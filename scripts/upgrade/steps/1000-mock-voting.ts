import { readNetworkState } from "#lib";

import { mockAragonVoting } from "#scripts/utils/upgrade.js";

export async function main() {
  const state = readNetworkState();
  await mockAragonVoting(state);
}
