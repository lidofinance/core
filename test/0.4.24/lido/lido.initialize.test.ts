import { expect } from "chai";
import { MaxUint256, ZeroAddress } from "ethers";
import hre from "hardhat";

import type { HardhatEthers, HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import type { NetworkHelpers } from "@nomicfoundation/hardhat-network-helpers/types";

import { type Lido, type LidoLocator } from "typechain-types/index.js";

import { certainAddress } from "lib/address.js";
import { INITIAL_STETH_HOLDER } from "lib/constants.js";
import { streccak } from "lib/keccak.js";
import { proxify } from "lib/proxy.js";

import { deployLidoLocator } from "test/deploy/index.js";
import { Snapshot } from "test/suite/index.js";
import { DEPOSITS_RESERVE_TARGET } from "lib/index.js";

describe("Lido.sol:initialize", () => {
  let ethers: HardhatEthers;
  let networkHelpers: NetworkHelpers;

  let deployer: HardhatEthersSigner;

  let lido: Lido;

  let originalState: string;

  before(async () => {
    ({ ethers, networkHelpers } = await hre.network.getOrCreate());
    [deployer] = await ethers.getSigners();
    const impl = await ethers.deployContract("Lido", {
      signer: deployer,
    });

    expect(await impl.getInitializationBlock()).to.equal(MaxUint256);
    [lido] = await proxify({ impl, admin: deployer });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("initialize", () => {
    const initialValue = 1n;
    const contractVersion = 4n;

    let withdrawalQueueAddress: string;
    let burnerAddress: string;
    const eip712helperAddress = certainAddress("lido:initialize:eip712helper");

    let locator: LidoLocator;

    before(async () => {
      locator = await deployLidoLocator({ lido });
      [withdrawalQueueAddress, burnerAddress] = await Promise.all([locator.withdrawalQueue(), locator.burner()]);
    });

    it("Reverts if Locator is zero address", async () => {
      await expect(lido.initialize(ZeroAddress, eip712helperAddress)).to.revert(ethers);
    });

    it("Reverts if EIP-712 helper is zero address", async () => {
      await expect(lido.initialize(locator, ZeroAddress)).to.revert(ethers);
    });

    it("Reverts if already initialized", async () => {
      await lido.initialize(locator, eip712helperAddress, DEPOSITS_RESERVE_TARGET, { value: initialValue });

      await expect(
        lido.initialize(locator, eip712helperAddress, DEPOSITS_RESERVE_TARGET, { value: initialValue }),
      ).to.be.revertedWith("INIT_ALREADY_INITIALIZED");
    });

    it("Bootstraps initial holder, sets the locator and EIP-712 helper", async () => {
      const latestBlock = BigInt(await networkHelpers.time.latestBlock());

      await expect(lido.initialize(locator, eip712helperAddress, DEPOSITS_RESERVE_TARGET, { value: initialValue }))
        .to.emit(lido, "DepositsReserveTargetSet")
        .withArgs(DEPOSITS_RESERVE_TARGET)
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

      expect(await lido.getDepositsReserveTarget()).to.equal(DEPOSITS_RESERVE_TARGET);
      expect(await lido.getBufferedEther()).to.equal(initialValue);
      expect(await lido.getLidoLocator()).to.equal(await locator.getAddress());
      expect(await lido.getEIP712StETH()).to.equal(eip712helperAddress);
      expect(await lido.allowance(withdrawalQueueAddress, burnerAddress)).to.equal(MaxUint256);
      expect(await lido.getInitializationBlock()).to.equal(latestBlock + 1n);
      expect(await lido.getContractVersion()).to.equal(contractVersion);
    });

    it("Does not bootstrap initial holder if total shares is not zero", async () => {
      const totalSharesSlot = streccak("lido.StETH.totalAndExternalShares");
      await networkHelpers.setStorageAt(await lido.getAddress(), totalSharesSlot, 1n);

      await expect(lido.initialize(locator, eip712helperAddress, DEPOSITS_RESERVE_TARGET, { value: initialValue }))
        .not.to.emit(lido, "Submitted")
        .and.not.to.emit(lido, "Transfer")
        .and.not.to.emit(lido, "TransferShares");
    });
  });
});
