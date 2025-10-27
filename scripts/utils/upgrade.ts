import { TransactionReceipt } from "ethers";
import fs from "fs";

import * as toml from "@iarna/toml";

import { IDualGovernance, IEmergencyProtectedTimelock, OmnibusBase, TokenManager, Voting } from "typechain-types";

import { advanceChainTime, ether, log } from "lib";
import { impersonate } from "lib/account";
import { UpgradeParameters, validateUpgradeParameters } from "lib/config-schemas";
import { loadContract } from "lib/contract";
import { findEventsWithInterfaces } from "lib/event";
import { DeploymentState, getAddress, Sk } from "lib/state-file";

const FUSAKA_TX_LIMIT = 2n ** 24n; // 16M =  16_777_216

const UPGRADE_PARAMETERS_FILE = process.env.UPGRADE_PARAMETERS_FILE;

export { UpgradeParameters };

export function readUpgradeParameters(): UpgradeParameters {
  if (!UPGRADE_PARAMETERS_FILE) {
    throw new Error("UPGRADE_PARAMETERS_FILE is not set");
  }

  if (!fs.existsSync(UPGRADE_PARAMETERS_FILE)) {
    throw new Error(`Upgrade parameters file not found: ${UPGRADE_PARAMETERS_FILE}`);
  }

  const rawData = fs.readFileSync(UPGRADE_PARAMETERS_FILE, "utf8");
  const parsedData = toml.parse(rawData);

  try {
    return validateUpgradeParameters(parsedData);
  } catch (error) {
    throw new Error(`Invalid upgrade parameters (${UPGRADE_PARAMETERS_FILE}): ${error}`);
  }
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
  const agentAddress = getAddress(Sk.appAgent, state);
  const votingAddress = getAddress(Sk.appVoting, state);
  const tokenManagerAddress = getAddress(Sk.appTokenManager, state);

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

  const voteScript = await loadContract<OmnibusBase>("OmnibusBase", omnibusScriptAddress);
  const voteBytecode = await voteScript.getNewVoteCallBytecode(description, proposalMetadata);

  await tokenManager.connect(deployer).forward(voteBytecode);
  if (!(await voteScript.isValidVoteScript(voteId, proposalMetadata))) throw new Error("Vote script is not valid");
  await voting.connect(deployer).vote(voteId, true, false);
  await advanceChainTime(await voting.voteTime());
  const executeTx = await voting.executeVote(voteId);
  const executeReceipt = (await executeTx.wait())!;
  log.success("Voting executed: gas used", executeReceipt.gasUsed);

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

  if (proposalExecutedReceipt.gasUsed > FUSAKA_TX_LIMIT) {
    log.error("Proposal executed: gas used exceeds FUSAKA_TX_LIMIT");
    process.exit(1);
  }

  return { voteId, proposalId, executeReceipt, scheduleReceipt, proposalExecutedReceipt };
}
