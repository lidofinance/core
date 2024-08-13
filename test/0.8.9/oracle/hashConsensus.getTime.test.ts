import { expect } from "chai";
import { Signer } from "ethers";
import { ethers } from "hardhat";

import { HashConsensus } from "typechain-types";

import {
  CONSENSUS_VERSION,
  EPOCHS_PER_FRAME,
  GENESIS_TIME,
  INITIAL_FAST_LANE_LENGTH_SLOTS,
  SECONDS_PER_SLOT,
  SLOTS_PER_EPOCH,
} from "lib";

import { DeployHashConsensusParams } from "test/deploy";

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
  const reportProcessor = await ethers.deployContract("MockReportProcessor", [CONSENSUS_VERSION]);

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

describe("HashConsensus:getTime", function () {
  let admin: Signer;
  let consensus: HashConsensus;

  const deploy = async () => {
    [admin] = await ethers.getSigners();
    const deployed = await deployOriginalHashConsensus(await admin.getAddress());
    consensus = deployed.consensus;
  };

  before(deploy);

  it("call original _getTime by updateInitialEpoch method", async () => {
    await consensus.updateInitialEpoch(10);
    expect((await consensus.getFrameConfig()).initialEpoch).to.equal(10);
  });
});
