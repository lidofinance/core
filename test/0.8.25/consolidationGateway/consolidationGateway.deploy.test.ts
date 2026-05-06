import { expect } from "chai";
import { ethers } from "hardhat";

import { WithdrawalVault__MockForConsolidationGateway } from "typechain-types";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";

const DUMMY_GI = "0x0000000000000000000000000000000000000000000000000096000000000028";

describe("ConsolidationGateway.sol: deployment", () => {
  let withdrawalVault: WithdrawalVault__MockForConsolidationGateway;

  before(async () => {
    const locator = await deployLidoLocator();
    const locatorAddr = await locator.getAddress();

    withdrawalVault = await ethers.deployContract("WithdrawalVault__MockForConsolidationGateway");

    await updateLidoLocatorImplementation(locatorAddr, {
      withdrawalVault: await withdrawalVault.getAddress(),
    });
  });

  it("should deploy successfully with valid admin and verify initial state", async () => {
    const [admin] = await ethers.getSigners();
    const locatorAddr = (await deployLidoLocator()).getAddress();

    const gateway = await ethers.deployContract("ConsolidationGateway", [
      admin.address,
      locatorAddr,
      100,
      1,
      48,
      DUMMY_GI,
      DUMMY_GI,
      0,
    ]);

    const adminRole = await gateway.DEFAULT_ADMIN_ROLE();
    expect(await gateway.hasRole(adminRole, admin.address)).to.be.true;
  });

  it("should initialize rate limit config during deployment", async () => {
    const [admin] = await ethers.getSigners();
    const locatorAddr = (await deployLidoLocator()).getAddress();

    const gateway = await ethers.deployContract("ConsolidationGateway", [
      admin.address,
      locatorAddr,
      50,
      5,
      100,
      DUMMY_GI,
      DUMMY_GI,
      0,
    ]);

    const data = await gateway.getConsolidationRequestLimitFullInfo();
    expect(data[0]).to.equal(50); // maxConsolidationRequestsLimit
    expect(data[1]).to.equal(5); // consolidationsPerFrame
    expect(data[2]).to.equal(100); // frameDurationInSec
    expect(data[3]).to.equal(50); // prevConsolidationRequestsLimit
    expect(data[4]).to.equal(50); // currentConsolidationRequestsLimit
  });

  it("should emit ConsolidationRequestsLimitSet during deployment", async () => {
    const [admin] = await ethers.getSigners();
    const locatorAddr = (await deployLidoLocator()).getAddress();

    const gateway = await ethers.deployContract("ConsolidationGateway", [
      admin.address,
      locatorAddr,
      100,
      1,
      48,
      DUMMY_GI,
      DUMMY_GI,
      0,
    ]);

    await expect(gateway.deploymentTransaction())
      .to.emit(gateway, "ConsolidationRequestsLimitSet")
      .withArgs(100, 1, 48);
  });

  it("should revert if admin is zero address", async () => {
    const locatorAddr = (await deployLidoLocator()).getAddress();

    await expect(
      ethers.deployContract("ConsolidationGateway", [
        ethers.ZeroAddress,
        locatorAddr,
        100,
        1,
        48,
        DUMMY_GI,
        DUMMY_GI,
        0,
      ]),
    ).to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationGateway"), "AdminCannotBeZero");
  });

  it("should revert if lidoLocator is zero address", async () => {
    const [admin] = await ethers.getSigners();

    await expect(
      ethers.deployContract("ConsolidationGateway", [
        admin.address,
        ethers.ZeroAddress,
        100,
        1,
        48,
        DUMMY_GI,
        DUMMY_GI,
        0,
      ]),
    )
      .to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationGateway"), "ZeroArgument")
      .withArgs("lidoLocator");
  });
});
