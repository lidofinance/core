import { BaseContract as EthersBaseContract } from "ethers";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracle,
  ACL,
  Burner,
  DepositSecurityModule,
  HashConsensus,
  Kernel,
  LegacyOracle,
  Lido,
  LidoExecutionLayerRewardsVault,
  LidoLocator,
  NodeOperatorsRegistry,
  OracleDaemonConfig,
  OracleReportSanityChecker,
  StakingRouter,
  ValidatorsExitBusOracle,
  WithdrawalQueueERC721,
  WithdrawalVault,
} from "typechain-types";

type ProtocolNetworkItems = {
  locator: string;
  agent: string;
  voting: string;
  easyTrack: string;
};

export type ProtocolNetworkConfig = {
  env: Record<keyof ProtocolNetworkItems, string>;
  defaults: Record<keyof ProtocolNetworkItems, string>;
};

export interface ContractTypes {
  LidoLocator: LidoLocator;
  AccountingOracle: AccountingOracle;
  DepositSecurityModule: DepositSecurityModule;
  LidoExecutionLayerRewardsVault: LidoExecutionLayerRewardsVault;
  LegacyOracle: LegacyOracle;
  Lido: Lido;
  OracleReportSanityChecker: OracleReportSanityChecker;
  Burner: Burner;
  StakingRouter: StakingRouter;
  ValidatorsExitBusOracle: ValidatorsExitBusOracle;
  WithdrawalQueueERC721: WithdrawalQueueERC721;
  WithdrawalVault: WithdrawalVault;
  OracleDaemonConfig: OracleDaemonConfig;
  Kernel: Kernel;
  ACL: ACL;
  HashConsensus: HashConsensus;
  NodeOperatorsRegistry: NodeOperatorsRegistry;
}

export type ContractName = keyof ContractTypes;
export type ContractType<Name extends ContractName> = ContractTypes[Name];

export type BaseContract = EthersBaseContract;

export type LoadedContract<T extends BaseContract = BaseContract> = T & {
  address: string;
};

export type FoundationContracts = {
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
};

export type AragonContracts = {
  kernel: LoadedContract<Kernel>;
  acl: LoadedContract<ACL>;
};

export type StackingModulesContracts = {
  nor: LoadedContract<NodeOperatorsRegistry>;
  sdvt: LoadedContract<NodeOperatorsRegistry>;
};

export type HashConsensusContracts = {
  hashConsensus: LoadedContract<HashConsensus>;
};

export type ProtocolContracts = { locator: LoadedContract<LidoLocator> } & FoundationContracts &
  AragonContracts &
  StackingModulesContracts &
  HashConsensusContracts;

export type ProtocolSigners = {
  agent: string;
  voting: string;
  easyTrack: string;
};

export type Signer = keyof ProtocolSigners;

export type ProtocolContext = {
  contracts: ProtocolContracts;
  signers: ProtocolSigners;
  interfaces: Array<BaseContract["interface"]>;
  getSigner: (signer: Signer, balance?: bigint) => Promise<HardhatEthersSigner>;
};
