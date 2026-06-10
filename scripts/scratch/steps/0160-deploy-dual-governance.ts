import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ethers, network } from "hardhat";
import { assertNoDevCommitteesOnPublicChain, DG_SUBMODULE_DIR, resolveDgForgeRpcUrl } from "scripts/scratch/dg-checks";
import { readScratchParameters, ScratchParameters } from "scripts/utils/scratch";

import * as toml from "@iarna/toml";

import { ACL, LidoTemplate, ValidatorsExitBusOracle, WithdrawalQueueERC721 } from "typechain-types";

import { DEFAULT_ADMIN_ROLE } from "lib/constants";
import { loadContract, LoadedContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { streccak } from "lib/keccak";
import { cy, log } from "lib/log";
import { isDGDeploymentEnabled } from "lib/scratch";
import { getAddress, persistNetworkState, readNetworkState, Sk, tryGetAddress } from "lib/state-file";
import { getCurrentBlockTimestamp } from "lib/time";

const RUN_SCRIPT_ROLE = streccak("RUN_SCRIPT_ROLE");
const PAUSE_ROLE = streccak("PAUSE_ROLE");
const RESUME_ROLE = streccak("RESUME_ROLE");

const DG_SUBMODULE = DG_SUBMODULE_DIR;
const DG_DEPLOY_CONFIG_DIR = path.join(DG_SUBMODULE, "deploy-config");
const DG_DEPLOY_ARTIFACTS_DIR = path.join(DG_SUBMODULE, "deploy-artifacts");
const DG_DEPLOY_CONFIG_FILE = "deploy-config-scratch.toml";

// snake_case key in the DG deploy artifact → Sk under which we store its address.
const DG_CONTRACT_FIELDS: Record<string, Sk> = {
  admin_executor: Sk.dgAdminExecutor,
  timelock: Sk.dgEmergencyProtectedTimelock,
  emergency_governance: Sk.dgEmergencyGovernance,
  dual_governance: Sk.dgDualGovernance,
  escrow_master_copy: Sk.dgEscrowMasterCopy,
  dual_governance_config_provider: Sk.dgConfigProvider,
  tiebreaker_core_committee: Sk.dgTiebreakerCoreCommittee,
};

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const agentAddress = getAddress(Sk.appAgent, state);
  const lidoTemplate = await loadContract<LidoTemplate>("LidoTemplate", getAddress(Sk.lidoTemplate, state));

  if (!isDGDeploymentEnabled()) {
    await finalizeWithoutDG(deployer, agentAddress, lidoTemplate);
    return;
  }

  const params = readScratchParameters();
  if (!params.dualGovernance) {
    throw new Error(
      "Scratch deploy params have no [dualGovernance] section. Add one (see deploy-params-testnet.toml) " +
        "or set DG_DEPLOYMENT_ENABLED=false to skip DG.",
    );
  }

  // Forge deploy is the one expensive, non-idempotent operation. If we already
  // have its output in state (from a previous run that died before finalize),
  // reuse it.
  let adminExecutorAddress = tryGetAddress(Sk.dgAdminExecutor, state);
  let resealManagerAddress = tryGetAddress(Sk.resealManager, state);
  if (!adminExecutorAddress || !resealManagerAddress) {
    ({ adminExecutorAddress, resealManagerAddress } = await runForgeAndPersist(deployer, state, params.dualGovernance));
    // forge runs as a blocking child process, so the JS-side keep-alive RPC
    // socket sits idle for the whole DG deploy (30-60s). Some nodes (notably
    // `hardhat node`) close idle keep-alive connections in that window, and the
    // first reused request then throws ECONNRESET. Drop the stale socket with a
    // retried probe before the post-forge txs run. (anvil keeps the socket, so
    // this is a no-op there.)
    await reEstablishRpcAfterForge();
  } else {
    log(`DG already deployed (admin executor ${cy(adminExecutorAddress)}); skipping forge deploy`);
  }

  // Each post-forge tx has its own guard so a partial failure (e.g. setOwner
  // reverted after finalize succeeded) doesn't leave the retry running into
  // permanently-broken state (renounceRole on a role the deployer no longer
  // holds, finalize on already-wiped deployState).
  await transferSealableRolesForDG(deployer, state, resealManagerAddress);

  const acl = await loadContract<ACL>("ACL", getAddress(Sk.aragonAcl, state));
  if (!(await acl["hasPermission(address,address,bytes32)"](adminExecutorAddress, agentAddress, RUN_SCRIPT_ROLE))) {
    await makeTx(lidoTemplate, "finalizePermissionsAfterDGDeployment", [adminExecutorAddress], { from: deployer });
  } else {
    log("AdminExecutor already has RUN_SCRIPT_ROLE on Agent — finalize already applied, skipping");
  }

  await setTemplateOwnerToAgent(deployer, agentAddress, lidoTemplate);

  log.success("Dual Governance deployed and launched via LidoTemplate");
}

