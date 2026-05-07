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
  oneDay,
  useFinalizeUpgradeV4Fixture,
} from "./lido.finalizeUpgrade_v4.helpers";

describe("Lido.sol:finalizeUpgrade_v4 CL balance decrease sanity check", () => {
  const fixture = useFinalizeUpgradeV4Fixture();
  const noWithdrawalVaultBalance = 0n;

  context("migration-time withdrawal vault balance in CL decrease checks", () => {
    for (const migratedNetwork of [hoodiLikeMigratedNetwork, mainnetLikeMigratedNetwork]) {
      // This boundary test fixes first-report CL decrease behavior for each network size:
      // 1. Migration seeds current WV as the checker vault baseline.
      // 2. The first report sees the same WV, so it records zero fresh CL withdrawals.
      // 3. That WV-sized CL decrease may only fit inside the migration-adjusted 36-day window.
      it(`must bound first-report CL decrease from migration-time WV on ${migratedNetwork.name}`, async () => {
        const balanceStats = await fixture.migrateNetworkV3State(migratedNetwork);

        // Step 1. Fix the exact first-report limit for this migrated network.
        // The limit depends on CL balance, so Hoodi-like and Mainnet-like networks
        // must keep different explicit expected values.
        const maxAllowedFirstReportCLDecrease = calcMaxAllowedFirstReportCLBalanceDecrease(
          balanceStats.clValidatorsBalanceAtLastReport,
        );

        expect(maxAllowedFirstReportCLDecrease).to.equal(
          migratedNetwork.expectedBootstrapAdjustedFirstReportCLDecreaseLimit,
        );

        const { accounting, deployStandaloneChecker } =
          await fixture.deployAccountingAndChecker(noWithdrawalVaultBalance);
        const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

        const maxSafeMigrationVaultBalance = maxAllowedFirstReportCLDecrease;
        const excessiveMigrationVaultBalance = maxAllowedFirstReportCLDecrease + 1n;

        // Step 2. Exactly the migration-adjusted limit is still accepted.
        await fixture.setWithdrawalVaultBalance(maxSafeMigrationVaultBalance);
        const maxSafeChecker = await deployStandaloneChecker();
        await maxSafeChecker.migrateBaselineSnapshot();

        const maxSafeReport = buildCLBalanceDecreaseReport({
          preCLValidatorsBalance: balanceStats.clValidatorsBalanceAtLastReport,
          preCLPendingBalance: balanceStats.clPendingBalanceAtLastReport,
          clBalanceDecrease: maxSafeMigrationVaultBalance,
          withdrawalVaultBalance: maxSafeMigrationVaultBalance,
          depositsForReport: balanceStats.depositedForCurrentReport,
        });
        expect(maxSafeReport.timeElapsed).to.equal(oneDay);

        await expect(checkAccountingOracleReport(maxSafeChecker, accountingSigner, maxSafeReport)).not.to.be.reverted;

        // Step 3. One wei more than the migration-adjusted limit must fail.
        await fixture.setWithdrawalVaultBalance(excessiveMigrationVaultBalance);
        const excessiveChecker = await deployStandaloneChecker();
        await excessiveChecker.migrateBaselineSnapshot();

        const excessiveReport = buildCLBalanceDecreaseReport({
          preCLValidatorsBalance: balanceStats.clValidatorsBalanceAtLastReport,
          preCLPendingBalance: balanceStats.clPendingBalanceAtLastReport,
          clBalanceDecrease: excessiveMigrationVaultBalance,
          withdrawalVaultBalance: excessiveMigrationVaultBalance,
          depositsForReport: balanceStats.depositedForCurrentReport,
        });

        await expect(checkAccountingOracleReport(excessiveChecker, accountingSigner, excessiveReport))
          .to.be.revertedWithCustomError(excessiveChecker, "IncorrectCLBalanceDecrease")
          .withArgs(excessiveMigrationVaultBalance, maxAllowedFirstReportCLDecrease);
      });
    }
  });

  context("post-migration withdrawal vault delta", () => {
    // This test fixes the report-to-report WV baseline transition:
    // 1. The first report may transfer part of WV into the Lido buffer.
    // 2. The checker must store the after-transfer WV balance as the next baseline.
    // 3. The next report then counts only the new WV delta as fresh CL withdrawals.
    it("uses first-report after-transfer withdrawal vault balance as baseline for the next report", async () => {
      const balanceStats = await fixture.migrateMainnetLikeV3State();
      const migrationVaultBaseline = ether("100");
      const firstReportFreshCLWithdrawals = ether("10");
      const firstReportVaultBalanceBeforeTransfer = migrationVaultBaseline + firstReportFreshCLWithdrawals;
      const firstReportVaultTransfer = ether("90");
      const firstReportVaultBalanceAfterTransfer = firstReportVaultBalanceBeforeTransfer - firstReportVaultTransfer;
      const secondReportFreshCLWithdrawals = ether("1");
      const secondReportVaultBalanceBeforeTransfer =
        firstReportVaultBalanceAfterTransfer + secondReportFreshCLWithdrawals;

      const { accounting, checker } = await fixture.deployAccountingAndChecker(migrationVaultBaseline);
      const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));
      await checker.migrateBaselineSnapshot();

      // Step 1. Make the WV sequence around the first report explicit:
      //   migration baseline: 100 ETH
      //   before transfer:    110 ETH = 100 ETH baseline + 10 ETH fresh withdrawals
      //   after transfer:      20 ETH = 110 ETH - 90 ETH moved to the Lido buffer
      expect(firstReportVaultBalanceBeforeTransfer).to.equal(ether("110"));
      expect(firstReportVaultBalanceAfterTransfer).to.equal(ether("20"));

      // Step 2. The first report records only the 10 ETH fresh WV delta,
      // then finalizes the checker baseline to the 20 ETH after-transfer balance.
      await fixture.setWithdrawalVaultBalance(firstReportVaultBalanceBeforeTransfer);
      const firstReport = buildCLBalanceDecreaseReport({
        preCLValidatorsBalance: balanceStats.clValidatorsBalanceAtLastReport,
        preCLPendingBalance: balanceStats.clPendingBalanceAtLastReport,
        clBalanceDecrease: firstReportFreshCLWithdrawals,
        withdrawalVaultBalance: firstReportVaultBalanceBeforeTransfer,
        depositsForReport: balanceStats.depositedForCurrentReport,
        withdrawalsVaultTransfer: firstReportVaultTransfer,
      });
      await expect(checkAccountingOracleReport(checker, accountingSigner, firstReport)).not.to.be.reverted;

      expect(secondReportVaultBalanceBeforeTransfer).to.equal(ether("21"));
      expect(secondReportVaultBalanceBeforeTransfer).to.be.lt(firstReportVaultBalanceBeforeTransfer);

      // Step 3. The second report sees 21 ETH in WV. It is below the first
      // report's 110 ETH before-transfer balance, so it can only pass and record
      // 1 ETH of fresh withdrawals if the checker uses the 20 ETH baseline.
      await fixture.setWithdrawalVaultBalance(secondReportVaultBalanceBeforeTransfer);
      const secondReport = buildCLBalanceDecreaseReport({
        preCLValidatorsBalance: firstReport.postCLValidatorsBalance,
        preCLPendingBalance: firstReport.postCLPendingBalance,
        clBalanceDecrease: secondReportFreshCLWithdrawals,
        withdrawalVaultBalance: secondReportVaultBalanceBeforeTransfer,
        withdrawalsVaultTransfer: 0n,
      });
      await expect(checkAccountingOracleReport(checker, accountingSigner, secondReport)).not.to.be.reverted;

      const reportDataCount = await checker.getReportDataCount();
      const secondReportData = await checker.reportData(reportDataCount - 1n);
      expect(secondReportData.clWithdrawals).to.equal(secondReportFreshCLWithdrawals);
    });
  });

  context("36-day CL decrease window after migration", () => {
    // This test fixes the long-window effect of migration:
    // 1. The migration bootstrap writes 57_600 ETH of analytical CL withdrawals
    //    into reportData, which lowers the 36-day decrease limit.
    // 2. WV already present at migration is seeded as the vault baseline.
    //    If the first report sees the same WV, it records zero fresh CL withdrawals.
    // 3. A first-report CL decrease equal to that migrated WV therefore spends
    //    the ordinary 36-day headroom, and the next report may spend only the remainder.
    it("must leave only remaining 36-day CL decrease headroom after first report spends migration-time WV", async () => {
      const balanceStats = await fixture.migrateMainnetLikeV3State();
      const migrationTimeVaultBalance = ether("100000");

      // Step 1. Fix the total 36-day budget after migration bootstrap.
      // Mainnet-like 9M ETH would allow 324,000 ETH at 3.6%, but the
      // analytical 57,600 ETH bootstrap withdrawal reduces it to 321,926.4 ETH.
      const maxCLDecreaseWithoutMigrationBootstrap = calcMaxAllowedWindowCLBalanceDecrease(
        balanceStats.clValidatorsBalanceAtLastReport,
        0n,
        0n,
      );
      const maxCLDecreaseWithMigrationBootstrap = calcMaxAllowedFirstReportCLBalanceDecrease(
        balanceStats.clValidatorsBalanceAtLastReport,
      );
      const remainingHeadroomAfterFirstReport = maxCLDecreaseWithMigrationBootstrap - migrationTimeVaultBalance;

      expect(maxCLDecreaseWithMigrationBootstrap).to.equal(
        maxCLDecreaseWithoutMigrationBootstrap - expectedCLDecreaseLimitLossFromMigrationBootstrap,
      );
      expect(maxCLDecreaseWithMigrationBootstrap).to.equal(ether("321926.4"));
      expect(remainingHeadroomAfterFirstReport).to.equal(ether("221926.4"));

      const { accounting, deployStandaloneChecker } =
        await fixture.deployAccountingAndChecker(migrationTimeVaultBalance);
      const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

      const passFirstPostMigrationReport = async () => {
        const checker = await deployStandaloneChecker();
        await checker.migrateBaselineSnapshot();

        // Step 2. Spend 100,000 ETH of the 36-day budget on the first report.
        // The same 100,000 ETH was already in WV at migration, so the checker
        // records zero fresh CL withdrawals and treats the CL drop as window usage.
        const firstReport = buildCLBalanceDecreaseReport({
          preCLValidatorsBalance: balanceStats.clValidatorsBalanceAtLastReport,
          preCLPendingBalance: balanceStats.clPendingBalanceAtLastReport,
          clBalanceDecrease: migrationTimeVaultBalance,
          withdrawalVaultBalance: migrationTimeVaultBalance,
          depositsForReport: balanceStats.depositedForCurrentReport,
        });
        await expect(checkAccountingOracleReport(checker, accountingSigner, firstReport)).not.to.be.reverted;

        const reportDataCount = await checker.getReportDataCount();
        const firstReportData = await checker.reportData(reportDataCount - 1n);
        expect(firstReportData.clWithdrawals).to.equal(0n);

        return { checker, firstReport };
      };

      // Step 3a. The exact remaining headroom is still accepted.
      const { checker: allowedChecker, firstReport: allowedFirstReport } = await passFirstPostMigrationReport();
      const allowedSecondReport = buildCLBalanceDecreaseReport({
        preCLValidatorsBalance: allowedFirstReport.postCLValidatorsBalance,
        preCLPendingBalance: allowedFirstReport.postCLPendingBalance,
        clBalanceDecrease: remainingHeadroomAfterFirstReport,
        withdrawalVaultBalance: migrationTimeVaultBalance,
      });

      await expect(checkAccountingOracleReport(allowedChecker, accountingSigner, allowedSecondReport)).not.to.be
        .reverted;

      // Step 3b. One wei above the remaining headroom must revert against the
      // same 321,926.4 ETH total window limit.
      const { checker: excessiveChecker, firstReport: excessiveFirstReport } = await passFirstPostMigrationReport();
      const excessiveSecondReport = buildCLBalanceDecreaseReport({
        preCLValidatorsBalance: excessiveFirstReport.postCLValidatorsBalance,
        preCLPendingBalance: excessiveFirstReport.postCLPendingBalance,
        clBalanceDecrease: remainingHeadroomAfterFirstReport + 1n,
        withdrawalVaultBalance: migrationTimeVaultBalance,
      });

      await expect(checkAccountingOracleReport(excessiveChecker, accountingSigner, excessiveSecondReport))
        .to.be.revertedWithCustomError(excessiveChecker, "IncorrectCLBalanceDecrease")
        .withArgs(maxCLDecreaseWithMigrationBootstrap + 1n, maxCLDecreaseWithMigrationBootstrap);
    });
  });
});
