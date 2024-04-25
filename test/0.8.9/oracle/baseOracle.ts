import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { MockConsensusContract } from "typechain-types";

export const SLOTS_PER_EPOCH = 32;
export const SECONDS_PER_SLOT = 12;
export const GENESIS_TIME = 100;
export const EPOCHS_PER_FRAME = 225; // one day
export const INITIAL_EPOCH = 1;
export const INITIAL_FAST_LANE_LENGTH_SLOTS = 0;

export const SECONDS_PER_EPOCH = SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
export const SLOTS_PER_FRAME = EPOCHS_PER_FRAME * SLOTS_PER_EPOCH;
export const SECONDS_PER_FRAME = SECONDS_PER_EPOCH * EPOCHS_PER_FRAME;

export const computeSlotAt = (time: number) => Math.floor((time - GENESIS_TIME) / SECONDS_PER_SLOT);
export const computeEpochAt = (time: number) => Math.floor(computeSlotAt(time) / SLOTS_PER_EPOCH);
export const computeEpochFirstSlot = (epoch: number) => epoch * SLOTS_PER_EPOCH;
export const computeEpochFirstSlotAt = (time: number) => computeEpochFirstSlot(computeEpochAt(time));
export const computeTimestampAtSlot = (slot: number) => GENESIS_TIME + slot * SECONDS_PER_SLOT;
export const computeDeadlineFromRefSlot = (slot: number) => computeTimestampAtSlot(slot + SLOTS_PER_FRAME);
export const computeNextRefSlotFromRefSlot = (slot: number) => +slot + SLOTS_PER_FRAME;

export const HASH_1 = "0x1111111111111111111111111111111111111111111111111111111111111111";
export const HASH_2 = "0x2222222222222222222222222222222222222222222222222222222222222222";
export const HASH_3 = "0x3333333333333333333333333333333333333333333333333333333333333333";

export const CONSENSUS_VERSION = 1;

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

  const oracle = await ethers.deployContract("BaseOracleTimeTravellable", [secondsPerSlot, genesisTime, admin]);

  await oracle.initialize(await consensusContract.getAddress(), CONSENSUS_VERSION, 0);

  await consensusContract.setAsyncProcessor(await oracle.getAddress());

  return { oracle, consensusContract };
}
