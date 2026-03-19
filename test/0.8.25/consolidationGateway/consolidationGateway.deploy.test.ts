import { expect } from "chai";
import { ethers } from "hardhat";

import { WithdrawalVault__MockForConsolidationGateway } from "typechain-types";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";

const DUMMY_GI = "0x0000000000000000000000000000000000000000000000000096000000000028";
const DUMMY_WC = "0x010000000000000000000000b9d7934878b5fb9610b3fe8a5e441e8fad7e293f";

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

  it("should deploy successfully with valid admin", async () => {
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
      DUMMY_WC,
    ]);

    const adminRole = await gateway.DEFAULT_ADMIN_ROLE();
    expect(await gateway.hasRole(adminRole, admin.address)).to.be.true;
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
        DUMMY_WC,
      ]),
    ).to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationGateway"), "AdminCannotBeZero");
  });
});
