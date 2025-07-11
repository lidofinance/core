import { mockDGAragonVoting } from "scripts/utils/upgrade";

import { getAddress, readNetworkState, Sk } from "lib/state-file";

export async function main(): Promise<ReturnType<typeof mockDGAragonVoting>> {
  const state = readNetworkState();
  const votingDescription = "V3 Lido Upgrade description placeholder";
  const proposalMetadata = "V3 Lido Upgrade proposal metadata placeholder";
  return mockDGAragonVoting(getAddress(Sk.v3VoteScript, state), votingDescription, proposalMetadata, state);
}
