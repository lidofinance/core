import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { LidoLocator } from "typechain-types";

import { proxify, streccak } from "lib";

import { deployLidoLocator } from "test/deploy";

describe("TriggerableWithdrawalsBus.sol: deployment", () => {
  let admin: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let locator: LidoLocator;

  before(async () => {
    [admin, stranger] = await ethers.getSigners();
    locator = await deployLidoLocator();
  });

  it("deploys and initializes with valid parameters", async () => {
    const impl = await ethers.deployContract("TriggerableWithdrawalsBus", [await locator.getAddress()]);
    const [bus] = await proxify({ impl, admin });

    await bus.initialize(admin.address);

    expect(await bus.LOCATOR()).to.equal(await locator.getAddress());
    expect(await bus.hasRole(await bus.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
    expect(await bus.getRoleMemberCount(await bus.DEFAULT_ADMIN_ROLE())).to.equal(1);
    expect(await bus.ADD_WITHDRAWAL_INTENTS_ROLE()).to.equal(streccak("ADD_WITHDRAWAL_INTENTS_ROLE"));
    expect(await bus.unprocessedIntentsCount()).to.equal(0);
    expect(await bus.getWithdrawalIntents(0, 10)).to.deep.equal([]);
  });

  it("reverts if lidoLocator is zero address", async () => {
    await expect(ethers.deployContract("TriggerableWithdrawalsBus", [ethers.ZeroAddress]))
      .to.be.revertedWithCustomError(await ethers.getContractFactory("TriggerableWithdrawalsBus"), "ZeroArgument")
      .withArgs("lidoLocator");
  });

  it("reverts if admin is zero address on initialize", async () => {
    const impl = await ethers.deployContract("TriggerableWithdrawalsBus", [await locator.getAddress()]);
    const [bus] = await proxify({ impl, admin });

    await expect(bus.initialize(ethers.ZeroAddress)).to.be.revertedWithCustomError(bus, "AdminCannotBeZero");
  });

  it("reverts on the second initialize", async () => {
    const impl = await ethers.deployContract("TriggerableWithdrawalsBus", [await locator.getAddress()]);
    const [bus] = await proxify({ impl, admin });

    await bus.initialize(admin.address);

    await expect(bus.connect(stranger).initialize(stranger.address)).to.be.revertedWithCustomError(
      bus,
      "InvalidInitialization",
    );
  });

  it("disables initializers on the implementation", async () => {
    const impl = await ethers.deployContract("TriggerableWithdrawalsBus", [await locator.getAddress()]);

    await expect(impl.initialize(admin.address)).to.be.revertedWithCustomError(impl, "InvalidInitialization");
  });
});
