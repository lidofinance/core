import { TransactionReceipt } from "ethers";
import fs from "fs";

import { IDualGovernance, IEmergencyProtectedTimelock, OmnibusBase, TokenManager, Voting } from "typechain-types";

import { advanceChainTime, ether, log } from "lib";
import { impersonate } from "lib/account";
import { loadContract } from "lib/contract";
import { findEventsWithInterfaces } from "lib/event";
import { DeploymentState, Sk } from "lib/state-file";

const UPGRADE_PARAMETERS_FILE = process.env.UPGRADE_PARAMETERS_FILE;

export function readUpgradeParameters() {
  if (!UPGRADE_PARAMETERS_FILE) {
    throw new Error("UPGRADE_PARAMETERS_FILE is not set");
  }

  const rawData = fs.readFileSync(UPGRADE_PARAMETERS_FILE);
  return JSON.parse(rawData.toString());
}

export async function mockDGAragonVoting(
  omnibusScriptAddress: string,
  description: string,
  proposalMetadata: string,
  state: DeploymentState,
): Promise<{
  voteId: bigint;
  proposalId: bigint;
  executeReceipt: TransactionReceipt;
  scheduleReceipt: TransactionReceipt;
  proposalExecutedReceipt: TransactionReceipt;
}> {
  log("Starting mock Aragon voting...");
  const agentAddress = state[Sk.appAgent].proxy.address;
  const votingAddress = state[Sk.appVoting].proxy.address;
  const tokenManagerAddress = state[Sk.appTokenManager].proxy.address;

  const deployer = await impersonate(agentAddress, ether("100"));
  const tokenManager = await loadContract<TokenManager>("TokenManager", tokenManagerAddress);
  const voting = await loadContract<Voting>("Voting", votingAddress);
  const timelock = await loadContract<IEmergencyProtectedTimelock>(
    "IEmergencyProtectedTimelock",
    state[Sk.dgEmergencyProtectedTimelock].proxy.address,
  );
  const afterSubmitDelay = await timelock.getAfterSubmitDelay();
  const afterScheduleDelay = await timelock.getAfterScheduleDelay();

  const voteId = await voting.votesLength();

  const voteScriptTw = await loadContract<OmnibusBase>("OmnibusBase", omnibusScriptAddress);
  const voteBytecodeTw = await voteScriptTw.getNewVoteCallBytecode(description, proposalMetadata);

  await tokenManager.connect(deployer).forward(voteBytecodeTw);
  if (!(await voteScriptTw.isValidVoteScript(voteId, proposalMetadata))) throw new Error("Vote script is not valid");
  await voting.connect(deployer).vote(voteId, true, false);
  await advanceChainTime(await voting.voteTime());
  const executeTx = await voting.executeVote(voteId);
  const executeReceipt = (await executeTx.wait())!;
  log.success("TW voting executed: gas used", executeReceipt.gasUsed);

  const dualGovernance = await loadContract<IDualGovernance>(
    "IDualGovernance",
    state[Sk.dgDualGovernance].proxy.address,
  );
  const events = findEventsWithInterfaces(executeReceipt, "ProposalSubmitted", [dualGovernance.interface]);
  const proposalId = events[0].args.id;
  log.success("Proposal submitted: proposalId", proposalId);

  await advanceChainTime(afterSubmitDelay);
  const scheduleTx = await dualGovernance.connect(deployer).scheduleProposal(proposalId);
  const scheduleReceipt = (await scheduleTx.wait())!;
  log.success("Proposal scheduled: gas used", scheduleReceipt.gasUsed);

  await advanceChainTime(afterScheduleDelay);
  const proposalExecutedTx = await timelock.connect(deployer).execute(proposalId);
  const proposalExecutedReceipt = (await proposalExecutedTx.wait())!;
  log.success("Proposal executed: gas used", proposalExecutedReceipt.gasUsed);

  return { voteId, proposalId, executeReceipt, scheduleReceipt, proposalExecutedReceipt };
}