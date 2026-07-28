import { mockDGAragonVoting } from "scripts/utils/upgrade.js";

import { readNetworkState } from "lib/state-file.js";

export async function main(): Promise<ReturnType<typeof mockDGAragonVoting>> {
  const state = await readNetworkState();
  return mockDGAragonVoting(state);
}
