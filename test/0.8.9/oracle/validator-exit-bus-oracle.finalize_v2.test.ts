import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { LidoLocator, ValidatorsExitBus__Harness } from "typechain-types";

import { EPOCHS_PER_FRAME, INITIAL_FAST_LANE_LENGTH_SLOTS, SLOTS_PER_EPOCH, VEBO_CONSENSUS_VERSION } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("ValidatorsExitBusOracle.sol:finalizeUpgrade_v2", () => {
  let originalState: string;
  let locator: LidoLocator;
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;

  before(async () => {
    locator = await deployLidoLocator();
    [admin] = await ethers.getSigners();
    const nodeOperatorsRegistry = await ethers.deployContract("NodeOperatorsRegistry__Mock");
    oracle = await ethers.deployContract("ValidatorsExitBus__Harness", [
      12n,
      100n,
      await locator.getAddress(),
      await nodeOperatorsRegistry.getAddress(),
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
      100_000_000_000n,
      32_000_000_000n,
      48,
    );
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  // contract version
  it("should revert if set wrong version", async () => {
    await expect(oracle.finalizeUpgrade_v2(10, 100_000_000_000n, 32_000_000_000n, 48)).to.be.revertedWithCustomError(
      oracle,
      "InvalidContractVersionIncrement",
    );
  });

  it("should successfully finalize upgrade", async () => {
    await oracle.setContractVersion(1);

    // Set balance limits in Gwei (not validator counts)
    const maxExitBalanceGwei = 150_000_000_000n; // 150 ETH in Gwei
    const balancePerFrameGwei = 32_000_000_000n; // 32 ETH in Gwei (1 legacy validator)
    const maxValidatorsPerReport = 15;
    const frameDuration = 48;

    await oracle.finalizeUpgrade_v2(maxValidatorsPerReport, maxExitBalanceGwei, balancePerFrameGwei, frameDuration);

    expect(await oracle.getContractVersion()).to.equal(2);

    const exitRequestLimitData = await oracle.getExitRequestLimitFullInfo();
    expect(exitRequestLimitData.maxExitBalanceGwei).to.equal(maxExitBalanceGwei);
    expect(exitRequestLimitData.balancePerFrameGwei).to.equal(balancePerFrameGwei);
    expect(exitRequestLimitData.frameDurationInSec).to.equal(frameDuration);

    expect(await oracle.getMaxValidatorsPerReport()).to.equal(maxValidatorsPerReport);

    // should not allow to run finalizeUpgrade_v2 again
    await expect(oracle.finalizeUpgrade_v2(10, 100, 1, 48)).to.be.revertedWithCustomError(
      oracle,
      "InvalidContractVersionIncrement",
    );
  });
});
