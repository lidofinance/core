import { BaseContract as EthersBaseContract, ContractTransactionReceipt, Interface, LogDescription } from "ethers";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

export type LogDescriptionExtended = LogDescription & {
  address?: string;
};

import {
  Accounting,
  AccountingOracle,
  ACL,
  Burner,
  DepositSecurityModule,
  HashConsensus,
  IStakingModule,
  Kernel,
  Lido,
  LidoExecutionLayerRewardsVault,
  LidoLocator,
  NodeOperatorsRegistry,
  OperatorGrid,
  OracleDaemonConfig,
  OracleReportSanityChecker,
  PredepositGuarantee,
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
  csm: string;
  // hash consensus
  hashConsensus: string;
  // vaults
  stakingVaultFactory: string;
  stakingVaultBeacon: string;
  vaultHub: string;
  predepositGuarantee: string;
  operatorGrid: string;
};

export interface ContractTypes {
  LidoLocator: LidoLocator;
  AccountingOracle: AccountingOracle;
  DepositSecurityModule: DepositSecurityModule;
  LidoExecutionLayerRewardsVault: LidoExecutionLayerRewardsVault;
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
  PredepositGuarantee: PredepositGuarantee;
  NodeOperatorsRegistry: NodeOperatorsRegistry;
  WstETH: WstETH;
  VaultFactory: VaultFactory;
  UpgradeableBeacon: UpgradeableBeacon;
  VaultHub: VaultHub;
  OperatorGrid: OperatorGrid;
  IStakingModule: IStakingModule;
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
  csm?: LoadedContract<IStakingModule>;
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
  predepositGuarantee: LoadedContract<PredepositGuarantee>;
  operatorGrid: LoadedContract<OperatorGrid>;
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
  isScratch: boolean;
  getSigner: (signer: Signer, balance?: bigint) => Promise<HardhatEthersSigner>;
  getEvents: (
    receipt: ContractTransactionReceipt,
    eventName: string,
    extraInterfaces?: Interface[], // additional interfaces to parse
  ) => LogDescriptionExtended[];
};
