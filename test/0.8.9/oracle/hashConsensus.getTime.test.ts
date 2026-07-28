import { expect } from "chai";
import { type Signer } from "ethers";
import hre from "hardhat";

import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";

import type { HashConsensus } from "typechain-types/index.js";

import {
  BASE_CONSENSUS_VERSION,
  EPOCHS_PER_FRAME,
  GENESIS_TIME,
  INITIAL_FAST_LANE_LENGTH_SLOTS,
  SECONDS_PER_SLOT,
  SLOTS_PER_EPOCH,
} from "lib/constants.js";

import { type DeployHashConsensusParams } from "test/deploy/index.js";

async function deployOriginalHashConsensus(
  admin: string,
  {
    slotsPerEpoch = SLOTS_PER_EPOCH,
    secondsPerSlot = SECONDS_PER_SLOT,
    genesisTime = GENESIS_TIME,
    epochsPerFrame = EPOCHS_PER_FRAME,
    fastLaneLengthSlots = INITIAL_FAST_LANE_LENGTH_SLOTS,
  }: DeployHashConsensusParams = {},
) {
  const { ethers } = await hre.network.getOrCreate();

  const reportProcessor = await ethers.deployContract("ReportProcessor__Mock", [BASE_CONSENSUS_VERSION]);

  const consensus = await ethers.deployContract("HashConsensus", [
    slotsPerEpoch,
    secondsPerSlot,
    genesisTime,
    epochsPerFrame,
    fastLaneLengthSlots,
    admin,
    await reportProcessor.getAddress(),
  ]);

  await consensus.grantRole(await consensus.MANAGE_MEMBERS_AND_QUORUM_ROLE(), admin);
  await consensus.grantRole(await consensus.DISABLE_CONSENSUS_ROLE(), admin);
  await consensus.grantRole(await consensus.MANAGE_FRAME_CONFIG_ROLE(), admin);
  await consensus.grantRole(await consensus.MANAGE_FAST_LANE_CONFIG_ROLE(), admin);
  await consensus.grantRole(await consensus.MANAGE_REPORT_PROCESSOR_ROLE(), admin);

  return { reportProcessor, consensus };
}

describe("HashConsensus.sol:getTime", function () {
  let ethers: HardhatEthers;

  let admin: Signer;
  let consensus: HashConsensus;

  before(async () => {
    ({ ethers } = await hre.network.getOrCreate());

    [admin] = await ethers.getSigners();
    const deployed = await deployOriginalHashConsensus(await admin.getAddress());
    consensus = deployed.consensus;
  });

  it("call original _getTime by updateInitialEpoch method", async () => {
    await consensus.updateInitialEpoch(10);
    expect((await consensus.getFrameConfig()).initialEpoch).to.equal(10);
  });
});
