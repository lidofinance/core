import assert from "assert";
import { Contract, JsonRpcProvider } from "ethers";
import { ethers } from "hardhat";

import { advanceChainTime, ether, log } from "lib";
import { readNetworkState, Sk } from "lib/state-file";

const ONE_HOUR = 3600n;
const DG_ABI = [
  "function getProposers() view returns ((address account,address executor)[])",
  "function submitProposal((address target,uint96 value,bytes payload)[] calls,string metadata) returns (uint256 proposalId)",
  "function scheduleProposal(uint256 proposalId)",
];
const TIMELOCK_ABI = [
  "function getAfterSubmitDelay() view returns (uint32)",
  "function getAfterScheduleDelay() view returns (uint32)",
  "function execute(uint256 proposalId)",
];
const VOTE_SCRIPT_ABI = [
  "function AGENT() view returns (address)",
  "function ITEMS_COUNT() view returns (uint256)",
  "function getAgentForwardCalldata() view returns (bytes)",
];

async function getRpcProvider() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    throw new Error("RPC_URL is required");
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const clientVersion = String(await provider.send("web3_clientVersion", []));
  const clientLower = clientVersion.toLowerCase();
  const rpcPrefix = clientLower.includes("anvil") ? "anvil" : "hardhat";

  return { provider, rpcPrefix };
}

async function impersonateRpc(provider: JsonRpcProvider, rpcPrefix: string, address: string) {
  await provider.send(`${rpcPrefix}_impersonateAccount`, [address]);
  await provider.send(`${rpcPrefix}_setBalance`, [address, ethers.toQuantity(ether("100"))]);
  return provider.getSigner(address);
}

export async function main(): Promise<void> {
  const deployer = (await ethers.provider.getSigner()).address;
  assert.equal(process.env.DEPLOYER, deployer);

  // State file can be imported from another environment with a different historical deployer.
  // For vote execution on forks we only need addresses from that state, not deployer equality.
  const state = readNetworkState();
  const voteScriptAddress = state[Sk.stakingRouterV3VoteScript]?.address;
  const dualGovernanceAddress = state[Sk.dgDualGovernance]?.proxy?.address;
  const timelockAddress = state[Sk.dgEmergencyProtectedTimelock]?.proxy?.address;

  if (!voteScriptAddress) {
    throw new Error(`State key ${Sk.stakingRouterV3VoteScript} is missing. Run deploy step first.`);
  }
  if (!dualGovernanceAddress) {
    throw new Error(`State key ${Sk.dgDualGovernance} is missing in state file.`);
  }
  if (!timelockAddress) {
    throw new Error(`State key ${Sk.dgEmergencyProtectedTimelock} is missing in state file.`);
  }

  const { provider: rpcProvider, rpcPrefix } = await getRpcProvider();
  const voteScript = new Contract(voteScriptAddress, VOTE_SCRIPT_ABI, rpcProvider);
  const dualGovernance = new Contract(dualGovernanceAddress, DG_ABI, rpcProvider);
  const timelock = new Contract(timelockAddress, TIMELOCK_ABI, rpcProvider);

  const agentAddress = (await voteScript.getFunction("AGENT")()) as string;
  const itemsCount = (await voteScript.getFunction("ITEMS_COUNT")()) as bigint;
  const agentForwardCalldata = (await voteScript.getFunction("getAgentForwardCalldata")()) as string;

  const proposers = (await dualGovernance.getFunction("getProposers")()) as { account: string; executor: string }[];
  const preferredProposer = process.env.STAKING_ROUTER_V3_VOTE_PROPOSER || state[Sk.appVoting]?.proxy?.address;
  const proposer = proposers.find((p) => p.account.toLowerCase() === preferredProposer?.toLowerCase()) ?? proposers[0];

  if (!proposer) {
    throw new Error("No proposer found in DualGovernance.");
  }

  const proposerAddress = proposer.account;
  const executorAddress =
    process.env.STAKING_ROUTER_V3_VOTE_EXECUTOR ||
    (typeof proposer.executor === "string" && proposer.executor !== ethers.ZeroAddress ? proposer.executor : undefined);

  if (!executorAddress) {
    throw new Error("DualGovernance proposer has no executor and STAKING_ROUTER_V3_VOTE_EXECUTOR is not set.");
  }

  const proposalMetadata = process.env.STAKING_ROUTER_V3_VOTE_PROPOSAL_METADATA || "staking-router-v3-vote";
  const proposalCalls = [{ target: agentAddress, value: 0n, payload: agentForwardCalldata }];

  log.info("Prepared StakingRouterV3 vote script for DG execution", {
    voteScript: voteScriptAddress,
    itemsCount: itemsCount.toString(),
    dualGovernance: dualGovernanceAddress,
    timelock: timelockAddress,
    proposer: proposerAddress,
    executor: executorAddress,
  });

  const proposerSigner = await impersonateRpc(rpcProvider, rpcPrefix, proposerAddress);
  const executorSigner = await impersonateRpc(rpcProvider, rpcPrefix, executorAddress);

  const proposalId = (await dualGovernance
    .connect(proposerSigner)
    .getFunction("submitProposal")
    .staticCall(proposalCalls, proposalMetadata)) as bigint;

  const submitTx = await dualGovernance.connect(proposerSigner).getFunction("submitProposal")(
    proposalCalls,
    proposalMetadata,
  );
  await log.txLink(submitTx.hash);
  const submitReceipt = await submitTx.wait();
  if (!submitReceipt) {
    throw new Error("submitProposal transaction was not mined");
  }
  log.success("DG proposal submitted", proposalId.toString());

  const afterSubmitDelay = (await timelock.getFunction("getAfterSubmitDelay")()) as bigint;
  await advanceChainTime(afterSubmitDelay);
  const scheduleTx = await dualGovernance.connect(proposerSigner).getFunction("scheduleProposal")(proposalId);
  await log.txLink(scheduleTx.hash);
  const scheduleReceipt = await scheduleTx.wait();
  if (!scheduleReceipt) {
    throw new Error("scheduleProposal transaction was not mined");
  }
  log.success("DG proposal scheduled", proposalId.toString());

  const afterScheduleDelay = (await timelock.getFunction("getAfterScheduleDelay")()) as bigint;
  await advanceChainTime(afterScheduleDelay);

  const maxExecuteRetries = Number(process.env.STAKING_ROUTER_V3_VOTE_EXECUTE_RETRIES || "0");
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxExecuteRetries; attempt++) {
    try {
      const executeTx = await timelock.connect(executorSigner).getFunction("execute")(proposalId);
      await log.txLink(executeTx.hash);
      const executeReceipt = await executeTx.wait();
      if (!executeReceipt) {
        throw new Error("timelock.execute transaction was not mined");
      }
      log.success("Atomic StakingRouterV3 vote script executed via Dual Governance", proposalId.toString());
      log.info("Execution receipt", {
        txHash: executeTx.hash,
        gasUsed: executeReceipt.gasUsed.toString(),
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxExecuteRetries) {
        await advanceChainTime(ONE_HOUR);
      }
    }
  }

  throw new Error(`Failed to execute proposal ${proposalId.toString()}. ` + `Original error: ${String(lastError)}`);
}
