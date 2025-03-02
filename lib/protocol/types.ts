import { BaseContract as EthersBaseContract, ContractTransactionReceipt, Interface, LogDescription } from "ethers";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Accounting,
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
  UpgradeableBeacon,
  ValidatorsExitBusOracle,
  VaultFactory,
  VaultHub,
  WithdrawalQueueERC721,
  WithdrawalVault,
  WstETH,
} from "typechain-types";

export type ProtocolNetworkItems = {
  locator: string;
  // signers
  agentAddress: string;
  votingAddress: string;
  easyTrackAddress: string;
  // foundation contracts
  accountingOracle: string;
  depositSecurityModule: string;
  elRewardsVault: string;
  legacyOracle: string;
  lido: string;
  accounting: string;
  oracleReportSanityChecker: string;
  burner: string;
  stakingRouter: string;
  validatorsExitBusOracle: string;
  withdrawalQueue: string;
  withdrawalVault: string;
  oracleDaemonConfig: string;
  wstETH: string;
  // aragon contracts
  kernel: string;
  acl: string;
  // stacking modules
  nor: string;
  sdvt: string;
  // hash consensus
  hashConsensus: string;
  // vaults
  stakingVaultFactory: string;
  stakingVaultBeacon: string;
  vaultHub: string;
};

export interface ContractTypes {
  LidoLocator: LidoLocator;
  AccountingOracle: AccountingOracle;
  DepositSecurityModule: DepositSecurityModule;
  LidoExecutionLayerRewardsVault: LidoExecutionLayerRewardsVault;
  LegacyOracle: LegacyOracle;
  Lido: Lido;
  Accounting: Accounting;
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
  WstETH: WstETH;
  VaultFactory: VaultFactory;
  UpgradeableBeacon: UpgradeableBeacon;
  VaultHub: VaultHub;
}

export type ContractName = keyof ContractTypes;
export type ContractType<Name extends ContractName> = ContractTypes[Name];

export type BaseContract = EthersBaseContract;

export type LoadedContract<T extends BaseContract = BaseContract> = T & {
  address: string;
};

export type CoreContracts = {
  accountingOracle: LoadedContract<AccountingOracle>;
  depositSecurityModule: LoadedContract<DepositSecurityModule>;
  elRewardsVault: LoadedContract<LidoExecutionLayerRewardsVault>;
  legacyOracle: LoadedContract<LegacyOracle>;
  lido: LoadedContract<Lido>;
  accounting: LoadedContract<Accounting>;
  oracleReportSanityChecker: LoadedContract<OracleReportSanityChecker>;
  burner: LoadedContract<Burner>;
  stakingRouter: LoadedContract<StakingRouter>;
  validatorsExitBusOracle: LoadedContract<ValidatorsExitBusOracle>;
  withdrawalQueue: LoadedContract<WithdrawalQueueERC721>;
  withdrawalVault: LoadedContract<WithdrawalVault>;
  oracleDaemonConfig: LoadedContract<OracleDaemonConfig>;
  wstETH: LoadedContract<WstETH>;
};

export type AragonContracts = {
  kernel: LoadedContract<Kernel>;
  acl: LoadedContract<ACL>;
};

export type StakingModuleContracts = {
  nor: LoadedContract<NodeOperatorsRegistry>;
  sdvt: LoadedContract<NodeOperatorsRegistry>;
};

export type StakingModuleName = "nor" | "sdvt";

export type HashConsensusContracts = {
  hashConsensus: LoadedContract<HashConsensus>;
};

export type WstETHContracts = {
  wstETH: LoadedContract<WstETH>;
};

export type VaultsContracts = {
  stakingVaultFactory: LoadedContract<VaultFactory>;
  stakingVaultBeacon: LoadedContract<UpgradeableBeacon>;
  vaultHub: LoadedContract<VaultHub>;
};

export type ProtocolContracts = { locator: LoadedContract<LidoLocator> } & CoreContracts &
  AragonContracts &
  StakingModuleContracts &
  HashConsensusContracts &
  WstETHContracts &
  VaultsContracts;

export type ProtocolSigners = {
  agent: string;
  voting: string;
  easyTrack: string;
};

export type Signer = keyof ProtocolSigners;

export type ProtocolContextFlags = {
  withCSM: boolean;
};

export type ProtocolContext = {
  contracts: ProtocolContracts;
  signers: ProtocolSigners;
  interfaces: Array<BaseContract["interface"]>;
  flags: ProtocolContextFlags;
  getSigner: (signer: Signer, balance?: bigint) => Promise<HardhatEthersSigner>;
  getEvents: (
    receipt: ContractTransactionReceipt,
    eventName: string,
    extraInterfaces?: Interface[], // additional interfaces to parse
  ) => LogDescription[];
};
