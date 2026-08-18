import { expect } from "chai";
import { ethers } from "hardhat";

import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { ether, ONE_GWEI } from "lib";
import {
  getProtocolContext,
  ProtocolContext,
  reportWithoutClActivation,
  setWithdrawalVaultBalance,
  updateOracleReportLimits,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: Negative rebase", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalState: string;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    const [ethHolder] = await ethers.getSigners();
    await setBalance(ethHolder.address, ether("1000000"));
    const network = await ethers.provider.getNetwork();

    // In case of sepolia network, transfer some BEPOLIA tokens to the adapter contract
    if (network.name == "sepolia" || network.name == "sepolia-fork") {
      const sepoliaDepositContractAddress = "0x7f02C3E3c98b133055B8B348B2Ac625669Ed295D";
      const bepoliaWhaleHolder = "0xf97e180c050e5Ab072211Ad2C213Eb5AEE4DF134";
      const BEPOLIA_TO_TRANSFER = 20;

      const bepoliaToken = await ethers.getContractAt("ISepoliaDepositContract", sepoliaDepositContractAddress);
      const bepoliaSigner = await ethers.getImpersonatedSigner(bepoliaWhaleHolder);

      const adapterAddr = await ctx.contracts.stakingRouter.DEPOSIT_CONTRACT();
      await bepoliaToken.connect(bepoliaSigner).transfer(adapterAddr, BEPOLIA_TO_TRANSFER);
    }
  });

  beforeEach(async () => (originalState = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(originalState));
  after(async () => await Snapshot.restore(snapshot));

  const exitedValidatorsCount = async () => {
    const ids = await ctx.contracts.stakingRouter.getStakingModuleIds();
    const exited = new Map<bigint, bigint>();
    for (const id of ids) {
      const module = await ctx.contracts.stakingRouter.getStakingModule(id);
      exited.set(id, module.exitedValidatorsCount);
    }
    return exited;
  };

  it("stores an exited-validators update independently of rebase classification", async () => {
    const currentExited = await exitedValidatorsCount();
    const reportExitedValidators = currentExited.get(1n) ?? 0n;

    await reportWithoutClActivation(ctx, {
      skipWithdrawals: true,
      clAppearedValidators: 0n,
      reportElVault: false,
      stakingModuleIdsWithNewlyExitedValidators: [1n],
      numExitedValidatorsByStakingModule: [reportExitedValidators + 2n],
    });

    const updatedExited = await exitedValidatorsCount();
    const totalExitedBefore = Array.from(currentExited.values()).reduce((acc, val) => acc + val, 0n);
    const totalExitedAfter = Array.from(updatedExited.values()).reduce((acc, val) => acc + val, 0n);

    expect(updatedExited.get(1n) ?? 0n).to.equal(reportExitedValidators + 2n);
    expect(totalExitedAfter).to.equal(totalExitedBefore + 2n);
  });

  it("accepts a per-report CL decrease below the soft limit", async () => {
    const { accountingOracle } = ctx.contracts;
    await setWithdrawalVaultBalance(ctx, 0n);
    await updateOracleReportLimits(ctx, {
      clRebaseDecreaseSoftBPLimit: 100n,
      clRebaseDecreaseHardBPLimit: 500n,
    });

    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    await reportWithoutClActivation(ctx, {
      effectiveClDiff: -ONE_GWEI,
      skipWithdrawals: true,
      reportElVault: false,
    });

    expect(await accountingOracle.getLastProcessingRefSlot()).to.be.gt(lastProcessingRefSlotBefore);
  });

  it("applies the soft decrease limit independently to consecutive reports", async () => {
    const { lido } = ctx.contracts;
    await setWithdrawalVaultBalance(ctx, 0n);
    await updateOracleReportLimits(ctx, {
      clRebaseDecreaseSoftBPLimit: 100n,
      clRebaseDecreaseHardBPLimit: 500n,
    });

    const getPrincipalCLBalance = async () => {
      const { clValidatorsBalanceAtLastReport, clPendingBalanceAtLastReport, depositedForCurrentReport } =
        await lido.getBalanceStats();
      return clValidatorsBalanceAtLastReport + clPendingBalanceAtLastReport + depositedForCurrentReport;
    };
    const initialPrincipal = await getPrincipalCLBalance();

    for (let i = 0; i < 2; ++i) {
      const principal = await getPrincipalCLBalance();
      const decrease = ((principal * 60n) / 10_000n / ONE_GWEI) * ONE_GWEI;
      await reportWithoutClActivation(ctx, {
        effectiveClDiff: -decrease,
        skipWithdrawals: true,
        reportElVault: false,
      });
    }

    const finalPrincipal = await getPrincipalCLBalance();
    expect(initialPrincipal - finalPrincipal).to.be.gt((initialPrincipal * 100n) / 10_000n);
  });

  it("rejects a per-report CL decrease above the hard limit", async () => {
    const { lido, oracleReportSanityChecker } = ctx.contracts;
    await setWithdrawalVaultBalance(ctx, 0n);
    await updateOracleReportLimits(ctx, {
      clRebaseDecreaseSoftBPLimit: 100n,
      clRebaseDecreaseHardBPLimit: 500n,
    });

    const { clValidatorsBalanceAtLastReport, clPendingBalanceAtLastReport, depositedForCurrentReport } =
      await lido.getBalanceStats();
    const principalCLBalance =
      clValidatorsBalanceAtLastReport + clPendingBalanceAtLastReport + depositedForCurrentReport;
    const decreaseAboveHardLimit = ((principalCLBalance * 600n) / 10_000n / ONE_GWEI) * ONE_GWEI;

    await expect(
      reportWithoutClActivation(ctx, {
        effectiveClDiff: -decreaseAboveHardLimit,
        skipWithdrawals: true,
        reportElVault: false,
      }),
    ).to.be.revertedWithCustomError(oracleReportSanityChecker, "CLRebaseDecreaseAboveHardLimit");
  });
});
