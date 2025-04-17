import hre from "hardhat";

import {
  AccountingOracle,
  ICSModule,
  Lido,
  LidoLocator,
  NodeOperatorsRegistry,
  StakingRouter,
  WithdrawalQueueERC721,
} from "typechain-types";

import { batch, log } from "lib";

import { getNetworkConfig, ProtocolNetworkConfig } from "./networks";
import {
  AragonContracts,
  ContractName,
  ContractType,
  CoreContracts,
  HashConsensusContracts,
  LoadedContract,
  ProtocolContracts,
  ProtocolSigners,
  StakingModuleContracts,
  VaultsContracts,
  WstETHContracts,
} from "./types";

const guard = (address: string, env: string) => {
  if (!address) throw new Error(`${address} address is not set, please set it in the environment variables: ${env}`);
};

const getDiscoveryConfig = async () => {
  const config = await getNetworkConfig(hre.network.name);
  if (!config) {
    throw new Error(`Network ${hre.network.name} is not supported`);
  }

  const locatorAddress = config.get("locator");
  const agentAddress = config.get("agentAddress");
  const votingAddress = config.get("votingAddress");
  const easyTrackExecutorAddress = config.get("easyTrackAddress");

  guard(locatorAddress, config.env.locator);
  guard(agentAddress, config.env.agentAddress);
  guard(votingAddress, config.env.votingAddress);
  guard(easyTrackExecutorAddress, config.env.easyTrackAddress);

  log.debug("Discovery config", {
    "Network": hre.network.name,
    "Source": config.source,
    "Locator address": locatorAddress,
    "Agent address": agentAddress,
    "Voting address": votingAddress,
    "Easy track executor address": easyTrackExecutorAddress,
  });

  return config;
};

/**
 * Load contract by name and address.
 */
const loadContract = async <Name extends ContractName>(name: Name, address: string) => {
  const contract = (await hre.ethers.getContractAt(name, address)) as unknown as LoadedContract<ContractType<Name>>;
  contract.address = address;
  return contract;
};

/**
 * Load all Lido protocol foundation contracts.
 */
const getCoreContracts = async (locator: LoadedContract<LidoLocator>, config: ProtocolNetworkConfig) => {
  return (await batch({
    accountingOracle: loadContract(
      "AccountingOracle",
      config.get("accountingOracle") || (await locator.accountingOracle()),
    ),
    depositSecurityModule: loadContract(
      "DepositSecurityModule",
      config.get("depositSecurityModule") || (await locator.depositSecurityModule()),
    ),
    elRewardsVault: loadContract(
      "LidoExecutionLayerRewardsVault",
      config.get("elRewardsVault") || (await locator.elRewardsVault()),
    ),
    lido: loadContract("Lido", config.get("lido") || (await locator.lido())),
    accounting: loadContract("Accounting", config.get("accounting") || (await locator.accounting())),
    oracleReportSanityChecker: loadContract(
      "OracleReportSanityChecker",
      config.get("oracleReportSanityChecker") || (await locator.oracleReportSanityChecker()),
    ),
    burner: loadContract("Burner", config.get("burner") || (await locator.burner())),
    stakingRouter: loadContract("StakingRouter", config.get("stakingRouter") || (await locator.stakingRouter())),
    validatorsExitBusOracle: loadContract(
      "ValidatorsExitBusOracle",
      config.get("validatorsExitBusOracle") || (await locator.validatorsExitBusOracle()),
    ),
    withdrawalQueue: loadContract(
      "WithdrawalQueueERC721",
      config.get("withdrawalQueue") || (await locator.withdrawalQueue()),
    ),
    withdrawalVault: loadContract(
      "WithdrawalVault",
      config.get("withdrawalVault") || (await locator.withdrawalVault()),
    ),
    oracleDaemonConfig: loadContract(
      "OracleDaemonConfig",
      config.get("oracleDaemonConfig") || (await locator.oracleDaemonConfig()),
    ),
  })) as CoreContracts;
};

/**
 * Load Aragon contracts required for protocol.
 */
const getAragonContracts = async (lido: LoadedContract<Lido>, config: ProtocolNetworkConfig) => {
  const kernelAddress = config.get("kernel") || (await lido.kernel());
  const kernel = await loadContract("Kernel", kernelAddress);
  return (await batch({
    kernel: new Promise((resolve) => resolve(kernel)), // Avoiding double loading
    acl: loadContract("ACL", config.get("acl") || (await kernel.acl())),
  })) as AragonContracts;
};

/**
 * Load staking modules contracts registered in the staking router.
 */
