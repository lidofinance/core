import child_process from "node:child_process";
import fs from "node:fs/promises";
import util from "node:util";

import { ethers } from "hardhat";

import { log } from "lib";
import { DeploymentState, getAddress, readNetworkState, Sk, updateObjectInState } from "lib/state-file";

const DG_INSTALL_DIR = `${process.cwd()}/dg`;
const DG_DEPLOY_ARTIFACTS_DIR = `${DG_INSTALL_DIR}/deploy-artifacts`;

export async function main() {
  if (process.env.DG_DEPLOYMENT_ENABLED == "false") {
    log.header("DG deployment disabled");
    return;
  }

  log.header(`Deploy DG from folder ${DG_INSTALL_DIR}`);
  log.emptyLine();

  const deployerAccountNetworkName = process.env.DG_DEPLOYER_ACCOUNT_NETWORK_NAME || "";
  if (!deployerAccountNetworkName.length) {
    log.error(`You need to set the env variable DG_DEPLOYER_ACCOUNT_NETWORK_NAME to run DG deployment.
To do so, please place first a deployer private key to an accounts.json file in the next format:
{
  "eth": {
    "<DG_DEPLOYER_ACCOUNT_NETWORK_NAME>": ["<private key>"]
  }
}

Then set DG_DEPLOYER_ACCOUNT_NETWORK_NAME=<DG_DEPLOYER_ACCOUNT_NETWORK_NAME> in the .env file.
`);
    throw new Error("Env variable DG_DEPLOYER_ACCOUNT_NETWORK_NAME is not set.");
  }

  log.warning(`To run the deployment with the local Hardhat node you need to increase allowed memory usage to 16Gb.
> yarn hardhat node --fork <YOUR RPC URL> --port 8555 --max-memory 16384

AND

> export NODE_OPTIONS=--max_old_space_size=16384
`);

  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const network = await ethers.getDefaultProvider(process.env.LOCAL_RPC_URL).getNetwork();
  const chainId = `${network.chainId}`;

  const config = getDGConfig(chainId, state);

  const timestamp = `${Date.now()}`;
  const dgDeployConfigFilename = `deploy-config-scratch-${timestamp}.json`;
  await writeDGConfigFile(JSON.stringify(config, null, 2), dgDeployConfigFilename);

  const deployerPrivateKey = await getDeployerPrivateKey(deployerAccountNetworkName);

  if (!deployerPrivateKey.length) {
    throw new Error("Deployer private key not found");
  }

  let etherscanVerifyOption = "";
  let etherscanApiKey = "ETHERSCAN API KEY PLACEHOLDER";
  if (process.env.DG_ETHERSCAN_VERIFY == "true") {
    if (!process.env.ETHERSCAN_API_KEY) {
      throw new Error("Env variable ETHERSCAN_API_KEY is not set when DG_ETHERSCAN_VERIFY is set to true");
    }
    etherscanVerifyOption = "--verify";
    etherscanApiKey = process.env.ETHERSCAN_API_KEY;
  }

  await runCommand(
    `DEPLOY_CONFIG_FILE_NAME="${dgDeployConfigFilename}" RPC_URL="${process.env.LOCAL_RPC_URL}" ETHERSCAN_API_KEY="${etherscanApiKey}" DEPLOYER_ADDRESS="${deployer}" npm run forge:script scripts/deploy/DeployConfigurable.s.sol -- --broadcast --slow ${etherscanVerifyOption} --private-key ${deployerPrivateKey}`,
    DG_INSTALL_DIR,
  );

  await runDGRegressionTests(chainId, state, process.env.LOCAL_RPC_URL);

  const dgDeployArtifacts = await getDGDeployArtifacts(chainId);

  saveDGNetworkState(dgDeployArtifacts);
}

async function runDGRegressionTests(networkChainId: string, networkState: DeploymentState, rpcUrl: string) {
  log.header("Run DG regression tests");

  const deployArtifactFilename = await getLatestDGDeployArtifactFilename(networkChainId);

  const dotEnvFile = getDGDotEnvFile(deployArtifactFilename, networkState, rpcUrl);
  await writeDGDotEnvFile(dotEnvFile);

  try {
    await runCommand("npm run test:regressions", DG_INSTALL_DIR);
  } catch (error) {
    // TODO: some of regression tests don't work at the moment, need to fix it.
    log.error("DG regression tests run failed");
    log(`${error}`);
  }
}

