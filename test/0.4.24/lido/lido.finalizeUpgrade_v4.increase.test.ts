import { expect } from "chai";
import { ethers } from "hardhat";

import { OracleReportSanityChecker } from "typechain-types";

import { ether, impersonate } from "lib";

import {
  buildCLBalanceIncreaseReport,
  calcAnnualValidatorsBalanceIncreaseLimit,
  checkAccountingOracleReport,
  initialValue,
  mainnetLikeMigratedNetwork,
  maxWithdrawalsByChurnLimitPerReport,
  useFinalizeUpgradeV4Fixture,
} from "./lido.finalizeUpgrade_v4.helpers";

describe("Lido.sol:finalizeUpgrade_v4 CL balance increase sanity check invariants", () => {
  const fixture = useFinalizeUpgradeV4Fixture();
  const lastVaultBalanceAfterTransferSlot = 4n;

  const setLastVaultBalanceAfterTransfer = async (checker: OracleReportSanityChecker, value: bigint) => {
    await ethers.provider.send("hardhat_setStorageAt", [
      await checker.getAddress(),
      ethers.toBeHex(lastVaultBalanceAfterTransferSlot, 32),
      ethers.toBeHex(value, 32),
    ]);
  };

  context("migrated deposits", () => {
    it("keeps depositedForCurrentReport zero in the migration frame and seeds zero checker bootstrap deposits", async () => {
      const migratedCLValidators = mainnetLikeMigratedNetwork.clValidators;
      const migratedCLValidatorsBalance = mainnetLikeMigratedNetwork.clValidatorsBalance;

      // Simulate validators deposited before migration, but not yet visible as CL validators.
      const transientDepositedValidators = 1_800n;
      const migratedDepositedValidators = migratedCLValidators + transientDepositedValidators;
      const migratedDepositsForReport = transientDepositedValidators * ether("32");
      expect(migratedDepositsForReport).to.equal(maxWithdrawalsByChurnLimitPerReport);

      // In the migration frame Lido keeps transient deposits in depositedSinceLastReport,
      // while depositedForCurrentReport remains zero until the next oracle frame.
      const balanceStats = await fixture.migrateV3State({
        bufferedEther: initialValue,
        depositedValidators: migratedDepositedValidators,
        clValidatorsBalance: migratedCLValidatorsBalance,
        clValidators: migratedCLValidators,
      });
      expect(balanceStats.depositedSinceLastReport).to.equal(migratedDepositsForReport);
      expect(balanceStats.depositedForCurrentReport).to.equal(0n);

      const { deployChecker } = await fixture.deployAccountingAndChecker(0n);
      const migratedBaselineChecker = await deployChecker();

      // Checker bootstrap uses Lido's current report frame, so migrated deposits are not
      // included as checker deposits yet; only the synthetic churn-limited flow is seeded.
      await expect(migratedBaselineChecker.migrateBaselineSnapshot())
        .to.emit(migratedBaselineChecker, "BaselineSnapshotMigrated")
        .withArgs(migratedCLValidatorsBalance, 0n, maxWithdrawalsByChurnLimitPerReport);

      // Two snapshots are created: the historical baseline and the bootstrap flow snapshot.
      const baselineSnapshot = await migratedBaselineChecker.reportData(0n);
      const bootstrapFlowSnapshot = await migratedBaselineChecker.reportData(1n);
      expect(baselineSnapshot.clBalance).to.equal(migratedCLValidatorsBalance);
      expect(baselineSnapshot.deposits).to.equal(0n);
      expect(baselineSnapshot.clWithdrawals).to.equal(0n);
      expect(bootstrapFlowSnapshot.clBalance).to.equal(migratedCLValidatorsBalance);
      expect(bootstrapFlowSnapshot.deposits).to.equal(0n);
      expect(bootstrapFlowSnapshot.clWithdrawals).to.equal(maxWithdrawalsByChurnLimitPerReport);
    });

    it("requires migrated transient deposits to fund validators increase while migrated pending balance stays zero", async () => {
      const migratedCLValidators = mainnetLikeMigratedNetwork.clValidators;
      const migratedCLValidatorsBalance = mainnetLikeMigratedNetwork.clValidatorsBalance;

      // Use a non-trivial transient deposit amount that is much larger than the daily APR cap.
      const transientDepositedValidators = 1_000n;
      const migratedDepositedValidators = migratedCLValidators + transientDepositedValidators;
      const migratedDepositsForReport = transientDepositedValidators * ether("32");
      expect(migratedDepositsForReport).to.equal(ether("32000"));

      // Migration stores no pending balance, but preserves the transient deposit amount.
      const balanceStatsAtMigration = await fixture.migrateV3State({
        bufferedEther: initialValue,
        depositedValidators: migratedDepositedValidators,
        clValidatorsBalance: migratedCLValidatorsBalance,
        clValidators: migratedCLValidators,
      });
      expect(balanceStatsAtMigration.clPendingBalanceAtLastReport).to.equal(0n);
      expect(balanceStatsAtMigration.depositedSinceLastReport).to.equal(migratedDepositsForReport);
      expect(balanceStatsAtMigration.depositedForCurrentReport).to.equal(0n);

      const { accounting, deployChecker } = await fixture.deployAccountingAndChecker(0n);
      const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

      const migratedBaselineChecker = await deployChecker();
      await expect(migratedBaselineChecker.migrateBaselineSnapshot())
        .to.emit(migratedBaselineChecker, "BaselineSnapshotMigrated")
        .withArgs(migratedCLValidatorsBalance, 0n, maxWithdrawalsByChurnLimitPerReport);

      // Move into the next oracle frame: the same migrated transient deposits now become
      // depositedForCurrentReport and may fund the validators balance increase.
      await fixture.accountingOracle.mock_setProcessingState(2, true, true);
      const balanceStatsAtFirstReport = await fixture.lido.getBalanceStats();
      expect(balanceStatsAtFirstReport.clPendingBalanceAtLastReport).to.equal(0n);
      expect(balanceStatsAtFirstReport.depositedSinceLastReport).to.equal(migratedDepositsForReport);
      expect(balanceStatsAtFirstReport.depositedForCurrentReport).to.equal(migratedDepositsForReport);

      const preCLValidatorsBalance = balanceStatsAtFirstReport.clValidatorsBalanceAtLastReport;
      const preCLPendingBalance = balanceStatsAtFirstReport.clPendingBalanceAtLastReport;
      const depositsForReport = balanceStatsAtFirstReport.depositedForCurrentReport;
      const reportFundedByMigratedDeposits = buildCLBalanceIncreaseReport({
        preCLValidatorsBalance,
        preCLPendingBalance,
        clBalanceIncrease: migratedDepositsForReport,
        depositsForReport,
      });

      // Positive path: activation is accepted because Accounting passes migrated deposits
      // into the report, even though migrated pending balance is always zero.
      await expect(
        checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, reportFundedByMigratedDeposits),
      ).not.to.be.reverted;

      // Counterfactual: the same activation without depositsForReport is checked only
      // against APR and should be rejected.
      const reportWithoutMigratedDeposits = {
        ...reportFundedByMigratedDeposits,
        depositsForReport: 0n,
      };
      const maxAllowedValidatorsBalanceIncreaseWithoutDeposits = calcAnnualValidatorsBalanceIncreaseLimit(
        preCLValidatorsBalance,
        reportWithoutMigratedDeposits.timeElapsed,
      );

      const checkerWithoutMigratedDeposits = await deployChecker();
      await checkerWithoutMigratedDeposits.migrateBaselineSnapshot();
      await expect(
        checkAccountingOracleReport(checkerWithoutMigratedDeposits, accountingSigner, reportWithoutMigratedDeposits),
      )
        .to.be.revertedWithCustomError(checkerWithoutMigratedDeposits, "IncorrectTotalCLBalanceIncrease")
        .withArgs(maxAllowedValidatorsBalanceIncreaseWithoutDeposits, migratedDepositsForReport);
    });
  });

  context("migration-time withdrawal vault balance", () => {
    it("does not treat migration-time withdrawal vault balance as first-report CL withdrawals", async () => {
      const migrationVaultBalance = ether("3000");
      const balanceStats = await fixture.migrateMainnetLikeV3State();

      // deployAccountingAndChecker seeds the checker with the vault balance that exists
      // at migration time; it must become the baseline, not a fresh withdrawal.
      const { accounting, deployChecker } = await fixture.deployAccountingAndChecker(migrationVaultBalance);
      const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

      // First report has no CL change and the same vault balance as at migration.
      const preCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
      const preCLPendingBalance = balanceStats.clPendingBalanceAtLastReport;
      const depositsForReport = balanceStats.depositedForCurrentReport;
      const firstReportCheck = buildCLBalanceIncreaseReport({
        preCLValidatorsBalance,
        preCLPendingBalance,
        clBalanceIncrease: 0n,
        withdrawalVaultBalance: migrationVaultBalance,
        depositsForReport,
      });

      const migratedBaselineChecker = await deployChecker();
      await migratedBaselineChecker.migrateBaselineSnapshot();
      await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, firstReportCheck)).not.to.be
        .reverted;
    });

    it("counterfactual: missing migration-time vault baseline triggers the CL increase check against APR cap only", async () => {
      const migrationVaultBalance = ether("3000");
      const balanceStats = await fixture.migrateMainnetLikeV3State();
      const { accounting, deployChecker } = await fixture.deployAccountingAndChecker(migrationVaultBalance);
      const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

      // Keep the real first-report payload: no CL increase, no migrated deposits,
      // and the vault still contains only the migration-time balance.
      const preCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
      const preCLPendingBalance = balanceStats.clPendingBalanceAtLastReport;
      const depositsForReport = balanceStats.depositedForCurrentReport;
      expect(preCLPendingBalance).to.equal(0n);
      expect(depositsForReport).to.equal(0n);
      const firstReportCheck = buildCLBalanceIncreaseReport({
        preCLValidatorsBalance,
        preCLPendingBalance,
        clBalanceIncrease: 0n,
        withdrawalVaultBalance: migrationVaultBalance,
        depositsForReport,
      });

      const zeroBaselineChecker = await deployChecker();
      await zeroBaselineChecker.migrateBaselineSnapshot();

      // Break only the private vault baseline to model a migration that forgot to seed it.
      await setLastVaultBalanceAfterTransfer(zeroBaselineChecker, 0n);

      // With a zero baseline, migration-time vault ETH looks like fresh CL withdrawals,
      // which inflates the apparent validators balance increase.
      const clWithdrawalsIfMigrationVaultBalanceWasNotSeeded = firstReportCheck.withdrawalVaultBalance - 0n;
      const apparentValidatorsBalanceIncrease = clWithdrawalsIfMigrationVaultBalanceWasNotSeeded;
      expect(clWithdrawalsIfMigrationVaultBalanceWasNotSeeded).to.equal(firstReportCheck.withdrawalVaultBalance);

      // The inflated increase is far above the one-day APR allowance, so the report reverts.
      const maxAllowedValidatorsBalanceIncrease = calcAnnualValidatorsBalanceIncreaseLimit(
        preCLValidatorsBalance,
        firstReportCheck.timeElapsed,
      );
      expect(maxAllowedValidatorsBalanceIncrease).to.be.lessThan(apparentValidatorsBalanceIncrease);

      await expect(checkAccountingOracleReport(zeroBaselineChecker, accountingSigner, firstReportCheck))
        .to.be.revertedWithCustomError(zeroBaselineChecker, "IncorrectTotalCLBalanceIncrease")
        .withArgs(maxAllowedValidatorsBalanceIncrease, apparentValidatorsBalanceIncrease);
    });
  });
});
