import { ethers } from "hardhat";
import { VoteItem } from "scripts/utils/omnibus";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { IDualGovernance, TokenManager, UpgradeVoteScript, Voting } from "typechain-types";

import { ether, impersonate } from "lib";
import { loadContract } from "lib/contract";
import { getAddress, readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = await ethers.provider.getSigner();
  const state = readNetworkState();
  const params = readUpgradeParameters();

  const agentAddress = getAddress(Sk.appAgent, state);
  const tm = await loadContract<TokenManager>("TokenManager", getAddress(Sk.appTokenManager, state));

  const voteScript = await loadContract<UpgradeVoteScript>(
    "UpgradeVoteScript",
    getAddress(Sk.upgradeVoteScript, state),
  );
  // const template = await loadContract<UpgradeTemplate>("UpgradeTemplate", getAddress(Sk.upgradeTemplate, state));
  const dualGovernance = await loadContract<IDualGovernance>("IDualGovernance", getAddress(Sk.dgDualGovernance, state));
  // const timelock = await loadContract<ITimelock>("ITimelock", getAddress(Sk.dgEmergencyProtectedTimelock, state));
  const voting = await loadContract<Voting>("Voting", getAddress(Sk.appVoting, state));

  const proposalMetadata = process.env.PROPOSAL_METADATA || "proposal-metadata";
  const voteDescription = process.env.VOTE_DESCRIPTION || "vote-description";

  const holder = await impersonate(agentAddress, ether("100"));
  // const holder = await impersonate("0x9Bb75183646e2A0DC855498bacD72b769AE6ceD3", ether("100"));

  const voteItems = (await voteScript.getVotingVoteItems()) as VoteItem[];
  console.log(voteItems.map(({ description }) => description));

  const evmScriptNewVote1 = await voteScript.getNewVoteCallBytecode(voteDescription, proposalMetadata);
  console.log("evmScriptNewVote1 bytes", evmScriptNewVote1.length / 2);
  console.log("estimate newVote - evmScriptNewVote1", await tm.connect(holder).forward.estimateGas(evmScriptNewVote1));

  const evmScriptNewVote2 = await voteScript.getNewVoteCallBytecode2(voteDescription, proposalMetadata);
  console.log("evmScriptNewVote2 bytes", evmScriptNewVote2.length / 2);
  console.log("estimate newVote - evmScriptNewVote2", await tm.connect(holder).forward.estimateGas(evmScriptNewVote2));
}
