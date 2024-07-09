import { expect } from "chai";
import { MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setStorageAt, time } from "@nomicfoundation/hardhat-network-helpers";

import { Lido, Lido__factory, LidoLocator } from "typechain-types";

import { certainAddress, INITIAL_STETH_HOLDER, proxify, streccak } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("Lido:initialize", () => {
  let deployer: HardhatEthersSigner;

  let lido: Lido;

  let originalState: string;

  before(async () => {
    [deployer] = await ethers.getSigners();
    const factory = new Lido__factory(deployer);
    const impl = await factory.deploy();

    expect(await impl.getInitializationBlock()).to.equal(MaxUint256);
    [lido] = await proxify({ impl, admin: deployer });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("initialize", () => {
    const initialValue = 1n;
    const contractVersion = 2n;

    let withdrawalQueueAddress: string;
    let burnerAddress: string;
    const eip712helperAddress = certainAddress("lido:initialize:eip712helper");

    let locator: LidoLocator;

    beforeEach(async () => {
      locator = await deployLidoLocator({ lido });
      [withdrawalQueueAddress, burnerAddress] = await Promise.all([locator.withdrawalQueue(), locator.burner()]);
    });

    it("Reverts if Locator is zero address", async () => {
      await expect(lido.initialize(ZeroAddress, eip712helperAddress)).to.be.reverted;
    });

    it("Reverts if EIP-712 helper is zero address", async () => {
      await expect(lido.initialize(locator, ZeroAddress)).to.be.reverted;
    });

    it("Reverts if already initialized", async () => {
      await lido.initialize(locator, eip712helperAddress, { value: initialValue });

      await expect(lido.initialize(locator, eip712helperAddress, { value: initialValue })).to.be.revertedWith(
        "INIT_ALREADY_INITIALIZED",
      );
    });

    it("Bootstraps initial holder, sets the locator and EIP-712 helper", async () => {
      const latestBlock = BigInt(await time.latestBlock());

      await expect(lido.initialize(locator, eip712helperAddress, { value: initialValue }))
        .to.emit(lido, "Submitted")
        .withArgs(INITIAL_STETH_HOLDER, initialValue, ZeroAddress)
        .and.to.emit(lido, "Transfer")
        .withArgs(ZeroAddress, INITIAL_STETH_HOLDER, initialValue)
        .and.to.emit(lido, "TransferShares")
        .withArgs(ZeroAddress, INITIAL_STETH_HOLDER, initialValue)
        .and.to.emit(lido, "ContractVersionSet")
        .withArgs(contractVersion)
        .and.to.emit(lido, "EIP712StETHInitialized")
        .withArgs(eip712helperAddress)
        .and.to.emit(lido, "Approval")
        .withArgs(withdrawalQueueAddress, burnerAddress, MaxUint256)
        .and.to.emit(lido, "LidoLocatorSet")
        .withArgs(await locator.getAddress());

      expect(await lido.getBufferedEther()).to.equal(initialValue);
      expect(await lido.getLidoLocator()).to.equal(await locator.getAddress());
      expect(await lido.getEIP712StETH()).to.equal(eip712helperAddress);
      expect(await lido.allowance(withdrawalQueueAddress, burnerAddress)).to.equal(MaxUint256);
      expect(await lido.getInitializationBlock()).to.equal(latestBlock + 1n);
    });

    it("Does not bootstrap initial holder if total shares is not zero", async () => {
      const totalSharesSlot = streccak("lido.StETH.totalShares");
      await setStorageAt(await lido.getAddress(), totalSharesSlot, 1n);

      await expect(lido.initialize(locator, eip712helperAddress, { value: initialValue }))
        .not.to.emit(lido, "Submitted")
        .and.not.to.emit(lido, "Transfer")
        .and.not.to.emit(lido, "TransferShares");
    });
  });
});