const getStakingModules = async (stakingRouter: LoadedContract<StakingRouter>, config: ProtocolNetworkConfig) => {
  const [nor, sdvt, csm] = await stakingRouter.getStakingModules();

  const promises: { [key: string]: Promise<LoadedContract<NodeOperatorsRegistry | ICSModule>> } = {
    nor: loadContract("NodeOperatorsRegistry", config.get("nor") || nor.stakingModuleAddress),
    sdvt: loadContract("NodeOperatorsRegistry", config.get("sdvt") || sdvt.stakingModuleAddress),
  };

  if (csm) {
    promises.csm = loadContract("ICSModule", config.get("csm") || csm.stakingModuleAddress);
  }

  return (await batch(promises)) as StakingModuleContracts;
};

/**
 * Load HashConsensus contract for accounting oracle.
 */
const getHashConsensusContract = async (
  accountingOracle: LoadedContract<AccountingOracle>,
  config: ProtocolNetworkConfig,
) => {
  const hashConsensusAddress = config.get("hashConsensus") || (await accountingOracle.getConsensusContract());
  return (await batch({
    hashConsensus: loadContract("HashConsensus", hashConsensusAddress),
  })) as HashConsensusContracts;
};

/**
 * Load wstETH contracts.
 * @notice https://github.com/lidofinance/core/issues/163 – wstETH contract should be a part of the CoreContracts
 */
const getWstEthContract = async (
  withdrawalQueue: LoadedContract<WithdrawalQueueERC721>,
  config: ProtocolNetworkConfig,
) => {
  const wstETHAddress = config.get("wstETH") || (await withdrawalQueue.WSTETH());
  return (await batch({
    wstETH: loadContract("WstETH", wstETHAddress),
  })) as WstETHContracts;
};

/**
 * Load all required vaults contracts.
 */
const getVaultsContracts = async (config: ProtocolNetworkConfig, locator: LoadedContract<LidoLocator>) => {
  return (await batch({
    stakingVaultFactory: loadContract("VaultFactory", config.get("stakingVaultFactory")),
    stakingVaultBeacon: loadContract("UpgradeableBeacon", config.get("stakingVaultBeacon")),
    vaultHub: loadContract("VaultHub", config.get("vaultHub") || (await locator.vaultHub())),
    predepositGuarantee: loadContract(
      "PredepositGuarantee",
      config.get("predepositGuarantee") || (await locator.predepositGuarantee()),
    ),
  })) as VaultsContracts;
};

export async function discover() {
  const networkConfig = await getDiscoveryConfig();
  const locator = await loadContract("LidoLocator", networkConfig.get("locator"));
  const foundationContracts = await getCoreContracts(locator, networkConfig);

  const contracts = {
    locator,
    ...foundationContracts,
    ...(await getAragonContracts(foundationContracts.lido, networkConfig)),
    ...(await getStakingModules(foundationContracts.stakingRouter, networkConfig)),
    ...(await getHashConsensusContract(foundationContracts.accountingOracle, networkConfig)),
    ...(await getWstEthContract(foundationContracts.withdrawalQueue, networkConfig)),
    ...(await getVaultsContracts(networkConfig, locator)),
  } as ProtocolContracts;

  log.debug("Contracts discovered", {
    "Locator": locator.address,
    "Lido": foundationContracts.lido.address,
    "Accounting": foundationContracts.accounting.address,
    "Accounting Oracle": foundationContracts.accountingOracle.address,
    "Hash Consensus": contracts.hashConsensus.address,
    "Execution Layer Rewards Vault": foundationContracts.elRewardsVault.address,
    "Withdrawal Queue": foundationContracts.withdrawalQueue.address,
    "Withdrawal Vault": foundationContracts.withdrawalVault.address,
    "Validators Exit Bus Oracle": foundationContracts.validatorsExitBusOracle.address,
    "Oracle Daemon Config": foundationContracts.oracleDaemonConfig.address,
    "Oracle Report Sanity Checker": foundationContracts.oracleReportSanityChecker.address,
    "Staking Router": foundationContracts.stakingRouter.address,
    "Deposit Security Module": foundationContracts.depositSecurityModule.address,
    "NOR": contracts.nor.address,
    "sDVT": contracts.sdvt.address,
    "Kernel": contracts.kernel.address,
    "ACL": contracts.acl.address,
    "Burner": foundationContracts.burner.address,
    "wstETH": contracts.wstETH.address,
    // Vaults
    "Staking Vault Factory": contracts.stakingVaultFactory.address,
    "Staking Vault Beacon": contracts.stakingVaultBeacon.address,
    "Vault Hub": contracts.vaultHub.address,
    "Predeposit Guarantee": contracts.predepositGuarantee.address,
  });

  const signers = {
    agent: networkConfig.get("agentAddress"),
    voting: networkConfig.get("votingAddress"),
    easyTrack: networkConfig.get("easyTrackAddress"),
  } as ProtocolSigners;

  log.debug("Signers discovered", signers);

  return { contracts, signers };
}
