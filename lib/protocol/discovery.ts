import hre from "hardhat";

import { AccountingOracle, Lido, LidoLocator, StakingRouter } from "typechain-types";

import { batch, log } from "lib";

import { networks } from "./networks";
import {
  AragonContracts,
  ContractName,
  ContractType,
  FoundationContracts,
  HashConsensusContracts,
  LoadedContract,
  ProtocolContracts,
  ProtocolSigners,
  StackingModulesContracts,
} from "./types";

// TODO: inflate config from whatever source is available (yaml, json, etc)

const guard = (address: string, env: string) => {
  if (!address) throw new Error(`${address} address is not set, please set it in the environment variables: ${env}`);
};

const getDiscoveryConfig = () => {
  const config = networks.get(hre.network.name);

  if (!config) {
    throw new Error(`Network ${hre.network.name} is not supported`);
  }

  const locatorAddress = process.env[config.env.locator] ?? config.defaults.locator ?? "";
  const agentAddress = process.env[config.env.agent] ?? config.defaults.agent ?? "";
  const votingAddress = process.env[config.env.voting] ?? config.defaults.voting ?? "";
  const easyTrackExecutorAddress = process.env[config.env.easyTrack] ?? config.defaults.easyTrack ?? "";

  guard(locatorAddress, config.env.locator);
  guard(agentAddress, config.env.agent);
  guard(votingAddress, config.env.voting);

  log.debug("Discovery config", {
    "Network": hre.network.name,
    "Locator address": locatorAddress,
    "Agent address": agentAddress,
    "Voting address": votingAddress,
    "Easy track executor address": easyTrackExecutorAddress,
  });

  return {
    locatorAddress,
    agentAddress,
    votingAddress,
    easyTrackExecutorAddress,
  };
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
const getFoundationContracts = async (locator: LoadedContract<LidoLocator>) =>
  (await batch({
    accountingOracle: loadContract("AccountingOracle", await locator.accountingOracle()),
    depositSecurityModule: loadContract("DepositSecurityModule", await locator.depositSecurityModule()),
    elRewardsVault: loadContract("LidoExecutionLayerRewardsVault", await locator.elRewardsVault()),
    legacyOracle: loadContract("LegacyOracle", await locator.legacyOracle()),
    lido: loadContract("Lido", await locator.lido()),
    oracleReportSanityChecker: loadContract("OracleReportSanityChecker", await locator.oracleReportSanityChecker()),
    burner: loadContract("Burner", await locator.burner()),
    stakingRouter: loadContract("StakingRouter", await locator.stakingRouter()),
    validatorsExitBusOracle: loadContract("ValidatorsExitBusOracle", await locator.validatorsExitBusOracle()),
    withdrawalQueue: loadContract("WithdrawalQueueERC721", await locator.withdrawalQueue()),
    withdrawalVault: loadContract("WithdrawalVault", await locator.withdrawalVault()),
    oracleDaemonConfig: loadContract("OracleDaemonConfig", await locator.oracleDaemonConfig()),
  })) as FoundationContracts;

/**
 * Load Aragon contracts required for protocol.
 */
const getAragonContracts = async (lido: LoadedContract<Lido>) => {
  const kernelAddress = await lido.kernel();
  const kernel = await loadContract("Kernel", kernelAddress);
  return (await batch({
    kernel: new Promise((resolve) => resolve(kernel)), // Avoiding double loading
    acl: loadContract("ACL", await kernel.acl()),
  })) as AragonContracts;
};

/**
 * Load staking modules contracts registered in the staking router.
 */
const getStakingModules = async (stakingRouter: LoadedContract<StakingRouter>) => {
  const [nor, sdvt] = await stakingRouter.getStakingModules();
  return (await batch({
    nor: loadContract("NodeOperatorsRegistry", nor.stakingModuleAddress),
    sdvt: loadContract("NodeOperatorsRegistry", sdvt.stakingModuleAddress),
  })) as StackingModulesContracts;
};

/**
 * Load HashConsensus contract for accounting oracle.
 */
const getHashConsensus = async (accountingOracle: LoadedContract<AccountingOracle>) => {
  const hashConsensusAddress = await accountingOracle.getConsensusContract();
  return (await batch({
    hashConsensus: loadContract("HashConsensus", hashConsensusAddress),
  })) as HashConsensusContracts;
};

export async function discover() {
  const networkConfig = getDiscoveryConfig();
  const locator = await loadContract("LidoLocator", networkConfig.locatorAddress);
  const foundationContracts = await getFoundationContracts(locator);

  const contracts = {
    locator,
    ...foundationContracts,
    ...(await getAragonContracts(foundationContracts.lido)),
    ...(await getStakingModules(foundationContracts.stakingRouter)),
    ...(await getHashConsensus(foundationContracts.accountingOracle)),
  } as ProtocolContracts;

  log.debug("Contracts discovered", {
    "Locator": locator.address,
    "Lido": foundationContracts.lido.address,
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
    "Legacy Oracle": foundationContracts.legacyOracle.address,
  });

  const signers = {
    agent: networkConfig.agentAddress,
    voting: networkConfig.votingAddress,
    easyTrack: networkConfig.easyTrackExecutorAddress,
  } as ProtocolSigners;

  log.debug("Signers discovered", signers);

  return { contracts, signers };
}
