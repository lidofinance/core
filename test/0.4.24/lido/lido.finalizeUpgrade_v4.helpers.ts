import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Accounting,
  AccountingOracle__MockForStakingRouter,
  Burner__MockForSanityChecker,
  Lido__HarnessForFinalizeUpgradeV4,
  LidoLocator,
  OracleReportSanityChecker,
} from "typechain-types";

import { ether, proxify } from "lib";
import { TOTAL_BASIS_POINTS } from "lib/constants";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy/locator";
import { Snapshot } from "test/suite";

export const sanityCheckerLimits = {
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

export type AccountingOracleReportCheck = {
  timeElapsed: bigint;
  preCLValidatorsBalance: bigint;
  preCLPendingBalance: bigint;
  postCLValidatorsBalance: bigint;
  postCLPendingBalance: bigint;
  withdrawalVaultBalance: bigint;
  elRewardsVaultBalance: bigint;
  sharesRequestedToBurn: bigint;
  depositsForReport: bigint;
  withdrawalsVaultTransfer: bigint;
};

type CLBalanceChangeReportParams = {
  timeElapsed?: bigint;
  preCLValidatorsBalance: bigint;
  preCLPendingBalance?: bigint;
  postCLPendingBalance?: bigint;
  withdrawalVaultBalance?: bigint;
  elRewardsVaultBalance?: bigint;
  sharesRequestedToBurn?: bigint;
  depositsForReport?: bigint;
  withdrawalsVaultTransfer?: bigint;
};

type CLBalanceIncreaseReportParams = CLBalanceChangeReportParams & {
  clBalanceIncrease: bigint;
};

type CLBalanceDecreaseReportParams = CLBalanceChangeReportParams & {
  clBalanceDecrease: bigint;
};

export type V3MigrationState = {
  bufferedEther: bigint;
  depositedValidators: bigint;
  clValidatorsBalance: bigint;
  clValidators: bigint;
};

export type MigratedNetworkScenario = {
  name: string;
  depositedValidators: bigint;
  clValidators: bigint;
  clValidatorsBalance: bigint;
  expectedBootstrapAdjustedFirstReportCLDecreaseLimit: bigint;
};

export const initialValue = 1n;
export const oneDay = 24n * 60n * 60n;
export const maxWithdrawalsByChurnLimitPerReport = ether("57600");
export const expectedCLDecreaseLimitLossFromMigrationBootstrap =
  (maxWithdrawalsByChurnLimitPerReport * sanityCheckerLimits.maxCLBalanceDecreaseBP) / TOTAL_BASIS_POINTS;

const annualBalanceIncreaseDenominator = 365n * oneDay * TOTAL_BASIS_POINTS;

export const hoodiLikeMigratedNetwork: MigratedNetworkScenario = {
  name: "Hoodi-like 2M ETH migrated protocol",
  depositedValidators: 62_500n,
  clValidators: 62_500n,
  clValidatorsBalance: ether("2000000"),
  expectedBootstrapAdjustedFirstReportCLDecreaseLimit: ether("69926.4"),
};

export const mainnetLikeMigratedNetwork: MigratedNetworkScenario = {
  name: "Mainnet-like 9M ETH migrated protocol",
  depositedValidators: 281_250n,
  clValidators: 281_250n,
  clValidatorsBalance: ether("9000000"),
  expectedBootstrapAdjustedFirstReportCLDecreaseLimit: ether("321926.4"),
};

export const buildCLBalanceIncreaseReport = ({
  timeElapsed = oneDay,
  preCLValidatorsBalance,
  preCLPendingBalance = 0n,
  postCLPendingBalance = preCLPendingBalance,
  clBalanceIncrease,
  withdrawalVaultBalance = 0n,
  elRewardsVaultBalance = 0n,
  sharesRequestedToBurn = 0n,
  depositsForReport = 0n,
  withdrawalsVaultTransfer = 0n,
}: CLBalanceIncreaseReportParams): AccountingOracleReportCheck => ({
  timeElapsed,
  preCLValidatorsBalance,
  preCLPendingBalance,
  postCLValidatorsBalance: preCLValidatorsBalance + clBalanceIncrease,
  postCLPendingBalance,
  withdrawalVaultBalance,
  elRewardsVaultBalance,
  sharesRequestedToBurn,
  depositsForReport,
  withdrawalsVaultTransfer,
});

export const buildCLBalanceDecreaseReport = ({
  timeElapsed = oneDay,
  preCLValidatorsBalance,
  preCLPendingBalance = 0n,
  postCLPendingBalance = preCLPendingBalance,
  clBalanceDecrease,
  withdrawalVaultBalance = 0n,
  elRewardsVaultBalance = 0n,
  sharesRequestedToBurn = 0n,
  depositsForReport = 0n,
  withdrawalsVaultTransfer = 0n,
}: CLBalanceDecreaseReportParams): AccountingOracleReportCheck => ({
  timeElapsed,
  preCLValidatorsBalance,
  preCLPendingBalance,
  postCLValidatorsBalance: preCLValidatorsBalance - clBalanceDecrease,
  postCLPendingBalance,
  withdrawalVaultBalance,
  elRewardsVaultBalance,
  sharesRequestedToBurn,
  depositsForReport,
  withdrawalsVaultTransfer,
});

export const checkAccountingOracleReport = (
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
      report.depositsForReport,
      report.withdrawalsVaultTransfer,
    );

export const calcMaxAllowedWindowCLBalanceDecrease = (
  baselineCLBalance: bigint,
  depositsInsideWindow: bigint,
  clWithdrawalsInsideWindow: bigint,
) =>
  ((baselineCLBalance + depositsInsideWindow - clWithdrawalsInsideWindow) *
    sanityCheckerLimits.maxCLBalanceDecreaseBP) /
  TOTAL_BASIS_POINTS;

export const calcMaxAllowedFirstReportCLBalanceDecrease = (preCLValidatorsBalance: bigint) =>
  calcMaxAllowedWindowCLBalanceDecrease(preCLValidatorsBalance, 0n, maxWithdrawalsByChurnLimitPerReport);

export const calcAnnualValidatorsBalanceIncreaseLimit = (preCLValidatorsBalance: bigint, timeElapsed: bigint) =>
  (preCLValidatorsBalance * sanityCheckerLimits.annualBalanceIncreaseBPLimit * timeElapsed) /
  annualBalanceIncreaseDenominator;

export const useFinalizeUpgradeV4Fixture = () => {
  let deployer: HardhatEthersSigner;
  let withdrawalVault: HardhatEthersSigner;
  let elRewardsVault: HardhatEthersSigner;

  let impl: Lido__HarnessForFinalizeUpgradeV4;
  let lido: Lido__HarnessForFinalizeUpgradeV4;
  let accountingOracle: AccountingOracle__MockForStakingRouter;
  let locator: LidoLocator;
  let originalState: string;

  before(async () => {
    [deployer, withdrawalVault, elRewardsVault] = await ethers.getSigners();
    impl = await ethers.deployContract("Lido__HarnessForFinalizeUpgradeV4", {
      signer: deployer,
    });
    [lido] = await proxify({ impl, admin: deployer });
    accountingOracle = await ethers.deployContract("AccountingOracle__MockForStakingRouter", deployer);
    locator = await deployLidoLocator({ lido, accountingOracle }, deployer);
    await lido.connect(deployer).harness_initialize_v3(locator, { value: initialValue });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(originalState));

  const migrateV3State = async (migrationState: V3MigrationState) => {
    const { bufferedEther, depositedValidators, clValidatorsBalance, clValidators } = migrationState;
    const expectedMigratedCLPendingBalance = 0n;
    const expectedMigratedDepositsSinceLastReport = (depositedValidators - clValidators) * ether("32");
    const expectedMigratedDepositsForCurrentReport = 0n;

    await accountingOracle.mock_setProcessingState(1, true, true);
    await lido.harness_setV3BalanceState(bufferedEther, depositedValidators, clValidatorsBalance, clValidators);

    await expect(lido.finalizeUpgrade_v4()).not.to.be.reverted;

    const balanceStats = await lido.getBalanceStats();
    expect(balanceStats.clValidatorsBalanceAtLastReport).to.equal(clValidatorsBalance);
    expect(balanceStats.clPendingBalanceAtLastReport).to.equal(expectedMigratedCLPendingBalance);
    expect(balanceStats.depositedSinceLastReport).to.equal(expectedMigratedDepositsSinceLastReport);
    expect(balanceStats.depositedForCurrentReport).to.equal(expectedMigratedDepositsForCurrentReport);

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

    const deployStandaloneChecker = async () =>
      (await ethers.deployContract("OracleReportSanityChecker", [
        await locator.getAddress(),
        await accounting.getAddress(),
        deployer.address,
        sanityCheckerLimits,
      ])) as OracleReportSanityChecker;

    const checker = await deployStandaloneChecker();

    await updateLidoLocatorImplementation(
      await locator.getAddress(),
      {
        accounting: await accounting.getAddress(),
        oracleReportSanityChecker: await checker.getAddress(),
        withdrawalVault: withdrawalVault.address,
        elRewardsVault: elRewardsVault.address,
        burner: await burner.getAddress(),
      },
      undefined,
      deployer,
    );

    return { accounting, checker, deployStandaloneChecker };
  };

  return {
    get lido() {
      return lido;
    },
    get accountingOracle() {
      return accountingOracle;
    },
    migrateV3State,
    migrateNetworkV3State,
    migrateMainnetLikeV3State,
    deployAccountingAndChecker,
    setWithdrawalVaultBalance: (balance: bigint) => setBalance(withdrawalVault.address, balance),
  };
};
