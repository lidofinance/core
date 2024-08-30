import { ethers } from "hardhat";

import { ReportProcessor__Mock } from "typechain-types";

import {
  CONSENSUS_VERSION,
  EPOCHS_PER_FRAME,
  GENESIS_TIME,
  INITIAL_EPOCH,
  INITIAL_FAST_LANE_LENGTH_SLOTS,
  SECONDS_PER_SLOT,
  SLOTS_PER_EPOCH,
} from "lib";

export interface DeployHashConsensusParams {
  reportProcessor?: ReportProcessor__Mock;
  slotsPerEpoch?: bigint | undefined;
  secondsPerSlot?: bigint | undefined;
  genesisTime?: bigint | undefined;
  epochsPerFrame?: bigint | undefined;
  fastLaneLengthSlots?: bigint | undefined;
  initialEpoch?: bigint | null;
}

export async function deployHashConsensus(
  admin: string,
  {
    reportProcessor,
    slotsPerEpoch = SLOTS_PER_EPOCH,
    secondsPerSlot = SECONDS_PER_SLOT,
    genesisTime = GENESIS_TIME,
    epochsPerFrame = EPOCHS_PER_FRAME,
    fastLaneLengthSlots = INITIAL_FAST_LANE_LENGTH_SLOTS,
    initialEpoch = INITIAL_EPOCH,
  }: DeployHashConsensusParams = {},
) {
  if (!reportProcessor) {
    reportProcessor = await ethers.deployContract("ReportProcessor__Mock", [CONSENSUS_VERSION]);
  }

  const consensus = await ethers.deployContract("HashConsensus__Harness", [
    slotsPerEpoch,
    secondsPerSlot,
    genesisTime,
    epochsPerFrame,
    fastLaneLengthSlots,
    admin,
    await reportProcessor.getAddress(),
  ]);

  if (initialEpoch !== null) {
    await consensus.updateInitialEpoch(initialEpoch);
    await consensus.setTime(genesisTime + initialEpoch * slotsPerEpoch * secondsPerSlot);
  }

  await consensus.grantRole(await consensus.MANAGE_MEMBERS_AND_QUORUM_ROLE(), admin);
  await consensus.grantRole(await consensus.DISABLE_CONSENSUS_ROLE(), admin);
  await consensus.grantRole(await consensus.MANAGE_FRAME_CONFIG_ROLE(), admin);
  await consensus.grantRole(await consensus.MANAGE_FAST_LANE_CONFIG_ROLE(), admin);
  await consensus.grantRole(await consensus.MANAGE_REPORT_PROCESSOR_ROLE(), admin);

  return { reportProcessor, consensus };
}
