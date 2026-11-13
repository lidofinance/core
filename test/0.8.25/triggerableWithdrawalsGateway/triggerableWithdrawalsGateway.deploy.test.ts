import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { LidoLocator } from "typechain-types";

import { streccak } from "lib";

import { deployLidoLocator, deployTriggerableWithdrawalsGateway } from "test/deploy";

describe("TriggerableWithdrawalsGateway.sol: deployment", () => {
  let admin: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let locator: LidoLocator;

  const deploy = async (args: unknown[]) => ethers.deployContract("TriggerableWithdrawalsGateway", args);

  const factory = () => ethers.getContractFactory("TriggerableWithdrawalsGateway");

  before(async () => {
    [admin, stranger] = await ethers.getSigners();
    locator = await deployLidoLocator();
  });

  it("deploys with valid parameters", async () => {
    const { gateway, locator: gatewayLocator } = await deployTriggerableWithdrawalsGateway(admin);

    expect(await gateway.LOCATOR()).to.equal(await gatewayLocator.getAddress());
    expect(await gateway.hasRole(await gateway.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
    expect(await gateway.getRoleMemberCount(await gateway.DEFAULT_ADMIN_ROLE())).to.equal(1);
    expect(await gateway.isPaused()).to.be.false;
  });

  it("has expected role constants", async () => {
    const { gateway } = await deployTriggerableWithdrawalsGateway(admin);

    expect(await gateway.PAUSE_ROLE()).to.equal(streccak("PAUSE_ROLE"));
    expect(await gateway.RESUME_ROLE()).to.equal(streccak("RESUME_ROLE"));
    expect(await gateway.TW_EXIT_LIMIT_MANAGER_ROLE()).to.equal(streccak("TW_EXIT_LIMIT_MANAGER_ROLE"));
  });

  it("has no request role: consumer limits decide who can submit requests", async () => {
    const { gateway } = await deployTriggerableWithdrawalsGateway(admin);

    // Neither ADD_WITHDRAWAL_REQUEST_ROLE nor the old ADD_FULL_WITHDRAWAL_REQUEST_ROLE
    expect(gateway.interface.format().join("\n")).to.not.include("WITHDRAWAL_REQUEST_ROLE");
  });

  it("starts without consumer limits", async () => {
    const { gateway } = await deployTriggerableWithdrawalsGateway(admin);

    const [pwrLimit, fwrLimit] = await gateway.getConsumerLimitsFullInfo(stranger.address);
    expect(pwrLimit).to.deep.equal([0n, 0n, 0n, 0n, 0n]);
    expect(fwrLimit).to.deep.equal([0n, 0n, 0n, 0n, 0n]);
  });

  context("reverts", () => {
    it("if admin is zero address", async () => {
      await expect(deploy([ethers.ZeroAddress, await locator.getAddress()]))
        .to.be.revertedWithCustomError(await factory(), "ZeroArgument")
        .withArgs("admin");
    });

    it("if lidoLocator is zero address", async () => {
      await expect(deploy([admin.address, ethers.ZeroAddress]))
        .to.be.revertedWithCustomError(await factory(), "ZeroArgument")
        .withArgs("lidoLocator");
    });
  });
});
