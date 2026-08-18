import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { ether, impersonate, ONE_GWEI } from "lib";
import {
  getProtocolContext,
  ProtocolContext,
  queueBadDebtInternalization,
  removeStakingLimit,
  reportWithoutClActivation,
  setupLidoForVaults,
  setupVaultWithBadDebt,
  updateOracleReportLimits,
  upDefaultTierShareLimit,
} from "lib/protocol";

import { Snapshot } from "test/suite";
import { SHARE_RATE_PRECISION } from "test/suite/constants";

const FORMER_PRODUCTION_MAX_POSITIVE_TOKEN_REBASE = 750_000n;
const FORMER_REBASE_PRECISION_BASE = 1_000_000_000n;

describe("Integration: Sanity checker with bad debt internalization", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;
  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const formerPositiveRebaseLimitWei = async () => {
    const { lido } = ctx.contracts;
    const internalEther = (await lido.getTotalPooledEther()) - (await lido.getExternalEther());
    return (internalEther * FORMER_PRODUCTION_MAX_POSITIVE_TOKEN_REBASE) / FORMER_REBASE_PRECISION_BASE;
  };

  const sharesToReachFormerPositiveRebaseLimit = async () => {
    const { lido } = ctx.contracts;
    const internalShares = (await lido.getTotalShares()) - (await lido.getExternalShares());
    return (
      (internalShares * FORMER_PRODUCTION_MAX_POSITIVE_TOKEN_REBASE) /
      (FORMER_REBASE_PRECISION_BASE + FORMER_PRODUCTION_MAX_POSITIVE_TOKEN_REBASE)
    );
  };

  const captureState = async () => {
    const { lido, vaultHub, burner, elRewardsVault } = ctx.contracts;
    const totalPooledEther = await lido.getTotalPooledEther();
    const totalShares = await lido.getTotalShares();
    const [coverShares, nonCoverShares] = await burner.getSharesRequestedToBurn();

    return {
      externalShares: await lido.getExternalShares(),
      badDebtToInternalize: await vaultHub.badDebtToInternalize(),
      burnerShares: coverShares + nonCoverShares,
      elRewardsVaultBalance: await ethers.provider.getBalance(elRewardsVault),
      shareRate: totalShares > 0n ? (totalPooledEther * SHARE_RATE_PRECISION) / totalShares : 0n,
    };
  };

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();
    [, owner, nodeOperator, , , stranger] = await ethers.getSigners();

    await setupLidoForVaults(ctx);
    await upDefaultTierShareLimit(ctx, ether("1000"));
    await setBalance(await ctx.contracts.withdrawalVault.getAddress(), 0n);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  it("internalizes queued bad debt during a neutral report", async () => {
    const { lido } = ctx.contracts;
    const { stakingVault, badDebtShares } = await setupVaultWithBadDebt(ctx, owner, nodeOperator);
    await queueBadDebtInternalization(ctx, stakingVault, badDebtShares);
    const stateBefore = await captureState();

    const { reportTx } = await reportWithoutClActivation(ctx, {
      reportElVault: false,
      skipWithdrawals: true,
      reportBurner: false,
    });

    await expect(reportTx).to.emit(lido, "ExternalBadDebtInternalized").withArgs(badDebtShares);
    await expect(reportTx).to.emit(lido, "ExternalSharesBurnt").withArgs(badDebtShares);
    const stateAfter = await captureState();
    expect(stateAfter.badDebtToInternalize).to.equal(0n);
    expect(stateAfter.externalShares).to.equal(stateBefore.externalShares - badDebtShares);
  });

  it("collects the full EL rewards balance while internalizing bad debt", async () => {
    const { lido, elRewardsVault } = ctx.contracts;
    const { stakingVault, badDebtShares } = await setupVaultWithBadDebt(ctx, owner, nodeOperator);
    await queueBadDebtInternalization(ctx, stakingVault, badDebtShares);

    const rewards = (await formerPositiveRebaseLimitWei()) + ether("10");
    await setBalance(await elRewardsVault.getAddress(), rewards);

    const { reportTx } = await reportWithoutClActivation(ctx, {
      reportElVault: true,
      skipWithdrawals: true,
      reportBurner: false,
    });

    await expect(reportTx).to.emit(lido, "ExternalBadDebtInternalized").withArgs(badDebtShares);
    expect(await ethers.provider.getBalance(elRewardsVault)).to.equal(0n);
    expect((await captureState()).badDebtToInternalize).to.equal(0n);
  });

  it("burns all requested Burner shares while internalizing bad debt", async () => {
    const { lido, burner, accounting } = ctx.contracts;
    const { stakingVault, badDebtShares } = await setupVaultWithBadDebt(ctx, owner, nodeOperator);
    await queueBadDebtInternalization(ctx, stakingVault, badDebtShares);

    const sharesToRequest = (await sharesToReachFormerPositiveRebaseLimit()) + ether("10");
    const pooledEthToSubmit = (await lido.getPooledEthByShares(sharesToRequest)) + ether("1");
    await removeStakingLimit(ctx);
    await setBalance(stranger.address, pooledEthToSubmit + ether("1"));
    await lido.connect(stranger).submit(ZeroAddress, { value: pooledEthToSubmit });

    await lido.connect(stranger).approve(burner, await lido.getPooledEthByShares(sharesToRequest));
    const accountingSigner = await impersonate(accounting.address, ether("1"));
    await burner.connect(accountingSigner).requestBurnShares(stranger, sharesToRequest);
    expect((await captureState()).burnerShares).to.be.gte(sharesToRequest);

    const { reportTx } = await reportWithoutClActivation(ctx, {
      reportElVault: false,
      skipWithdrawals: true,
      reportBurner: true,
    });

    await expect(reportTx).to.emit(lido, "ExternalBadDebtInternalized").withArgs(badDebtShares);
    const stateAfter = await captureState();
    expect(stateAfter.burnerShares).to.equal(0n);
    expect(stateAfter.badDebtToInternalize).to.equal(0n);
  });

  it("accepts a CL decrease below the soft limit while internalizing bad debt", async () => {
    const { lido } = ctx.contracts;
    await updateOracleReportLimits(ctx, {
      clRebaseDecreaseSoftBPLimit: 500n,
      clRebaseDecreaseHardBPLimit: 500n,
    });

    const { stakingVault, badDebtShares } = await setupVaultWithBadDebt(ctx, owner, nodeOperator);
    await queueBadDebtInternalization(ctx, stakingVault, badDebtShares);
    const stateBefore = await captureState();

    const { clValidatorsBalanceAtLastReport, clPendingBalanceAtLastReport } = await lido.getBalanceStats();
    const preCLBalance = clValidatorsBalanceAtLastReport + clPendingBalanceAtLastReport;
    const decrease = ((preCLBalance * 100n) / 10_000n / ONE_GWEI) * ONE_GWEI;
    expect(decrease).to.be.gt(0n);

    await reportWithoutClActivation(ctx, {
      effectiveClDiff: -decrease,
      reportElVault: false,
      skipWithdrawals: true,
      reportBurner: false,
    });

    const stateAfter = await captureState();
    expect(stateAfter.badDebtToInternalize).to.equal(0n);
    expect(stateAfter.externalShares).to.equal(stateBefore.externalShares - badDebtShares);
    expect(stateAfter.shareRate).to.be.lt(stateBefore.shareRate);
  });

  it("rejects a CL increase above the hard limit even with queued bad debt", async () => {
    const { oracleReportSanityChecker } = ctx.contracts;
    await updateOracleReportLimits(ctx, {
      annualCLRebaseIncreaseSoftBPLimit: 0n,
      annualCLRebaseIncreaseHardBPLimit: 0n,
    });

    const { stakingVault, badDebtShares } = await setupVaultWithBadDebt(ctx, owner, nodeOperator);
    await queueBadDebtInternalization(ctx, stakingVault, badDebtShares);

    await expect(
      reportWithoutClActivation(ctx, {
        effectiveClDiff: ONE_GWEI,
        reportElVault: false,
        skipWithdrawals: true,
        reportBurner: false,
      }),
    ).to.be.revertedWithCustomError(oracleReportSanityChecker, "AnnualCLRebaseIncreaseAboveHardLimit");
  });
});