async function finalizeWithoutDG(
  deployer: string,
  agentAddress: string,
  lidoTemplate: LoadedContract<LidoTemplate>,
): Promise<void> {
  log("DG deployment disabled — finalizing without Dual Governance");
  // The owner==Agent short-circuit lives in setTemplateOwnerToAgent; once the
  // template is owned by Agent, finalize has necessarily already run (it is
  // onlyOwner and precedes setOwner), so skipping both together is correct.
  const [currentOwner] = await lidoTemplate.getConfig();
  if (currentOwner.toLowerCase() !== agentAddress.toLowerCase()) {
    await makeTx(lidoTemplate, "finalizePermissionsWithoutDGDeployment", [], { from: deployer });
  }
  await setTemplateOwnerToAgent(deployer, agentAddress, lidoTemplate);
}

// Hand LidoTemplate ownership to Agent — the single "method" (A.15) shared by
// both the DG and non-DG finalize paths. Idempotent: a no-op once Agent owns it.
async function setTemplateOwnerToAgent(
  deployer: string,
  agentAddress: string,
  lidoTemplate: LoadedContract<LidoTemplate>,
): Promise<void> {
  const [currentOwner] = await lidoTemplate.getConfig();
  if (currentOwner.toLowerCase() === agentAddress.toLowerCase()) {
    log(`LidoTemplate owner is already Agent (${cy(agentAddress)}), skipping setOwner`);
    return;
  }
  await makeTx(lidoTemplate, "setOwner", [agentAddress], { from: deployer });
}

async function transferSealableRolesForDG(
  deployer: string,
  state: ReturnType<typeof readNetworkState>,
  resealManagerAddress: string,
): Promise<void> {
  const wq = await loadContract<WithdrawalQueueERC721>(
    "WithdrawalQueueERC721",
    getAddress(Sk.withdrawalQueueERC721, state),
  );
  const vebo = await loadContract<ValidatorsExitBusOracle>(
    "ValidatorsExitBusOracle",
    getAddress(Sk.validatorsExitBusOracle, state),
  );

  for (const [label, c] of [
    ["WithdrawalQueueERC721", wq],
    ["ValidatorsExitBusOracle", vebo],
  ] as const) {
    if (!(await c.hasRole(DEFAULT_ADMIN_ROLE, deployer))) {
      log(`${cy(label)}: deployer no longer holds DEFAULT_ADMIN_ROLE, sealable roles already wired, skipping`);
      continue;
    }
    log(`Wiring DG permissions on ${cy(label)} (${cy(await c.getAddress())})`);
    await makeTx(c, "grantRole", [PAUSE_ROLE, resealManagerAddress], { from: deployer });
    await makeTx(c, "grantRole", [RESUME_ROLE, resealManagerAddress], { from: deployer });
    await makeTx(c, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });
  }
}

