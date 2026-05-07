import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Accounting__MockForSanityChecker,
  AccountingOracle__MockForStakingRouter,
  Lido__HarnessForFinalizeUpgradeV4,
  LidoLocator,
  OracleReportSanityChecker,
} from "typechain-types";

import { ether, impersonate, proxify, randomAddress } from "lib";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy/locator";

export const DAY = 86_400n;
export const DEPOSIT_SIZE = ether("32");
export const FINALIZE_UPGRADE_V4_MIGRATION_REF_SLOT = 1n;
export const FIRST_POST_MIGRATION_REF_SLOT = FINALIZE_UPGRADE_V4_MIGRATION_REF_SLOT + 1n;

const FINALIZE_UPGRADE_V4_INITIAL_BUFFERED_ETHER = 1n;
const LAST_VAULT_BALANCE_AFTER_TRANSFER_SLOT = 4n;

export type OracleReportLimits = {
  exitedEthAmountPerDayLimit: bigint;
  appearedEthAmountPerDayLimit: bigint;
  annualBalanceIncreaseBPLimit: bigint;
  simulatedShareRateDeviationBPLimit: bigint;
  maxBalanceExitRequestedPerReportInEth: bigint;
  maxEffectiveBalanceWeightWCType01: bigint;
  maxEffectiveBalanceWeightWCType02: bigint;
  maxItemsPerExtraDataTransaction: bigint;
  maxNodeOperatorsPerExtraDataItem: bigint;
  requestTimestampMargin: bigint;
  maxPositiveTokenRebase: bigint;
  maxCLBalanceDecreaseBP: bigint;
  clBalanceOraclesErrorUpperBPLimit: bigint;
  consolidationEthAmountPerDayLimit: bigint;
  exitedValidatorEthAmountLimit: bigint;
  externalPendingBalanceCapEth: bigint;
};

export type ModuleBalanceStep = {
  moduleId: bigint;
  previousValidatorsBalance: bigint;
  postValidatorsBalance: bigint;
  hasPreviousAccounting?: boolean;
};

export type MigrationStep = {
  kind: "migration";
  label: string;
  clValidators: bigint;
  transientDeposits: bigint;
  withdrawalVaultBalance: bigint;
};

export type FinalizeUpgradeV4MigrationStep = MigrationStep;

export type ReportCLState = {
  preValidatorsBalance: bigint;
  prePendingBalance: bigint;
  postValidatorsBalance: bigint;
  postPendingBalance: bigint;
};

export type ReportCLStateInput = Omit<ReportCLState, "preValidatorsBalance" | "prePendingBalance"> & {
  preValidatorsBalance?: bigint;
  prePendingBalance?: bigint;
};

export type ReportStep = {
  kind: "report";
  label: string;
  timeElapsed: bigint;
  cl: ReportCLState;
  movements: {
    deposits: bigint;
    clWithdrawals: bigint;
    withdrawalsVaultTransfer?: bigint;
  };
  modules?: ModuleBalanceStep[];
};

export type ReportStepInput = Omit<ReportStep, "cl"> & {
  cl: ReportCLStateInput;
};

export type FormulaFixtureSet<TCase> = {
  title: string;
  limits: OracleReportLimits;
  cases: TCase[];
};

export type ScenarioStep = MigrationStep | ReportStepInput;
export type ResolvedScenarioStep = MigrationStep | ReportStep;

export const migrate = ({
  label,
  clValidators,
  transientDeposits,
  withdrawalVaultBalance,
}: {
  label: string;
  clValidators: bigint;
  transientDeposits: bigint;
  withdrawalVaultBalance: bigint;
}): MigrationStep => ({
  kind: "migration",
  label,
  clValidators,
  transientDeposits,
  withdrawalVaultBalance,
});

export const getMigrationCLValidatorsBalance = (step: MigrationStep) => step.clValidators * DEPOSIT_SIZE;

export const isReportStep = (step: ScenarioStep): step is ReportStepInput => step.kind === "report";

