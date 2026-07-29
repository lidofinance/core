import { ContractTransactionReceipt, ContractTransactionResponse } from "ethers";
import { ethers, network as hardhatNetwork } from "hardhat";
import { createEDFDevnetVote, updateEDFDevnetVoteState } from "scripts/utils/edf-devnet-voting";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { EDFUpgradeTemplate, Voting } from "typechain-types";

import {
  advanceChainTime,
  findEventsWithInterfaces,
  getAddress,
  getCurrentBlockTimestamp,
  getDeployerSigner,
  loadContract,
  log,
  logScriptHeader,
  readNetworkState,
  Sk,
} from "lib";

type RunMode = "fork" | "live";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_WAIT_GRACE_MS = 10 * 60 * 1_000;

function readRunMode(): RunMode {
  const mode = process.env.EDF_DEVNET_VOTE_MODE;
  if (mode === "fork" || mode === "live") return mode;
  throw new Error("EDF_DEVNET_VOTE_MODE must be fork or live; use a package command");
}

function readPositiveInteger(name: string, defaultValue: number): number {
  const rawValue = process.env[name];
  if (!rawValue) return defaultValue;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${rawValue}`);
  }
  return value;
}

async function waitAndLog(tx: ContractTransactionResponse): Promise<ContractTransactionReceipt> {
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`Transaction ${tx.hash} did not return a receipt`);
  log(`Transaction: ${receipt.hash}`);
  log(`Gas used: ${receipt.gasUsed}`);
  return receipt;
}

async function getVoteSigner(mode: RunMode): Promise<HardhatEthersSigner> {
  const deployer = process.env.DEPLOYER;
  if (!deployer) throw new Error("DEPLOYER is required");

  const deployerAddress = ethers.getAddress(deployer);
  const configuredSigner = (await ethers.getSigners()).find(
    (signer) => signer.address.toLowerCase() === deployerAddress.toLowerCase(),
  );
  if (configuredSigner) return configuredSigner;

  if (mode === "live") {
    throw new Error(`LOCAL_DEVNET_PK does not match DEPLOYER ${deployerAddress}`);
  }
  return getDeployerSigner();
}

async function waitForLiveExecution(voting: Voting, voteId: bigint): Promise<void> {
  if (await voting.canExecute(voteId)) return;

  const vote = await voting.getVote(voteId);
  const voteTime = await voting.voteTime();
  const currentTimestamp = await getCurrentBlockTimestamp();
  const voteEnd = vote.startDate + voteTime;
  const secondsUntilVoteEnd = voteEnd > currentTimestamp ? voteEnd - currentTimestamp : 0n;
  const defaultTimeoutMs = Number(secondsUntilVoteEnd) * 1_000 + DEFAULT_WAIT_GRACE_MS;
  const timeoutMs = readPositiveInteger("EDF_DEVNET_VOTE_WAIT_TIMEOUT_MS", defaultTimeoutMs);
  const pollIntervalMs = readPositiveInteger("EDF_DEVNET_VOTE_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;

  log(`Waiting up to ${Math.ceil(timeoutMs / 1_000)} seconds for vote ${voteId}...`);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    if (await voting.canExecute(voteId)) return;
    const currentVote = await voting.getVote(voteId);
    if (currentVote.executed) return;
  }

  throw new Error(`Vote ${voteId} did not become executable within ${timeoutMs} ms`);
}

async function advanceForkToExecution(voting: Voting, voteId: bigint): Promise<void> {
  if (await voting.canExecute(voteId)) return;

  const vote = await voting.getVote(voteId);
  const voteTime = await voting.voteTime();
  const currentTimestamp = await getCurrentBlockTimestamp();
  const voteEnd = vote.startDate + voteTime;
  if (currentTimestamp <= voteEnd) {
    const secondsToAdvance = voteEnd - currentTimestamp + 1n;
    log(`Advancing fork time by ${secondsToAdvance} seconds...`);
    await advanceChainTime(secondsToAdvance);
  }
}

async function main() {
  const mode = readRunMode();
  const expectedNetwork = mode === "fork" ? "local" : "local-devnet";
  if (hardhatNetwork.name !== expectedNetwork) {
    throw new Error(`${mode} mode requires --network ${expectedNetwork}, got ${hardhatNetwork.name}`);
  }
  if (mode === "live" && !process.env.LOCAL_DEVNET_PK) {
    throw new Error("LOCAL_DEVNET_PK is required in live mode");
  }

  let state = readNetworkState();
  const signer = await getVoteSigner(mode);
  const voteDescription = process.env.VOTE_DESCRIPTION ?? "EDF/DSM v5 devnet upgrade";
  await logScriptHeader(`EDF/DSM v5 — Vote and enact (${mode})`, signer.address);

  const voteId = await createEDFDevnetVote(state, signer, voteDescription);
  state = readNetworkState();

  const voting = await loadContract<Voting>("Voting", getAddress(Sk.appVoting, state), signer);
  let vote = await voting.getVote(voteId);
  if (!vote.startDate) throw new Error(`Aragon vote ${voteId} does not exist`);
  if (vote.executed) {
    log.success(`Aragon vote ${voteId} is already executed`);
    return;
  }

  const voterState = await voting.getVoterState(voteId, signer.address);
  if (voterState === 1n) {
    log.success(`Signer already voted Yes on vote ${voteId}`);
  } else {
    if (!(await voting.canVote(voteId, signer.address))) {
      throw new Error(`Signer ${signer.address} cannot vote on Aragon vote ${voteId}`);
    }
    const castReceipt = await waitAndLog(await voting.connect(signer).vote(voteId, true, false));
    updateEDFDevnetVoteState(readNetworkState(), {
      castTx: castReceipt.hash,
      castBlock: castReceipt.blockNumber,
    });
    log.success(`Cast Yes on Aragon vote ${voteId}`);
  }

  if (mode === "fork") {
    await advanceForkToExecution(voting, voteId);
  } else {
    await waitForLiveExecution(voting, voteId);
  }

  vote = await voting.getVote(voteId);
  if (vote.executed) {
    log.success(`Aragon vote ${voteId} was executed while waiting`);
    return;
  }
  if (!(await voting.canExecute(voteId))) {
    throw new Error(`Aragon vote ${voteId} is not ready for execution`);
  }

  const enactReceipt = await waitAndLog(await voting.connect(signer).executeVote(voteId));
  updateEDFDevnetVoteState(readNetworkState(), {
    enactTx: enactReceipt.hash,
    enactBlock: enactReceipt.blockNumber,
  });

  const template = await loadContract<EDFUpgradeTemplate>(
    "EDFUpgradeTemplate",
    getAddress(Sk.upgradeTemplate, state),
    signer,
  );
  const events = findEventsWithInterfaces(enactReceipt, "UpgradeFinished", [template.interface]);
  if (events.length !== 1) {
    throw new Error(`Expected one UpgradeFinished event in ${enactReceipt.hash}, got ${events.length}`);
  }

  log.success(`Executed Aragon vote ${voteId}`);
  log.success(`UpgradeFinished found in transaction ${enactReceipt.hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