async function runForgeAndPersist(
  deployer: string,
  state: ReturnType<typeof readNetworkState>,
  dgParams: NonNullable<ScratchParameters["dualGovernance"]>,
): Promise<{ adminExecutorAddress: string; resealManagerAddress: string }> {
  // Backstop for entry points that bypass the preflight — see dg-checks.ts.
  const rpcUrl = resolveDgForgeRpcUrl();

  const chainId = Number(state.chainId);
  assertNoDevCommitteesOnPublicChain(dgParams, chainId);
  const tomlContent = await renderDGConfigToml(dgParams, state, chainId);

  fs.mkdirSync(DG_DEPLOY_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(DG_DEPLOY_ARTIFACTS_DIR, { recursive: true });
  const configPath = path.join(DG_DEPLOY_CONFIG_DIR, DG_DEPLOY_CONFIG_FILE);
  fs.writeFileSync(configPath, tomlContent);
  log(`DG deploy config written: ${cy(configPath)}`);

  const before = listArtifactNames(chainId);
  runForgeDeploy(deployer, rpcUrl);
  const artifact = pickArtifactProducedBy(before, chainId);
  log(`DG deploy artifact: ${cy(artifact)}`);

  const parsed = toml.parse(fs.readFileSync(artifact, "utf8")) as Record<string, unknown>;
  const deployed = parsed.deployed_contracts as Record<string, unknown> | undefined;
  if (!deployed) {
    throw new Error(`Missing [deployed_contracts] in ${artifact}`);
  }

  for (const [snake, sk] of Object.entries(DG_CONTRACT_FIELDS)) {
    const addr = deployed[snake];
    if (typeof addr !== "string") {
      throw new Error(`Missing or non-address deployed_contracts.${snake} in ${artifact}`);
    }
    state[sk] = { address: addr };
  }
  const subCommittees = deployed.tiebreaker_sub_committees;
  if (!Array.isArray(subCommittees)) {
    throw new Error(`Missing deployed_contracts.tiebreaker_sub_committees in ${artifact}`);
  }
  state[Sk.dgTiebreakerSubCommittees] = { addresses: subCommittees };

  const resealManager = deployed.reseal_manager;
  if (typeof resealManager !== "string") {
    throw new Error(`Missing deployed_contracts.reseal_manager in ${artifact}`);
  }
  state[Sk.resealManager] = { address: resealManager };

  persistNetworkState(state);

  // The DG submodule's .gitignore covers deploy-config/* but not deploy-artifacts/.
  // Without cleanup, every local scratch deploy leaves untracked .toml files
  // that pollute `git status` of the parent repo.
  pruneArtifactsExcept(artifact, chainId);

  return {
    adminExecutorAddress: getAddress(Sk.dgAdminExecutor, state),
    resealManagerAddress: getAddress(Sk.resealManager, state),
  };
}

async function renderDGConfigToml(
  dg: NonNullable<ScratchParameters["dualGovernance"]>,
  state: ReturnType<typeof readNetworkState>,
  chainId: number,
): Promise<string> {
  const stETH = getAddress(Sk.appLido, state);
  const wstETH = getAddress(Sk.wstETH, state);
  const withdrawalQueue = getAddress(Sk.withdrawalQueueERC721, state);
  const vebo = getAddress(Sk.validatorsExitBusOracle, state);
  const voting = getAddress(Sk.appVoting, state);

  // Anchor on chain timestamp, not wall clock — anvil forks can be hours behind real time.
  const blockTs = await getCurrentBlockTimestamp();
  const emergencyProtectionEndDate = Number(blockTs) + dg.timelock.emergencyProtection.emergencyProtectionEndOffset;

  // BigInt for rage-quit-support D16 values (>2^53). ethers patches
  // BigInt.prototype.toJSON, which trips @iarna/toml's Date-detection check
  // (`'toISOString' in <bigint>` throws). Suppress the patch for the duration
  // of stringify so the library's native bigint→integer path runs.
  const bigIntProto = BigInt.prototype as unknown as { toJSON?: unknown };
  const savedToJSON = bigIntProto.toJSON;
  delete bigIntProto.toJSON;
  try {
    return toml.stringify({
      chain_id: chainId,
      dual_governance: {
        admin_proposer: voting,
        proposals_canceller: voting,
        reseal_committee: dg.resealCommittee,
        tiebreaker_activation_timeout: dg.tiebreakerActivationTimeout,
        sealable_withdrawal_blockers: [withdrawalQueue, vebo],
        signalling_tokens: {
          st_eth: stETH,
          wst_eth: wstETH,
          withdrawal_queue: withdrawalQueue,
        },
        sanity_check_params: {
          min_withdrawals_batch_size: dg.sanityCheckParams.minWithdrawalsBatchSize,
          min_tiebreaker_activation_timeout: dg.sanityCheckParams.minTiebreakerActivationTimeout,
          max_tiebreaker_activation_timeout: dg.sanityCheckParams.maxTiebreakerActivationTimeout,
          max_sealable_withdrawal_blockers_count: dg.sanityCheckParams.maxSealableWithdrawalBlockersCount,
          max_min_assets_lock_duration: dg.sanityCheckParams.maxMinAssetsLockDuration,
        },
      },
      dual_governance_config_provider: {
        first_seal_rage_quit_support: BigInt(dg.configProvider.firstSealRageQuitSupport),
        second_seal_rage_quit_support: BigInt(dg.configProvider.secondSealRageQuitSupport),
        min_assets_lock_duration: dg.configProvider.minAssetsLockDuration,
        veto_signalling_min_duration: dg.configProvider.vetoSignallingMinDuration,
        veto_signalling_min_active_duration: dg.configProvider.vetoSignallingMinActiveDuration,
        veto_signalling_max_duration: dg.configProvider.vetoSignallingMaxDuration,
        veto_signalling_deactivation_max_duration: dg.configProvider.vetoSignallingDeactivationMaxDuration,
        veto_cooldown_duration: dg.configProvider.vetoCooldownDuration,
        rage_quit_extension_period_duration: dg.configProvider.rageQuitExtensionPeriodDuration,
        rage_quit_eth_withdrawals_min_delay: dg.configProvider.rageQuitEthWithdrawalsMinDelay,
        rage_quit_eth_withdrawals_max_delay: dg.configProvider.rageQuitEthWithdrawalsMaxDelay,
        rage_quit_eth_withdrawals_delay_growth: dg.configProvider.rageQuitEthWithdrawalsDelayGrowth,
      },
      timelock: {
        after_submit_delay: dg.timelock.afterSubmitDelay,
        after_schedule_delay: dg.timelock.afterScheduleDelay,
        sanity_check_params: {
          min_execution_delay: dg.timelock.sanityCheckParams.minExecutionDelay,
          max_after_submit_delay: dg.timelock.sanityCheckParams.maxAfterSubmitDelay,
          max_after_schedule_delay: dg.timelock.sanityCheckParams.maxAfterScheduleDelay,
          max_emergency_mode_duration: dg.timelock.sanityCheckParams.maxEmergencyModeDuration,
          max_emergency_protection_duration: dg.timelock.sanityCheckParams.maxEmergencyProtectionDuration,
        },
        emergency_protection: {
          emergency_mode_duration: dg.timelock.emergencyProtection.emergencyModeDuration,
          emergency_protection_end_date: emergencyProtectionEndDate,
          emergency_governance_proposer: dg.timelock.emergencyProtection.emergencyGovernanceProposer,
          emergency_activation_committee: dg.timelock.emergencyProtection.emergencyActivationCommittee,
          emergency_execution_committee: dg.timelock.emergencyProtection.emergencyExecutionCommittee,
        },
      },
      tiebreaker: {
        quorum: dg.tiebreaker.quorum,
        // DG's TOML parser reads `committees_count` explicitly rather than inferring from the array.
        committees_count: dg.tiebreaker.committees.length,
        execution_delay: dg.tiebreaker.executionDelay,
        committees: dg.tiebreaker.committees.map((c) => ({ quorum: c.quorum, members: c.members })),
      },
    } as unknown as toml.JsonMap);
  } finally {
    if (savedToJSON !== undefined) {
      bigIntProto.toJSON = savedToJSON;
    }
  }
}

// Transient socket errors raised when a previously-pooled keep-alive connection
// was closed by the node while forge held the event loop.
const TRANSIENT_RPC_ERRORS = ["ECONNRESET", "ECONNREFUSED", "EPIPE", "socket hang up", "network socket disconnected"];

// Issue a trivial RPC call, retrying on transient socket errors, so the dead
// keep-alive connection is discarded and a fresh one is opened before the real
// post-forge transactions run. See the call site for why forge causes this.
async function reEstablishRpcAfterForge(): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await ethers.provider.getBlockNumber();
      return;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isTransient = TRANSIENT_RPC_ERRORS.some((needle) => message.includes(needle));
      if (attempt === maxAttempts || !isTransient) throw e;
      log.warning(`Post-forge RPC connection stale (${message}); reconnecting, attempt ${attempt}/${maxAttempts}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

function runForgeDeploy(deployer: string, rpcUrl: string) {
  // forge needs its own --private-key on a live RPC (no unlocked accounts).
  // Reuse whatever hardhat loaded for this network so the JS- and forge-side
  // signers stay in sync; fall through to --unlocked otherwise.
  const accounts = network.config.accounts;
  const privateKey = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : undefined;
  const signingArgs = privateKey ? ["--private-key", privateKey] : ["--unlocked", "--sender", deployer];

  const args = [
    "script",
    "scripts/deploy/DeployConfigurable.s.sol:DeployConfigurable",
    "--rpc-url",
    rpcUrl,
    "--broadcast",
    ...signingArgs,
    "--silent",
    "--skip",
    "test",
    // forge can pipeline receipts faster than a fork-backed anvil can respond
    // when fetching cold mainnet slots; --slow serializes broadcasts.
    "--slow",
  ];

  const argsForLog = privateKey ? args.map((a) => (a === privateKey ? "<redacted>" : a)) : args;
  log(
    `Running: ${cy(`forge ${argsForLog.join(" ")}`)} (cwd: ${cy(DG_SUBMODULE)}, ` +
      `signing: ${privateKey ? "--private-key from accounts.json" : "--unlocked"})`,
  );
  const result = spawnSync("forge", args, {
    cwd: DG_SUBMODULE,
    stdio: "inherit",
    env: { ...process.env, DEPLOY_CONFIG_FILE_NAME: DG_DEPLOY_CONFIG_FILE } as unknown as NodeJS.ProcessEnv,
  });

  if (result.error) {
    throw new Error(`Failed to spawn forge: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`forge script DeployConfigurable exited with status ${result.status}`);
  }
}

