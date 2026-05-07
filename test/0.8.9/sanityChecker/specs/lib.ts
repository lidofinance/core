export const DAY = 86_400n;

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
  clValidatorsBalance: bigint;
  clPendingBalance: bigint;
  deposits: bigint;
  withdrawalVaultBalance: bigint;
};

export type ReportStep = {
  kind: "report";
  label: string;
  timeElapsed: bigint;
  cl: {
    preValidatorsBalance: bigint;
    prePendingBalance: bigint;
    postValidatorsBalance: bigint;
    postPendingBalance: bigint;
  };
  movements: {
    deposits: bigint;
    clWithdrawals: bigint;
  };
  modules?: ModuleBalanceStep[];
};

export type FormulaFixtureSet<TCase> = {
  title: string;
  limits: OracleReportLimits;
  cases: TCase[];
};

export type ScenarioStep = MigrationStep | ReportStep;

export const migrate = ({
  label,
  clValidatorsBalance,
  clPendingBalance,
  deposits,
  withdrawalVaultBalance,
}: {
  label: string;
  clValidatorsBalance: bigint;
  clPendingBalance: bigint;
  deposits: bigint;
  withdrawalVaultBalance: bigint;
}): MigrationStep => ({
  kind: "migration",
  label,
  clValidatorsBalance,
  clPendingBalance,
  deposits,
  withdrawalVaultBalance,
});

export const isReportStep = (step: ScenarioStep): step is ReportStep => step.kind === "report";