type PreviousCLState = {
  validatorsBalance: bigint;
  pendingBalance: bigint;
};

export const resolveReportStep = (step: ReportStepInput, previousCLState?: PreviousCLState): ReportStep => {
  const preValidatorsBalance = step.cl.preValidatorsBalance ?? previousCLState?.validatorsBalance ?? 0n;
  const prePendingBalance = step.cl.prePendingBalance ?? previousCLState?.pendingBalance ?? 0n;

  return {
    ...step,
    cl: {
      ...step.cl,
      preValidatorsBalance,
      prePendingBalance,
    },
  };
};

export const resolveScenarioSteps = (steps: ScenarioStep[]): ResolvedScenarioStep[] => {
  let previousCLState: PreviousCLState | undefined;

  return steps.map((step) => {
    if (!isReportStep(step)) {
      previousCLState = {
        validatorsBalance: getMigrationCLValidatorsBalance(step),
        pendingBalance: 0n,
      };
      return step;
    }

    const resolvedStep = resolveReportStep(step, previousCLState);
    previousCLState = {
      validatorsBalance: resolvedStep.cl.postValidatorsBalance,
      pendingBalance: resolvedStep.cl.postPendingBalance,
    };
    return resolvedStep;
  });
};

export type LidoBalanceStats = {
  clValidatorsBalanceAtLastReport: bigint;
  clPendingBalanceAtLastReport: bigint;
  depositedSinceLastReport: bigint;
  depositedForCurrentReport: bigint;
};

export type FinalizeUpgradeV4CheckerFixture = {
  checker: OracleReportSanityChecker;
  accountingSigner: HardhatEthersSigner;
  accountingOracle: AccountingOracle__MockForStakingRouter;
  lido: Lido__HarnessForFinalizeUpgradeV4;
  withdrawalVaultAddress: string;
};

export const hasFinalizeUpgradeV4State = (step: MigrationStep): step is FinalizeUpgradeV4MigrationStep =>
  step.clValidators !== undefined;

export const deployFinalizeUpgradeV4Checker = async (
  limitsList: OracleReportLimits,
): Promise<FinalizeUpgradeV4CheckerFixture> => {
  const [deployer] = await ethers.getSigners();
  const withdrawalVaultAddress = randomAddress();
  const elRewardsVaultAddress = randomAddress();
  const burner = await ethers.deployContract("Burner__MockForSanityChecker", []);
  const accounting = (await ethers.deployContract(
    "Accounting__MockForSanityChecker",
    [],
  )) as Accounting__MockForSanityChecker;
  const accountingOracle = (await ethers.deployContract(
    "AccountingOracle__MockForStakingRouter",
    deployer,
  )) as AccountingOracle__MockForStakingRouter;
  const impl = (await ethers.deployContract("Lido__HarnessForFinalizeUpgradeV4", {
    signer: deployer,
  })) as Lido__HarnessForFinalizeUpgradeV4;
  const [lido] = await proxify({ impl, admin: deployer });
  const locator = (await deployLidoLocator({ lido, accountingOracle }, deployer)) as LidoLocator;

  await lido.connect(deployer).harness_initialize_v3(locator, {
    value: FINALIZE_UPGRADE_V4_INITIAL_BUFFERED_ETHER,
  });

  const checker = (await ethers.deployContract("OracleReportSanityChecker", [
    await locator.getAddress(),
    await accounting.getAddress(),
    deployer.address,
    limitsList,
  ])) as OracleReportSanityChecker;

  await updateLidoLocatorImplementation(
    await locator.getAddress(),
    {
      accounting: await accounting.getAddress(),
      oracleReportSanityChecker: await checker.getAddress(),
      withdrawalVault: withdrawalVaultAddress,
      elRewardsVault: elRewardsVaultAddress,
      burner: await burner.getAddress(),
    },
    undefined,
    deployer,
  );

  return {
    checker,
    accountingSigner: await impersonate(await accounting.getAddress(), ether("1")),
    accountingOracle,
    lido,
    withdrawalVaultAddress,
  };
};

