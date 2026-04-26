import { expect } from "chai";
import { MaxUint256 } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  Accounting,
  AccountingOracle__MockForStakingRouter,
  Burner__MockForSanityChecker,
  Lido__HarnessForFinalizeUpgradeV4,
  LidoLocator,
  OracleReportSanityChecker,
} from "typechain-types";

import { ether, getStorageAtPositionAsUint128Pair, impersonate, proxify } from "lib";
import { TOTAL_BASIS_POINTS } from "lib/constants";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy/locator";
import { Snapshot } from "test/suite";

const sanityCheckerLimits = {
  exitedEthAmountPerDayLimit: 57_600n,
  appearedEthAmountPerDayLimit: 57_600n,
  annualBalanceIncreaseBPLimit: 1_000n,
  simulatedShareRateDeviationBPLimit: 250n,
  maxBalanceExitRequestedPerReportInEth: 19_200n,
  maxEffectiveBalanceWeightWCType01: 32n,
  maxEffectiveBalanceWeightWCType02: 2_048n,
  maxItemsPerExtraDataTransaction: 8n,
  maxNodeOperatorsPerExtraDataItem: 24n,
  requestTimestampMargin: 128n,
  maxPositiveTokenRebase: 5_000_000n,
  maxCLBalanceDecreaseBP: 360n,
  clBalanceOraclesErrorUpperBPLimit: 50n,
  consolidationEthAmountPerDayLimit: 93_375n,
  exitedValidatorEthAmountLimit: 32n,
  externalPendingBalanceCapEth: 300n,
};

type AccountingOracleReportCheck = {
  timeElapsed: bigint;
  preCLValidatorsBalance: bigint;
  preCLPendingBalance: bigint;
  postCLValidatorsBalance: bigint;
  postCLPendingBalance: bigint;
  withdrawalVaultBalance: bigint;
  elRewardsVaultBalance: bigint;
  sharesRequestedToBurn: bigint;
  depositsSinceLastReport: bigint;
  withdrawalsVaultTransfer: bigint;
};

type V3MigrationState = {
  bufferedEther: bigint;
  depositedValidators: bigint;
  clValidatorsBalance: bigint;
  clValidators: bigint;
};

type MigratedNetworkScenario = {
  name: string;
  depositedValidators: bigint;
  clValidators: bigint;
  clValidatorsBalance: bigint;
  expectedMaxSafeMigrationWithdrawalVaultBalance: bigint;
};

