import { ether } from "lib";

export const DAY = 86_400n;
export const HOUR = 3_600n;
export const MAX_BASIS_POINTS = 10_000n;
export const ANNUAL_BALANCE_INCREASE_DENOMINATOR = 365n * DAY * MAX_BASIS_POINTS;

const ONE_GWEI = 10n ** 9n;

export const toGwei = (value: bigint) => value / ONE_GWEI;

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

export type ModuleBalanceLimits = Pick<
  OracleReportLimits,
  | "appearedEthAmountPerDayLimit"
  | "annualBalanceIncreaseBPLimit"
  | "consolidationEthAmountPerDayLimit"
  | "externalPendingBalanceCapEth"
>;

export type ModuleBalance = {
  moduleId: bigint;
  previousValidatorsBalance: bigint;
  postValidatorsBalance: bigint;
  hasPreviousAccounting?: boolean;
};

export type ModuleBalanceReport = {
  timeElapsed: bigint;
  preCLValidatorsBalance?: bigint;
  preCLPendingBalance: bigint;
  postCLPendingBalance: bigint;
  deposits: bigint;
  modules: ModuleBalance[];
};

export type ModuleBalanceFormula = {
  pendingBalanceCap: bigint;
  activatedBalance: bigint;
  appearedBalanceLimit: bigint;
  validatorsBalanceIncrease: bigint;
  validatorsGrowthLimit: bigint;
  totalPositiveModuleDelta: bigint;
  moduleValidatorsGrowthLimit: bigint;
};

export type ModuleBalanceCase = {
  title: string;
  rationale: string;
  limits?: Partial<OracleReportLimits>;
  report: ModuleBalanceReport;
  expected: {
    outcome:
      | "accepted"
      | "IncorrectTotalPendingBalance"
      | "IncorrectTotalActivatedBalance"
      | "IncorrectTotalCLBalanceIncrease"
      | "IncorrectTotalModuleValidatorsBalanceIncrease";
    formula?: Partial<ModuleBalanceFormula>;
  };
};

export type ModuleBalanceFixtureSet = {
  title: string;
  limits: OracleReportLimits;
  cases: ModuleBalanceCase[];
};

export const moduleReport = ({
  timeElapsed = DAY,
  preCLValidatorsBalance,
  preCLPendingBalance,
  postCLPendingBalance,
  deposits,
  modules,
}: {
  timeElapsed?: bigint;
  preCLValidatorsBalance?: bigint;
  preCLPendingBalance: bigint;
  postCLPendingBalance: bigint;
  deposits: bigint;
  modules: ModuleBalance[];
}): ModuleBalanceReport => ({
  timeElapsed,
  preCLValidatorsBalance,
  preCLPendingBalance,
  postCLPendingBalance,
  deposits,
  modules,
});

export const getPreCLValidatorsBalance = (report: ModuleBalanceReport) =>
  report.preCLValidatorsBalance ?? report.modules.reduce((sum, module) => sum + module.previousValidatorsBalance, 0n);

export const getPostCLValidatorsBalance = (report: ModuleBalanceReport) =>
  report.modules.reduce((sum, module) => sum + module.postValidatorsBalance, 0n);

export const calcModuleBalanceFormula = (
  report: ModuleBalanceReport,
  limits: ModuleBalanceLimits,
): ModuleBalanceFormula => {
  const effectiveTimeElapsed = report.timeElapsed === 0n ? HOUR : report.timeElapsed;
  const preCLValidatorsBalance = getPreCLValidatorsBalance(report);
  const postCLValidatorsBalance = getPostCLValidatorsBalance(report);
  const fundedPendingBalance = report.preCLPendingBalance + report.deposits;
  const pendingBalanceCap = fundedPendingBalance + ether(limits.externalPendingBalanceCapEth.toString());
  const activatedBalance =
    fundedPendingBalance > report.postCLPendingBalance ? fundedPendingBalance - report.postCLPendingBalance : 0n;
  const appearedBalanceLimit = (ether(limits.appearedEthAmountPerDayLimit.toString()) * effectiveTimeElapsed) / DAY;
  const validatorsGrowthLimit =
    activatedBalance +
    ((preCLValidatorsBalance + activatedBalance) * limits.annualBalanceIncreaseBPLimit * effectiveTimeElapsed) /
      ANNUAL_BALANCE_INCREASE_DENOMINATOR;
  const validatorsBalanceIncrease =
    postCLValidatorsBalance > preCLValidatorsBalance ? postCLValidatorsBalance - preCLValidatorsBalance : 0n;
  const totalPositiveModuleDelta = report.modules.reduce((sum, module) => {
    if (module.hasPreviousAccounting === false) return sum;
    if (module.postValidatorsBalance <= module.previousValidatorsBalance) return sum;
    return sum + module.postValidatorsBalance - module.previousValidatorsBalance;
  }, 0n);
  const consolidationLimit = (ether(limits.consolidationEthAmountPerDayLimit.toString()) * effectiveTimeElapsed) / DAY;

  return {
    pendingBalanceCap,
    activatedBalance,
    appearedBalanceLimit,
    validatorsBalanceIncrease,
    validatorsGrowthLimit,
    totalPositiveModuleDelta,
    moduleValidatorsGrowthLimit: validatorsGrowthLimit + consolidationLimit,
  };
};
