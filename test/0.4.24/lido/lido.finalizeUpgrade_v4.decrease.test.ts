import { expect } from "chai";

import { ether, impersonate } from "lib";

import {
  buildCLBalanceDecreaseReport,
  calcMaxAllowedFirstReportCLBalanceDecrease,
  calcMaxAllowedWindowCLBalanceDecrease,
  checkAccountingOracleReport,
  expectedCLDecreaseLimitLossFromMigrationBootstrap,
  hoodiLikeMigratedNetwork,
  mainnetLikeMigratedNetwork,
  maxWithdrawalsByChurnLimitPerReport,
  MigratedNetworkScenario,
  oneDay,
  useFinalizeUpgradeV4Fixture,
} from "./lido.finalizeUpgrade_v4.helpers";

describe("Lido.sol:finalizeUpgrade_v4 CL balance decrease sanity check invariants", () => {
  const fixture = useFinalizeUpgradeV4Fixture();

  const prepareCheckerAfterFirstReportWithMigrationVaultBalance = async (
    migratedNetwork: MigratedNetworkScenario,
    withdrawalVaultBalanceAtMigration: bigint,
    withdrawalsVaultTransferAtFirstReport = 0n,
  ) => {
    // Shared setup for 36-day window checks: run the real migration, then accept
    // a first report whose CL decrease equals the migration-time vault balance.
    const balanceStats = await fixture.migrateNetworkV3State(migratedNetwork);
    const { accounting, deployChecker } = await fixture.deployAccountingAndChecker(withdrawalVaultBalanceAtMigration);
    const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

    // The bootstrap snapshot already contains maxWithdrawalsByChurnLimitPerReport,
    // so the available decrease window is smaller than raw 3.6% of CL balance.
    const bootstrapAdjustedFullWindowCLDecreaseLimit = calcMaxAllowedFirstReportCLBalanceDecrease(
      balanceStats.clValidatorsBalanceAtLastReport,
    );
    const firstReportPreCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
    const firstReportPreCLPendingBalance = balanceStats.clPendingBalanceAtLastReport;
    const firstReportCLValidatorsBalanceDecrease = withdrawalVaultBalanceAtMigration;
    const firstReportWithdrawalVaultBalance = withdrawalVaultBalanceAtMigration;
    const firstReportDepositsForReport = balanceStats.depositedForCurrentReport;
    const firstReportCheck = buildCLBalanceDecreaseReport({
      preCLValidatorsBalance: firstReportPreCLValidatorsBalance,
      preCLPendingBalance: firstReportPreCLPendingBalance,
      clBalanceDecrease: firstReportCLValidatorsBalanceDecrease,
      withdrawalVaultBalance: firstReportWithdrawalVaultBalance,
      depositsForReport: firstReportDepositsForReport,
      withdrawalsVaultTransfer: withdrawalsVaultTransferAtFirstReport,
    });

    const migratedBaselineChecker = await deployChecker();
    await migratedBaselineChecker.migrateBaselineSnapshot();

    // This first report records migration-time WV pressure in the checker window
    // and returns the state that the next report will see.
    await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, firstReportCheck)).not.to.be
      .reverted;

    return {
      migratedBaselineChecker,
      accountingSigner,
      bootstrapAdjustedFullWindowCLDecreaseLimit,
      migrationTimeCLDecrease: firstReportCLValidatorsBalanceDecrease,
      nextReportPreCLValidatorsBalance: firstReportCheck.postCLValidatorsBalance,
      nextReportPreCLPendingBalance: firstReportCheck.postCLPendingBalance,
      nextReportWithdrawalVaultBalance: firstReportWithdrawalVaultBalance - withdrawalsVaultTransferAtFirstReport,
    };
  };

  context("post-migration withdrawal vault delta", () => {
    it("counts only withdrawal vault balance delta after migration as CL withdrawals", async () => {
      const withdrawalVaultBalanceAtMigration = ether("100000");

      // Add new withdrawals after migration. Only this delta should be counted as
      // CL withdrawals; the migration-time balance is already the checker baseline.
      const freshCLWithdrawalsAfterMigration = ether("1000");
      const withdrawalVaultBalanceAtFirstReportRefSlot =
        withdrawalVaultBalanceAtMigration + freshCLWithdrawalsAfterMigration;
      const clWithdrawalsSinceMigration =
        withdrawalVaultBalanceAtFirstReportRefSlot - withdrawalVaultBalanceAtMigration;
      const firstReportCLValidatorsBalanceDecrease = freshCLWithdrawalsAfterMigration;
      const balanceStats = await fixture.migrateMainnetLikeV3State();
      const { accounting, deployChecker } = await fixture.deployAccountingAndChecker(withdrawalVaultBalanceAtMigration);
      const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

      const preCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
      const preCLPendingBalance = balanceStats.clPendingBalanceAtLastReport;
      const depositsForReport = balanceStats.depositedForCurrentReport;
      expect(clWithdrawalsSinceMigration).to.equal(freshCLWithdrawalsAfterMigration);

      // Match the CL decrease to only the fresh post-migration withdrawals.
      const firstReportCheck = buildCLBalanceDecreaseReport({
        preCLValidatorsBalance,
        preCLPendingBalance,
        clBalanceDecrease: firstReportCLValidatorsBalanceDecrease,
        withdrawalVaultBalance: withdrawalVaultBalanceAtFirstReportRefSlot,
        depositsForReport,
      });

      const migratedBaselineChecker = await deployChecker();
      await migratedBaselineChecker.migrateBaselineSnapshot();

      // The actual vault balance at the report reference slot must match the report payload.
      await fixture.setWithdrawalVaultBalance(withdrawalVaultBalanceAtFirstReportRefSlot);

      await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, firstReportCheck)).not.to.be
        .reverted;
    });

    it("uses the first-report after-transfer vault balance as the next CL withdrawals baseline", async () => {
      const withdrawalVaultBalanceAtMigration = ether("100000");

      // First report observes new withdrawals, then Accounting transfers part of
      // the vault balance to the buffer after the report is processed.
      const firstReportCLWithdrawals = ether("20000");
      const firstReportWithdrawalVaultBalance = withdrawalVaultBalanceAtMigration + firstReportCLWithdrawals;
      const firstReportWithdrawalsVaultTransfer = ether("50000");
      const firstReportVaultBalanceAfterTransfer =
        firstReportWithdrawalVaultBalance - firstReportWithdrawalsVaultTransfer;

      // Second report should measure new withdrawals from the after-transfer balance,
      // not from the first report reference-slot balance.
      const secondReportCLWithdrawals = ether("10000");
      const secondReportWithdrawalVaultBalance = firstReportVaultBalanceAfterTransfer + secondReportCLWithdrawals;
      const balanceStats = await fixture.migrateMainnetLikeV3State();
      const { accounting, deployChecker } = await fixture.deployAccountingAndChecker(withdrawalVaultBalanceAtMigration);
      const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

      const firstReportPreCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
      const firstReportPreCLPendingBalance = balanceStats.clPendingBalanceAtLastReport;
      const firstReportDepositsForReport = balanceStats.depositedForCurrentReport;
      expect(firstReportWithdrawalVaultBalance - withdrawalVaultBalanceAtMigration).to.equal(firstReportCLWithdrawals);

      // First report also records withdrawalsVaultTransfer, which updates the private
      // vault baseline to the after-transfer balance for subsequent reports.
      const firstReportCheck = buildCLBalanceDecreaseReport({
        preCLValidatorsBalance: firstReportPreCLValidatorsBalance,
        preCLPendingBalance: firstReportPreCLPendingBalance,
        clBalanceDecrease: firstReportCLWithdrawals,
        withdrawalVaultBalance: firstReportWithdrawalVaultBalance,
        depositsForReport: firstReportDepositsForReport,
        withdrawalsVaultTransfer: firstReportWithdrawalsVaultTransfer,
      });

      const migratedBaselineChecker = await deployChecker();
      await migratedBaselineChecker.migrateBaselineSnapshot();
      await fixture.setWithdrawalVaultBalance(firstReportWithdrawalVaultBalance);
      await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, firstReportCheck)).not.to.be
        .reverted;

      const secondReportPreCLValidatorsBalance = firstReportCheck.postCLValidatorsBalance;
      const secondReportPreCLPendingBalance = firstReportCheck.postCLPendingBalance;
      const secondReportDepositsForReport = 0n;
      expect(secondReportWithdrawalVaultBalance - firstReportVaultBalanceAfterTransfer).to.equal(
        secondReportCLWithdrawals,
      );

      // Now the second report passes only if the checker baseline was updated to
      // firstReportVaultBalanceAfterTransfer.
      const secondReportCheck = buildCLBalanceDecreaseReport({
        preCLValidatorsBalance: secondReportPreCLValidatorsBalance,
        preCLPendingBalance: secondReportPreCLPendingBalance,
        clBalanceDecrease: secondReportCLWithdrawals,
        withdrawalVaultBalance: secondReportWithdrawalVaultBalance,
        depositsForReport: secondReportDepositsForReport,
      });

      await fixture.setWithdrawalVaultBalance(secondReportWithdrawalVaultBalance);
      await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, secondReportCheck)).not.to.be
        .reverted;
    });
  });

  context("migration-time withdrawal vault balance in the CL decrease window", () => {
    it("does not offset first-report CL decrease with migration-time withdrawal vault balance", async () => {
      const withdrawalVaultBalanceAtMigration = ether("400000");

      // No fresh WV delta exists after migration, but CL balance decreases by the
      // full migration-time WV amount. The decrease checker must not offset it.
      const withdrawalVaultBalanceAtFirstReportRefSlot = withdrawalVaultBalanceAtMigration;
      const clWithdrawalsSinceMigration =
        withdrawalVaultBalanceAtFirstReportRefSlot - withdrawalVaultBalanceAtMigration;
      const clValidatorsBalanceDecrease = withdrawalVaultBalanceAtMigration;
      const balanceStats = await fixture.migrateMainnetLikeV3State();
      const { accounting, deployChecker } = await fixture.deployAccountingAndChecker(withdrawalVaultBalanceAtMigration);
      const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

      const preCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
      const preCLPendingBalance = balanceStats.clPendingBalanceAtLastReport;
      const depositsForReport = balanceStats.depositedForCurrentReport;
      expect(clWithdrawalsSinceMigration).to.equal(0n);

      // Since clWithdrawalsSinceMigration is zero, this entire decrease is checked
      // against the bootstrap-adjusted CL balance decrease limit.
      const firstReportCheck = buildCLBalanceDecreaseReport({
        preCLValidatorsBalance,
        preCLPendingBalance,
        clBalanceDecrease: clValidatorsBalanceDecrease,
        withdrawalVaultBalance: withdrawalVaultBalanceAtFirstReportRefSlot,
        depositsForReport,
      });

      const migratedBaselineChecker = await deployChecker();
      await migratedBaselineChecker.migrateBaselineSnapshot();

      const maxAllowedCLBalanceDecrease = calcMaxAllowedFirstReportCLBalanceDecrease(preCLValidatorsBalance);

      await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, firstReportCheck))
        .to.be.revertedWithCustomError(migratedBaselineChecker, "IncorrectCLBalanceDecrease")
        .withArgs(clValidatorsBalanceDecrease, maxAllowedCLBalanceDecrease);
    });

    const prepareFirstReportDecreaseAtMigrationVaultBalance = async (
      migratedNetwork: MigratedNetworkScenario,
      withdrawalVaultBalanceAtMigration: bigint,
    ) => {
      const balanceStats = await fixture.migrateNetworkV3State(migratedNetwork);
      const preCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;

      // The safe migration WV cap is network-size dependent because the decrease
      // limit is proportional to migrated CL validator balance.
      const maxSafeMigrationWithdrawalVaultBalance =
        calcMaxAllowedFirstReportCLBalanceDecrease(preCLValidatorsBalance);
      expect(maxSafeMigrationWithdrawalVaultBalance).to.equal(
        migratedNetwork.expectedBootstrapAdjustedFirstReportCLDecreaseLimit,
      );

      // Boundary cases isolate migration-time WV: no additional WV delta appears
      // between migration and the first report reference slot.
      const withdrawalVaultBalanceAtFirstReportRefSlot = withdrawalVaultBalanceAtMigration;
      const clWithdrawalsSinceMigration =
        withdrawalVaultBalanceAtFirstReportRefSlot - withdrawalVaultBalanceAtMigration;
      expect(clWithdrawalsSinceMigration).to.equal(0n);

      const { accounting, deployChecker } = await fixture.deployAccountingAndChecker(withdrawalVaultBalanceAtMigration);
      const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));
      const firstReportCLValidatorsBalanceDecrease = withdrawalVaultBalanceAtMigration;
      const firstReportCheck = buildCLBalanceDecreaseReport({
        preCLValidatorsBalance,
        preCLPendingBalance: balanceStats.clPendingBalanceAtLastReport,
        clBalanceDecrease: firstReportCLValidatorsBalanceDecrease,
        withdrawalVaultBalance: withdrawalVaultBalanceAtFirstReportRefSlot,
        depositsForReport: balanceStats.depositedForCurrentReport,
      });

      const migratedBaselineChecker = await deployChecker();
      await migratedBaselineChecker.migrateBaselineSnapshot();

      return {
        migratedBaselineChecker,
        accountingSigner,
        firstReportCheck,
        firstReportCLValidatorsBalanceDecrease,
        maxSafeMigrationWithdrawalVaultBalance,
      };
    };

    for (const migratedNetwork of [hoodiLikeMigratedNetwork, mainnetLikeMigratedNetwork]) {
      context(migratedNetwork.name, () => {
        it("accepts a first-report decrease one wei below the maximum safe migration vault balance", async () => {
          // One wei below the derived cap must still pass for this network size.
          const withdrawalVaultBalanceAtMigration =
            migratedNetwork.expectedBootstrapAdjustedFirstReportCLDecreaseLimit - 1n;
          const { migratedBaselineChecker, accountingSigner, firstReportCheck } =
            await prepareFirstReportDecreaseAtMigrationVaultBalance(migratedNetwork, withdrawalVaultBalanceAtMigration);

          await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, firstReportCheck)).not.to
            .be.reverted;
        });

        it("reverts a first-report decrease one wei above the maximum safe migration vault balance", async () => {
          // One wei above the same cap must fail and expose the exact cap in revert args.
          const withdrawalVaultBalanceAtMigration =
            migratedNetwork.expectedBootstrapAdjustedFirstReportCLDecreaseLimit + 1n;
          const {
            migratedBaselineChecker,
            accountingSigner,
            firstReportCheck,
            firstReportCLValidatorsBalanceDecrease,
            maxSafeMigrationWithdrawalVaultBalance,
          } = await prepareFirstReportDecreaseAtMigrationVaultBalance(migratedNetwork, withdrawalVaultBalanceAtMigration);

          await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, firstReportCheck))
            .to.be.revertedWithCustomError(migratedBaselineChecker, "IncorrectCLBalanceDecrease")
            .withArgs(firstReportCLValidatorsBalanceDecrease, maxSafeMigrationWithdrawalVaultBalance);
        });
      });
    }
  });

  context("36-day CL decrease headroom after migration-time vault balance", () => {
    const required36DayCLDecreaseHeadroom = ether("50000");

    for (const migratedNetwork of [hoodiLikeMigratedNetwork, mainnetLikeMigratedNetwork]) {
      context(migratedNetwork.name, () => {
        it("keeps the chosen CL decrease headroom when migration vault balance is capped", async () => {
          // Compare raw 36-day decrease capacity with the bootstrap-adjusted capacity;
          // the synthetic bootstrap withdrawal flow consumes part of the window.
          const rawFullWindowCLDecreaseLimit = calcMaxAllowedWindowCLBalanceDecrease(
            migratedNetwork.clValidatorsBalance,
            0n,
            0n,
          );
          const bootstrapAdjustedFullWindowCLDecreaseLimit = calcMaxAllowedWindowCLBalanceDecrease(
            migratedNetwork.clValidatorsBalance,
            0n,
            maxWithdrawalsByChurnLimitPerReport,
          );
          expect(bootstrapAdjustedFullWindowCLDecreaseLimit).to.equal(
            migratedNetwork.expectedBootstrapAdjustedFirstReportCLDecreaseLimit,
          );
          expect(rawFullWindowCLDecreaseLimit - bootstrapAdjustedFullWindowCLDecreaseLimit).to.equal(
            expectedCLDecreaseLimitLossFromMigrationBootstrap,
          );

          // Choose migration WV so exactly the requested headroom remains for
          // decreases reported before the 36-day window closes.
          const maxMigrationWithdrawalVaultBalanceKeepingHeadroom =
            bootstrapAdjustedFullWindowCLDecreaseLimit - required36DayCLDecreaseHeadroom;
          const withdrawalVaultBalanceAtMigration = maxMigrationWithdrawalVaultBalanceKeepingHeadroom;
          const remaining36DayCLDecreaseHeadroom =
            bootstrapAdjustedFullWindowCLDecreaseLimit - withdrawalVaultBalanceAtMigration;
          expect(remaining36DayCLDecreaseHeadroom).to.equal(required36DayCLDecreaseHeadroom);

          const {
            migratedBaselineChecker,
            accountingSigner,
            migrationTimeCLDecrease,
            nextReportPreCLValidatorsBalance,
            nextReportPreCLPendingBalance,
            nextReportWithdrawalVaultBalance,
          } = await prepareCheckerAfterFirstReportWithMigrationVaultBalance(
            migratedNetwork,
            withdrawalVaultBalanceAtMigration,
          );

          // The next report is placed at day 36; together with the first report it
          // exactly fills the bootstrap-adjusted sliding window.
          const elapsedSinceFirstReportToClose36DayWindow = 35n * oneDay;
          expect(oneDay + elapsedSinceFirstReportToClose36DayWindow).to.equal(36n * oneDay);
          const day36CLValidatorsBalanceDecrease = remaining36DayCLDecreaseHeadroom;
          const totalCLDecreaseInsideWindow = migrationTimeCLDecrease + day36CLValidatorsBalanceDecrease;
          expect(totalCLDecreaseInsideWindow).to.equal(bootstrapAdjustedFullWindowCLDecreaseLimit);

          const day36ReportCheck = buildCLBalanceDecreaseReport({
            timeElapsed: elapsedSinceFirstReportToClose36DayWindow,
            preCLValidatorsBalance: nextReportPreCLValidatorsBalance,
            preCLPendingBalance: nextReportPreCLPendingBalance,
            clBalanceDecrease: day36CLValidatorsBalanceDecrease,
            withdrawalVaultBalance: nextReportWithdrawalVaultBalance,
          });

          await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, day36ReportCheck)).not.to
            .be.reverted;
        });

        it("reverts one wei above the migration vault balance cap that preserves the chosen headroom", async () => {
          // Start from the same network-size dependent window limit.
          const bootstrapAdjustedFullWindowCLDecreaseLimit = calcMaxAllowedWindowCLBalanceDecrease(
            migratedNetwork.clValidatorsBalance,
            0n,
            maxWithdrawalsByChurnLimitPerReport,
          );
          expect(bootstrapAdjustedFullWindowCLDecreaseLimit).to.equal(
            migratedNetwork.expectedBootstrapAdjustedFirstReportCLDecreaseLimit,
          );

          // Add one wei too much migration WV, leaving one wei less than the chosen
          // future headroom inside the 36-day window.
          const maxMigrationWithdrawalVaultBalanceKeepingHeadroom =
            bootstrapAdjustedFullWindowCLDecreaseLimit - required36DayCLDecreaseHeadroom;
          const withdrawalVaultBalanceAtMigration = maxMigrationWithdrawalVaultBalanceKeepingHeadroom + 1n;
          const remaining36DayCLDecreaseHeadroom =
            bootstrapAdjustedFullWindowCLDecreaseLimit - withdrawalVaultBalanceAtMigration;
          expect(remaining36DayCLDecreaseHeadroom).to.equal(required36DayCLDecreaseHeadroom - 1n);

          const {
            migratedBaselineChecker,
            accountingSigner,
            migrationTimeCLDecrease,
            nextReportPreCLValidatorsBalance,
            nextReportPreCLPendingBalance,
            nextReportWithdrawalVaultBalance,
          } = await prepareCheckerAfterFirstReportWithMigrationVaultBalance(
            migratedNetwork,
            withdrawalVaultBalanceAtMigration,
          );

          // Asking for the original headroom now exceeds the remaining 36-day
          // decrease window by exactly one wei.
          const elapsedSinceFirstReportToClose36DayWindow = 35n * oneDay;
          expect(oneDay + elapsedSinceFirstReportToClose36DayWindow).to.equal(36n * oneDay);
          const day36CLValidatorsBalanceDecrease = required36DayCLDecreaseHeadroom;
          const totalCLDecreaseInsideWindow = migrationTimeCLDecrease + day36CLValidatorsBalanceDecrease;
          expect(totalCLDecreaseInsideWindow).to.equal(bootstrapAdjustedFullWindowCLDecreaseLimit + 1n);

          const day36ReportCheck = buildCLBalanceDecreaseReport({
            timeElapsed: elapsedSinceFirstReportToClose36DayWindow,
            preCLValidatorsBalance: nextReportPreCLValidatorsBalance,
            preCLPendingBalance: nextReportPreCLPendingBalance,
            clBalanceDecrease: day36CLValidatorsBalanceDecrease,
            withdrawalVaultBalance: nextReportWithdrawalVaultBalance,
          });

          await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, day36ReportCheck))
            .to.be.revertedWithCustomError(migratedBaselineChecker, "IncorrectCLBalanceDecrease")
            .withArgs(totalCLDecreaseInsideWindow, bootstrapAdjustedFullWindowCLDecreaseLimit);
        });
      });
    }
  });
});
