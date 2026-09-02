import { mockAragonVoting } from "scripts/utils/upgrade.js";

import { readNetworkState } from "#lib";

export async function main() {
  const state = readNetworkState();
  await mockAragonVoting(state);
}
