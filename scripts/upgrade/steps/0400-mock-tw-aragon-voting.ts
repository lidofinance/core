import { mockDGAragonVoting } from "scripts/utils/upgrade";

import { getAddress, readNetworkState, Sk } from "lib/state-file";

export async function main(): Promise<ReturnType<typeof mockDGAragonVoting>> {
  const state = readNetworkState();
  const votingDescription = "TW Lido Upgrade description placeholder";
  const proposalMetadata = "TW Lido Upgrade proposal metadata placeholder";
  return mockDGAragonVoting(getAddress(Sk.twVoteScript, state), votingDescription, proposalMetadata, state);
}
