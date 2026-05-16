import { executeExistingDGProposalOnFork } from "scripts/utils/upgrade";

import { readNetworkState } from "lib/state-file";

export async function main() {
  // https://dg.lido.fi/proposals/6 — mainnet upgrade omnibus submitted via DG.
  return executeExistingDGProposalOnFork({ state: readNetworkState(), proposalId: 6n });
}