async function runCommand(command: string, workingDirectory: string) {
  const exec = util.promisify(child_process.exec);

  try {
    const { stdout } = await exec(command, { cwd: workingDirectory });
    log("stdout:", stdout);
  } catch (error) {
    log.error(`Error running command ${command}`, `${error}`);
    throw error;
  }
}

async function writeDGConfigFile(dgConfig: string, filename: string) {
  const dgConfigFilePath = `${DG_INSTALL_DIR}/deploy-config/${filename}`;

  return writeFile(dgConfig, dgConfigFilePath, "config");
}

async function writeDGDotEnvFile(fileContent: string) {
  const dgDotEnvFilePath = `${DG_INSTALL_DIR}/.env`;

  return writeFile(fileContent, dgDotEnvFilePath, ".env");
}

async function writeFile(fileContent: string, filePath: string, fileKind: string) {
  try {
    await fs.writeFile(filePath, fileContent, "utf8");
    log.success(`${fileKind} file successfully saved to ${filePath}`);
  } catch (error) {
    log.error(`An error has occurred while writing DG ${filePath} file`, `${error}`);
    throw error;
  }
}

async function getLatestDGDeployArtifactFilename(networkChainId: string) {
  const deployArtifactFilenameRe = new RegExp(`deploy-artifact-${networkChainId}-\\d+.toml`, "ig");

  let files = [];
  try {
    files = await fs.readdir(DG_DEPLOY_ARTIFACTS_DIR);
  } catch (error) {
    log.error("An error has occurred while reading directory:", `${error}`);
    throw error;
  }

  files = files.filter((file) => file.match(deployArtifactFilenameRe)).sort();

  if (files.length === 0) {
    throw new Error("No deploy artifact file found");
  }

  return files[files.length - 1];
}

