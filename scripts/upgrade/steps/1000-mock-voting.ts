import { mockAragonVoting } from "scripts/utils/upgrade";

import { readNetworkState } from "lib";

export async function main() {
  const state = readNetworkState();
  await mockAragonVoting(state);
}
