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

  const tokenManager = await loadContract<TokenManager>("TokenManager", tokenManagerAddress);
  const voting = await loadContract<Voting>("Voting", votingAddress);

  {
    // TW voting
    const voteId = await voting.votesLength();

    const voteScriptTw = await loadContract<TWVoteScript>("TWVoteScript", state[Sk.TWVoteScript].address);
    console.log(await voteScriptTw.getDebugParams());
    const voteBytecodeTw = await voteScriptTw.getNewVoteCallBytecode("TW Lido Upgrade description placeholder");

    await tokenManager.connect(deployer).forward(voteBytecodeTw);
    if (!(await voteScriptTw.isValidVoteScript(voteId))) throw new Error("Vote script is not valid");
    await voting.connect(deployer).vote(voteId, true, false);
    await advanceChainTime(await voting.voteTime());
    const executeTx = await voting.executeVote(voteId);

    const executeReceipt = await executeTx.wait();
    log.success("TW voting executed: gas used", executeReceipt!.gasUsed);
  }
}
