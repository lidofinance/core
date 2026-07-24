import { expect } from "chai";
import { ethers } from "hardhat";

import { ConsolidationGateway__MockForConsolidationBus } from "typechain-types";

import { proxify } from "lib/proxy";

describe("ConsolidationBus.sol: deployment", () => {
  let consolidationGateway: ConsolidationGateway__MockForConsolidationBus;

  before(async () => {
    consolidationGateway = await ethers.deployContract("ConsolidationGateway__MockForConsolidationBus");
  });

  it("should deploy and initialize successfully with valid parameters", async () => {
    const [admin] = await ethers.getSigners();
    const gatewayAddr = await consolidationGateway.getAddress();

    const impl = await ethers.deployContract("ConsolidationBus", [gatewayAddr]);
    const [bus] = await proxify({ impl, admin });
    await bus.initialize(admin.address, 100, 100, 0);

    const adminRole = await bus.DEFAULT_ADMIN_ROLE();
    expect(await bus.hasRole(adminRole, admin.address)).to.be.true;
    expect(await bus.batchSize()).to.equal(100);
    expect(await bus.maxGroupsInBatch()).to.equal(100);
    expect(await bus.getConsolidationGateway()).to.equal(gatewayAddr);
  });

  it("should revert if admin is zero address on initialize", async () => {
    const [admin] = await ethers.getSigners();
    const gatewayAddr = await consolidationGateway.getAddress();

    const impl = await ethers.deployContract("ConsolidationBus", [gatewayAddr]);
    const [bus] = await proxify({ impl, admin });

    await expect(bus.initialize(ethers.ZeroAddress, 100, 100, 0)).to.be.revertedWithCustomError(
      bus,
      "AdminCannotBeZero",
    );
  });

  it("should revert if consolidationGateway is zero address", async () => {
    await expect(ethers.deployContract("ConsolidationBus", [ethers.ZeroAddress]))
      .to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationBus"), "ZeroArgument")
      .withArgs("consolidationGateway");
  });

  it("should revert zero batch size on initialize", async () => {
    const [admin] = await ethers.getSigners();
    const gatewayAddr = await consolidationGateway.getAddress();

    const impl = await ethers.deployContract("ConsolidationBus", [gatewayAddr]);
    const [bus] = await proxify({ impl, admin });

    await expect(bus.initialize(admin.address, 0, 100, 0))
      .to.be.revertedWithCustomError(bus, "ZeroArgument")
      .withArgs("batchSizeLimit");
  });

  it("should revert zero max groups in batch on initialize", async () => {
    const [admin] = await ethers.getSigners();
    const gatewayAddr = await consolidationGateway.getAddress();

    const impl = await ethers.deployContract("ConsolidationBus", [gatewayAddr]);
    const [bus] = await proxify({ impl, admin });

    await expect(bus.initialize(admin.address, 100, 0, 0))
      .to.be.revertedWithCustomError(bus, "ZeroArgument")
      .withArgs("maxGroupsInBatchLimit");
  });

  it("should revert if maxGroupsInBatch exceeds batchSize on initialize", async () => {
    const [admin] = await ethers.getSigners();
    const gatewayAddr = await consolidationGateway.getAddress();

    const impl = await ethers.deployContract("ConsolidationBus", [gatewayAddr]);
    const [bus] = await proxify({ impl, admin });

    await expect(bus.initialize(admin.address, 10, 20, 0))
      .to.be.revertedWithCustomError(bus, "MaxGroupsExceedsBatchSize")
      .withArgs(20, 10);
  });

  it("should revert on double initialization", async () => {
    const [admin] = await ethers.getSigners();
    const gatewayAddr = await consolidationGateway.getAddress();

    const impl = await ethers.deployContract("ConsolidationBus", [gatewayAddr]);
    const [bus] = await proxify({ impl, admin });
    await bus.initialize(admin.address, 100, 100, 0);

    await expect(bus.initialize(admin.address, 100, 100, 0)).to.be.revertedWithCustomError(
      bus,
      "InvalidInitialization",
    );
  });
});
