import hre from "hardhat";
import { type VoteItem } from "scripts/utils/omnibus.js";

import { type HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

import {
  type IDualGovernance,
  type ITimelock,
  type UpgradeTemplate,
  type UpgradeVoteScript,
  type Voting,
} from "typechain-types/index.js";

import {
  type DeploymentState,
  ether,
  getAddress,
  getAddressValidated,
  getDeployerSigner,
  impersonate,
  isContractDeployed,
  loadContract,
  log,
  or,
  readNetworkState,
  Sk,
} from "#lib";

const PROPOSAL_ID = BigInt(process.env.PROPOSAL_ID || "0");
const VOTE_ID = BigInt(process.env.VOTE_ID || "0");

// ITimelock.ProposalStatus.Executed (see contracts/upgrade/interfaces/ITimelock.sol)
const PROPOSAL_STATUS_EXECUTED = 3n;

export async function skip(): Promise<boolean> {
  const state = readNetworkState();
  // NOT skip if contract object exists in deployed state but address set as empty string or zero address
  const address = getAddressValidated(Sk.upgradeTemplate, state);
  // NOT skip if contract not deployed yet
  const isDeployed = !!(address && (await isContractDeployed(address)));

  if (isDeployed) {
    log(`UpgradeTemplate already deployed at ${address}`);
    const template = await loadContract<UpgradeTemplate>("UpgradeTemplate", address);

    const isFinished = await template.isUpgradeFinished();
    log(`isUpgradeFinished is ${isFinished}`);
    return isFinished;
  }

  return false;
}

export async function main() {
  const deployer = await getDeployerSigner();
  const state = readNetworkState();

  const voteScript = await loadContract<UpgradeVoteScript>(
    "UpgradeVoteScript",
    getAddress(Sk.upgradeVoteScript, state),
    deployer,
  );

  // --- non-DG (Aragon voting) items ---
  // A provided PROPOSAL_ID means we explicitly target the DG proposal only, so the
  // non-DG vote items are considered already handled and must be skipped entirely.
  // Otherwise, if a VOTE_ID is provided and its vote is already enacted, skip them too.
  if (PROPOSAL_ID) {
    log.warning("PROPOSAL_ID is set, skipping non-DG vote items:", PROPOSAL_ID);
  } else if (VOTE_ID && (await isVoteEnacted(state, VOTE_ID))) {
    log.warning("VOTE_ID vote already enacted, skipping non-DG vote items:", VOTE_ID);
  } else {
    const voteItems = (await voteScript.getVotingVoteItems()) as VoteItem[];
    const voting = await impersonate(getAddress(Sk.appVoting, state), ether("100"));
    await execVoteItems(voteItems, voting);
  }

  // --- DG items ---
  // If a PROPOSAL_ID is provided and its proposal is already enacted, skip DG items.
  if (PROPOSAL_ID && (await isProposalEnacted(state, PROPOSAL_ID))) {
    log.warning("PROPOSAL_ID proposal already enacted, skipping DG items:", PROPOSAL_ID);
  } else {
    const dg = await loadContract<IDualGovernance>("IDualGovernance", getAddress(Sk.dgDualGovernance, state));
    const proposers = await dg.getProposers();
    if (!proposers.length) {
      throw new Error("No proposer found in DualGovernance.");
    }

    const voteItemsDG = (await voteScript.getVoteItems()) as VoteItem[];
    const executor = await impersonate(proposers[0].executor, ether("100"));
    await execVoteItems(voteItemsDG, executor);
  }
}

// Returns true if the Aragon vote was already enacted (executed on-chain).
async function isVoteEnacted(state: DeploymentState, voteId: bigint): Promise<boolean> {
  const voting = await loadContract<Voting>("Voting", getAddress(Sk.appVoting, state));
  const { executed } = await voting.getVote(voteId);
  return executed;
}

// Returns true if the DG proposal was already enacted (ProposalStatus.Executed).
async function isProposalEnacted(state: DeploymentState, proposalId: bigint): Promise<boolean> {
  const timelock = await loadContract<ITimelock>("ITimelock", getAddress(Sk.dgEmergencyProtectedTimelock, state));
  const { status } = await timelock.getProposalDetails(proposalId);
  return status === PROPOSAL_STATUS_EXECUTED;
}

async function execVoteItems(voteItems: VoteItem[], executor: HardhatEthersSigner) {
  const { ethers } = await hre.network.getOrCreate();

  for (const item of voteItems) {
    log(`Execute vote item: ${or(item.description)}`);
    const tx = await executor.sendTransaction({
      to: item.call.to,
      data: ethers.hexlify(item.call.data),
      value: 0n,
    });
    await tx.wait();
  }
}
