import { expect } from "chai";
import { MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { Lido__HarnessForFinalizeUpgradeV3, LidoLocator } from "typechain-types";

import { certainAddress, INITIAL_STETH_HOLDER, proxify } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("Lido.sol:finalizeUpgrade_v3", () => {
  let deployer: HardhatEthersSigner;

  let impl: Lido__HarnessForFinalizeUpgradeV3;
  let lido: Lido__HarnessForFinalizeUpgradeV3;
  let locator: LidoLocator;

  const initialValue = 1n;
  const initialVersion = 2n;
  const finalizeVersion = 3n;

  let withdrawalQueueAddress: string;
  let burnerAddress: string;
  const eip712helperAddress = certainAddress("lido:initialize:eip712helper");

  let originalState: string;

  before(async () => {
    [deployer] = await ethers.getSigners();
    impl = await ethers.deployContract("Lido__HarnessForFinalizeUpgradeV3");
    [lido] = await proxify({ impl, admin: deployer });

    locator = await deployLidoLocator();
    [withdrawalQueueAddress, burnerAddress] = await Promise.all([locator.withdrawalQueue(), locator.burner()]);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  it("Reverts if not initialized", async () => {
    await expect(lido.harness_setContractVersion(initialVersion))
      .and.to.emit(lido, "ContractVersionSet")
      .withArgs(initialVersion);

    await expect(lido.finalizeUpgrade_v3()).to.be.revertedWith("NOT_INITIALIZED");
  });

  context("initialized", () => {
    before(async () => {
      const latestBlock = BigInt(await time.latestBlock());

      await expect(lido.initialize(locator, eip712helperAddress, { value: initialValue }))
        .to.emit(lido, "Submitted")
        .withArgs(INITIAL_STETH_HOLDER, initialValue, ZeroAddress)
        .and.to.emit(lido, "Transfer")
        .withArgs(ZeroAddress, INITIAL_STETH_HOLDER, initialValue)
        .and.to.emit(lido, "TransferShares")
        .withArgs(ZeroAddress, INITIAL_STETH_HOLDER, initialValue)
        .and.to.emit(lido, "ContractVersionSet")
        .withArgs(finalizeVersion)
        .and.to.emit(lido, "EIP712StETHInitialized")
        .withArgs(eip712helperAddress)
        .and.to.emit(lido, "Approval")
        .withArgs(withdrawalQueueAddress, burnerAddress, MaxUint256)
        .and.to.emit(lido, "LidoLocatorSet")
        .withArgs(await locator.getAddress());

      expect(await impl.getInitializationBlock()).to.equal(MaxUint256);
      expect(await lido.getInitializationBlock()).to.equal(latestBlock + 1n);
    });

    it("Reverts if initialized from scratch", async () => {
      await expect(lido.finalizeUpgrade_v3()).to.be.reverted;
    });

    it("Reverts if contract version does not equal 2", async () => {
      const unexpectedVersion = 1n;

      await expect(lido.harness_setContractVersion(unexpectedVersion))
        .and.to.emit(lido, "ContractVersionSet")
        .withArgs(unexpectedVersion);

      await expect(lido.finalizeUpgrade_v3()).to.be.reverted;
    });

    it("Sets contract version to 3", async () => {
      await expect(lido.harness_setContractVersion(initialVersion))
        .and.to.emit(lido, "ContractVersionSet")
        .withArgs(initialVersion);

      await expect(lido.finalizeUpgrade_v3()).and.to.emit(lido, "ContractVersionSet").withArgs(finalizeVersion);

      expect(await lido.getContractVersion()).to.equal(finalizeVersion);
    });
  });
});
