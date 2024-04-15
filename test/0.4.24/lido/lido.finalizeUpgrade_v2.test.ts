import { expect } from "chai";
import { MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { Lido__MockForFinalizeUpgradeV2, Lido__MockForFinalizeUpgradeV2__factory, LidoLocator } from "typechain-types";

import { certainAddress, dummyLocator, INITIAL_STETH_HOLDER, ONE_ETHER, proxify } from "lib";

describe("Lido:finalizeUpgrade_v2", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let impl: Lido__MockForFinalizeUpgradeV2;
  let lido: Lido__MockForFinalizeUpgradeV2;
  let locator: LidoLocator;

  const initialValue = 1n;
  const initialVersion = 0n;
  const finalizeVersion = 2n;

  let withdrawalQueueAddress: string;
  let burnerAddress: string;
  const eip712helperAddress = certainAddress("lido:initialize:eip712helper");

  beforeEach(async () => {
    [deployer, user] = await ethers.getSigners();
    const lidoFactory = new Lido__MockForFinalizeUpgradeV2__factory(deployer);
    impl = await lidoFactory.deploy();
    [lido] = await proxify({ impl, admin: deployer });

    locator = await dummyLocator();
    [withdrawalQueueAddress, burnerAddress] = await Promise.all([locator.withdrawalQueue(), locator.burner()]);
  });

  it("Reverts if contract version does not equal zero", async () => {
    const unexpectedVersion = 1n;

    await expect(lido.mock__initialize(unexpectedVersion, { value: initialValue }))
      .to.emit(lido, "Submitted")
      .withArgs(INITIAL_STETH_HOLDER, initialValue, ZeroAddress)
      .and.to.emit(lido, "Transfer")
      .withArgs(ZeroAddress, INITIAL_STETH_HOLDER, initialValue)
      .and.to.emit(lido, "TransferShares")
      .withArgs(ZeroAddress, INITIAL_STETH_HOLDER, initialValue)
      .and.to.emit(lido, "ContractVersionSet")
      .withArgs(unexpectedVersion);

    await expect(lido.finalizeUpgrade_v2(ZeroAddress, eip712helperAddress)).to.be.reverted;
  });

  it("Reverts if not initialized", async () => {
    await expect(lido.finalizeUpgrade_v2(locator, eip712helperAddress)).to.be.revertedWith("NOT_INITIALIZED");
  });

  context("contractVersion equals 0", () => {
    beforeEach(async () => {
      const latestBlock = BigInt(await time.latestBlock());

      await expect(lido.mock__initialize(initialVersion, { value: initialValue }))
        .to.emit(lido, "Submitted")
        .withArgs(INITIAL_STETH_HOLDER, initialValue, ZeroAddress)
        .and.to.emit(lido, "Transfer")
        .withArgs(ZeroAddress, INITIAL_STETH_HOLDER, initialValue)
        .and.to.emit(lido, "TransferShares")
        .withArgs(ZeroAddress, INITIAL_STETH_HOLDER, initialValue)
        .and.to.emit(lido, "ContractVersionSet")
        .withArgs(initialVersion);

      expect(await impl.getInitializationBlock()).to.equal(MaxUint256);
      expect(await lido.getInitializationBlock()).to.equal(latestBlock + 1n);
    });

    it("Reverts if Locator is zero address", async () => {
      await expect(lido.finalizeUpgrade_v2(ZeroAddress, eip712helperAddress)).to.be.reverted;
    });

    it("Reverts if EIP-712 helper is zero address", async () => {
      await expect(lido.finalizeUpgrade_v2(locator, ZeroAddress)).to.be.reverted;
    });

    it("Reverts if the balance of initial holder is zero", async () => {
      // first get someone else's some tokens to avoid division by 0 error
      await lido.mock__mintSharesWithoutChecks(user, ONE_ETHER);
      // then burn initial user's tokens
      await lido.mock__burnInitialHoldersShares();

      await expect(lido.finalizeUpgrade_v2(locator, eip712helperAddress)).to.be.revertedWith("INITIAL_HOLDER_EXISTS");
    });

    it("Bootstraps initial holder, sets the locator and EIP-712 helper", async () => {
      await expect(lido.finalizeUpgrade_v2(locator, eip712helperAddress))
        .and.to.emit(lido, "ContractVersionSet")
        .withArgs(finalizeVersion)
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
    });
  });
});
