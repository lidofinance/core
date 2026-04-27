import { ethers } from "hardhat";
import { VoteItem } from "scripts/utils/omnibus";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { IDualGovernance, UpgradeVoteScript } from "typechain-types";

import { ether, getAddress, impersonate, loadContract, log, or, readNetworkState, Sk } from "lib";

export async function main() {
  const deployer = await ethers.provider.getSigner();
  const state = readNetworkState();

  const voteScript = await loadContract<UpgradeVoteScript>(
    "UpgradeVoteScript",
    getAddress(Sk.upgradeVoteScript, state),
    deployer,
  );

  // non-DG items
  const voteItems = (await voteScript.getVotingVoteItems()) as VoteItem[];
  const voting = await impersonate(getAddress(Sk.appVoting, state), ether("100"));
  await execVoteItems(voteItems, voting);

  // DG items
  // const voteItemsDG = (await voteScript.getVoteItemsRaw()) as VoteItem[];
  // const agent = await impersonate(getAddress(Sk.appAgent, state), ether("100"));
  // await execVoteItems(voteItemsDG, agent);

  const dg = await loadContract<IDualGovernance>("IDualGovernance", getAddress(Sk.dgDualGovernance, state));
  const proposers = await dg.getProposers();
  if (!proposers.length) {
    throw new Error("No proposer found in DualGovernance.");
  }

  const voteItemsDG = (await voteScript.getVoteItems()) as VoteItem[];
  const executor = await impersonate(proposers[0].executor, ether("100"));
  await execVoteItems(voteItemsDG, executor);
}

async function execVoteItems(voteItems: VoteItem[], executor: HardhatEthersSigner) {
  for (const item of voteItems) {
    log(`Execute vote item: ${or(item.description)}`);
    const tx = await executor.sendTransaction({
      to: item.call.to,
      data: ethers.hexlify(item.call.data),
      value: 0n,
    });
    await tx.wait();
  }
}
