import { execFileSync } from "child_process";
import fs from "fs";
import { ethers, network as hardhatNetwork } from "hardhat";
import path from "path";
import { getPrivateKey, getRpcUrl, prepareExternalProject, RPC_GAS_ARGS } from "scripts/utils/external-project";

import * as toml from "@iarna/toml";

import { IDualGovernance } from "typechain-types";

import { cy, loadContract, log, warmUpJsonRpcProvider } from "lib";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

// Runs after the Lido initialization (0120): the deploy verification reads the escrow rage quit support,
// which calls stETH getPooledEthByShares and needs the bootstrap shares.
// Runs before the staking modules (0135), so they take the real ResealManager.

const DUAL_GOVERNANCE_REPO = "https://github.com/lidofinance/dual-governance.git";
// Tag v1.0.2, the release deployed on Ethereum mainnet.
const DUAL_GOVERNANCE_REF = "ba9dfc9213ec888993937a699e2a587a0082720f";

type DualGovernanceDeployParameters = {
  tiebreakerActivationTimeout: number;
  sanityCheckParams: {
    minWithdrawalsBatchSize: number;
    minTiebreakerActivationTimeout: number;
    maxTiebreakerActivationTimeout: number;
    maxSealableWithdrawalBlockersCount: number;
    maxMinAssetsLockDuration: number;
  };
  configProvider: {
    firstSealRageQuitSupport: string;
    secondSealRageQuitSupport: string;
    minAssetsLockDuration: number;
    vetoSignallingMinDuration: number;
    vetoSignallingMinActiveDuration: number;
    vetoSignallingMaxDuration: number;
    vetoSignallingDeactivationMaxDuration: number;
    vetoCooldownDuration: number;
    rageQuitExtensionPeriodDuration: number;
    rageQuitEthWithdrawalsMinDelay: number;
    rageQuitEthWithdrawalsMaxDelay: number;
    rageQuitEthWithdrawalsDelayGrowth: number;
  };
  timelock: {
    afterSubmitDelay: number;
    afterScheduleDelay: number;
    sanityCheckParams: {
      minExecutionDelay: number;
      maxAfterSubmitDelay: number;
      maxAfterScheduleDelay: number;
      maxEmergencyModeDuration: number;
      maxEmergencyProtectionDuration: number;
    };
    emergencyModeDuration: number;
    emergencyProtectionDuration: number;
  };
  tiebreaker: {
    executionDelay: number;
  };
};

type DualGovernanceAddresses = {
  voting: string;
  stETH: string;
  wstETH: string;
  withdrawalQueue: string;
  committee: string;
};

