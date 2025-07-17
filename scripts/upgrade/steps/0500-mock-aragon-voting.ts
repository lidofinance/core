import { TokenManager, TWVoteScript, Voting } from "typechain-types";

import { advanceChainTime, ether, log } from "lib";
import { impersonate } from "lib/account";
import { loadContract } from "lib/contract";
import { readNetworkState, Sk } from "lib/state-file";

export async function main(): Promise<void> {
  const state = readNetworkState();
  log("Starting mock Aragon voting...");
  const agentAddress = state[Sk.appAgent].proxy.address;
  const votingAddress = state[Sk.appVoting].proxy.address;
  const tokenManagerAddress = state[Sk.appTokenManager].proxy.address;

  const deployer = await impersonate(agentAddress, ether("100"));

  const voteScript = await loadContract<TWVoteScript>("TWVoteScript", state[Sk.TWVoteScript].address);
  const tokenManager = await loadContract<TokenManager>("TokenManager", tokenManagerAddress);
  const voting = await loadContract<Voting>("Voting", votingAddress);

  const voteId = await voting.votesLength();
  console.log(await voteScript.getDebugParams())
  const newVoteBytecode = await voteScript.getNewVoteCallBytecode("TW Lido Upgrade description placeholder");
  await tokenManager.connect(deployer).forward(newVoteBytecode);
  if (!(await voteScript.isValidVoteScript(voteId))) throw new Error("Vote script is not valid");
  await voting.connect(deployer).vote(voteId, true, false);
  await advanceChainTime(await voting.voteTime());
  const executeTx = await voting.executeVote(voteId);

  const executeReceipt = await executeTx.wait();
  log.success("Voting executed: gas used", executeReceipt!.gasUsed);
}
