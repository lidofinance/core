import { expect } from "chai";
import { ethers } from "hardhat";

import { ConsolidationGateway__MockForConsolidationBus } from "typechain-types";

describe("ConsolidationBus.sol: deployment", () => {
  let consolidationGateway: ConsolidationGateway__MockForConsolidationBus;

  before(async () => {
    consolidationGateway = await ethers.deployContract("ConsolidationGateway__MockForConsolidationBus");
  });

  it("should deploy successfully with valid parameters", async () => {
    const [admin] = await ethers.getSigners();
    const gatewayAddr = await consolidationGateway.getAddress();

    const bus = await ethers.deployContract("ConsolidationBus", [admin.address, gatewayAddr, 100, 100, 0]);

    const adminRole = await bus.DEFAULT_ADMIN_ROLE();
    expect(await bus.hasRole(adminRole, admin.address)).to.be.true;
    expect(await bus.batchSize()).to.equal(100);
    expect(await bus.maxGroupsInBatch()).to.equal(100);
    expect(await bus.getConsolidationGateway()).to.equal(gatewayAddr);
  });

  it("should revert if admin is zero address", async () => {
    const gatewayAddr = await consolidationGateway.getAddress();

    await expect(
      ethers.deployContract("ConsolidationBus", [ethers.ZeroAddress, gatewayAddr, 100, 100, 0]),
    ).to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationBus"), "AdminCannotBeZero");
  });

  it("should revert if consolidationGateway is zero address", async () => {
    const [admin] = await ethers.getSigners();

    await expect(ethers.deployContract("ConsolidationBus", [admin.address, ethers.ZeroAddress, 100, 100, 0]))
      .to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationBus"), "ZeroArgument")
      .withArgs("consolidationGateway");
  });

  it("should revert zero batch size", async () => {
    const [admin] = await ethers.getSigners();
    const gatewayAddr = await consolidationGateway.getAddress();

    await expect(ethers.deployContract("ConsolidationBus", [admin.address, gatewayAddr, 0, 100, 0]))
      .to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationBus"), "ZeroArgument")
      .withArgs("batchSizeLimit");
  });

  it("should revert zero max groups in batch", async () => {
    const [admin] = await ethers.getSigners();
    const gatewayAddr = await consolidationGateway.getAddress();

    await expect(ethers.deployContract("ConsolidationBus", [admin.address, gatewayAddr, 100, 0, 0]))
      .to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationBus"), "ZeroArgument")
      .withArgs("maxGroupsInBatchLimit");
  });

  it("should revert if maxGroupsInBatch exceeds batchSize", async () => {
    const [admin] = await ethers.getSigners();
    const gatewayAddr = await consolidationGateway.getAddress();

    await expect(ethers.deployContract("ConsolidationBus", [admin.address, gatewayAddr, 10, 20, 0]))
      .to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationBus"), "MaxGroupsExceedsBatchSize")
      .withArgs(20, 10);
  });
});
