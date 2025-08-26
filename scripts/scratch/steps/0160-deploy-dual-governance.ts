import child_process from "node:child_process";
import fs from "node:fs/promises";
import util from "node:util";

import { ethers } from "hardhat";

import { log } from "lib";
import { readNetworkState, Sk, getAddress, DeploymentState } from "lib/state-file";

export async function main() {
  // TODO: consider making DG installation optional, for example with env var
  log.header("Deploy DG");
  log.emptyLine();

  const deployerAccountName = process.env.DG_DEPLOYER_ACCOUNT_NAME || "";
  if (!deployerAccountName.length) {
    log.error(`You need to set the env variable DG_DEPLOYER_ACCOUNT_NAME to run DG deployment.
To do so, please create a new cast wallet account (see https://getfoundry.sh/cast/reference/wallet/) with the current deployer private key:
> cast wallet import <DEPLOYER ACCOUNT NAME>

Then set DG_DEPLOYER_ACCOUNT_NAME=<DEPLOYER ACCOUNT NAME> in the .env file.
`);
    throw new Error("Env variable DG_DEPLOYER_ACCOUNT_NAME is not set.");
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

  await runCommand(`DEPLOY_CONFIG_FILE_NAME="${dgDeployConfigFilename}" RPC_URL="${process.env.LOCAL_RPC_URL}" ETHERSCAN_API_KEY="foobar" DEPLOYER_ADDRESS="${deployer}" DEPLOYER_ACCOUNT="${deployerAccountName}" npm run forge:script scripts/deploy/DeployConfigurable.s.sol -- --broadcast --slow`, `${process.cwd()}/node_modules/@lido/dual-governance`);

  await runDGRegressionTests(chainId, state, process.env.LOCAL_RPC_URL);
}

async function runDGRegressionTests(networkChainId: string, networkState: DeploymentState, rpcUrl: string) {
  log.header("Run DG regression tests");

  const deployArtifactFilename = await getLatestDGDeployArtifactFilename(networkChainId);

  const dotEnvFile = getDGDotEnvFile(deployArtifactFilename, networkState, rpcUrl);
  await writeDGDotEnvFile(dotEnvFile);

  try {
    await runCommand("npm run test:regressions", `${process.cwd()}/node_modules/@lido/dual-governance`);
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
  const dgConfigDirPath = `${process.cwd()}/node_modules/@lido/dual-governance/deploy-config`;
  const dgConfigFilePath = `${dgConfigDirPath}/${filename}`;

  return writeFile(dgConfig, dgConfigFilePath, "config");
}

async function writeDGDotEnvFile(fileContent: string) {
  const dgDirPath = `${process.cwd()}/node_modules/@lido/dual-governance`;
  const dgDotEnvFilePath = `${dgDirPath}/.env`;

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
  const dgDeployArtifactsDirPath = `${process.cwd()}/node_modules/@lido/dual-governance/deploy-artifacts`;
  const deployArtifactFilenameRe = new RegExp(`deploy-artifact-${networkChainId}-\\d+.toml`, "ig");

  let files = [];
  try {
    files = await fs.readdir(dgDeployArtifactsDirPath);
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

  return {
    chain_id: chainId,
    dual_governance: {
      admin_proposer: daoVoting,
      proposals_canceller: daoVoting,
      sealable_withdrawal_blockers: [], // TODO: add withdrawalQueue
      reseal_committee: daoVoting,
      tiebreaker_activation_timeout: 31536000,

      signalling_tokens: {
        st_eth: stEth,
        wst_eth: wstEth,
        withdrawal_queue: withdrawalQueue,
      },
      sanity_check_params: {
        max_min_assets_lock_duration: 4147200,
        max_sealable_withdrawal_blockers_count: 255,
        max_tiebreaker_activation_timeout: 63072000,
        min_tiebreaker_activation_timeout: 15768000,
        min_withdrawals_batch_size: 4,
      }
    },
    dual_governance_config_provider: {
      first_seal_rage_quit_support: "10000000000000000",
      second_seal_rage_quit_support: "100000000000000000",
      min_assets_lock_duration: 18000,
      rage_quit_eth_withdrawals_delay_growth: 1296000,
      rage_quit_eth_withdrawals_min_delay: 5184000,
      rage_quit_eth_withdrawals_max_delay: 15552000,
      rage_quit_extension_period_duration: 604800,
      veto_cooldown_duration: 18000,
      veto_signalling_deactivation_max_duration: 259200,
      veto_signalling_min_active_duration: 18000,
      veto_signalling_min_duration: 432000,
      veto_signalling_max_duration: 3888000,
    },
    timelock: {
      after_submit_delay: 259200,
      after_schedule_delay: 86400,
      sanity_check_params: {
        min_execution_delay: 259200,
        max_after_submit_delay: 2592000,
        max_after_schedule_delay: 864000,
        max_emergency_mode_duration: 31536000,
        max_emergency_protection_duration: 94608000,
      },
      emergency_protection: {
        emergency_activation_committee: daoVoting,
        emergency_execution_committee: daoVoting,
        emergency_governance_proposer: daoVoting,
        emergency_mode_duration: 2592000,
        emergency_protection_end_date: 1781913600,
      },
    },
    tiebreaker: {
      execution_delay: 2592000,
      committees_count: 1,
      quorum: 1,
      committees: [
        {
          members: [
            daoVoting,
          ],
          quorum: 1,
        }
      ]
    }
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