describe("Lido.sol:finalizeUpgrade_v4", () => {
  let deployer: HardhatEthersSigner;
  let withdrawalVault: HardhatEthersSigner;
  let elRewardsVault: HardhatEthersSigner;

  let impl: Lido__HarnessForFinalizeUpgradeV4;
  let lido: Lido__HarnessForFinalizeUpgradeV4;
  let accountingOracle: AccountingOracle__MockForStakingRouter;
  let locator: LidoLocator;

  const initialValue = 1n;
  const finalizeVersion = 4n;
  const oneDay = 24n * 60n * 60n;
  const lastVaultBalanceAfterTransferSlot = 4n;
  const maxWithdrawalsByChurnLimitPerReport = ether("57600");
  const expectedCLDecreaseLimitLossFromMigrationBootstrap =
    (maxWithdrawalsByChurnLimitPerReport * sanityCheckerLimits.maxCLBalanceDecreaseBP) / TOTAL_BASIS_POINTS;
  const annualBalanceIncreaseDenominator = 365n * oneDay * TOTAL_BASIS_POINTS;
  const hoodiLikeMigratedNetwork = {
    name: "Hoodi-like 2M ETH migrated network",
    depositedValidators: 62_500n,
    clValidators: 62_500n,
    clValidatorsBalance: ether("2000000"),
    expectedMaxSafeMigrationWithdrawalVaultBalance: ether("69926.4"),
  };
  const mainnetLikeMigratedNetwork = {
    name: "Mainnet-like 9M ETH migrated network",
    depositedValidators: 281_250n,
    clValidators: 281_250n,
    clValidatorsBalance: ether("9000000"),
    expectedMaxSafeMigrationWithdrawalVaultBalance: ether("321926.4"),
  };

  let originalState: string;

  before(async () => {
    [deployer, withdrawalVault, elRewardsVault] = await ethers.getSigners();
    impl = await ethers.deployContract("Lido__HarnessForFinalizeUpgradeV4", {
      signer: deployer,
    });
    [lido] = await proxify({ impl, admin: deployer });
    accountingOracle = await ethers.deployContract("AccountingOracle__MockForStakingRouter", deployer);
    locator = await deployLidoLocator({ lido, accountingOracle }, deployer);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(originalState));

  it("Reverts if not initialized", async () => {
    await expect(lido.finalizeUpgrade_v4()).to.be.revertedWith("NOT_INITIALIZED");
  });

  context("initialized", () => {
    before(async () => {
      const latestBlock = BigInt(await time.latestBlock());

      await lido.connect(deployer).harness_initialize_v3(locator, { value: initialValue });

      expect(await impl.getInitializationBlock()).to.equal(MaxUint256);
      expect(await lido.getInitializationBlock()).to.equal(latestBlock + 1n);
    });

    it("Reverts if contract version does not equal 3", async () => {
      const unexpectedVersion = 1n;
      await lido.harness_setContractVersion(unexpectedVersion);
      await expect(lido.finalizeUpgrade_v4()).to.be.revertedWith("UNEXPECTED_CONTRACT_VERSION");
    });

    it("Sets contract version to 4", async () => {
      await expect(lido.finalizeUpgrade_v4()).to.emit(lido, "ContractVersionSet").withArgs(finalizeVersion);
      expect(await lido.getContractVersion()).to.equal(finalizeVersion);
    });

    it("Reverts upgrade if occurred before report", async () => {
      // simulate no report
      await accountingOracle.mock_setProcessingState(1, false, false);
      await expect(lido.finalizeUpgrade_v4()).to.be.revertedWith("NO_REPORT");
    });

    it("Migrates storage successfully after report and before next frame", async () => {
      // simulate report
      await accountingOracle.mock_setProcessingState(1, true, true);
      const { low: bufferedEther, high: depositedValidators } = await getStorageAtPositionAsUint128Pair(
        lido,
        "lido.Lido.bufferedEtherAndDepositedValidators",
      );
      const { low: clBalance, high: clValidators } = await getStorageAtPositionAsUint128Pair(
        lido,
        "lido.Lido.clBalanceAndClValidators",
      );

      const depositedBalance = (depositedValidators - clValidators) * ether("32");

      await expect(lido.finalizeUpgrade_v4()).to.not.be.reverted;

      expect(await lido.getBufferedEther()).to.equal(bufferedEther);
      expect((await lido.getBeaconStat()).beaconBalance).to.equal(clBalance);
      expect((await lido.getBeaconStat()).beaconValidators).to.equal(depositedValidators);
      expect((await lido.getBeaconStat()).depositedValidators).to.equal(depositedValidators);
      expect((await lido.getBalanceStats()).clValidatorsBalanceAtLastReport).to.equal(clBalance);
      expect((await lido.getBalanceStats()).clPendingBalanceAtLastReport).to.equal(0);
      expect((await lido.getBalanceStats()).depositedSinceLastReport).to.equal(depositedBalance);
      expect((await lido.getBalanceStats()).depositedForCurrentReport).to.equal(0);
    });

    context("OracleReportSanityChecker migration on migrated Lido stats", () => {
      const checkAccountingOracleReport = (
        checker: OracleReportSanityChecker,
        accountingSigner: HardhatEthersSigner,
        report: AccountingOracleReportCheck,
      ) =>
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(
            report.timeElapsed,
            report.preCLValidatorsBalance,
            report.preCLPendingBalance,
            report.postCLValidatorsBalance,
            report.postCLPendingBalance,
            report.withdrawalVaultBalance,
            report.elRewardsVaultBalance,
            report.sharesRequestedToBurn,
            report.depositsSinceLastReport,
            report.withdrawalsVaultTransfer,
          );

      const migrateV3State = async (migrationState: V3MigrationState) => {
        const { bufferedEther, depositedValidators, clValidatorsBalance, clValidators } = migrationState;
        const expectedMigratedCLPendingBalance = 0n;
        const expectedMigratedDepositsSinceLastReport = (depositedValidators - clValidators) * ether("32");

        await accountingOracle.mock_setProcessingState(1, true, true);
        await lido.harness_setV3BalanceState(bufferedEther, depositedValidators, clValidatorsBalance, clValidators);

        await expect(lido.finalizeUpgrade_v4()).not.to.be.reverted;

        const balanceStats = await lido.getBalanceStats();
        expect(balanceStats.clValidatorsBalanceAtLastReport).to.equal(clValidatorsBalance);
        expect(balanceStats.clPendingBalanceAtLastReport).to.equal(expectedMigratedCLPendingBalance);
        expect(balanceStats.depositedSinceLastReport).to.equal(expectedMigratedDepositsSinceLastReport);

        return balanceStats;
      };

      const migrateNetworkV3State = async (migratedNetwork: MigratedNetworkScenario) =>
        migrateV3State({
          bufferedEther: initialValue,
          depositedValidators: migratedNetwork.depositedValidators,
          clValidatorsBalance: migratedNetwork.clValidatorsBalance,
          clValidators: migratedNetwork.clValidators,
        });

      const migrateMainnetLikeV3State = async () => migrateNetworkV3State(mainnetLikeMigratedNetwork);

      const deployAccountingAndChecker = async (withdrawalVaultBalance: bigint) => {
        await setBalance(withdrawalVault.address, withdrawalVaultBalance);
        await setBalance(elRewardsVault.address, 0n);

        const burner = (await ethers.deployContract("Burner__MockForSanityChecker")) as Burner__MockForSanityChecker;
        const accountingImpl = await ethers.deployContract("Accounting", [
          await locator.getAddress(),
          await lido.getAddress(),
        ]);
        const accountingProxy = await ethers.deployContract("OssifiableProxy", [
          await accountingImpl.getAddress(),
          deployer.address,
          new Uint8Array(),
        ]);
        const accounting = (await ethers.getContractAt(
          "Accounting",
          await accountingProxy.getAddress(),
          deployer,
        )) as Accounting;

        await updateLidoLocatorImplementation(
          await locator.getAddress(),
          {
            accounting: await accounting.getAddress(),
            withdrawalVault: withdrawalVault.address,
            elRewardsVault: elRewardsVault.address,
            burner: await burner.getAddress(),
          },
          undefined,
          deployer,
        );

        const deployChecker = async () =>
          (await ethers.deployContract("OracleReportSanityChecker", [
            await locator.getAddress(),
            await accounting.getAddress(),
            deployer.address,
            sanityCheckerLimits,
          ])) as OracleReportSanityChecker;

        return { accounting, deployChecker };
      };

      const setLastVaultBalanceAfterTransfer = async (checker: OracleReportSanityChecker, value: bigint) => {
        await ethers.provider.send("hardhat_setStorageAt", [
          await checker.getAddress(),
          ethers.toBeHex(lastVaultBalanceAfterTransferSlot, 32),
          ethers.toBeHex(value, 32),
        ]);
      };

      const calcMaxAllowedWindowCLBalanceDecrease = (
        baselineCLBalance: bigint,
        depositsInsideWindow: bigint,
        clWithdrawalsInsideWindow: bigint,
      ) =>
        ((baselineCLBalance + depositsInsideWindow - clWithdrawalsInsideWindow) *
          sanityCheckerLimits.maxCLBalanceDecreaseBP) /
        TOTAL_BASIS_POINTS;

      const calcMaxAllowedFirstReportCLBalanceDecrease = (preCLValidatorsBalance: bigint) =>
        calcMaxAllowedWindowCLBalanceDecrease(preCLValidatorsBalance, 0n, maxWithdrawalsByChurnLimitPerReport);

      const prepareCheckerAfterFirstReportWithMigrationVaultBalance = async (
        migratedNetwork: MigratedNetworkScenario,
        withdrawalVaultBalanceAtMigration: bigint,
      ) => {
        const balanceStats = await migrateNetworkV3State(migratedNetwork);
        const { accounting, deployChecker } = await deployAccountingAndChecker(withdrawalVaultBalanceAtMigration);
        const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

        const bootstrapAdjustedFullWindowCLDecreaseLimit = calcMaxAllowedFirstReportCLBalanceDecrease(
          balanceStats.clValidatorsBalanceAtLastReport,
        );
        const firstReportTimeElapsed = oneDay;
        const firstReportPreCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
        const firstReportPreCLPendingBalance = balanceStats.clPendingBalanceAtLastReport;
        const firstReportCLValidatorsBalanceDecrease = withdrawalVaultBalanceAtMigration;
        const firstReportPostCLValidatorsBalance =
          firstReportPreCLValidatorsBalance - firstReportCLValidatorsBalanceDecrease;
        const firstReportPostCLPendingBalance = firstReportPreCLPendingBalance;
        const firstReportWithdrawalVaultBalance = withdrawalVaultBalanceAtMigration;
        const firstReportELRewardsVaultBalance = 0n;
        const firstReportSharesRequestedToBurn = 0n;
        const firstReportDepositsSinceLastReport = balanceStats.depositedSinceLastReport;
        const firstReportWithdrawalsVaultTransfer = 0n;
        const firstReportCheck = {
          timeElapsed: firstReportTimeElapsed,
          preCLValidatorsBalance: firstReportPreCLValidatorsBalance,
          preCLPendingBalance: firstReportPreCLPendingBalance,
          postCLValidatorsBalance: firstReportPostCLValidatorsBalance,
          postCLPendingBalance: firstReportPostCLPendingBalance,
          withdrawalVaultBalance: firstReportWithdrawalVaultBalance,
          elRewardsVaultBalance: firstReportELRewardsVaultBalance,
          sharesRequestedToBurn: firstReportSharesRequestedToBurn,
          depositsSinceLastReport: firstReportDepositsSinceLastReport,
          withdrawalsVaultTransfer: firstReportWithdrawalsVaultTransfer,
        };

        const migratedBaselineChecker = await deployChecker();
        await migratedBaselineChecker.migrateBaselineSnapshot();
        await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, firstReportCheck)).not.to.be
          .reverted;

        return {
          migratedBaselineChecker,
          accountingSigner,
          bootstrapAdjustedFullWindowCLDecreaseLimit,
          migrationTimeCLDecrease: firstReportCLValidatorsBalanceDecrease,
          nextReportPreCLValidatorsBalance: firstReportPostCLValidatorsBalance,
          nextReportPreCLPendingBalance: firstReportPostCLPendingBalance,
          nextReportWithdrawalVaultBalance: firstReportWithdrawalVaultBalance,
        };
      };

      context("withdrawal vault migration baseline", () => {
        it("does not treat migration-time withdrawal vault balance as first-report CL withdrawals", async () => {
          const migrationVaultBalance = ether("3000");
          const balanceStats = await migrateMainnetLikeV3State();
          const { accounting, deployChecker } = await deployAccountingAndChecker(migrationVaultBalance);
          const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

          const timeElapsed = oneDay;
          const preCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
          const preCLPendingBalance = balanceStats.clPendingBalanceAtLastReport;
          const postCLValidatorsBalance = preCLValidatorsBalance;
          const postCLPendingBalance = preCLPendingBalance;
          const withdrawalVaultBalance = migrationVaultBalance;
          const elRewardsVaultBalance = 0n;
          const sharesRequestedToBurn = 0n;
          const depositsSinceLastReport = balanceStats.depositedSinceLastReport;
          const withdrawalsVaultTransfer = 0n;
          const firstReportCheck = {
            timeElapsed,
            preCLValidatorsBalance,
            preCLPendingBalance,
            postCLValidatorsBalance,
            postCLPendingBalance,
            withdrawalVaultBalance,
            elRewardsVaultBalance,
            sharesRequestedToBurn,
            depositsSinceLastReport,
            withdrawalsVaultTransfer,
          };

          const migratedBaselineChecker = await deployChecker();
          await migratedBaselineChecker.migrateBaselineSnapshot();
          await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, firstReportCheck)).not.to
            .be.reverted;
        });

        it("control: zero vault baseline would treat the same vault balance as CL withdrawals", async () => {
          const migrationVaultBalance = ether("3000");
          const balanceStats = await migrateMainnetLikeV3State();
          const { accounting, deployChecker } = await deployAccountingAndChecker(migrationVaultBalance);
          const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

          const timeElapsed = oneDay;
          const preCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
          const preCLPendingBalance = balanceStats.clPendingBalanceAtLastReport;
          const postCLValidatorsBalance = preCLValidatorsBalance;
          const postCLPendingBalance = preCLPendingBalance;
          const withdrawalVaultBalance = migrationVaultBalance;
          const elRewardsVaultBalance = 0n;
          const sharesRequestedToBurn = 0n;
          const depositsSinceLastReport = balanceStats.depositedSinceLastReport;
          const withdrawalsVaultTransfer = 0n;
          const firstReportCheck = {
            timeElapsed,
            preCLValidatorsBalance,
            preCLPendingBalance,
            postCLValidatorsBalance,
            postCLPendingBalance,
            withdrawalVaultBalance,
            elRewardsVaultBalance,
            sharesRequestedToBurn,
            depositsSinceLastReport,
            withdrawalsVaultTransfer,
          };

          const zeroBaselineChecker = await deployChecker();
          await zeroBaselineChecker.migrateBaselineSnapshot();
          await setLastVaultBalanceAfterTransfer(zeroBaselineChecker, 0n);

          const maxAllowedValidatorsBalanceIncrease =
            (preCLValidatorsBalance * sanityCheckerLimits.annualBalanceIncreaseBPLimit * timeElapsed) /
            annualBalanceIncreaseDenominator;

          await expect(checkAccountingOracleReport(zeroBaselineChecker, accountingSigner, firstReportCheck))
            .to.be.revertedWithCustomError(zeroBaselineChecker, "IncorrectTotalCLBalanceIncrease")
            .withArgs(maxAllowedValidatorsBalanceIncrease, withdrawalVaultBalance);
        });
      });

      context("first-report CL decrease with migration-time vault balance", () => {
        it("treats migration-time withdrawal vault balance as CL loss", async () => {
          const withdrawalVaultBalanceAtMigration = ether("400000");
          const withdrawalVaultBalanceAtFirstReportRefSlot = withdrawalVaultBalanceAtMigration;
          const clWithdrawalsSinceMigration =
            withdrawalVaultBalanceAtFirstReportRefSlot - withdrawalVaultBalanceAtMigration;
          const clValidatorsBalanceDecrease = withdrawalVaultBalanceAtMigration;
          const balanceStats = await migrateMainnetLikeV3State();
          const { accounting, deployChecker } = await deployAccountingAndChecker(withdrawalVaultBalanceAtMigration);
          const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

          const timeElapsed = oneDay;
          const preCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
          const preCLPendingBalance = balanceStats.clPendingBalanceAtLastReport;
          const postCLValidatorsBalance = preCLValidatorsBalance - clValidatorsBalanceDecrease;
          const postCLPendingBalance = preCLPendingBalance;
          const withdrawalVaultBalance = withdrawalVaultBalanceAtFirstReportRefSlot;
          const elRewardsVaultBalance = 0n;
          const sharesRequestedToBurn = 0n;
          const depositsSinceLastReport = balanceStats.depositedSinceLastReport;
          const withdrawalsVaultTransfer = 0n;
          expect(clWithdrawalsSinceMigration).to.equal(0n);

          const firstReportCheck = {
            timeElapsed,
            preCLValidatorsBalance,
            preCLPendingBalance,
            postCLValidatorsBalance,
            postCLPendingBalance,
            withdrawalVaultBalance,
            elRewardsVaultBalance,
            sharesRequestedToBurn,
            depositsSinceLastReport,
            withdrawalsVaultTransfer,
          };

          const migratedBaselineChecker = await deployChecker();
          await migratedBaselineChecker.migrateBaselineSnapshot();

          const maxAllowedCLBalanceDecrease = calcMaxAllowedFirstReportCLBalanceDecrease(preCLValidatorsBalance);

          await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, firstReportCheck))
            .to.be.revertedWithCustomError(migratedBaselineChecker, "IncorrectCLBalanceDecrease")
            .withArgs(clValidatorsBalanceDecrease, maxAllowedCLBalanceDecrease);
        });

        it("control: zero vault baseline would treat the same decrease as CL withdrawals", async () => {
          const withdrawalVaultBalanceAtMigration = ether("400000");
          const withdrawalVaultBalanceAtFirstReportRefSlot = withdrawalVaultBalanceAtMigration;
          const clValidatorsBalanceDecrease = withdrawalVaultBalanceAtMigration;
          const balanceStats = await migrateMainnetLikeV3State();
          const { accounting, deployChecker } = await deployAccountingAndChecker(withdrawalVaultBalanceAtMigration);
          const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

          const timeElapsed = oneDay;
          const preCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
          const preCLPendingBalance = balanceStats.clPendingBalanceAtLastReport;
          const postCLValidatorsBalance = preCLValidatorsBalance - clValidatorsBalanceDecrease;
          const postCLPendingBalance = preCLPendingBalance;
          const withdrawalVaultBalance = withdrawalVaultBalanceAtFirstReportRefSlot;
          const elRewardsVaultBalance = 0n;
          const sharesRequestedToBurn = 0n;
          const depositsSinceLastReport = balanceStats.depositedSinceLastReport;
          const withdrawalsVaultTransfer = 0n;
          const firstReportCheck = {
            timeElapsed,
            preCLValidatorsBalance,
            preCLPendingBalance,
            postCLValidatorsBalance,
            postCLPendingBalance,
            withdrawalVaultBalance,
            elRewardsVaultBalance,
            sharesRequestedToBurn,
            depositsSinceLastReport,
            withdrawalsVaultTransfer,
          };

          const counterfactualZeroVaultBaselineChecker = await deployChecker();
          await counterfactualZeroVaultBaselineChecker.migrateBaselineSnapshot();
          await setLastVaultBalanceAfterTransfer(counterfactualZeroVaultBaselineChecker, 0n);

          await expect(
            checkAccountingOracleReport(counterfactualZeroVaultBaselineChecker, accountingSigner, firstReportCheck),
          ).not.to.be.reverted;
        });
      });

      context("network-size dependent first-report CL decrease limit", () => {
        it("reverts the same 100k ETH decrease on a smaller 2M ETH network", async () => {
          const migratedNetwork = hoodiLikeMigratedNetwork;
          const withdrawalVaultBalanceAtMigration = ether("100000");
          const withdrawalVaultBalanceAtFirstReportRefSlot = withdrawalVaultBalanceAtMigration;
          const firstReportCLValidatorsBalanceDecrease = withdrawalVaultBalanceAtMigration;
          const balanceStats = await migrateNetworkV3State(migratedNetwork);
          const { accounting, deployChecker } = await deployAccountingAndChecker(withdrawalVaultBalanceAtMigration);
          const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

          const timeElapsed = oneDay;
          const preCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
          const preCLPendingBalance = balanceStats.clPendingBalanceAtLastReport;
          const postCLValidatorsBalance = preCLValidatorsBalance - firstReportCLValidatorsBalanceDecrease;
          const postCLPendingBalance = preCLPendingBalance;
          const withdrawalVaultBalance = withdrawalVaultBalanceAtFirstReportRefSlot;
          const elRewardsVaultBalance = 0n;
          const sharesRequestedToBurn = 0n;
          const depositsSinceLastReport = balanceStats.depositedSinceLastReport;
          const withdrawalsVaultTransfer = 0n;
          const firstReportCheck = {
            timeElapsed,
            preCLValidatorsBalance,
            preCLPendingBalance,
            postCLValidatorsBalance,
            postCLPendingBalance,
            withdrawalVaultBalance,
            elRewardsVaultBalance,
            sharesRequestedToBurn,
            depositsSinceLastReport,
            withdrawalsVaultTransfer,
          };

          const migratedBaselineChecker = await deployChecker();
          await migratedBaselineChecker.migrateBaselineSnapshot();

          const maxAllowedCLBalanceDecrease = calcMaxAllowedFirstReportCLBalanceDecrease(preCLValidatorsBalance);
          expect(maxAllowedCLBalanceDecrease).to.equal(migratedNetwork.expectedMaxSafeMigrationWithdrawalVaultBalance);
          expect(firstReportCLValidatorsBalanceDecrease).to.be.greaterThan(maxAllowedCLBalanceDecrease);

          const reportCheck = checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, firstReportCheck);
          await expect(reportCheck)
            .to.be.revertedWithCustomError(migratedBaselineChecker, "IncorrectCLBalanceDecrease")
            .withArgs(firstReportCLValidatorsBalanceDecrease, maxAllowedCLBalanceDecrease);
        });

        it("accepts the same 100k ETH decrease on a larger 9M ETH network", async () => {
          const migratedNetwork = mainnetLikeMigratedNetwork;
          const withdrawalVaultBalanceAtMigration = ether("100000");
          const withdrawalVaultBalanceAtFirstReportRefSlot = withdrawalVaultBalanceAtMigration;
          const firstReportCLValidatorsBalanceDecrease = withdrawalVaultBalanceAtMigration;
          const balanceStats = await migrateNetworkV3State(migratedNetwork);
          const { accounting, deployChecker } = await deployAccountingAndChecker(withdrawalVaultBalanceAtMigration);
          const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

          const timeElapsed = oneDay;
          const preCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
          const preCLPendingBalance = balanceStats.clPendingBalanceAtLastReport;
          const postCLValidatorsBalance = preCLValidatorsBalance - firstReportCLValidatorsBalanceDecrease;
          const postCLPendingBalance = preCLPendingBalance;
          const withdrawalVaultBalance = withdrawalVaultBalanceAtFirstReportRefSlot;
          const elRewardsVaultBalance = 0n;
          const sharesRequestedToBurn = 0n;
          const depositsSinceLastReport = balanceStats.depositedSinceLastReport;
          const withdrawalsVaultTransfer = 0n;
          const firstReportCheck = {
            timeElapsed,
            preCLValidatorsBalance,
            preCLPendingBalance,
            postCLValidatorsBalance,
            postCLPendingBalance,
            withdrawalVaultBalance,
            elRewardsVaultBalance,
            sharesRequestedToBurn,
            depositsSinceLastReport,
            withdrawalsVaultTransfer,
          };

          const migratedBaselineChecker = await deployChecker();
          await migratedBaselineChecker.migrateBaselineSnapshot();

          const maxAllowedCLBalanceDecrease = calcMaxAllowedFirstReportCLBalanceDecrease(preCLValidatorsBalance);
          expect(maxAllowedCLBalanceDecrease).to.equal(migratedNetwork.expectedMaxSafeMigrationWithdrawalVaultBalance);
          expect(firstReportCLValidatorsBalanceDecrease).to.be.lessThanOrEqual(maxAllowedCLBalanceDecrease);

          await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, firstReportCheck)).not.to
            .be.reverted;
        });
      });

      context("safe migration withdrawal vault balance boundary", () => {
        for (const migratedNetwork of [hoodiLikeMigratedNetwork, mainnetLikeMigratedNetwork]) {
          context(migratedNetwork.name, () => {
            it("fixes the maximum safe migration vault balance", async () => {
              const balanceStats = await migrateNetworkV3State(migratedNetwork);
              const preCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
              const maxSafeMigrationWithdrawalVaultBalance =
                calcMaxAllowedFirstReportCLBalanceDecrease(preCLValidatorsBalance);

              expect(maxSafeMigrationWithdrawalVaultBalance).to.equal(
                migratedNetwork.expectedMaxSafeMigrationWithdrawalVaultBalance,
              );
            });

            it("accepts a first-report decrease one wei below the maximum safe migration vault balance", async () => {
              const balanceStats = await migrateNetworkV3State(migratedNetwork);
              const preCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
              const maxSafeMigrationWithdrawalVaultBalance =
                calcMaxAllowedFirstReportCLBalanceDecrease(preCLValidatorsBalance);
              expect(maxSafeMigrationWithdrawalVaultBalance).to.equal(
                migratedNetwork.expectedMaxSafeMigrationWithdrawalVaultBalance,
              );

              const withdrawalVaultBalanceAtMigration = maxSafeMigrationWithdrawalVaultBalance - 1n;
              const withdrawalVaultBalanceAtFirstReportRefSlot = withdrawalVaultBalanceAtMigration;
              const clWithdrawalsSinceMigration =
                withdrawalVaultBalanceAtFirstReportRefSlot - withdrawalVaultBalanceAtMigration;
              const firstReportCLValidatorsBalanceDecrease = withdrawalVaultBalanceAtMigration;
              const { accounting, deployChecker } = await deployAccountingAndChecker(withdrawalVaultBalanceAtMigration);
              const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

              const timeElapsed = oneDay;
              const preCLPendingBalance = balanceStats.clPendingBalanceAtLastReport;
              const postCLValidatorsBalance = preCLValidatorsBalance - firstReportCLValidatorsBalanceDecrease;
              const postCLPendingBalance = preCLPendingBalance;
              const withdrawalVaultBalance = withdrawalVaultBalanceAtFirstReportRefSlot;
              const elRewardsVaultBalance = 0n;
              const sharesRequestedToBurn = 0n;
              const depositsSinceLastReport = balanceStats.depositedSinceLastReport;
              const withdrawalsVaultTransfer = 0n;
              expect(clWithdrawalsSinceMigration).to.equal(0n);

              const firstReportCheck = {
                timeElapsed,
                preCLValidatorsBalance,
                preCLPendingBalance,
                postCLValidatorsBalance,
                postCLPendingBalance,
                withdrawalVaultBalance,
                elRewardsVaultBalance,
                sharesRequestedToBurn,
                depositsSinceLastReport,
                withdrawalsVaultTransfer,
              };

              const migratedBaselineChecker = await deployChecker();
              await migratedBaselineChecker.migrateBaselineSnapshot();

              await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, firstReportCheck)).not
                .to.be.reverted;
            });

            it("accepts a first-report decrease equal to the maximum safe migration vault balance", async () => {
              const balanceStats = await migrateNetworkV3State(migratedNetwork);
              const preCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
              const maxSafeMigrationWithdrawalVaultBalance =
                calcMaxAllowedFirstReportCLBalanceDecrease(preCLValidatorsBalance);
              expect(maxSafeMigrationWithdrawalVaultBalance).to.equal(
                migratedNetwork.expectedMaxSafeMigrationWithdrawalVaultBalance,
              );

              const withdrawalVaultBalanceAtMigration = maxSafeMigrationWithdrawalVaultBalance;
              const withdrawalVaultBalanceAtFirstReportRefSlot = withdrawalVaultBalanceAtMigration;
              const clWithdrawalsSinceMigration =
                withdrawalVaultBalanceAtFirstReportRefSlot - withdrawalVaultBalanceAtMigration;
              const firstReportCLValidatorsBalanceDecrease = maxSafeMigrationWithdrawalVaultBalance;
              const { accounting, deployChecker } = await deployAccountingAndChecker(withdrawalVaultBalanceAtMigration);
              const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

              const timeElapsed = oneDay;
              const preCLPendingBalance = balanceStats.clPendingBalanceAtLastReport;
              const postCLValidatorsBalance = preCLValidatorsBalance - firstReportCLValidatorsBalanceDecrease;
              const postCLPendingBalance = preCLPendingBalance;
              const withdrawalVaultBalance = withdrawalVaultBalanceAtFirstReportRefSlot;
              const elRewardsVaultBalance = 0n;
              const sharesRequestedToBurn = 0n;
              const depositsSinceLastReport = balanceStats.depositedSinceLastReport;
              const withdrawalsVaultTransfer = 0n;
              expect(clWithdrawalsSinceMigration).to.equal(0n);

              const firstReportCheck = {
                timeElapsed,
                preCLValidatorsBalance,
                preCLPendingBalance,
                postCLValidatorsBalance,
                postCLPendingBalance,
                withdrawalVaultBalance,
                elRewardsVaultBalance,
                sharesRequestedToBurn,
                depositsSinceLastReport,
                withdrawalsVaultTransfer,
              };

              const migratedBaselineChecker = await deployChecker();
              await migratedBaselineChecker.migrateBaselineSnapshot();

              await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, firstReportCheck)).not
                .to.be.reverted;
            });

            it("reverts a first-report decrease one wei above the maximum safe migration vault balance", async () => {
              const balanceStats = await migrateNetworkV3State(migratedNetwork);
              const preCLValidatorsBalance = balanceStats.clValidatorsBalanceAtLastReport;
              const maxSafeMigrationWithdrawalVaultBalance =
                calcMaxAllowedFirstReportCLBalanceDecrease(preCLValidatorsBalance);
              expect(maxSafeMigrationWithdrawalVaultBalance).to.equal(
                migratedNetwork.expectedMaxSafeMigrationWithdrawalVaultBalance,
              );

              const withdrawalVaultBalanceAtMigration = maxSafeMigrationWithdrawalVaultBalance + 1n;
              const withdrawalVaultBalanceAtFirstReportRefSlot = withdrawalVaultBalanceAtMigration;
              const clWithdrawalsSinceMigration =
                withdrawalVaultBalanceAtFirstReportRefSlot - withdrawalVaultBalanceAtMigration;
              const firstReportCLValidatorsBalanceDecrease = withdrawalVaultBalanceAtMigration;
              const { accounting, deployChecker } = await deployAccountingAndChecker(withdrawalVaultBalanceAtMigration);
              const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));

              const timeElapsed = oneDay;
              const preCLPendingBalance = balanceStats.clPendingBalanceAtLastReport;
              const postCLValidatorsBalance = preCLValidatorsBalance - firstReportCLValidatorsBalanceDecrease;
              const postCLPendingBalance = preCLPendingBalance;
              const withdrawalVaultBalance = withdrawalVaultBalanceAtFirstReportRefSlot;
              const elRewardsVaultBalance = 0n;
              const sharesRequestedToBurn = 0n;
              const depositsSinceLastReport = balanceStats.depositedSinceLastReport;
              const withdrawalsVaultTransfer = 0n;
              expect(clWithdrawalsSinceMigration).to.equal(0n);

              const firstReportCheck = {
                timeElapsed,
                preCLValidatorsBalance,
                preCLPendingBalance,
                postCLValidatorsBalance,
                postCLPendingBalance,
                withdrawalVaultBalance,
                elRewardsVaultBalance,
                sharesRequestedToBurn,
                depositsSinceLastReport,
                withdrawalsVaultTransfer,
              };

              const migratedBaselineChecker = await deployChecker();
              await migratedBaselineChecker.migrateBaselineSnapshot();

              await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, firstReportCheck))
                .to.be.revertedWithCustomError(migratedBaselineChecker, "IncorrectCLBalanceDecrease")
                .withArgs(firstReportCLValidatorsBalanceDecrease, maxSafeMigrationWithdrawalVaultBalance);
            });
          });
        }
      });

      context("36-day window headroom after migration-time vault balance", () => {
        const required36DayCLDecreaseHeadroom = ether("50000");

        for (const migratedNetwork of [hoodiLikeMigratedNetwork, mainnetLikeMigratedNetwork]) {
          context(migratedNetwork.name, () => {
            it("keeps the chosen CL decrease headroom when migration vault balance is capped", async () => {
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
                migratedNetwork.expectedMaxSafeMigrationWithdrawalVaultBalance,
              );
              expect(rawFullWindowCLDecreaseLimit - bootstrapAdjustedFullWindowCLDecreaseLimit).to.equal(
                expectedCLDecreaseLimitLossFromMigrationBootstrap,
              );

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

              const day36ReportTimeElapsed = 35n * oneDay;
              const day36CLValidatorsBalanceDecrease = remaining36DayCLDecreaseHeadroom;
              const day36PreCLValidatorsBalance = nextReportPreCLValidatorsBalance;
              const day36PreCLPendingBalance = nextReportPreCLPendingBalance;
              const day36PostCLValidatorsBalance = day36PreCLValidatorsBalance - day36CLValidatorsBalanceDecrease;
              const day36PostCLPendingBalance = day36PreCLPendingBalance;
              const day36WithdrawalVaultBalance = nextReportWithdrawalVaultBalance;
              const day36ELRewardsVaultBalance = 0n;
              const day36SharesRequestedToBurn = 0n;
              const day36DepositsSinceLastReport = 0n;
              const day36WithdrawalsVaultTransfer = 0n;
              const totalCLDecreaseInsideWindow = migrationTimeCLDecrease + day36CLValidatorsBalanceDecrease;
              expect(totalCLDecreaseInsideWindow).to.equal(bootstrapAdjustedFullWindowCLDecreaseLimit);

              const day36ReportCheck = {
                timeElapsed: day36ReportTimeElapsed,
                preCLValidatorsBalance: day36PreCLValidatorsBalance,
                preCLPendingBalance: day36PreCLPendingBalance,
                postCLValidatorsBalance: day36PostCLValidatorsBalance,
                postCLPendingBalance: day36PostCLPendingBalance,
                withdrawalVaultBalance: day36WithdrawalVaultBalance,
                elRewardsVaultBalance: day36ELRewardsVaultBalance,
                sharesRequestedToBurn: day36SharesRequestedToBurn,
                depositsSinceLastReport: day36DepositsSinceLastReport,
                withdrawalsVaultTransfer: day36WithdrawalsVaultTransfer,
              };

              await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, day36ReportCheck)).not
                .to.be.reverted;
            });

            it("reverts one wei above the migration vault balance cap that preserves the chosen headroom", async () => {
              const bootstrapAdjustedFullWindowCLDecreaseLimit = calcMaxAllowedWindowCLBalanceDecrease(
                migratedNetwork.clValidatorsBalance,
                0n,
                maxWithdrawalsByChurnLimitPerReport,
              );
              expect(bootstrapAdjustedFullWindowCLDecreaseLimit).to.equal(
                migratedNetwork.expectedMaxSafeMigrationWithdrawalVaultBalance,
              );

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

              const day36ReportTimeElapsed = 35n * oneDay;
              const day36CLValidatorsBalanceDecrease = required36DayCLDecreaseHeadroom;
              const day36PreCLValidatorsBalance = nextReportPreCLValidatorsBalance;
              const day36PreCLPendingBalance = nextReportPreCLPendingBalance;
              const day36PostCLValidatorsBalance = day36PreCLValidatorsBalance - day36CLValidatorsBalanceDecrease;
              const day36PostCLPendingBalance = day36PreCLPendingBalance;
              const day36WithdrawalVaultBalance = nextReportWithdrawalVaultBalance;
              const day36ELRewardsVaultBalance = 0n;
              const day36SharesRequestedToBurn = 0n;
              const day36DepositsSinceLastReport = 0n;
              const day36WithdrawalsVaultTransfer = 0n;
              const totalCLDecreaseInsideWindow = migrationTimeCLDecrease + day36CLValidatorsBalanceDecrease;
              expect(totalCLDecreaseInsideWindow).to.equal(bootstrapAdjustedFullWindowCLDecreaseLimit + 1n);

              const day36ReportCheck = {
                timeElapsed: day36ReportTimeElapsed,
                preCLValidatorsBalance: day36PreCLValidatorsBalance,
                preCLPendingBalance: day36PreCLPendingBalance,
                postCLValidatorsBalance: day36PostCLValidatorsBalance,
                postCLPendingBalance: day36PostCLPendingBalance,
                withdrawalVaultBalance: day36WithdrawalVaultBalance,
                elRewardsVaultBalance: day36ELRewardsVaultBalance,
                sharesRequestedToBurn: day36SharesRequestedToBurn,
                depositsSinceLastReport: day36DepositsSinceLastReport,
                withdrawalsVaultTransfer: day36WithdrawalsVaultTransfer,
              };

              await expect(checkAccountingOracleReport(migratedBaselineChecker, accountingSigner, day36ReportCheck))
                .to.be.revertedWithCustomError(migratedBaselineChecker, "IncorrectCLBalanceDecrease")
                .withArgs(totalCLDecreaseInsideWindow, bootstrapAdjustedFullWindowCLDecreaseLimit);
            });
          });
        }
      });
    });
  });
});
