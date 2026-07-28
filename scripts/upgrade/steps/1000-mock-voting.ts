import { mockAragonVoting } from "scripts/utils/upgrade.js";

import { readNetworkState } from "lib/index.js";

export async function main() {
  const state = await readNetworkState();
  await mockAragonVoting(state);
}