export const migrateFinalizeUpgradeV4State = async (
  fixture: FinalizeUpgradeV4CheckerFixture,
  step: MigrationStep,
): Promise<LidoBalanceStats> => {
  if (step.transientDeposits % DEPOSIT_SIZE !== 0n) {
    throw new Error(`Migration step '${step.label}' has transientDeposits that are not divisible by 32 ETH`);
  }

  const depositedValidators = step.clValidators + step.transientDeposits / DEPOSIT_SIZE;
  const clValidators = step.clValidators;
  const clValidatorsBalance = getMigrationCLValidatorsBalance(step);
  const depositedSinceLastReport = (depositedValidators - clValidators) * DEPOSIT_SIZE;
  const lidoV3Harness = await ethers.getContractAt(
    ["function harness_setV3BalanceState(uint256,uint256,uint256,uint256) external"],
    await fixture.lido.getAddress(),
  );

  await fixture.accountingOracle.mock_setProcessingState(FINALIZE_UPGRADE_V4_MIGRATION_REF_SLOT, true, true);
  await lidoV3Harness.harness_setV3BalanceState(
    FINALIZE_UPGRADE_V4_INITIAL_BUFFERED_ETHER,
    depositedValidators,
    clValidatorsBalance,
    clValidators,
  );

  await expect(fixture.lido.finalizeUpgrade_v4(), `finalizeUpgrade_v4 for '${step.label}'`).not.to.be.reverted;

  const balanceStats = await fixture.lido.getBalanceStats();
  expect(balanceStats.clValidatorsBalanceAtLastReport, `${step.label}: migrated validators balance`).to.equal(
    clValidatorsBalance,
  );
  expect(balanceStats.clPendingBalanceAtLastReport, `${step.label}: migrated pending balance`).to.equal(0n);
  expect(balanceStats.depositedSinceLastReport, `${step.label}: migrated deposits since last report`).to.equal(
    depositedSinceLastReport,
  );
  expect(balanceStats.depositedForCurrentReport, `${step.label}: migrated deposits for current report`).to.equal(0n);

  await setBalance(fixture.withdrawalVaultAddress, step.withdrawalVaultBalance);
  await expect(fixture.checker.migrateBaselineSnapshot(), `migration '${step.label}'`).not.to.be.reverted;

  return {
    clValidatorsBalanceAtLastReport: balanceStats.clValidatorsBalanceAtLastReport,
    clPendingBalanceAtLastReport: balanceStats.clPendingBalanceAtLastReport,
    depositedSinceLastReport: balanceStats.depositedSinceLastReport,
    depositedForCurrentReport: balanceStats.depositedForCurrentReport,
  };
};

export const moveToFirstPostMigrationReportFrame = async (
  fixture: FinalizeUpgradeV4CheckerFixture,
): Promise<LidoBalanceStats> => {
  await fixture.accountingOracle.mock_setProcessingState(FIRST_POST_MIGRATION_REF_SLOT, true, true);

  const balanceStats = await fixture.lido.getBalanceStats();
  return {
    clValidatorsBalanceAtLastReport: balanceStats.clValidatorsBalanceAtLastReport,
    clPendingBalanceAtLastReport: balanceStats.clPendingBalanceAtLastReport,
    depositedSinceLastReport: balanceStats.depositedSinceLastReport,
    depositedForCurrentReport: balanceStats.depositedForCurrentReport,
  };
};

export const setLastVaultBalanceAfterTransfer = async (checker: OracleReportSanityChecker, value: bigint) => {
  await ethers.provider.send("hardhat_setStorageAt", [
    await checker.getAddress(),
    ethers.toBeHex(LAST_VAULT_BALANCE_AFTER_TRANSFER_SLOT, 32),
    ethers.toBeHex(value, 32),
  ]);
};
