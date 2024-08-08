import { readFileSync, writeFileSync } from "fs";
import { network as hardhatNetwork } from "hardhat";
import { resolve } from "path";

const NETWORK_STATE_FILE_BASENAME = "deployed";
const NETWORK_STATE_FILE_DIR = ".";

export type DeploymentState = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

export const AppNames = {
  // Lido apps
  LIDO: "lido",
  ORACLE: "oracle",
  NODE_OPERATORS_REGISTRY: "node-operators-registry",
  // Aragon apps
  ARAGON_AGENT: "aragon-agent",
  ARAGON_FINANCE: "aragon-finance",
  ARAGON_TOKEN_MANAGER: "aragon-token-manager",
  ARAGON_VOTING: "aragon-voting",
};

// State file contracts root keys
export enum Sk {
  deployer = "deployer",
  aragonEnsLabelName = "aragonEnsLabelName",
  apmRegistryFactory = "apmRegistryFactory",
  appLido = "app:lido",
  appOracle = `app:oracle`,
  appNodeOperatorsRegistry = "app:node-operators-registry",
  aragonAcl = "aragon-acl",
  aragonEvmScriptRegistry = "aragon-evm-script-registry",
  aragonApmRegistry = "aragon-apm-registry",
  aragonId = "aragonID",
  aragonKernel = "aragon-kernel",
  aragonRepoBase = "aragon-repo-base",
  appAgent = "app:aragon-agent",
  appFinance = "app:aragon-finance",
  appTokenManager = "app:aragon-token-manager",
  appVoting = "app:aragon-voting",
  daoFactory = "daoFactory",
  daoInitialSettings = "daoInitialSettings",
  ens = "ens",
  ensFactory = "ensFactory",
  ensNode = "ensNode",
  evmScriptRegistryFactory = "evmScriptRegistryFactory",
  ensSubdomainRegistrar = "ensSubdomainRegistrar",
  ldo = "ldo",
  // lido = "lido",
  lidoApm = "lidoApm",
  lidoApmEnsName = "lidoApmEnsName",
  lidoApmEnsRegDurationSec = "lidoApmEnsRegDurationSec",
  lidoTemplate = "lidoTemplate",
  miniMeTokenFactory = "miniMeTokenFactory",
  lidoTemplateCreateStdAppReposTx = "lidoTemplateCreateStdAppReposTx",
  createAppReposTx = "createAppReposTx",
  lidoTemplateNewDaoTx = "lidoTemplateNewDaoTx",
  callsScript = "callsScript",
  vestingParams = "vestingParams",
  withdrawalVault = "withdrawalVault",
  gateSeal = "gateSeal",
  stakingRouter = "stakingRouter",
  burner = "burner",
  executionLayerRewardsVault = "executionLayerRewardsVault",
  accountingOracle = "accountingOracle",
  depositSecurityModule = "depositSecurityModule",
  dummyEmptyContract = "dummyEmptyContract",
  eip712StETH = "eip712StETH",
  hashConsensusForAccountingOracle = "hashConsensusForAccountingOracle",
  hashConsensusForValidatorsExitBusOracle = "hashConsensusForValidatorsExitBusOracle",
  oracleDaemonConfig = "oracleDaemonConfig",
  oracleReportSanityChecker = "oracleReportSanityChecker",
  validatorsExitBusOracle = "validatorsExitBusOracle",
  withdrawalQueueERC721 = "withdrawalQueueERC721",
  depositContract = "depositContract",
  wstETH = "wstETH",
  lidoLocator = "lidoLocator",
  chainSpec = "chainSpec",
  scratchDeployGasUsed = "scratchDeployGasUsed",
  minFirstAllocationStrategy = "minFirstAllocationStrategy",
}

