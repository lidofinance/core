import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { LidoLocator, ValidatorsExitBus__Harness } from "typechain-types";

import { EPOCHS_PER_FRAME, INITIAL_FAST_LANE_LENGTH_SLOTS, SLOTS_PER_EPOCH, VEBO_CONSENSUS_VERSION } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("ValidatorsExitBusOracle.sol:finalizeUpgrade_v3", () => {
  let originalState: string;
  let locator: LidoLocator;
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;

  before(async () => {
    locator = await deployLidoLocator();
    [admin] = await ethers.getSigners();

    // Legacy modules bitmask: Module 1 (NOR) is legacy
    const LEGACY_MODULES_BITMASK = 1n << 1n; // Module 1 is legacy

    oracle = await ethers.deployContract("ValidatorsExitBus__Harness", [
      12n,
      100n,
      await locator.getAddress(),
      LEGACY_MODULES_BITMASK,
      32, // maxBalanceWcType01Eth - legacy validators
      2048, // maxBalanceWcType02Eth - MaxEB validators
    ]);

    const consensus = await ethers.deployContract("HashConsensus__Harness", [
      SLOTS_PER_EPOCH,
      12,
      100n,
      EPOCHS_PER_FRAME,
      INITIAL_FAST_LANE_LENGTH_SLOTS,
      admin,
      await oracle.getAddress(),
    ]);

    await oracle.initialize(
      admin,
      await consensus.getAddress(),
      VEBO_CONSENSUS_VERSION,
      0,
      10,
      100n, // 100 ETH
      32n, // 32 ETH
      48,
    );
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  // contract version
  it("should revert if set wrong version", async () => {
    await expect(oracle.finalizeUpgrade_v3(10, 100n, 32n, 48)).to.be.revertedWithCustomError(
      oracle,
      "InvalidContractVersionIncrement",
    );
  });

  it("should successfully finalize upgrade", async () => {
    await oracle.setContractVersion(1);

    // Set balance limits in ETH (not Gwei, not validator counts)
    const maxExitBalanceEth = 150n; // 150 ETH
    const balancePerFrameEth = 32n; // 32 ETH (1 legacy validator)
    const maxValidatorsPerReport = 15;
    const frameDuration = 48;

    await oracle.finalizeUpgrade_v3(maxValidatorsPerReport, maxExitBalanceEth, balancePerFrameEth, frameDuration);

    expect(await oracle.getContractVersion()).to.equal(3);

    const exitRequestLimitData = await oracle.getExitRequestLimitFullInfo();
    expect(exitRequestLimitData.maxExitBalanceEth).to.equal(maxExitBalanceEth);
    expect(exitRequestLimitData.balancePerFrameEth).to.equal(balancePerFrameEth);
    expect(exitRequestLimitData.frameDurationInSec).to.equal(frameDuration);

    expect(await oracle.getMaxValidatorsPerReport()).to.equal(maxValidatorsPerReport);

    // should not allow to run finalizeUpgrade_v4 again
    await expect(oracle.finalizeUpgrade_v3(10, 100, 1, 48)).to.be.revertedWithCustomError(
      oracle,
      "InvalidContractVersionIncrement",
    );
  });
});
