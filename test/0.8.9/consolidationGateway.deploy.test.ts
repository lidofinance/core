import { expect } from "chai";
import { ethers } from "hardhat";

import { WithdrawalVault__MockForCG } from "typechain-types";

import { deployLidoLocator, updateLidoLocatorImplementation } from "../deploy/locator";

describe("ConsolidationGateway.sol: deployment", () => {
  let withdrawalVault: WithdrawalVault__MockForCG;

  before(async () => {
    const locator = await deployLidoLocator();
    const locatorAddr = await locator.getAddress();

    withdrawalVault = await ethers.deployContract("WithdrawalVault__MockForCG");

    await updateLidoLocatorImplementation(locatorAddr, {
      withdrawalVault: await withdrawalVault.getAddress(),
    });
  });

  it("should deploy successfully with valid admin", async () => {
    const [admin] = await ethers.getSigners();
    const locatorAddr = (await deployLidoLocator()).getAddress();

    const gateway = await ethers.deployContract("ConsolidationGateway__Harness", [
      admin.address,
      locatorAddr,
      100,
      1,
      48,
    ]);

    const adminRole = await gateway.DEFAULT_ADMIN_ROLE();
    expect(await gateway.hasRole(adminRole, admin.address)).to.be.true;
  });

  it("should revert if admin is zero address", async () => {
    const locatorAddr = (await deployLidoLocator()).getAddress();

    await expect(
      ethers.deployContract("ConsolidationGateway__Harness", [ethers.ZeroAddress, locatorAddr, 100, 1, 48]),
    ).to.be.revertedWithCustomError(
      await ethers.getContractFactory("ConsolidationGateway__Harness"),
      "AdminCannotBeZero",
    );
  });
});
