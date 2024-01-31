import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { INITIAL_STETH_HOLDER, certainAddress, proxify } from "lib/address";
import {
  Lido,
  LidoLocator,
  Lido__factory,
  LidoLocatorPartialReturningOnlyWithdrawalQueueAndBurner__factory,
} from "typechain-types";

describe("Lido:initialize", () => {
  let deployer: HardhatEthersSigner;

  let impl: Lido;
  let lido: Lido;

  beforeEach(async () => {
    [deployer] = await ethers.getSigners();
    const factory = new Lido__factory(deployer);
    impl = await factory.deploy();
    expect(await impl.getInitializationBlock()).to.equal(MaxUint256);

    [lido] = await proxify({ impl, admin: deployer });
  });

  context("initialize", () => {
    const initialValue = 1n;
    const contractVersion = 2n;

    const withdrawalQueueAddress = certainAddress("lido:initialize:withdrawalQueue");
    const burnerAddress = certainAddress("lido:initialize:burner");
    const eip712helperAddress = certainAddress("lido:initialize:eip712helper");

    let locator: LidoLocator;

    beforeEach(async () => {
      const factory = new LidoLocatorPartialReturningOnlyWithdrawalQueueAndBurner__factory(deployer);
      locator = (await factory.deploy(withdrawalQueueAddress, burnerAddress)) as LidoLocator;
    });

    it("Reverts if Locator is zero address", async () => {
      await expect(lido.initialize(ZeroAddress, eip712helperAddress)).to.be.reverted;
    });

    it("Reverts if EIP-712 helper is zero address", async () => {
      await expect(lido.initialize(locator, ZeroAddress)).to.be.reverted;
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
  });
});