// The deploy config format of scripts/deploy/DeployConfigurable.s.sol at DUAL_GOVERNANCE_REF.
// Voting is the admin proposer, the proposals canceller and the emergency governance proposer, as on mainnet.
// One address holds every committee role. The sealable withdrawal blockers are empty: DG refuses a paused
// sealable, and WithdrawalQueue and ValidatorsExitBusOracle stay paused until the protocol is activated.
function buildDeployConfig(
  chainId: bigint,
  emergencyProtectionEndDate: bigint,
  p: DualGovernanceDeployParameters,
  a: DualGovernanceAddresses,
): string {
  return `chain_id = ${chainId}

[dual_governance]
admin_proposer = "${a.voting}"
proposals_canceller = "${a.voting}"
reseal_committee = "${a.committee}"
tiebreaker_activation_timeout = ${p.tiebreakerActivationTimeout}
sealable_withdrawal_blockers = []

[dual_governance.signalling_tokens]
st_eth = "${a.stETH}"
wst_eth = "${a.wstETH}"
withdrawal_queue = "${a.withdrawalQueue}"

[dual_governance.sanity_check_params]
min_withdrawals_batch_size = ${p.sanityCheckParams.minWithdrawalsBatchSize}
min_tiebreaker_activation_timeout = ${p.sanityCheckParams.minTiebreakerActivationTimeout}
max_tiebreaker_activation_timeout = ${p.sanityCheckParams.maxTiebreakerActivationTimeout}
max_sealable_withdrawal_blockers_count = ${p.sanityCheckParams.maxSealableWithdrawalBlockersCount}
max_min_assets_lock_duration = ${p.sanityCheckParams.maxMinAssetsLockDuration}

[dual_governance_config_provider]
first_seal_rage_quit_support = ${p.configProvider.firstSealRageQuitSupport}
second_seal_rage_quit_support = ${p.configProvider.secondSealRageQuitSupport}
min_assets_lock_duration = ${p.configProvider.minAssetsLockDuration}
veto_signalling_min_duration = ${p.configProvider.vetoSignallingMinDuration}
veto_signalling_min_active_duration = ${p.configProvider.vetoSignallingMinActiveDuration}
veto_signalling_max_duration = ${p.configProvider.vetoSignallingMaxDuration}
veto_signalling_deactivation_max_duration = ${p.configProvider.vetoSignallingDeactivationMaxDuration}
veto_cooldown_duration = ${p.configProvider.vetoCooldownDuration}
rage_quit_extension_period_duration = ${p.configProvider.rageQuitExtensionPeriodDuration}
rage_quit_eth_withdrawals_min_delay = ${p.configProvider.rageQuitEthWithdrawalsMinDelay}
rage_quit_eth_withdrawals_max_delay = ${p.configProvider.rageQuitEthWithdrawalsMaxDelay}
rage_quit_eth_withdrawals_delay_growth = ${p.configProvider.rageQuitEthWithdrawalsDelayGrowth}

[timelock]
after_submit_delay = ${p.timelock.afterSubmitDelay}
after_schedule_delay = ${p.timelock.afterScheduleDelay}

[timelock.sanity_check_params]
min_execution_delay = ${p.timelock.sanityCheckParams.minExecutionDelay}
max_after_submit_delay = ${p.timelock.sanityCheckParams.maxAfterSubmitDelay}
max_after_schedule_delay = ${p.timelock.sanityCheckParams.maxAfterScheduleDelay}
max_emergency_mode_duration = ${p.timelock.sanityCheckParams.maxEmergencyModeDuration}
max_emergency_protection_duration = ${p.timelock.sanityCheckParams.maxEmergencyProtectionDuration}

[timelock.emergency_protection]
emergency_governance_proposer = "${a.voting}"
emergency_activation_committee = "${a.committee}"
emergency_execution_committee = "${a.committee}"
emergency_mode_duration = ${p.timelock.emergencyModeDuration}
emergency_protection_end_date = ${emergencyProtectionEndDate}

[tiebreaker]
quorum = 1
committees_count = 1
execution_delay = ${p.tiebreaker.executionDelay}

[[tiebreaker.committees]]
quorum = 1
members = ["${a.committee}"]
`;
}

function readDeployedAddress(contracts: Record<string, unknown>, key: string): string {
  const value = contracts[key];
  if (typeof value !== "string" || ethers.getAddress(value) === ethers.ZeroAddress) {
    throw new Error(`Dual Governance deploy artifact has no valid ${key} address`);
  }
  return ethers.getAddress(value);
}

