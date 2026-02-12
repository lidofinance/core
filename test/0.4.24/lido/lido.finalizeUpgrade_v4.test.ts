import { expect } from "chai";
import { MaxUint256 } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { Lido__HarnessForFinalizeUpgradeV4 } from "typechain-types";

import { ether, getStorageAtPositionAsUint128Pair, proxify } from "lib";

import { Snapshot } from "test/suite";

describe("Lido.sol:finalizeUpgrade_v4", () => {
  let deployer: HardhatEthersSigner;

  let impl: Lido__HarnessForFinalizeUpgradeV4;
  let lido: Lido__HarnessForFinalizeUpgradeV4;

  const initialValue = 1n;
  const finalizeVersion = 4n;

  let originalState: string;

  before(async () => {
    [deployer] = await ethers.getSigners();
    const fastLaneLib = await ethers.deployContract("FastLaneStorage", deployer);
    impl = await ethers.deployContract("Lido__HarnessForFinalizeUpgradeV4", {
      signer: deployer,
      libraries: {
        ["contracts/0.4.24/lib/FastLaneStorage.sol:FastLaneStorage"]: await fastLaneLib.getAddress(),
      },
    });
    [lido] = await proxify({ impl, admin: deployer });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(originalState));

  it("Reverts if not initialized", async () => {
    await expect(lido.finalizeUpgrade_v4()).to.be.revertedWith("NOT_INITIALIZED");
  });

  context("initialized", () => {
    before(async () => {
      const latestBlock = BigInt(await time.latestBlock());

      await lido.connect(deployer).harness_initialize_v3({ value: initialValue });

      expect(await impl.getInitializationBlock()).to.equal(MaxUint256);
      expect(await lido.getInitializationBlock()).to.equal(latestBlock + 1n);
    });

    it("Reverts if contract version does not equal 3", async () => {
      const unexpectedVersion = 1n;
      await lido.harness_setContractVersion(unexpectedVersion);
      await expect(lido.finalizeUpgrade_v4()).to.be.revertedWith("UNEXPECTED_CONTRACT_VERSION");
    });

    it("Sets contract version to 3 and max external ratio to 10", async () => {
      await expect(lido.finalizeUpgrade_v4()).to.emit(lido, "ContractVersionSet").withArgs(finalizeVersion);
      expect(await lido.getContractVersion()).to.equal(finalizeVersion);
    });

    it("Migrates storage successfully", async () => {
      const { low: bufferedEther, high: depositedValidators } = await getStorageAtPositionAsUint128Pair(
        lido,
        "lido.Lido.bufferedEtherAndDepositedValidators",
      );
      const { low: clBalance, high: clValidators } = await getStorageAtPositionAsUint128Pair(
        lido,
        "lido.Lido.clBalanceAndClValidators",
      );

      const depositedBalance = (depositedValidators - clValidators) * ether("32");

      await expect(lido.finalizeUpgrade_v4()).to.not.be.reverted;

      expect(await lido.getBufferedEther()).to.equal(bufferedEther);
      expect((await lido.getBeaconStat()).beaconBalance).to.equal(clBalance);
      expect((await lido.getBeaconStat()).beaconValidators).to.equal(depositedValidators);
      expect((await lido.getBeaconStat()).depositedValidators).to.equal(depositedValidators);
      expect((await lido.getBalanceStats()).clValidatorsBalanceAtLastReport).to.equal(clBalance);
      expect((await lido.getBalanceStats()).clPendingBalanceAtLastReport).to.equal(0);
      expect((await lido.getBalanceStats()).depositedSinceLastReport).to.equal(depositedBalance);
    });
  });
});
