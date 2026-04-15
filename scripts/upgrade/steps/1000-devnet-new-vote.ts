import { ethers } from "hardhat";
import { encodeCallScript, VoteItem } from "scripts/utils/omnibus";

import { IDualGovernance, TokenManager, UpgradeVoteScript, Voting } from "typechain-types";

import { findEventsWithInterfaces } from "lib";
import { loadContract } from "lib/contract";
import { getAddress, readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const holderAddress = process.env.HOLDER || process.env.DEPLOYER || "";
  const holder = await ethers.provider.getSigner(holderAddress);

  const state = readNetworkState();

  const tm = await loadContract<TokenManager>("TokenManager", getAddress(Sk.appTokenManager, state));

  const voteScript = await loadContract<UpgradeVoteScript>(
    "UpgradeVoteScript",
    getAddress(Sk.upgradeVoteScript, state),
  );
  // const template = await loadContract<UpgradeTemplate>("UpgradeTemplate", getAddress(Sk.upgradeTemplate, state));
  await loadContract<IDualGovernance>("IDualGovernance", getAddress(Sk.dgDualGovernance, state));
  const voting = await loadContract<Voting>("Voting", getAddress(Sk.appVoting, state));

  const voteDescription = process.env.VOTE_DESCRIPTION || "vote-description";

  const voteItems = (await voteScript.getVotingVoteItems()) as VoteItem[];
  console.log("Voting vote items:");
  console.log(voteItems.map(({ description }) => description));

  const voteItemsDg = (await voteScript.getVoteItems()) as VoteItem[];
  console.log("Dual Governance vote items:");
  console.log(voteItemsDg.map(({ description }) => description));

  const evmScript = encodeCallScript(
    voteItems.concat(voteItemsDg).map(({ call }) => ({ to: call.to, data: call.data })),
  );
  const evmScriptNewVote = encodeCallScript([
    {
      to: voting.address,
      data: voting.interface.encodeFunctionData("newVote(bytes,string,bool,bool)", [
        evmScript,
        voteDescription,
        true,
        true,
      ]),
    },
  ]);

  console.log("estimateGas newVote", await tm.connect(holder).forward.estimateGas(evmScriptNewVote));

  const tx = await tm.connect(holder).forward(evmScriptNewVote);
  console.log("newVote tx.hash", tx.hash);
  const receipt = await tx.wait();

  if (!receipt) {
    throw new Error(`Transaction ${tx.hash} did not return a receipt`);
  }

  console.log("newVote tx success");
  const voteId = await findEventsWithInterfaces(receipt, "StartVote", [voting.interface])[0].args.voteId;
  console.log("New voteId", voteId);

  const voteTx = await voting.connect(holder).vote(voteId, true, true);
  console.log("cast vote tx.hash", voteTx.hash);
}