async function requireCode(name: string, address: string) {
  if ((await ethers.provider.getCode(address)) === "0x") {
    throw new Error(`${name} at ${address} has no bytecode`);
  }
}

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const deployParameters = state[Sk.dgDualGovernance]?.deployParameters as DualGovernanceDeployParameters | undefined;
  if (!deployParameters) {
    log("Dual Governance is not configured in the scratch parameters, skipping");
    log.emptyLine();
    return;
  }

  // Check if DualGovernance address is already specified
  if (state[Sk.dgDualGovernance].proxy?.address) {
    log(`Using the specified DualGovernance address: ${cy(state[Sk.dgDualGovernance].proxy.address)}`);
    log.emptyLine();
    return;
  }

  if (hardhatNetwork.name === "hardhat") {
    throw new Error("Dual Governance requires an external scratch RPC for its Foundry deploy. Use NETWORK=local.");
  }

  const { emergencyProtectionDuration } = deployParameters.timelock;
  if (emergencyProtectionDuration > deployParameters.timelock.sanityCheckParams.maxEmergencyProtectionDuration) {
    throw new Error("Dual Governance emergencyProtectionDuration exceeds maxEmergencyProtectionDuration");
  }

  const { chainId } = await ethers.provider.getNetwork();
  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("Latest block is not available");
  const emergencyProtectionEndDate = BigInt(latestBlock.timestamp) + BigInt(emergencyProtectionDuration);

  const addresses: DualGovernanceAddresses = {
    voting: state[Sk.appVoting].proxy.address,
    stETH: state[Sk.appLido].proxy.address,
    wstETH: state[Sk.wstETH].address,
    withdrawalQueue: state[Sk.withdrawalQueueERC721].proxy.address,
    committee: deployer,
  };

  const tmpDir = prepareExternalProject("dual-governance", DUAL_GOVERNANCE_REPO, DUAL_GOVERNANCE_REF, [
    ["forge", "install"],
  ]);

  const configFileName = `scratch-${chainId}.toml`;
  fs.writeFileSync(
    path.join(tmpDir, "deploy-config", configFileName),
    buildDeployConfig(chainId, emergencyProtectionEndDate, deployParameters, addresses),
  );

  // The deploy script names its artifact by chain id and block timestamp. A replayed chain repeats
  // the name and the script overwrites the file, so take the artifact written by this run.
  const artifactsDir = path.join(tmpDir, "deploy-artifacts");
  const artifactPrefix = `deploy-artifact-${chainId}-`;
  const startedAt = Date.now();

  const forgeArgs = [
    "script",
    "scripts/deploy/DeployConfigurable.s.sol:DeployConfigurable",
    "--rpc-url",
    getRpcUrl(),
    "--private-key",
    getPrivateKey(),
    "--broadcast",
    "--slow",
    ...RPC_GAS_ARGS,
  ];

  log("Running Dual Governance deploy script...");
  execFileSync("forge", forgeArgs, {
    cwd: tmpDir,
    env: { ...process.env, DEPLOY_CONFIG_FILE_NAME: configFileName } as unknown as NodeJS.ProcessEnv,
    stdio: "inherit",
  });

  await warmUpJsonRpcProvider();

  const newArtifacts = fs
    .readdirSync(artifactsDir)
    .filter(
      (file) => file.startsWith(artifactPrefix) && fs.statSync(path.join(artifactsDir, file)).mtimeMs >= startedAt,
    );
  if (newArtifacts.length !== 1) {
    throw new Error(`Expected one new Dual Governance deploy artifact, found: ${newArtifacts.join(", ") || "none"}`);
  }

  const artifact = toml.parse(fs.readFileSync(path.join(artifactsDir, newArtifacts[0]), "utf8"));
  const deployedContracts = artifact.deployed_contracts as Record<string, unknown>;

  const dualGovernanceAddress = readDeployedAddress(deployedContracts, "dual_governance");
  const timelockAddress = readDeployedAddress(deployedContracts, "timelock");
  const resealManagerAddress = readDeployedAddress(deployedContracts, "reseal_manager");

  await requireCode("DualGovernance", dualGovernanceAddress);
  await requireCode("EmergencyProtectedTimelock", timelockAddress);
  await requireCode("ResealManager", resealManagerAddress);

  const dualGovernance = await loadContract<IDualGovernance>("IDualGovernance", dualGovernanceAddress);
  if ((await dualGovernance.getResealManager()) !== resealManagerAddress) {
    throw new Error("DualGovernance reseal manager does not match the deploy artifact");
  }

  updateObjectInState(Sk.dgDualGovernance, {
    proxy: { address: dualGovernanceAddress },
    deployArtifact: deployedContracts,
    repository: DUAL_GOVERNANCE_REPO,
    ref: DUAL_GOVERNANCE_REF,
  });
  updateObjectInState(Sk.dgEmergencyProtectedTimelock, {
    proxy: { address: timelockAddress },
  });
  updateObjectInState(Sk.resealManager, {
    address: resealManagerAddress,
  });

  log(`DualGovernance deployed at: ${cy(dualGovernanceAddress)}`);
  log(`EmergencyProtectedTimelock deployed at: ${cy(timelockAddress)}`);
  log(`ResealManager deployed at: ${cy(resealManagerAddress)}`);
  log.emptyLine();
}