function getDGConfig(chainId: string, networkState: DeploymentState) {
  const daoVoting = getAddress(Sk.appVoting, networkState);
  const withdrawalQueue = getAddress(Sk.withdrawalQueueERC721, networkState);
  const stEth = getAddress(Sk.appLido, networkState);
  const wstEth = getAddress(Sk.wstETH, networkState);

  if (!networkState[Sk.dualGovernanceConfig]) {
    throw new Error("DG deploy config is not set, please specify it in the deploy-params-testnet.toml file");
  }

  return {
    chain_id: chainId,
    dual_governance: {
      admin_proposer: daoVoting,
      proposals_canceller: daoVoting,
      sealable_withdrawal_blockers: [], // TODO: add withdrawalQueue
      reseal_committee: daoVoting,
      tiebreaker_activation_timeout:
        networkState[Sk.dualGovernanceConfig].dual_governance.tiebreaker_activation_timeout,

      signalling_tokens: {
        st_eth: stEth,
        wst_eth: wstEth,
        withdrawal_queue: withdrawalQueue,
      },
      sanity_check_params: {
        max_min_assets_lock_duration:
          networkState[Sk.dualGovernanceConfig].dual_governance.sanity_check_params.max_min_assets_lock_duration,
        max_sealable_withdrawal_blockers_count:
          networkState[Sk.dualGovernanceConfig].dual_governance.sanity_check_params
            .max_sealable_withdrawal_blockers_count,
        max_tiebreaker_activation_timeout:
          networkState[Sk.dualGovernanceConfig].dual_governance.sanity_check_params.max_tiebreaker_activation_timeout,
        min_tiebreaker_activation_timeout:
          networkState[Sk.dualGovernanceConfig].dual_governance.sanity_check_params.min_tiebreaker_activation_timeout,
        min_withdrawals_batch_size:
          networkState[Sk.dualGovernanceConfig].dual_governance.sanity_check_params.min_withdrawals_batch_size,
      },
    },
    dual_governance_config_provider: {
      first_seal_rage_quit_support:
        networkState[Sk.dualGovernanceConfig].dual_governance_config_provider.first_seal_rage_quit_support,
      second_seal_rage_quit_support:
        networkState[Sk.dualGovernanceConfig].dual_governance_config_provider.second_seal_rage_quit_support,
      min_assets_lock_duration:
        networkState[Sk.dualGovernanceConfig].dual_governance_config_provider.min_assets_lock_duration,
      rage_quit_eth_withdrawals_delay_growth:
        networkState[Sk.dualGovernanceConfig].dual_governance_config_provider.rage_quit_eth_withdrawals_delay_growth,
      rage_quit_eth_withdrawals_min_delay:
        networkState[Sk.dualGovernanceConfig].dual_governance_config_provider.rage_quit_eth_withdrawals_min_delay,
      rage_quit_eth_withdrawals_max_delay:
        networkState[Sk.dualGovernanceConfig].dual_governance_config_provider.rage_quit_eth_withdrawals_max_delay,
      rage_quit_extension_period_duration:
        networkState[Sk.dualGovernanceConfig].dual_governance_config_provider.rage_quit_extension_period_duration,
      veto_cooldown_duration:
        networkState[Sk.dualGovernanceConfig].dual_governance_config_provider.veto_cooldown_duration,
      veto_signalling_deactivation_max_duration:
        networkState[Sk.dualGovernanceConfig].dual_governance_config_provider.veto_signalling_deactivation_max_duration,
      veto_signalling_min_active_duration:
        networkState[Sk.dualGovernanceConfig].dual_governance_config_provider.veto_signalling_min_active_duration,
      veto_signalling_min_duration:
        networkState[Sk.dualGovernanceConfig].dual_governance_config_provider.veto_signalling_min_duration,
      veto_signalling_max_duration:
        networkState[Sk.dualGovernanceConfig].dual_governance_config_provider.veto_signalling_max_duration,
    },
    timelock: {
      after_submit_delay: networkState[Sk.dualGovernanceConfig].timelock.after_submit_delay,
      after_schedule_delay: networkState[Sk.dualGovernanceConfig].timelock.after_schedule_delay,
      sanity_check_params: {
        min_execution_delay: networkState[Sk.dualGovernanceConfig].timelock.sanity_check_params.min_execution_delay,
        max_after_submit_delay:
          networkState[Sk.dualGovernanceConfig].timelock.sanity_check_params.max_after_submit_delay,
        max_after_schedule_delay:
          networkState[Sk.dualGovernanceConfig].timelock.sanity_check_params.max_after_schedule_delay,
        max_emergency_mode_duration:
          networkState[Sk.dualGovernanceConfig].timelock.sanity_check_params.max_emergency_mode_duration,
        max_emergency_protection_duration:
          networkState[Sk.dualGovernanceConfig].timelock.sanity_check_params.max_emergency_protection_duration,
      },
      emergency_protection: {
        emergency_activation_committee: daoVoting,
        emergency_execution_committee: daoVoting,
        emergency_governance_proposer: daoVoting,
        emergency_mode_duration:
          networkState[Sk.dualGovernanceConfig].timelock.emergency_protection.emergency_mode_duration,
        emergency_protection_end_date:
          networkState[Sk.dualGovernanceConfig].timelock.emergency_protection.emergency_protection_end_date,
      },
    },
    tiebreaker: {
      execution_delay: networkState[Sk.dualGovernanceConfig].tiebreaker.execution_delay,
      committees_count: 1,
      quorum: 1,
      committees: [
        {
          members: [daoVoting],
          quorum: 1,
        },
      ],
    },
  };
}

function getDGDotEnvFile(deployArtifactFilename: string, networkState: DeploymentState, rpcUrl: string) {
  const stEth = getAddress(Sk.appLido, networkState);
  const wstEth = getAddress(Sk.wstETH, networkState);
  const withdrawalQueue = getAddress(Sk.withdrawalQueueERC721, networkState);
  const hashConsensus = getAddress(Sk.hashConsensusForAccountingOracle, networkState);
  const burner = getAddress(Sk.burner, networkState);
  const accountingOracle = getAddress(Sk.accountingOracle, networkState);
  const elRewardsVault = getAddress(Sk.executionLayerRewardsVault, networkState);
  const withdrawalVault = getAddress(Sk.withdrawalVault, networkState);
  const oracleReportSanityChecker = getAddress(Sk.oracleReportSanityChecker, networkState);
  const acl = getAddress(Sk.aragonAcl, networkState);
  const ldo = getAddress(Sk.ldo, networkState);
  const daoAgent = getAddress(Sk.appAgent, networkState);
  const daoVoting = getAddress(Sk.appVoting, networkState);
  const daoTokenManager = getAddress(Sk.appTokenManager, networkState);

  return `MAINNET_RPC_URL=${rpcUrl}
DEPLOY_ARTIFACT_FILE_NAME=${deployArtifactFilename}
DG_TESTS_LIDO_ST_ETH=${stEth}
DG_TESTS_LIDO_WST_ETH=${wstEth}
DG_TESTS_LIDO_WITHDRAWAL_QUEUE=${withdrawalQueue}
DG_TESTS_LIDO_HASH_CONSENSUS=${hashConsensus}
DG_TESTS_LIDO_BURNER=${burner}
DG_TESTS_LIDO_ACCOUNTING_ORACLE=${accountingOracle}
DG_TESTS_LIDO_EL_REWARDS_VAULT=${elRewardsVault}
DG_TESTS_LIDO_WITHDRAWAL_VAULT=${withdrawalVault}
DG_TESTS_LIDO_ORACLE_REPORT_SANITY_CHECKER=${oracleReportSanityChecker}
DG_TESTS_LIDO_DAO_ACL=${acl}
DG_TESTS_LIDO_LDO_TOKEN=${ldo}
DG_TESTS_LIDO_DAO_AGENT=${daoAgent}
DG_TESTS_LIDO_DAO_VOTING=${daoVoting}
DG_TESTS_LIDO_DAO_TOKEN_MANAGER=${daoTokenManager}
`;
}

