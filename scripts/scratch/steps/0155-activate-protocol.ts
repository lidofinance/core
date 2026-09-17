import { ethers } from "hardhat";
import { readScratchParameters } from "scripts/utils/scratch";

import { Lido, LidoTemplate } from "typechain-types";

import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { log } from "lib/log";
import { isProtocolActivationEnabled } from "lib/scratch";
import { getAddress, readNetworkState, Sk } from "lib/state-file";

// Defaults match lib/protocol/provision.ts `ensureStakeLimit` so a production-driver
// activated deploy and the in-process test-driver provisioned deploy converge on the
// same staking limit. Used only when [protocolActivation] is absent from the config.
const DEFAULT_MAX_STAKE_LIMIT = ethers.parseEther("150000");
const DEFAULT_STAKE_LIMIT_INCREASE_PER_BLOCK = ethers.parseEther("20");

// Aragon CallsScript (spec id 0x00000001): for each action, the 20-byte target,
// the 4-byte big-endian calldata length, then the calldata. Run via Agent.forward,
// each call executes with the Agent as msg.sender.
function encodeCallScript(actions: { to: string; data: string }[]): string {
  return actions.reduce((script, { to, data }) => {
    const target = to.slice(2).toLowerCase().padStart(40, "0");
    const length = ((data.length - 2) / 2).toString(16).padStart(8, "0");
    return script + target + length + data.slice(2);
  }, "0x00000001");
}

// Optionally bring the freshly deployed protocol to an operational state without a vote:
// resume Lido (pool + staking) and set the staking rate limit. Routed through
// LidoTemplate.activateProtocol, which forwards an EVM script through the Agent (holder of
// Lido's RESUME_ROLE / STAKING_CONTROL_ROLE) while the template still manages the Agent's
// RUN_SCRIPT_ROLE — i.e. before step 0160 hands the Agent to Dual Governance. No-op unless
// PROTOCOL_ACTIVATION_ENABLED is set; by default the protocol stays paused and is resumed by
// governance after deploy (the historical scratch state). The sealables (WQ + VEBO) are
// resumed separately by step 0145, which also fires on protocol activation.
export async function main() {
  if (!isProtocolActivationEnabled()) {
    log("Protocol activation disabled — leaving the protocol paused (resume via governance later)");
    return;
  }

  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const lidoAddress = getAddress(Sk.appLido, state);
  const lido = await loadContract<Lido>("Lido", lidoAddress);
  const lidoTemplate = await loadContract<LidoTemplate>("LidoTemplate", getAddress(Sk.lidoTemplate, state));

  const activation = readScratchParameters().protocolActivation;
  const maxStakeLimit = activation ? BigInt(activation.maxStakeLimit) : DEFAULT_MAX_STAKE_LIMIT;
  const stakeLimitIncreasePerBlock = activation
    ? BigInt(activation.stakeLimitIncreasePerBlock)
    : DEFAULT_STAKE_LIMIT_INCREASE_PER_BLOCK;

  // Idempotency for a RESUME=1 re-run: Lido.resume() reverts if the pool is already active,
  // and re-applying the staking limit is needless once it is at the target.
  const [resumePool, stakeLimitInfo] = await Promise.all([lido.isStopped(), lido.getStakeLimitFullInfo()]);

  // maxStakeLimit == 0 means "resume without a rate limit" (see deploy-params-testnet.toml).
  // Lido.setStakingLimit(0, ..) reverts with ZERO_MAX_STAKE_LIMIT, so the no-limit case is
  // expressed as removeStakingLimit() instead — and skipped entirely when no limit is set yet
  // (the fresh-deploy default already has none). For a non-zero limit, set it once.
  const noLimit = maxStakeLimit === 0n;
  const setLimit = !noLimit && !stakeLimitInfo.isStakingLimitSet;
  const removeLimit = noLimit && stakeLimitInfo.isStakingLimitSet;

  if (!resumePool && !setLimit && !removeLimit) {
    log("Protocol already active and staking limit already at the target — nothing to do");
    return;
  }

  // Bundle the actions into one EVM script forwarded through the Agent. Encoding off-chain
  // keeps LidoTemplate under the EIP-170 size limit. resume() before the staking-limit change.
  const actions: { to: string; data: string }[] = [];
  if (resumePool) {
    actions.push({ to: lidoAddress, data: lido.interface.encodeFunctionData("resume") });
  }
  if (setLimit) {
    actions.push({
      to: lidoAddress,
      data: lido.interface.encodeFunctionData("setStakingLimit", [maxStakeLimit, stakeLimitIncreasePerBlock]),
    });
  }
  if (removeLimit) {
    actions.push({ to: lidoAddress, data: lido.interface.encodeFunctionData("removeStakingLimit") });
  }

  await makeTx(lidoTemplate, "activateProtocol", [encodeCallScript(actions)], { from: deployer });

  const stakingLimitSummary = setLimit
    ? `${maxStakeLimit}/${stakeLimitIncreasePerBlock}`
    : removeLimit
      ? "removed (no limit)"
      : "unchanged";
  log(`Protocol activated without a vote (resumePool=${resumePool}, stakingLimit=${stakingLimitSummary})`);
}
