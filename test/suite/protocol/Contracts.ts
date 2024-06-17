import { BaseContract } from "ethers";

import {
  AccountingOracle,
  Burner,
  DepositSecurityModule,
  LegacyOracle,
  Lido,
  LidoExecutionLayerRewardsVault,
  OracleDaemonConfig,
  OracleReportSanityChecker,
  StakingRouter,
  ValidatorsExitBusOracle,
  WithdrawalQueueERC721,
  WithdrawalVault,
} from "typechain-types";

export type LoadedContract<T extends BaseContract = BaseContract> = T;

export interface Contracts {
  // Contracts
  accountingOracle: LoadedContract<AccountingOracle>;
  depositSecurityModule: LoadedContract<DepositSecurityModule>;
  elRewardsVault: LoadedContract<LidoExecutionLayerRewardsVault>;
  legacyOracle: LoadedContract<LegacyOracle>;
  lido: LoadedContract<Lido>;
  oracleReportSanityChecker: LoadedContract<OracleReportSanityChecker>;
  burner: LoadedContract<Burner>;
  stakingRouter: LoadedContract<StakingRouter>;
  validatorsExitBusOracle: LoadedContract<ValidatorsExitBusOracle>;
  withdrawalQueue: LoadedContract<WithdrawalQueueERC721>;
  withdrawalVault: LoadedContract<WithdrawalVault>;
  oracleDaemonConfig: LoadedContract<OracleDaemonConfig>;
  // Addresses
  postTokenRebaseReceiverAddress: string;
  treasuryAddress: string;
}
