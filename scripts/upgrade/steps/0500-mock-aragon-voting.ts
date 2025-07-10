import { mockDGAragonVoting } from "scripts/utils/upgrade";

import { readNetworkState, Sk } from "lib/state-file";

export async function main(): Promise<ReturnType<typeof mockDGAragonVoting>> {
  const state = readNetworkState();
  const voteScriptAddress = state[Sk.TWVoteScript].address;
  const votingDescription = "TW Lido Upgrade description placeholder";
  const proposalMetadata = "TW Lido Upgrade proposal metadata placeholder";
  return mockDGAragonVoting(voteScriptAddress, votingDescription, proposalMetadata, state);
}
