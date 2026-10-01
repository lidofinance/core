import { expect } from "chai";
import { ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { HashConsensus } from "typechain-types";

import {
  advanceChainTime,
  certainAddress,
  ether,
  getCurrentBlockTimestamp,
  HASH_CONSENSUS_FAR_FUTURE_EPOCH,
  impersonate,
  log,
} from "lib";

import { ProtocolContext } from "../types";

/**
 * Helpers for submitting a real ValidatorsExitBusOracle consensus report.
 *
 * VEB has its own HashConsensus instance (separate from the AccountingOracle's one in
 * ctx.contracts.hashConsensus), so the frame alignment and consensus voting mirror the
 * accounting helpers but run against the VEB consensus contract.
 */

export const VEB_DATA_FORMAT_LIST_WITH_KEY_INDEX = 2n;

export interface VebExitRequest {
  moduleId: bigint;
  nodeOpId: bigint;
  validatorIndex: bigint;
  keyIndex: bigint;
  pubkey: string;
}

/**
 * Pack exit requests into DATA_FORMAT_LIST_WITH_KEY_INDEX (72 bytes per request):
 * | 3 bytes moduleId | 5 bytes nodeOpId | 8 bytes validatorIndex | 8 bytes keyIndex | 48 bytes pubkey |
 * Requests must be sorted ascending by (moduleId, nodeOpId, validatorIndex).
 */
export const encodeVebExitRequests = (requests: VebExitRequest[]): string =>
  ethers.concat(
    requests.map(({ moduleId, nodeOpId, validatorIndex, keyIndex, pubkey }) =>
      ethers.concat([
        ethers.toBeHex(moduleId, 3),
        ethers.toBeHex(nodeOpId, 5),
        ethers.toBeHex(validatorIndex, 8),
        ethers.toBeHex(keyIndex, 8),
        pubkey,
      ]),
    ),
  );

export const getVebHashConsensus = async (ctx: ProtocolContext): Promise<HashConsensus> => {
  const consensusAddress = await ctx.contracts.validatorsExitBusOracle.getConsensusContract();
  return ethers.getContractAt("HashConsensus", consensusAddress);
};

/**
 * Resume the ValidatorsExitBusOracle when it is paused (e.g. right after a scratch deploy).
 */
export const ensureVebResumed = async (ctx: ProtocolContext): Promise<void> => {
  const { validatorsExitBusOracle } = ctx.contracts;
  if (!(await validatorsExitBusOracle.isPaused())) return;

  const agent = await ctx.getSigner("agent");
  const resumeRole = await validatorsExitBusOracle.RESUME_ROLE();
  await validatorsExitBusOracle.connect(agent).grantRole(resumeRole, agent.address);
  await validatorsExitBusOracle.connect(agent).resume();
  await validatorsExitBusOracle.connect(agent).revokeRole(resumeRole, agent.address);
};

/**
 * Ensure the VEB HashConsensus has enough committee members to reach quorum
 * (scratch deploys start with an empty committee).
 */
export const ensureVebOracleCommitteeMembers = async (
  ctx: ProtocolContext,
  minMembersCount = 3n,
  quorum = 2n,
): Promise<void> => {
  const consensus = await getVebHashConsensus(ctx);

  const { addresses } = await consensus.getFastLaneMembers();
  if (BigInt(addresses.length) >= minMembersCount) return;

  const agentSigner = await ctx.getSigner("agent");
  const managementRole = await consensus.MANAGE_MEMBERS_AND_QUORUM_ROLE();
  await consensus.connect(agentSigner).grantRole(managementRole, agentSigner);

  for (let count = addresses.length; count < Number(minMembersCount); count++) {
    const address = certainAddress(`VEB:HC:OC:${count}`);
    if (!(await consensus.getIsMember(address))) {
      await consensus.connect(agentSigner).addMember(address, quorum);
    }
  }

  await consensus.connect(agentSigner).renounceRole(managementRole, agentSigner);
};

/**
 * Ensure the VEB HashConsensus has its initial epoch set (scratch deploys leave it
 * at the far-future sentinel until the DAO starts the oracle).
 */
export const ensureVebHashConsensusInitialEpoch = async (ctx: ProtocolContext): Promise<void> => {
  const consensus = await getVebHashConsensus(ctx);

  const { initialEpoch } = await consensus.getFrameConfig();
  if (initialEpoch === HASH_CONSENSUS_FAR_FUTURE_EPOCH) {
    const latestBlockTimestamp = await getCurrentBlockTimestamp();
    const { genesisTime, secondsPerSlot, slotsPerEpoch } = await consensus.getChainConfig();
    const updatedInitialEpoch = (latestBlockTimestamp - genesisTime) / (slotsPerEpoch * secondsPerSlot);

    const agentSigner = await ctx.getSigner("agent");
    await consensus.connect(agentSigner).updateInitialEpoch(updatedInitialEpoch);
  }
};

/**
 * Return the current VEB consensus frame ref slot, advancing to the next frame first
 * when the current one has already been processed by the oracle.
 */
export const waitVebReportFrame = async (ctx: ProtocolContext): Promise<bigint> => {
  const { validatorsExitBusOracle } = ctx.contracts;
  const consensus = await getVebHashConsensus(ctx);

  await ensureVebHashConsensusInitialEpoch(ctx);

  let { refSlot } = await consensus.getCurrentFrame();

  if ((await validatorsExitBusOracle.getLastProcessingRefSlot()) >= refSlot) {
    const { slotsPerEpoch, secondsPerSlot, genesisTime } = await consensus.getChainConfig();
    const { epochsPerFrame } = await consensus.getFrameConfig();

    const nextRefSlot = refSlot + slotsPerEpoch * epochsPerFrame;
    // add 10 slots to be sure that the next frame starts
    const nextFrameStartWithOffset = genesisTime + (nextRefSlot + 10n) * secondsPerSlot;
    await advanceChainTime(nextFrameStartWithOffset - (await getCurrentBlockTimestamp()));

    ({ refSlot } = await consensus.getCurrentFrame());
    expect(refSlot).to.equal(nextRefSlot, "Next VEB frame refSlot is incorrect");
  }

  return refSlot;
};

/**
 * Reach consensus on a VEB report among the fast lane members and submit it through
 * the real `submitReportData` path. Returns the submission transaction promise, so
 * callers can assert on the sanity-checker reverts it surfaces.
 */
export const submitVebReportWithConsensus = async (
  ctx: ProtocolContext,
  requests: VebExitRequest[],
): Promise<ContractTransactionResponse> => {
  const { validatorsExitBusOracle } = ctx.contracts;
  const consensus = await getVebHashConsensus(ctx);

  await ensureVebResumed(ctx);
  // The initial epoch must be set before any frame-dependent view (incl. fast lane members)
  await ensureVebHashConsensusInitialEpoch(ctx);
  await ensureVebOracleCommitteeMembers(ctx);
  const refSlot = await waitVebReportFrame(ctx);

  const reportData = {
    consensusVersion: await validatorsExitBusOracle.getConsensusVersion(),
    refSlot,
    requestsCount: BigInt(requests.length),
    dataFormat: VEB_DATA_FORMAT_LIST_WITH_KEY_INDEX,
    data: encodeVebExitRequests(requests),
  };

  const reportHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["(uint256 consensusVersion, uint256 refSlot, uint256 requestsCount, uint256 dataFormat, bytes data)"],
      [reportData],
    ),
  );

  const { addresses } = await consensus.getFastLaneMembers();
  expect(addresses.length).to.be.gt(0, "VEB consensus has no fast lane members");

  log.debug("Reaching VEB consensus", {
    "Ref slot": refSlot,
    "Report hash": reportHash,
    "Members": addresses.join(", "),
  });

  let submitter = null;
  for (const address of addresses) {
    const member = await impersonate(address, ether("1"));
    submitter = submitter ?? member;
    await consensus.connect(member).submitReport(refSlot, reportHash, reportData.consensusVersion);
  }

  const { consensusReport } = await consensus.getConsensusState();
  expect(consensusReport).to.equal(reportHash, "VEB consensus report hash is incorrect");

  const contractVersion = await validatorsExitBusOracle.getContractVersion();
  return validatorsExitBusOracle.connect(submitter!).submitReportData(reportData, contractVersion);
};
