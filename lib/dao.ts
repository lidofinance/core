import { ContractTransactionReceipt, ContractTransactionResponse, ethers, Signer } from "ethers";

import {
  ACL__factory,
  IDualGovernance__factory,
  ITimelock__factory,
  TokenManager__factory,
  Voting__factory,
} from "typechain-types";

import { DeploymentState, Sk } from "./state-file";

/** A call that the DAO makes: by its voting itself, or by the Agent. */
export type DaoCall = { to: string; data: string };

/**
 * One DAO decision. `voting` calls are made by the DAO's voting itself, such as changes of the ACL
 * permissions it manages. `agent` calls are made by the Agent.
 */
export interface DaoDecision {
  description: string;
  voting?: DaoCall[];
  agent?: DaoCall[];
}

/** How a decision sends its transactions and waits for protocol time on a given network. */
export interface DaoRunner {
  /** An LDO holder that creates, supports and executes the vote. */
  signer: Signer;
  send(tx: Promise<ContractTransactionResponse>): Promise<ContractTransactionReceipt>;
  /** Returns once `ready()` holds; `time` is the earliest block timestamp at which it can. */
  waitUntil(time: bigint, ready: () => Promise<boolean>): Promise<void>;
}

/**
 * Who controls the Agent. In Agent mode the DAO's voting holds the Agent's `RUN_SCRIPT_ROLE`. After
 * the Dual Governance launch only Dual Governance's admin executor holds it.
 */
export type DaoMode = "agent" | "dualGovernance";

const RUN_SCRIPT_ROLE = ethers.id("RUN_SCRIPT_ROLE");
const agentInterface = new ethers.Interface(["function execute(address,uint256,bytes)"]);

/** Aragon EVM script: spec 1, then each call as address, calldata length and calldata. */
function callsScript(calls: DaoCall[]): string {
  return ethers.concat([
    "0x00000001",
    ...calls.flatMap(({ to, data }) => [to, ethers.toBeHex(ethers.dataLength(data), 4), data]),
  ]);
}

export async function daoMode(state: DeploymentState, signer: Signer): Promise<DaoMode> {
  const acl = ACL__factory.connect(state[Sk.aragonAcl].proxy.address, signer);
  const hasPermission = acl["hasPermission(address,address,bytes32)"];
  const agent = state[Sk.appAgent].proxy.address;
  if (await hasPermission(state[Sk.appVoting].proxy.address, agent, RUN_SCRIPT_ROLE)) return "agent";
  const adminExecutor = state[Sk.dgDualGovernance]?.deployArtifact?.admin_executor;
  if (adminExecutor && (await hasPermission(adminExecutor, agent, RUN_SCRIPT_ROLE))) return "dualGovernance";
  throw new Error("Neither the DAO's voting nor Dual Governance controls the Agent");
}

/**
 * Execute one DAO decision whichever governs the Agent. In Agent mode one vote makes every call. In
 * Dual Governance mode the vote makes the voting's calls and submits the Agent's calls as one
 * proposal, which is scheduled and executed after the timelock's delays.
 */
export async function executeDaoDecision(decision: DaoDecision, state: DeploymentState, runner: DaoRunner) {
  const votingCalls = decision.voting ?? [];
  const agentCalls = decision.agent ?? [];
  if (!votingCalls.length && !agentCalls.length) return;

  const agent = state[Sk.appAgent].proxy.address;
  const agentExecutions = agentCalls.map(({ to, data }) => ({
    to: agent,
    data: agentInterface.encodeFunctionData("execute", [to, 0n, data]),
  }));

  const mode = agentCalls.length ? await daoMode(state, runner.signer) : "agent";
  if (mode === "agent") {
    await vote([...votingCalls, ...agentExecutions], decision.description, state, runner);
    return;
  }

  const dualGovernance = IDualGovernance__factory.connect(state[Sk.dgDualGovernance].proxy.address, runner.signer);
  const timelock = ITimelock__factory.connect(state[Sk.dgEmergencyProtectedTimelock].proxy.address, runner.signer);
  const submission = {
    to: state[Sk.dgDualGovernance].proxy.address,
    data: dualGovernance.interface.encodeFunctionData("submitProposal", [
      agentExecutions.map(({ to, data }) => ({ target: to, value: 0n, payload: data })),
      decision.description,
    ]),
  };
  const proposalsBefore = await timelock.getProposalsCount();
  await vote([...votingCalls, submission], decision.description, state, runner);
  const proposalId = await timelock.getProposalsCount();
  if (proposalId !== proposalsBefore + 1n) throw new Error(`The vote "${decision.description}" submitted no proposal`);

  const submitted = await timelock.getProposalDetails(proposalId);
  await runner.waitUntil(submitted.submittedAt + (await timelock.getAfterSubmitDelay()), () =>
    timelock.canSchedule(proposalId),
  );
  await runner.send(dualGovernance.scheduleProposal(proposalId));

  const scheduled = await timelock.getProposalDetails(proposalId);
  await runner.waitUntil(scheduled.scheduledAt + (await timelock.getAfterScheduleDelay()), () =>
    timelock.canExecute(proposalId),
  );
  await runner.send(timelock.execute(proposalId));
}

async function vote(calls: DaoCall[], description: string, state: DeploymentState, runner: DaoRunner) {
  const voting = Voting__factory.connect(state[Sk.appVoting].proxy.address, runner.signer);
  const tokenManager = TokenManager__factory.connect(state[Sk.appTokenManager].proxy.address, runner.signer);
  const newVote = voting.interface.encodeFunctionData("newVote(bytes,string)", [callsScript(calls), description]);
  const created = await runner.send(
    tokenManager.forward(callsScript([{ to: state[Sk.appVoting].proxy.address, data: newVote }])),
  );
  const started = created.logs
    .filter((entry) => entry.address.toLowerCase() === state[Sk.appVoting].proxy.address.toLowerCase())
    .map((entry) => voting.interface.parseLog(entry))
    .find((parsed) => parsed?.name === "StartVote");
  if (!started) throw new Error(`The vote "${description}" was not created`);
  const voteId: bigint = started.args.voteId;

  await runner.send(voting.vote(voteId, true, false));
  const { startDate } = await voting.getVote(voteId);
  await runner.waitUntil(startDate + (await voting.voteTime()), () => voting.canExecute(voteId));
  await runner.send(voting.executeVote(voteId));
  if (!(await voting.getVote(voteId)).executed) throw new Error(`Vote ${voteId} was not executed`);
}
