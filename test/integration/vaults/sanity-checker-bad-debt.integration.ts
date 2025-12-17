import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { advanceChainTime, ether, impersonate, LIMITER_PRECISION_BASE } from "lib";
import {
  getProtocolContext,
  ProtocolContext,
  queueBadDebtInternalization,
  removeStakingLimit,
  report,
  setupLidoForVaults,
  setupVaultWithBadDebt,
  upDefaultTierShareLimit,
  waitNextAvailableReportTime,
} from "lib/protocol";

import { Snapshot } from "test/suite";
import { SHARE_RATE_PRECISION } from "test/suite/constants";

describe("Integration: Sanity checker with bad debt internalization", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  // Get shares burn limit from sanity checker when NO changes in pooled Ether are expected
  const sharesToBurnToReachRebaseLimit = async () => {
    const { lido, oracleReportSanityChecker } = ctx.contracts;

    const rebaseLimit = await oracleReportSanityChecker.getMaxPositiveTokenRebase();
    const rebaseLimitPlus1 = rebaseLimit + LIMITER_PRECISION_BASE;

    const internalShares = (await lido.getTotalShares()) - (await lido.getExternalShares());

    // Derived from: rebaseLimit = (postShareRate - preShareRate) / preShareRate
    return (internalShares * rebaseLimit) / rebaseLimitPlus1;
  };

  // Helper to capture protocol state
  const captureState = async () => {
    const { lido, vaultHub, burner, elRewardsVault, withdrawalVault } = ctx.contracts;

    const totalPooledEther = await lido.getTotalPooledEther();
    const totalShares = await lido.getTotalShares();
    const externalShares = await lido.getExternalShares();
    const externalEther = await lido.getExternalEther();
    const badDebtToInternalize = await vaultHub.badDebtToInternalize();
    const [coverShares, nonCoverShares] = await burner.getSharesRequestedToBurn();
    const elRewardsVaultBalance = await ethers.provider.getBalance(elRewardsVault);
    const withdrawalVaultBalance = await ethers.provider.getBalance(withdrawalVault);

    return {
      totalPooledEther,
      totalShares,
      externalShares,
      externalEther,
      badDebtToInternalize,
      burnerShares: coverShares + nonCoverShares,
      elRewardsVaultBalance,
      withdrawalVaultBalance,
      shareRate: totalShares > 0n ? (totalPooledEther * SHARE_RATE_PRECISION) / totalShares : 0n,
    };
  };

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    [, owner, nodeOperator, , , stranger] = await ethers.getSigners();
    const { withdrawalVault } = ctx.contracts;

    await setupLidoForVaults(ctx);
    await upDefaultTierShareLimit(ctx, ether("1000"));
    await setBalance(await withdrawalVault.getAddress(), 0n);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Smoothing rebase with bad debt internalization", () => {
    it("No smoothing", async () => {
      const { lido, burner } = ctx.contracts;

      const { stakingVault, badDebtShares } = await setupVaultWithBadDebt(ctx, owner, nodeOperator);
      const stateBefore = await captureState();

      await queueBadDebtInternalization(ctx, stakingVault, badDebtShares);

      // Report with zero CL diff, skip withdrawals, don't report burner
      const { reportTx } = await report(ctx, {
        clDiff: 0n,
        excludeVaultsBalances: true,
        skipWithdrawals: true,
        reportBurner: false,
        waitNextReportTime: true,
      });

      const receipt = await reportTx!.wait();

      // Verify nothing was burned on burner contract (check SharesBurnt events)
      const sharesBurntEvents = ctx.getEvents(receipt!, "SharesBurnt");
      const burnerAddress = await burner.getAddress();
      const burnerSharesBurnt = sharesBurntEvents.filter((e) => e.args.account === burnerAddress);
      expect(burnerSharesBurnt.length).to.equal(0, "No shares should be burnt from burner");

      // Verify bad debt was internalized
      await expect(reportTx).to.emit(lido, "ExternalBadDebtInternalized").withArgs(badDebtShares);
      await expect(reportTx).to.emit(lido, "ExternalSharesBurnt").withArgs(badDebtShares);

      const stateAfter = await captureState();

      // External shares decreased by bad debt
      expect(stateAfter.externalShares).to.equal(
        stateBefore.externalShares - badDebtShares,
        "External shares should decrease by bad debt amount",
      );

      // Bad debt queue cleared
      expect(stateAfter.badDebtToInternalize).to.equal(0n, "Bad debt should be cleared");
    });

    it("Smoothing due to large rewards", async () => {
      const { stakingVault, badDebtShares } = await setupVaultWithBadDebt(ctx, owner, nodeOperator);

      const reportWithLargeElRewardsEnsureSmoothing = async (badDebtToInternalize: bigint) => {
        const { lido, elRewardsVault } = ctx.contracts;

        const stateBefore = await captureState();

        // Add large EL rewards (will be limited by smoothing)
        const largeRewards = ether("10000");
        await setBalance(await elRewardsVault.getAddress(), largeRewards);

        const { reportTx } = await report(ctx, {
          clDiff: 0n,
          excludeVaultsBalances: false, // Include vault balances to collect rewards
          skipWithdrawals: true,
          waitNextReportTime: true,
        });

        // Verify bad debt was fully applied
        await expect(reportTx).to.emit(lido, "ExternalBadDebtInternalized").withArgs(badDebtToInternalize);

        const stateAfter = await captureState();

        // Bad debt fully cleared
        expect(stateAfter.badDebtToInternalize).to.equal(0n, "Bad debt should be fully cleared");
        expect(stateAfter.externalShares).to.equal(
          stateBefore.externalShares - badDebtToInternalize,
          "External shares should decrease by full bad debt amount",
        );

        // Smoothing applied: not all rewards collected (some left on vault)
        expect(stateAfter.elRewardsVaultBalance).to.be.lt(largeRewards, "Some EL rewards should be collected");
        expect(stateAfter.elRewardsVaultBalance).to.be.gt(0n, "Some EL rewards should remain due to smoothing");

        return stateAfter;
      };

      const beforeReportSnapshot = await Snapshot.take();

      // Report with smoothen token rebase with small bad debt internalization
      await queueBadDebtInternalization(ctx, stakingVault, badDebtShares / 10n); // Internalize part
      const stateAfter1 = await reportWithLargeElRewardsEnsureSmoothing(badDebtShares / 10n);

      await Snapshot.restore(beforeReportSnapshot);

      // Report with smoothen token rebase with larger bad debt internalization
      await queueBadDebtInternalization(ctx, stakingVault, badDebtShares); // Internalize all
      const stateAfter2 = await reportWithLargeElRewardsEnsureSmoothing(badDebtShares);

      expect(stateAfter1.shareRate).to.be.gt(
        stateAfter2.shareRate,
        "Share rate should be higher after less bad debt internalized",
      );

      expect(stateAfter1.elRewardsVaultBalance).to.be.eq(
        stateAfter2.elRewardsVaultBalance,
        "Smoothing should not be affected by bad debt amount",
      );
    });

    it("Smoothing due to large shares to burn", async () => {
      const { stakingVault, badDebtShares } = await setupVaultWithBadDebt(ctx, owner, nodeOperator);

      const reportWithLargeSharesToBurnEnsureSmoothing = async (badDebtToInternalize: bigint) => {
        const { lido, burner, accounting } = ctx.contracts;

        // Calculate shares limit and add excess to ensure smoothing kicks in
        const sharesLimit = await sharesToBurnToReachRebaseLimit();
        const excess = ether("100"); // Large excess to ensure smoothing
        const sharesToRequest = sharesLimit + excess;

        // Ensure whale has enough stETH
        const whaleBalance = (await lido.getPooledEthByShares(sharesToRequest)) + ether("100");
        await removeStakingLimit(ctx);
        await setBalance(stranger.address, whaleBalance + ether("1"));
        await lido.connect(stranger).submit(ZeroAddress, { value: whaleBalance });

        // Request burn of large amount of shares
        await lido.connect(stranger).approve(burner, await lido.getPooledEthByShares(sharesToRequest));

        const accountingSigner = await impersonate(accounting.address, ether("1"));
        await burner.connect(accountingSigner).requestBurnShares(stranger, sharesToRequest);

        const stateBefore = await captureState();

        // Verify burner has shares to burn
        expect(stateBefore.burnerShares).to.be.gte(sharesToRequest, "Burner should have shares to burn");

        const { reportTx } = await report(ctx, {
          clDiff: 0n,
          excludeVaultsBalances: true,
          skipWithdrawals: true,
          waitNextReportTime: true,
        });

        // Verify bad debt was fully applied regardless of burner shares
        await expect(reportTx).to.emit(lido, "ExternalBadDebtInternalized").withArgs(badDebtToInternalize);

        const stateAfter = await captureState();

        // Bad debt fully cleared
        expect(stateAfter.badDebtToInternalize).to.equal(0n, "Bad debt should be fully cleared");
        expect(stateAfter.externalShares).to.equal(
          stateBefore.externalShares - badDebtToInternalize,
          "External shares should decrease by full bad debt amount",
        );

        // Verify smoothing was applied: not all shares were burned (some remain on burner)
        expect(stateAfter.burnerShares).to.be.lt(stateBefore.burnerShares, "Some shares should be burned from burner");
        expect(stateAfter.burnerShares).to.be.gt(0n, "Some shares should remain on burner due to smoothing");

        return stateAfter;
      };

      const beforeReportSnapshot = await Snapshot.take();

      // Report with smoothen token rebase with small bad debt internalization
      await queueBadDebtInternalization(ctx, stakingVault, badDebtShares / 10n); // Internalize part
      const stateAfter1 = await reportWithLargeSharesToBurnEnsureSmoothing(badDebtShares / 10n);

      await Snapshot.restore(beforeReportSnapshot);

      // Report with smoothen token rebase with larger bad debt internalization
      await queueBadDebtInternalization(ctx, stakingVault, badDebtShares); // Internalize all
      const stateAfter2 = await reportWithLargeSharesToBurnEnsureSmoothing(badDebtShares);

      expect(stateAfter1.shareRate).to.be.gt(
        stateAfter2.shareRate,
        "Share rate should be higher after less bad debt internalized",
      );

      expect(stateAfter1.burnerShares).to.be.eq(
        stateAfter2.burnerShares,
        "Smoothing should not be affected by bad debt amount",
      );
    });
  });

  describe("CL balance decrease check with bad debt internalization", () => {
    it("Small CL balance decrease", async () => {
      const stateBefore = await captureState();

      // Queue bad debt internalization
      const { stakingVault, badDebtShares } = await setupVaultWithBadDebt(ctx, owner, nodeOperator);
      await queueBadDebtInternalization(ctx, stakingVault, badDebtShares);

      // Small negative CL diff (within allowed limits)
      const smallDecrease = ether("-1");

      await report(ctx, {
        clDiff: smallDecrease,
        excludeVaultsBalances: true,
        skipWithdrawals: true,
        waitNextReportTime: true,
      });

      const stateAfter = await captureState();

      expect(stateAfter.badDebtToInternalize).to.equal(0n, "Bad debt should be cleared");
      expect(stateAfter.shareRate).to.be.lt(stateBefore.shareRate, "Share rate should decrease");
    });

    it("Max allowed CL balance decrease", async () => {
      // Bad debt internalization does not affect calculation of dynamic slashing limit
      // so the report with max allowed CL decrease should still pass with bad debt internalization

      const { oracleReportSanityChecker, lido, stakingRouter } = ctx.contracts;

      // Time travel to 54 days to invalidate all current penalties and get max slashing limits
      const DAYS_54_IN_SECONDS = 54n * 24n * 60n * 60n;
      await advanceChainTime(DAYS_54_IN_SECONDS);
      await report(ctx);

      // Get current protocol state to calculate dynamic slashing limit
      const { beaconValidators } = await lido.getBeaconStat();
      const moduleDigests = await stakingRouter.getAllStakingModuleDigests();
      const limits = await oracleReportSanityChecker.getOracleReportLimits();

      const exitedValidators = moduleDigests.reduce((total, { summary }) => total + summary.totalExitedValidators, 0n);
      const activeValidators = beaconValidators - exitedValidators;

      // maxAllowedCLRebaseNegativeSum = initialSlashingAmountPWei * 1e15 * validators + inactivityPenaltiesAmountPWei * 1e15 * validators
      const ONE_PWEI = 10n ** 15n;
      const maxAllowedNegativeRebase =
        limits.initialSlashingAmountPWei * ONE_PWEI * activeValidators +
        limits.inactivityPenaltiesAmountPWei * ONE_PWEI * activeValidators;

      // CL decrease exactly at limit minus 1 wei should pass
      const clSlashing = -(maxAllowedNegativeRebase - 1n);

      const { stakingVault, badDebtShares } = await setupVaultWithBadDebt(ctx, owner, nodeOperator);
      await queueBadDebtInternalization(ctx, stakingVault, badDebtShares);

      const stateBefore = await captureState();
      expect(stateBefore.badDebtToInternalize).to.equal(badDebtShares, "Bad debt should be queued");

      const { reportTx } = await report(ctx, {
        clDiff: clSlashing,
        excludeVaultsBalances: true,
        skipWithdrawals: true,
        waitNextReportTime: true,
      });

      // Report should pass - CL decrease is under the limit
      // Bad debt should also be internalized in the same report
      await expect(reportTx).to.emit(lido, "ExternalBadDebtInternalized").withArgs(badDebtShares);

      const stateAfter = await captureState();
      expect(stateAfter.badDebtToInternalize).to.equal(0n, "Bad debt should be cleared");
      expect(stateAfter.externalShares).to.equal(
        stateBefore.externalShares - badDebtShares,
        "External shares should decrease by bad debt amount",
      );
    });
  });

  describe("Annual balance increase check with bad debt internalization", () => {
    it("CL balance increase over limit reverts, bad debt does not compensate", async () => {
      // Bad debt internalization does not affect CL balance increase check
      // so even with bad debt queued, the report exceeding limit should revert

      const { oracleReportSanityChecker, lido, accountingOracle, hashConsensus } = ctx.contracts;

      const { stakingVault, badDebtShares } = await setupVaultWithBadDebt(ctx, owner, nodeOperator);
      await queueBadDebtInternalization(ctx, stakingVault, badDebtShares);
      await waitNextAvailableReportTime(ctx);

      // Get current protocol state
      const { beaconBalance: preCLBalance } = await lido.getBeaconStat();
      const { annualBalanceIncreaseBPLimit } = await oracleReportSanityChecker.getOracleReportLimits();
      const { secondsPerSlot } = await hashConsensus.getChainConfig();
      const { currentFrameRefSlot } = await accountingOracle.getProcessingState();
      const lastRefSlot = await accountingOracle.getLastProcessingRefSlot();
      const slotElapsed = currentFrameRefSlot - lastRefSlot;

      expect(slotElapsed).to.be.gt(0n, "Some slots should have elapsed since last report");

      // Calculate time elapsed for one frame
      const timeElapsed = slotElapsed * secondsPerSlot;

      // Calculate balance increase that exceeds the limit
      // The check is: (365 days * 10000 * balanceIncrease / preCLBalance) / timeElapsed > limit
      // Solving : balanceIncrease > ((limit + 1) * preCLBalance * timeElapsed - 1) / (365 days * 10000)
      const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
      const MAX_BASIS_POINTS = 10000n;
      const maxBalanceIncrease =
        ((annualBalanceIncreaseBPLimit + 1n) * preCLBalance * timeElapsed - 1n) / (SECONDS_PER_YEAR * MAX_BASIS_POINTS);

      const stateBefore = await captureState();
      expect(stateBefore.badDebtToInternalize).to.equal(badDebtShares, "Bad debt should be queued");

      // Report should revert - CL increase exceeds the limit
      // Bad debt being queued does NOT compensate for the excess
      await expect(
        report(ctx, {
          clDiff: maxBalanceIncrease + 10n ** 9n, // + 1 gwei to exceed limit
          excludeVaultsBalances: true,
          skipWithdrawals: true,
          waitNextReportTime: false,
        }),
      ).to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectCLBalanceIncrease");

      // Now report exactly at the limit. Should pass despite bad debt internalization
      await report(ctx, {
        clDiff: maxBalanceIncrease,
        excludeVaultsBalances: true,
        skipWithdrawals: true,
        waitNextReportTime: false,
      });

      const stateAfter = await captureState();
      expect(stateAfter.badDebtToInternalize).to.equal(0n, "Bad debt should be cleared");
      expect(stateAfter.externalShares).to.equal(
        stateBefore.externalShares - badDebtShares,
        "External shares should decrease by bad debt amount",
      );
    });
  });
});
