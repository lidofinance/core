import { expect } from "chai";
import { ethers } from "hardhat";

import { StakingRouter__MockForTWG, WithdrawalVault__MockForTWG } from "typechain-types";

import { deployLidoLocator, updateLidoLocatorImplementation } from "../deploy/locator";

describe("TriggerableWithdrawalsGateway.sol: deployment", () => {
  let withdrawalVault: WithdrawalVault__MockForTWG;
  let stakingRouter: StakingRouter__MockForTWG;

  before(async () => {
    const locator = await deployLidoLocator();
    const locatorAddr = await locator.getAddress();

    withdrawalVault = await ethers.deployContract("WithdrawalVault__MockForTWG");
    stakingRouter = await ethers.deployContract("StakingRouter__MockForTWG");

    await updateLidoLocatorImplementation(locatorAddr, {
      withdrawalVault: await withdrawalVault.getAddress(),
      stakingRouter: await stakingRouter.getAddress(),
    });
  });

  it("should deploy successfully with valid admin", async () => {
    const [admin] = await ethers.getSigners();
    const locatorAddr = (await deployLidoLocator()).getAddress();

    const gateway = await ethers.deployContract("TriggerableWithdrawalsGateway__Harness", [
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
      ethers.deployContract("TriggerableWithdrawalsGateway__Harness", [ethers.ZeroAddress, locatorAddr, 100, 1, 48]),
    ).to.be.revertedWithCustomError(
      await ethers.getContractFactory("TriggerableWithdrawalsGateway__Harness"),
      "AdminCannotBeZero",
    );
  });
});
