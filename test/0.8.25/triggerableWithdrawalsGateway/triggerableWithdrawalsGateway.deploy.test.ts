import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { LidoLocator } from "typechain-types";

import { streccak } from "lib";

import { DEFAULT_TWG_LIMIT, deployLidoLocator, deployTriggerableWithdrawalsGateway } from "test/deploy";

describe("TriggerableWithdrawalsGateway.sol: deployment", () => {
  let admin: HardhatEthersSigner;
  let locator: LidoLocator;

  const deploy = async (args: unknown[]) => ethers.deployContract("TriggerableWithdrawalsGateway", args);

  const factory = () => ethers.getContractFactory("TriggerableWithdrawalsGateway");

  before(async () => {
    [admin] = await ethers.getSigners();
    locator = await deployLidoLocator();
  });

  it("deploys with valid parameters", async () => {
    const { gateway, locator: gatewayLocator } = await deployTriggerableWithdrawalsGateway(admin);

    expect(await gateway.LOCATOR()).to.equal(await gatewayLocator.getAddress());
    expect(await gateway.hasRole(await gateway.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
    expect(await gateway.getRoleMemberCount(await gateway.DEFAULT_ADMIN_ROLE())).to.equal(1);
    expect(await gateway.isPaused()).to.be.false;
  });

  it("has expected role and storage constants", async () => {
    const { gateway } = await deployTriggerableWithdrawalsGateway(admin);

    expect(await gateway.PAUSE_ROLE()).to.equal(streccak("PAUSE_ROLE"));
    expect(await gateway.RESUME_ROLE()).to.equal(streccak("RESUME_ROLE"));
    expect(await gateway.ADD_WITHDRAWAL_REQUEST_ROLE()).to.equal(streccak("ADD_WITHDRAWAL_REQUEST_ROLE"));
    expect(await gateway.TW_EXIT_LIMIT_MANAGER_ROLE()).to.equal(streccak("TW_EXIT_LIMIT_MANAGER_ROLE"));
    expect(await gateway.EXIT_BALANCE_LIMIT_POSITION()).to.equal(
      streccak("lido.TriggerableWithdrawalsGateway.exitBalanceLimitEth"),
    );
  });

  it("starts with a fully available exit balance limit", async () => {
    const { gateway } = await deployTriggerableWithdrawalsGateway(admin);

    const info = await gateway.getExitRequestLimitFullInfo();
    expect(info.maxExitBalanceEth).to.equal(DEFAULT_TWG_LIMIT.maxExitBalanceEth);
    expect(info.balancePerFrameEth).to.equal(DEFAULT_TWG_LIMIT.balancePerFrameEth);
    expect(info.frameDurationInSec).to.equal(DEFAULT_TWG_LIMIT.frameDurationInSec);
    expect(info.prevExitBalanceEth).to.equal(DEFAULT_TWG_LIMIT.maxExitBalanceEth);
    expect(info.currentExitBalanceEth).to.equal(DEFAULT_TWG_LIMIT.maxExitBalanceEth);
  });

  it("emits ExitBalanceLimitSet on deployment", async () => {
    const gateway = await deploy([admin.address, await locator.getAddress(), 2048, 1, 12]);

    await expect(gateway.deploymentTransaction()).to.emit(gateway, "ExitBalanceLimitSet").withArgs(2048, 1, 12);
  });

  it("accepts the max exit balance equal to the full withdrawal weight", async () => {
    const gateway = await deploy([admin.address, await locator.getAddress(), 2048, 2048, 12]);

    expect((await gateway.getExitRequestLimitFullInfo()).maxExitBalanceEth).to.equal(2048);
  });

  context("reverts", () => {
    it("if admin is zero address", async () => {
      await expect(deploy([ethers.ZeroAddress, await locator.getAddress(), 2048, 1, 12]))
        .to.be.revertedWithCustomError(await factory(), "ZeroArgument")
        .withArgs("admin");
    });

    it("if lidoLocator is zero address", async () => {
      await expect(deploy([admin.address, ethers.ZeroAddress, 2048, 1, 12]))
        .to.be.revertedWithCustomError(await factory(), "ZeroArgument")
        .withArgs("lidoLocator");
    });

    it("if max exit balance is below the full withdrawal weight", async () => {
      await expect(deploy([admin.address, await locator.getAddress(), 2047, 1, 12]))
        .to.be.revertedWithCustomError(await factory(), "TooSmallMaxExitBalance")
        .withArgs(2047);
    });

    it("if balance per frame is zero", async () => {
      await expect(deploy([admin.address, await locator.getAddress(), 2048, 0, 12]))
        .to.be.revertedWithCustomError(await factory(), "ZeroArgument")
        .withArgs("balancePerFrameEth");
    });

    it("if balance per frame exceeds the max exit balance", async () => {
      await expect(deploy([admin.address, await locator.getAddress(), 2048, 2049, 12])).to.be.revertedWithCustomError(
        await factory(),
        "TooLargeItemsPerFrame",
      );
    });

    it("if frame duration is zero", async () => {
      await expect(deploy([admin.address, await locator.getAddress(), 2048, 1, 0])).to.be.revertedWithCustomError(
        await factory(),
        "ZeroFrameDuration",
      );
    });

    it("if max exit balance exceeds uint32", async () => {
      await expect(deploy([admin.address, await locator.getAddress(), 2n ** 32n, 1, 12])).to.be.revertedWithCustomError(
        await factory(),
        "TooLargeMaxLimit",
      );
    });
  });
});
