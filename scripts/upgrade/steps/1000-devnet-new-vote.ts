import { ethers } from "hardhat";
import { mockAragonVoting } from "scripts/utils/upgrade";

export async function main() {
  const holderAddress = process.env.HOLDER || process.env.DEPLOYER || "";
  const holder = await ethers.provider.getSigner(holderAddress);
  const voteDescription = process.env.VOTE_DESCRIPTION || "vote-description";
  const voteId = BigInt(process.env.VOTE_ID || "");

  await mockAragonVoting(holder, voteId, voteDescription);
}
