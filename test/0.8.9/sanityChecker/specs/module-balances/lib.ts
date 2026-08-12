import { ether } from "lib";

export const DAY = 86_400n;
export const HOUR = 3_600n;
export const MAX_BASIS_POINTS = 10_000n;
export const DAYS_PER_YEAR = 365n;
export const MAX_VALIDATOR_EFFECTIVE_BALANCE = ether("2048");

const ANNUAL_BALANCE_INCREASE_DENOMINATOR = MAX_BASIS_POINTS * DAYS_PER_YEAR * DAY;

export type OracleReportLimits = {
  exitedEthAmountPerDayLimit: bigint;
  appearedEthAmountPerDayLimit: bigint;
  annualCLRebaseIncreaseSoftBPLimit: bigint;
  simulatedShareRateDeviationBPLimit: bigint;
  maxBalanceExitRequestedPerReportInEth: bigint;
  maxEffectiveBalanceWeightWCType01: bigint;
  maxEffectiveBalanceWeightWCType02: bigint;
  maxItemsPerExtraDataTransaction: bigint;
  maxNodeOperatorsPerExtraDataItem: bigint;
  requestTimestampMargin: bigint;
  annualCLRebaseIncreaseHardBPLimit: bigint;
  clRebaseDecreaseSoftBPLimit: bigint;
  clRebaseDecreaseHardBPLimit: bigint;
  consolidationEthAmountPerDayLimit: bigint;
  exitedValidatorEthAmountLimit: bigint;
  externalPendingBalanceCapEth: bigint;
};

export type ModuleBalance = {
  moduleId: bigint;
  previousValidatorsBalance: bigint;
  postValidatorsBalance: bigint;
  hasPreviousAccounting?: boolean;
};

export type ModuleBalanceReport = {
  timeElapsed: bigint;
  preCLValidatorsBalance: bigint;
  preCLPendingBalance: bigint;
  postCLPendingBalance: bigint;
  deposits: bigint;
  modules: ModuleBalance[];
};

export type ModuleBalanceFormula = {
  effectiveTimeElapsed: bigint;
  fundedPendingBalance: bigint;
  pendingBalanceCap: bigint;
  activatedBalance: bigint;
  appearedBalanceAllowance: bigint;
  activatedBalanceLimit: bigint;
  annualSoftAllowance: bigint;
  consolidationAllowance: bigint;
  grossPositiveModuleDeltas: bigint;
  moduleGrowthLimit: bigint;
};

export type ModuleBalanceOutcome =
  | "accepted"
  | "IncorrectTotalPendingBalance"
  | "IncorrectTotalActivatedBalance"
  | "IncorrectTotalModuleValidatorsBalanceIncrease";

export type ModuleBalanceCase = {
  title: string;
  rationale: string;
  limits?: Partial<OracleReportLimits>;
  report: ModuleBalanceReport;
  expected: {
    outcome: ModuleBalanceOutcome;
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
  preCLPendingBalance = 0n,
  postCLPendingBalance = 0n,
  deposits = 0n,
  modules,
}: {
  timeElapsed?: bigint;
  preCLValidatorsBalance?: bigint;
  preCLPendingBalance?: bigint;
  postCLPendingBalance?: bigint;
  deposits?: bigint;
  modules: ModuleBalance[];
}): ModuleBalanceReport => ({
  timeElapsed,
  preCLValidatorsBalance:
    preCLValidatorsBalance ?? modules.reduce((sum, module) => sum + module.previousValidatorsBalance, 0n),
  preCLPendingBalance,
  postCLPendingBalance,
  deposits,
  modules,
});

export const getPostCLValidatorsBalance = (report: ModuleBalanceReport): bigint =>
  report.modules.reduce((sum, module) => sum + module.postValidatorsBalance, 0n);

export const calcModuleBalanceFormula = (
  report: ModuleBalanceReport,
  limits: OracleReportLimits,
): ModuleBalanceFormula => {
  const effectiveTimeElapsed = report.timeElapsed === 0n ? HOUR : report.timeElapsed;
  const fundedPendingBalance = report.preCLPendingBalance + report.deposits;
  const pendingBalanceCap = fundedPendingBalance + ether(limits.externalPendingBalanceCapEth.toString());
  const activatedBalance =
    fundedPendingBalance > report.postCLPendingBalance ? fundedPendingBalance - report.postCLPendingBalance : 0n;
  const appearedBalanceAllowance = (ether(limits.appearedEthAmountPerDayLimit.toString()) * effectiveTimeElapsed) / DAY;
  const activatedBalanceLimit = appearedBalanceAllowance + MAX_VALIDATOR_EFFECTIVE_BALANCE;
  const annualSoftAllowance =
    ((report.preCLValidatorsBalance + activatedBalance) *
      limits.annualCLRebaseIncreaseSoftBPLimit *
      effectiveTimeElapsed) /
    ANNUAL_BALANCE_INCREASE_DENOMINATOR;
  const consolidationAllowance =
    (ether(limits.consolidationEthAmountPerDayLimit.toString()) * effectiveTimeElapsed) / DAY;
  const grossPositiveModuleDeltas = report.modules.reduce((sum, module) => {
    if (module.hasPreviousAccounting === false) return sum;
    if (module.postValidatorsBalance <= module.previousValidatorsBalance) return sum;
    return sum + module.postValidatorsBalance - module.previousValidatorsBalance;
  }, 0n);

  return {
    effectiveTimeElapsed,
    fundedPendingBalance,
    pendingBalanceCap,
    activatedBalance,
    appearedBalanceAllowance,
    activatedBalanceLimit,
    annualSoftAllowance,
    consolidationAllowance,
    grossPositiveModuleDeltas,
    moduleGrowthLimit: activatedBalance + annualSoftAllowance + consolidationAllowance,
  };
};