export function getAddress(contractKey: Sk, state: DeploymentState): string {
  switch (contractKey) {
    case Sk.accountingOracle:
    case Sk.appAgent:
    case Sk.appFinance:
    case Sk.appTokenManager:
    case Sk.appVoting:
    case Sk.appLido:
    case Sk.appNodeOperatorsRegistry:
    case Sk.appOracle:
    case Sk.aragonAcl:
    case Sk.aragonApmRegistry:
    case Sk.aragonEvmScriptRegistry:
    case Sk.aragonKernel:
    case Sk.lidoLocator:
    case Sk.stakingRouter:
    case Sk.validatorsExitBusOracle:
    case Sk.withdrawalQueueERC721:
    case Sk.withdrawalVault:
      return state[contractKey].proxy.address;
    case Sk.apmRegistryFactory:
    case Sk.burner:
    case Sk.callsScript:
    case Sk.daoFactory:
    case Sk.depositSecurityModule:
    case Sk.dummyEmptyContract:
    case Sk.eip712StETH:
    case Sk.ens:
    case Sk.ensFactory:
    case Sk.evmScriptRegistryFactory:
    case Sk.executionLayerRewardsVault:
    case Sk.gateSeal:
    case Sk.hashConsensusForAccountingOracle:
    case Sk.hashConsensusForValidatorsExitBusOracle:
    case Sk.ldo:
    case Sk.lidoApm:
    case Sk.lidoTemplate:
    case Sk.miniMeTokenFactory:
    case Sk.oracleDaemonConfig:
    case Sk.oracleReportSanityChecker:
    case Sk.wstETH:
    case Sk.depositContract:
      return state[contractKey].address;
    default:
      throw new Error(`Unsupported contract entry key ${contractKey}`);
  }
}

export function readNetworkState({
  deployer,
  networkStateFile,
}: {
  deployer?: string;
  networkStateFile?: string;
} = {}) {
  const fileName = networkStateFile
    ? resolve(NETWORK_STATE_FILE_DIR, networkStateFile)
    : _getFileName(hardhatNetwork.name, NETWORK_STATE_FILE_BASENAME, NETWORK_STATE_FILE_DIR);
  const state = _readStateFile(fileName);

  if (deployer !== undefined && deployer != state.deployer) {
    throw new Error(`The specified deployer ${deployer} does not match the one ${state.deployer} in the state file`);
  }

  return state;
}

export function updateObjectInState(key: Sk, supplement: object): DeploymentState {
  const state = readNetworkState();
  state[key] = {
    ...state[key],
    ...supplement,
  };
  persistNetworkState(state);
  return state as unknown as DeploymentState;
}

// path is either top level key or array of keys
export function setValueInState(key: Sk, value: unknown): DeploymentState {
  const state = readNetworkState();
  state[key] = value;
  persistNetworkState(state);
  return state;
}

export function incrementGasUsed(increment: bigint | number) {
  const state = readNetworkState();
  state[Sk.scratchDeployGasUsed] = (BigInt(state[Sk.scratchDeployGasUsed] || 0) + BigInt(increment)).toString();
  persistNetworkState(state);
  return state;
}

// If network name is undefined current hardhat network will be used
export function persistNetworkState(state: DeploymentState, networkName?: string) {
  networkName = networkName || hardhatNetwork.name;
  const fileName = _getFileName(networkName, NETWORK_STATE_FILE_BASENAME, NETWORK_STATE_FILE_DIR);

  const stateSorted = _sortKeysAlphabetically(state);
  const data = JSON.stringify(stateSorted, null, "  ");
  writeFileSync(fileName, data + "\n", "utf8");
}

function _getFileName(networkName: string, baseName: string, dir: string) {
  return resolve(dir, `${baseName}-${networkName}.json`);
}

function _readStateFile(fileName: string) {
  const data = readFileSync(fileName, "utf8");
  try {
    // return parseToDeploymentState(data);
    return JSON.parse(data) as DeploymentState;
  } catch (error) {
    throw new Error(`malformed network state file ${fileName}: ${(error as Error).message}`);
  }
}

function _sortKeysAlphabetically(unsortedObject: DeploymentState) {
  const sortedObject: DeploymentState = {};
  const sortedKeys = Object.keys(unsortedObject).sort();
  for (const key of sortedKeys) {
    sortedObject[key] = unsortedObject[key];
  }
  return sortedObject;
}
