import { mockEnactOmnibus } from "scripts/utils/upgrade";

import { SRPhase2UpgradeTemplate, SRPhase2UpgradeVoteScript } from "typechain-types";

import {
  getAddress,
  getAddressValidated,
  getDeployerSigner,
  isContractDeployed,
  loadContract,
  log,
  readNetworkState,
  Sk,
} from "lib";

// Ids of the real SR phase 2 vote and DG proposal once they exist on-chain (see `mockEnactOmnibus`)
const VOTE_ID = BigInt(process.env.SR_PHASE_2_VOTE_ID || "0");
const PROPOSAL_ID = BigInt(process.env.SR_PHASE_2_PROPOSAL_ID || "0");

export async function skip(): Promise<boolean> {
  const state = readNetworkState();
  const address = getAddressValidated(Sk.srPhase2UpgradeTemplate, state);
  if (!address || !(await isContractDeployed(address))) return false;

  const template = await loadContract<SRPhase2UpgradeTemplate>("SRPhase2UpgradeTemplate", address);
  const isFinished = await template.isUpgradeFinished();
  log(`SRPhase2UpgradeTemplate at ${address}: isUpgradeFinished is ${isFinished}`);
  return isFinished;
}

export async function main() {
  const state = readNetworkState();

  const voteScript = await loadContract<SRPhase2UpgradeVoteScript>(
    "SRPhase2UpgradeVoteScript",
    getAddress(Sk.srPhase2UpgradeVoteScript, state),
    await getDeployerSigner(),
  );

  await mockEnactOmnibus(state, voteScript, { voteId: VOTE_ID, proposalId: PROPOSAL_ID });
}