// Filename format from DG's DeployConfigurable.s.sol:
//   deploy-artifact-{chainId}-{block.timestamp}.toml
// We snapshot the artifact set before invoking forge and pick the new file
// after — no reliance on wall-clock mtime, robust to fork chains whose
// block.timestamp diverges from real time.
function listArtifactNames(chainId: number): Set<string> {
  if (!fs.existsSync(DG_DEPLOY_ARTIFACTS_DIR)) return new Set();
  const prefix = `deploy-artifact-${chainId}-`;
  return new Set(fs.readdirSync(DG_DEPLOY_ARTIFACTS_DIR).filter((f) => f.startsWith(prefix) && f.endsWith(".toml")));
}

function pickArtifactProducedBy(before: Set<string>, chainId: number): string {
  const after = listArtifactNames(chainId);
  const created = [...after].filter((f) => !before.has(f));
  if (created.length === 0) {
    throw new Error(`forge produced no new deploy-artifact-${chainId}-*.toml in ${DG_DEPLOY_ARTIFACTS_DIR}`);
  }
  if (created.length > 1) {
    // Should not happen in scratch — a single forge invocation writes one artifact.
    log.warning(`Multiple new artifacts found, picking highest-timestamp: ${created.join(", ")}`);
  }
  // Filename suffix is `{block.timestamp}.toml`; numeric sort is monotonic.
  created.sort((a, b) => artifactTs(b) - artifactTs(a));
  return path.join(DG_DEPLOY_ARTIFACTS_DIR, created[0]);
}

function artifactTs(name: string): number {
  const m = name.match(/-(\d+)\.toml$/);
  return m ? Number(m[1]) : 0;
}

function pruneArtifactsExcept(keepPath: string, chainId: number): void {
  const keep = path.basename(keepPath);
  const prefix = `deploy-artifact-${chainId}-`;
  for (const name of fs.readdirSync(DG_DEPLOY_ARTIFACTS_DIR)) {
    if (name === keep) continue;
    if (!name.startsWith(prefix) || !name.endsWith(".toml")) continue;
    fs.unlinkSync(path.join(DG_DEPLOY_ARTIFACTS_DIR, name));
  }
}
