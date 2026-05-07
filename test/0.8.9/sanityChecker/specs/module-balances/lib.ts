import { ether } from "lib";

import {
  DAY,
  FormulaFixtureSet,
  migrate,
  MigrationStep,
  ModuleBalanceStep,
  OracleReportLimits,
  ReportStep,
} from "../lib";

export { migrate };
export type { OracleReportLimits };

export const HOUR = 3_600n;
export const MAX_BASIS_POINTS = 10_000n;
export const ANNUAL_BALANCE_INCREASE_DENOMINATOR = 365n * DAY * MAX_BASIS_POINTS;

const ONE_GWEI = 10n ** 9n;

export const toGwei = (value: bigint) => value / ONE_GWEI;

export type ModuleBalanceLimits = Pick<
  OracleReportLimits,
  | "appearedEthAmountPerDayLimit"
  | "annualBalanceIncreaseBPLimit"
  | "consolidationEthAmountPerDayLimit"
  | "externalPendingBalanceCapEth"
>;

export type ModuleBalance = ModuleBalanceStep;

export type ModuleBalanceReport = ReportStep & { modules: ModuleBalance[] };
export type ModuleBalanceStepFixture = MigrationStep | ModuleBalanceReport;

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
  steps: ModuleBalanceStepFixture[];
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

export type ModuleBalanceFixtureSet = FormulaFixtureSet<ModuleBalanceCase>;

export const moduleReport = ({
  label,
  timeElapsed = DAY,
  preCLValidatorsBalance,
  preCLPendingBalance = 0n,
  postCLPendingBalance,
  deposits,
  clWithdrawals,
  withdrawalsVaultTransfer,
  modules,
}: {
  label: string;
  timeElapsed?: bigint;
  preCLValidatorsBalance?: bigint;
  preCLPendingBalance?: bigint;
  postCLPendingBalance: bigint;
  deposits: bigint;
  clWithdrawals: bigint;
  withdrawalsVaultTransfer?: bigint;
  modules: ModuleBalance[];
}): ModuleBalanceReport => {
  const postValidatorsBalance = modules.reduce((sum, module) => sum + module.postValidatorsBalance, 0n);

  return {
    kind: "report",
    label,
    timeElapsed,
    cl: {
      preValidatorsBalance:
        preCLValidatorsBalance ?? modules.reduce((sum, module) => sum + module.previousValidatorsBalance, 0n),
      prePendingBalance: preCLPendingBalance,
      postValidatorsBalance,
      postPendingBalance: postCLPendingBalance,
    },
    movements: {
      deposits,
      clWithdrawals,
      withdrawalsVaultTransfer,
    },
    modules,
  };
};

export const getPreCLValidatorsBalance = (report: ModuleBalanceReport) => report.cl.preValidatorsBalance;

export const getPostCLValidatorsBalance = (report: ModuleBalanceReport) => report.cl.postValidatorsBalance;

export const calcModuleBalanceFormula = (
  report: ModuleBalanceReport,
  limits: ModuleBalanceLimits,
): ModuleBalanceFormula => {
  const effectiveTimeElapsed = report.timeElapsed === 0n ? HOUR : report.timeElapsed;
  const preCLValidatorsBalance = getPreCLValidatorsBalance(report);
  const postCLValidatorsBalance = getPostCLValidatorsBalance(report);
  const fundedPendingBalance = report.cl.prePendingBalance + report.movements.deposits;
  const pendingBalanceCap = fundedPendingBalance + ether(limits.externalPendingBalanceCapEth.toString());
  const activatedBalance =
    fundedPendingBalance > report.cl.postPendingBalance ? fundedPendingBalance - report.cl.postPendingBalance : 0n;
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
