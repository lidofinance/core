import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { MockConsensusContract } from "typechain-types";

import {
  CONSENSUS_VERSION,
  EPOCHS_PER_FRAME,
  GENESIS_TIME,
  INITIAL_EPOCH,
  INITIAL_FAST_LANE_LENGTH_SLOTS,
  SECONDS_PER_SLOT,
  SLOTS_PER_EPOCH,
} from "lib";

export const SECONDS_PER_EPOCH = SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
export const SLOTS_PER_FRAME = EPOCHS_PER_FRAME * SLOTS_PER_EPOCH;
export const SECONDS_PER_FRAME = SECONDS_PER_EPOCH * EPOCHS_PER_FRAME;

export const slotAt = (time: bigint) => (time - GENESIS_TIME) / SECONDS_PER_SLOT;
export const epochAt = (time: bigint) => slotAt(time) / SLOTS_PER_EPOCH;
export const epochFirstSlot = (epoch: bigint) => epoch * SLOTS_PER_EPOCH;
export const epochFirstSlotAt = (time: bigint) => epochFirstSlot(epochAt(time));
export const timestampAtSlot = (slot: bigint) => GENESIS_TIME + slot * SECONDS_PER_SLOT;
export const timestampAtEpoch = (epoch: bigint) => timestampAtSlot(epochFirstSlot(epoch));
export const deadlineFromRefSlot = (slot: bigint) => timestampAtSlot(slot + SLOTS_PER_FRAME);
export const nextRefSlotFromRefSlot = (slot: bigint) => slot + SLOTS_PER_FRAME;

export const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
export const HASH_1 = "0x1111111111111111111111111111111111111111111111111111111111111111";
export const HASH_2 = "0x2222222222222222222222222222222222222222222222222222222222222222";
export const HASH_3 = "0x3333333333333333333333333333333333333333333333333333333333333333";

export async function deployBaseOracle(
  admin: HardhatEthersSigner,
  {
    secondsPerSlot = SECONDS_PER_SLOT,
    genesisTime = GENESIS_TIME,
    slotsPerEpoch = SLOTS_PER_EPOCH,
    consensusContract = null as MockConsensusContract | null,
    epochsPerFrame = EPOCHS_PER_FRAME,
    fastLaneLengthSlots = INITIAL_FAST_LANE_LENGTH_SLOTS,
    initialEpoch = INITIAL_EPOCH,
    mockMember = admin,
  } = {},
) {
  if (!consensusContract) {
    consensusContract = await ethers.deployContract("MockConsensusContract", [
      slotsPerEpoch,
      secondsPerSlot,
      genesisTime,
      epochsPerFrame,
      initialEpoch,
      fastLaneLengthSlots,
      mockMember,
    ]);
  }

  const oracle = await ethers.deployContract("BaseOracle__Harness", [secondsPerSlot, genesisTime, admin]);

  await oracle.initialize(await consensusContract.getAddress(), CONSENSUS_VERSION, 0);

  await consensusContract.setAsyncProcessor(await oracle.getAddress());

  return { oracle, consensusContract };
}

const floor = (n: bigint): bigint => BigInt(Math.floor(parseInt(n.toString(), 10)));

export const computeSlotAt = (time: bigint): bigint => floor((time - GENESIS_TIME) / SECONDS_PER_SLOT);
export const computeEpochAt = (time: bigint): bigint => floor(computeSlotAt(time) / SLOTS_PER_EPOCH);
export const computeEpochFirstSlot = (epoch: bigint): bigint => epoch * SLOTS_PER_EPOCH;
export const computeEpochFirstSlotAt = (time: bigint): bigint => computeEpochFirstSlot(computeEpochAt(time));
export const computeTimestampAtEpoch = (epoch: bigint): bigint => GENESIS_TIME + epoch * SECONDS_PER_EPOCH;
export const computeTimestampAtSlot = (slot: bigint): bigint => GENESIS_TIME + slot * SECONDS_PER_SLOT;
