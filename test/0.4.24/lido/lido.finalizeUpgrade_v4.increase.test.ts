import { expect } from "chai";
import { ethers } from "hardhat";

import { OracleReportSanityChecker } from "typechain-types";

import { ether, impersonate } from "lib";

import {
  buildCLBalanceIncreaseReport,
  calcAnnualValidatorsBalanceIncreaseLimit,
  checkAccountingOracleReport,
  mainnetLikeMigratedNetwork,
  oneDay,
  sanityCheckerLimits,
  useFinalizeUpgradeV4Fixture,
} from "./lido.finalizeUpgrade_v4.helpers";

describe("Lido.sol:finalizeUpgrade_v4 CL balance increase sanity check", () => {
  const fixture = useFinalizeUpgradeV4Fixture();
  const lastVaultBalanceAfterTransferSlot = 4n;
  const depositSize = ether("32");
  const noWithdrawalVaultBalance = 0n;
  const migrationRefSlot = 1n;
  const firstPostMigrationReportRefSlot = migrationRefSlot + 1n;
  const appearedEthLimitPerDay = ether(sanityCheckerLimits.appearedEthAmountPerDayLimit.toString());

  const setLastVaultBalanceAfterTransfer = async (checker: OracleReportSanityChecker, value: bigint) => {
    await ethers.provider.send("hardhat_setStorageAt", [
      await checker.getAddress(),
      ethers.toBeHex(lastVaultBalanceAfterTransferSlot, 32),
      ethers.toBeHex(value, 32),
    ]);
  };

  const migrateMainnetLikeStateWithTransientDeposits = async (transientDeposits: bigint) => {
    expect(transientDeposits % depositSize).to.equal(0n);

    const transientValidators = transientDeposits / depositSize;
    return fixture.migrateNetworkV3State({
      ...mainnetLikeMigratedNetwork,
      depositedValidators: mainnetLikeMigratedNetwork.clValidators + transientValidators,
    });
  };

  const moveToFirstPostMigrationReportFrame = async () => {
    await fixture.accountingOracle.mock_setProcessingState(firstPostMigrationReportRefSlot, true, true);
    return fixture.lido.getBalanceStats();
  };

  const deployCheckersAtMigrationFrame = async (count: number) => {
    const { accounting, deployStandaloneChecker } = await fixture.deployAccountingAndChecker(noWithdrawalVaultBalance);
    const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));
    const checkers: OracleReportSanityChecker[] = [];

    for (let i = 0; i < count; ++i) {
      const checker = await deployStandaloneChecker();
      await checker.migrateBaselineSnapshot();
      checkers.push(checker);
    }

    return { accountingSigner, checkers };
  };

  // This test fixes the CL increase risk from an unseeded WV baseline:
  // 1. Choose migration-time WV equal to the first-report APR cap plus 1 wei.
  // 2. Production migration seeds that WV as baseline, so a neutral report passes.
  // 3. A zero WV baseline would count the same WV as fresh CL withdrawals and
  //    make the neutral report look like excessive CL balance increase.
  it("must seed migration-time withdrawal vault balance so unaccounted vault ETH is not interpreted as CL balance increase", async () => {
    // Step 1. Pick the smallest migration-time WV that would exceed the
    // first-report annual-growth gap if it were counted as fresh withdrawals.
    const balanceStats = await fixture.migrateMainnetLikeV3State();
    const maxAllowedValidatorsBalanceIncrease = calcAnnualValidatorsBalanceIncreaseLimit(
      balanceStats.clValidatorsBalanceAtLastReport,
      oneDay,
    );
    const migrationVaultBalance = maxAllowedValidatorsBalanceIncrease + 1n;

    const {
      accounting,
      checker: checkerWithMigratedVaultBaseline,
      deployStandaloneChecker,
    } = await fixture.deployAccountingAndChecker(migrationVaultBalance);
    const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

    // Step 2. The first report is neutral: no CL increase and the same WV balance
    // as at migration. Production baseline seeding must make this pass.
    const firstReportCheck = buildCLBalanceIncreaseReport({
      preCLValidatorsBalance: balanceStats.clValidatorsBalanceAtLastReport,
      preCLPendingBalance: balanceStats.clPendingBalanceAtLastReport,
      clBalanceIncrease: 0n,
      withdrawalVaultBalance: migrationVaultBalance,
      depositsForReport: balanceStats.depositedForCurrentReport,
    });
    expect(firstReportCheck.timeElapsed).to.equal(oneDay);

    // Production path: migrated WV is the baseline, so it is not counted as fresh withdrawals.
    await checkerWithMigratedVaultBaseline.migrateBaselineSnapshot();
    await expect(checkAccountingOracleReport(checkerWithMigratedVaultBaseline, accountingSigner, firstReportCheck)).not
      .to.be.reverted;

    // Step 3. Counterfactual: if migration did not seed the WV baseline, the same
    // WV balance would look like fresh CL withdrawals.
    const checkerWithZeroVaultBaseline = await deployStandaloneChecker();
    await checkerWithZeroVaultBaseline.migrateBaselineSnapshot();
    await setLastVaultBalanceAfterTransfer(checkerWithZeroVaultBaseline, 0n);

    // Step 4. Fresh CL withdrawals lower the checker-side preCLValidatorsBalance.
    // Since the report itself keeps postCLValidatorsBalance unchanged, the same
    // amount appears as artificial CL balance increase and exceeds the APR cap.
    const unseededVaultBaseline = 0n;
    const unseededCLWithdrawals = migrationVaultBalance - unseededVaultBaseline;
    const preCLValidatorsBalanceAfterWithdrawals = firstReportCheck.preCLValidatorsBalance - unseededCLWithdrawals;
    const apparentValidatorsBalanceIncrease =
      firstReportCheck.postCLValidatorsBalance - preCLValidatorsBalanceAfterWithdrawals;
    expect(unseededCLWithdrawals).to.equal(migrationVaultBalance);
    expect(firstReportCheck.postCLValidatorsBalance).to.equal(firstReportCheck.preCLValidatorsBalance);
    expect(apparentValidatorsBalanceIncrease).to.equal(maxAllowedValidatorsBalanceIncrease + 1n);

    await expect(checkAccountingOracleReport(checkerWithZeroVaultBaseline, accountingSigner, firstReportCheck))
      .to.be.revertedWithCustomError(checkerWithZeroVaultBaseline, "IncorrectTotalCLBalanceIncrease")
      .withArgs(maxAllowedValidatorsBalanceIncrease, apparentValidatorsBalanceIncrease);
  });

  context("migrated transient deposits on a mainnet-like network", () => {
    // These cases fix where migrated transient deposits are visible:
    // 1. In the migration frame, preCLPendingBalance is reset to zero and
    //    depositedForCurrentReport is still zero.
    // 2. In the first post-migration report frame, the same transient amount
    //    becomes depositedForCurrentReport.
    // 3. The checker funding input is therefore preCLPendingBalance + deposits.
    for (const transientDeposits of [0n, depositSize, ether("57600"), ether("57632")]) {
      it(`must preserve ${ethers.formatEther(transientDeposits)} migrated transient ETH as preCLPendingBalance plus deposits`, async () => {
        // Step 1. Same frame as migration: the transient amount exists in Lido's
        // depositedSinceLastReport state but is not fed to the checker yet.
        const sameFrameBalanceStats = await migrateMainnetLikeStateWithTransientDeposits(transientDeposits);

        expect(sameFrameBalanceStats.clValidatorsBalanceAtLastReport).to.equal(
          mainnetLikeMigratedNetwork.clValidatorsBalance,
        );
        expect(sameFrameBalanceStats.clPendingBalanceAtLastReport).to.equal(0n);
        expect(sameFrameBalanceStats.depositedSinceLastReport).to.equal(transientDeposits);
        expect(sameFrameBalanceStats.depositedForCurrentReport).to.equal(0n);
        expect(
          sameFrameBalanceStats.clPendingBalanceAtLastReport + sameFrameBalanceStats.depositedForCurrentReport,
        ).to.equal(0n);

        // Step 2. First post-migration report frame: the transient amount becomes
        // depositsForReport and funds the checker together with preCLPendingBalance.
        const nextFrameBalanceStats = await moveToFirstPostMigrationReportFrame();
        expect(nextFrameBalanceStats.clValidatorsBalanceAtLastReport).to.equal(
          mainnetLikeMigratedNetwork.clValidatorsBalance,
        );
        expect(nextFrameBalanceStats.clPendingBalanceAtLastReport).to.equal(0n);
        expect(nextFrameBalanceStats.depositedSinceLastReport).to.equal(transientDeposits);
        expect(nextFrameBalanceStats.depositedForCurrentReport).to.equal(transientDeposits);
        expect(
          nextFrameBalanceStats.clPendingBalanceAtLastReport + nextFrameBalanceStats.depositedForCurrentReport,
        ).to.equal(transientDeposits);
      });
    }

    // These boundary cases fix how migrated transient deposits affect CL increase:
    // 1. Only the part that activates may be counted above the APR cap.
    // 2. The remaining part must stay in postCLPendingBalance.
    // 3. The checker accepts exactly activated deposits plus its APR safety cap and rejects +1 wei.
    for (const { name, transientDeposits, activatedDeposits } of [
      {
        name: "without migrated transient deposits",
        transientDeposits: 0n,
        activatedDeposits: 0n,
      },
      {
        name: "when all migrated transient deposits remain pending",
        transientDeposits: ether("57600"),
        activatedDeposits: 0n,
      },
      {
        name: "when part of migrated transient deposits activates",
        transientDeposits: ether("57600"),
        activatedDeposits: ether("19200"),
      },
      {
        name: "when all migrated transient deposits activate within appeared limit",
        transientDeposits: ether("57600"),
        activatedDeposits: ether("57600"),
      },
    ]) {
      it(`must allow only activated migrated deposits plus APR cap ${name}`, async () => {
        // Step 1. Move from the migration frame into the first report frame where
        // migrated transient deposits are visible as depositedForCurrentReport.
        await migrateMainnetLikeStateWithTransientDeposits(transientDeposits);
        const { accountingSigner, checkers } = await deployCheckersAtMigrationFrame(2);
        const [allowedChecker, excessiveChecker] = checkers;
        const balanceStats = await moveToFirstPostMigrationReportFrame();

        // Step 2. Split migrated deposits into activated ETH and still-pending ETH.
        // The checker adds the APR safety cap on top of the already activated balance.
        const postCLPendingBalance = transientDeposits - activatedDeposits;
        const clBalanceForAprSafetyCap = balanceStats.clValidatorsBalanceAtLastReport + activatedDeposits;
        const aprSafetyCap = calcAnnualValidatorsBalanceIncreaseLimit(clBalanceForAprSafetyCap, oneDay);
        const maxAllowedValidatorsBalanceIncrease = activatedDeposits + aprSafetyCap;

        expect(balanceStats.clValidatorsBalanceAtLastReport).to.equal(mainnetLikeMigratedNetwork.clValidatorsBalance);
        expect(balanceStats.clPendingBalanceAtLastReport).to.equal(0n);
        expect(balanceStats.depositedForCurrentReport).to.equal(transientDeposits);
        expect(activatedDeposits).to.be.lte(appearedEthLimitPerDay);

        // Step 3. Boundary: exactly activated deposits plus APR cap is accepted.
        const maxAllowedReport = buildCLBalanceIncreaseReport({
          preCLValidatorsBalance: balanceStats.clValidatorsBalanceAtLastReport,
          preCLPendingBalance: balanceStats.clPendingBalanceAtLastReport,
          postCLPendingBalance,
          clBalanceIncrease: maxAllowedValidatorsBalanceIncrease,
          withdrawalVaultBalance: noWithdrawalVaultBalance,
          depositsForReport: balanceStats.depositedForCurrentReport,
        });
        await expect(checkAccountingOracleReport(allowedChecker, accountingSigner, maxAllowedReport)).not.to.be
          .reverted;

        // Step 4. One wei above that boundary must fail as excessive CL balance increase.
        const excessiveReport = buildCLBalanceIncreaseReport({
          preCLValidatorsBalance: balanceStats.clValidatorsBalanceAtLastReport,
          preCLPendingBalance: balanceStats.clPendingBalanceAtLastReport,
          postCLPendingBalance,
          clBalanceIncrease: maxAllowedValidatorsBalanceIncrease + 1n,
          withdrawalVaultBalance: noWithdrawalVaultBalance,
          depositsForReport: balanceStats.depositedForCurrentReport,
        });
        await expect(checkAccountingOracleReport(excessiveChecker, accountingSigner, excessiveReport))
          .to.be.revertedWithCustomError(excessiveChecker, "IncorrectTotalCLBalanceIncrease")
          .withArgs(maxAllowedValidatorsBalanceIncrease, maxAllowedValidatorsBalanceIncrease + 1n);
      });
    }

    // This boundary test fixes that the cap applies to activated migrated deposits,
    // not to the raw migrated transient deposits amount:
    // 1. Put more than 57,600 ETH of migrated transient deposits into the first frame.
    // 2. A report activating exactly 57,600 ETH is accepted.
    // 3. A report activating 57,600 ETH + 1 wei is rejected.
    it("must cap activated migrated deposits when transient deposits exceed the appeared ETH limit", async () => {
      const transientDeposits = appearedEthLimitPerDay + depositSize;
      const maxAllowedActivatedDeposits = appearedEthLimitPerDay;
      const excessiveActivatedDeposits = maxAllowedActivatedDeposits + 1n;

      // Step 1. Move 57,632 ETH of migrated transient deposits into depositsForReport.
      await migrateMainnetLikeStateWithTransientDeposits(transientDeposits);
      const { accountingSigner, checkers } = await deployCheckersAtMigrationFrame(2);
      const [allowedChecker, excessiveChecker] = checkers;
      const balanceStats = await moveToFirstPostMigrationReportFrame();

      expect(balanceStats.depositedForCurrentReport).to.equal(transientDeposits);

      // Step 2. The raw deposits amount is above the appeared limit, but only
      // exactly 57,600 ETH activates; the remaining 32 ETH stays pending.
      const maxAllowedReport = buildCLBalanceIncreaseReport({
        preCLValidatorsBalance: balanceStats.clValidatorsBalanceAtLastReport,
        preCLPendingBalance: balanceStats.clPendingBalanceAtLastReport,
        postCLPendingBalance: transientDeposits - maxAllowedActivatedDeposits,
        clBalanceIncrease: maxAllowedActivatedDeposits,
        withdrawalVaultBalance: noWithdrawalVaultBalance,
        depositsForReport: balanceStats.depositedForCurrentReport,
      });
      await expect(checkAccountingOracleReport(allowedChecker, accountingSigner, maxAllowedReport)).not.to.be.reverted;

      // Step 3. Activating one wei above the appeared limit fails before APR can
      // expand the CL balance increase window.
      const excessiveReport = buildCLBalanceIncreaseReport({
        preCLValidatorsBalance: balanceStats.clValidatorsBalanceAtLastReport,
        preCLPendingBalance: balanceStats.clPendingBalanceAtLastReport,
        postCLPendingBalance: transientDeposits - excessiveActivatedDeposits,
        clBalanceIncrease: excessiveActivatedDeposits,
        withdrawalVaultBalance: noWithdrawalVaultBalance,
        depositsForReport: balanceStats.depositedForCurrentReport,
      });
      await expect(checkAccountingOracleReport(excessiveChecker, accountingSigner, excessiveReport))
        .to.be.revertedWithCustomError(excessiveChecker, "IncorrectTotalActivatedBalance")
        .withArgs(appearedEthLimitPerDay, excessiveActivatedDeposits);
    });
  });
});
