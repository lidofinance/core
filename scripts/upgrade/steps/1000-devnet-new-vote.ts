import { mockAragonVoting } from "scripts/utils/upgrade";

import { ether, getSignerOrImpersonate } from "lib";

export async function main() {
  const holderAddress = process.env.HOLDER || process.env.DEPLOYER || "";
  const holder = await getSignerOrImpersonate(holderAddress, ether("100"));
  const voteDescription = process.env.VOTE_DESCRIPTION || "vote-description";
  const voteId = BigInt(process.env.VOTE_ID || "");

  await mockAragonVoting(holder, voteId, voteDescription);
}
