import { mockDGAragonVoting } from "scripts/utils/upgrade";

import { readNetworkState } from "lib/state-file";

export async function main(): Promise<ReturnType<typeof mockDGAragonVoting>> {
  const state = readNetworkState();
  return mockDGAragonVoting(state);
}