async function checkFileExists(path: string) {
  return fs
    .access(path)
    .then(() => true)
    .catch(() => false);
}

async function getDeployerPrivateKey(networkName: string): Promise<string> {
  const accountsFilePath = `${process.cwd()}/accounts.json`;

  const accountsFileExists = await checkFileExists(accountsFilePath);
  if (!accountsFileExists) {
    log.error(`accounts.json file not found at ${accountsFilePath}`);
    return "";
  }

  log(`accounts.json file found at ${accountsFilePath}`);

  const accountsFile = (await fs.readFile(accountsFilePath)).toString();
  let accountsJson;
  try {
    accountsJson = JSON.parse(accountsFile);
  } catch (error) {
    log.error("accounts.json is not a valid JSON file", `${error}`);
    return "";
  }

  const privateKeys = accountsJson.eth && accountsJson.eth[networkName];
  return Array.isArray(privateKeys) ? privateKeys[0] : "";
}

interface DGDeployArtifacts {
  admin_executor: string;
  dualGovernance: string;
  dual_governance_config_provider: string;
  emergency_governance: string;
  escrow_master_copy: string;
  reseal_manager: string;
  tiebreaker_core_committee: string;
  emergencyProtectedTimelock: string;
}

async function getDGDeployArtifacts(networkChainId: string): Promise<DGDeployArtifacts> {
  const deployArtifactFilename = await getLatestDGDeployArtifactFilename(networkChainId);
  const deployArtifactFilePath = `${DG_DEPLOY_ARTIFACTS_DIR}/${deployArtifactFilename}`;

  log(`Reading DG deploy artifact file: ${deployArtifactFilePath}`);

  const deployArtifactFile = (await fs.readFile(deployArtifactFilePath)).toString();

  const contractsAddressesRe = {
    admin_executor: /admin_executor = "(.+)"/,
    dualGovernance: /dual_governance = "(.+)"/,
    dual_governance_config_provider: /dual_governance_config_provider = "(.+)"/,
    emergency_governance: /emergency_governance = "(.+)"/,
    escrow_master_copy: /escrow_master_copy = "(.+)"/,
    reseal_manager: /reseal_manager = "(.+)"/,
    tiebreaker_core_committee: /tiebreaker_core_committee = "(.+)"/,
    // TODO: tiebreaker_sub_committees ?
    emergencyProtectedTimelock: /timelock = "(.+)"/,
  } as Record<keyof DGDeployArtifacts, RegExp>;

  const result = {} as DGDeployArtifacts;

  (Object.keys(contractsAddressesRe) as (keyof DGDeployArtifacts)[]).forEach((key) => {
    const address = deployArtifactFile.match(contractsAddressesRe[key]);
    log("ADDRESS", (address && address[0]) || "", (address && address[1]) || "");
    if (!address || address.length < 2 || !address[1].length) {
      throw new Error(`DG deploy artifact file corrupted: ${key} not found`);
    }

    result[key] = address[1];
  });

  return result;
}

function saveDGNetworkState(dgDeployArtifacts: DGDeployArtifacts) {
  (Object.keys(dgDeployArtifacts) as (keyof DGDeployArtifacts)[]).forEach((key) => {
    // TODO: sync operation!
    updateObjectInState(`dg:${key}` as Sk, { address: dgDeployArtifacts[key] });
  });
}
