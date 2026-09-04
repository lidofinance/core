import { readNetworkState } from "#lib/state-file.js";

import { mockDGAragonVoting } from "#scripts/utils/upgrade.js";

export async function main(): Promise<ReturnType<typeof mockDGAragonVoting>> {
  const state = readNetworkState();
  return mockDGAragonVoting(state);
}
