import { expect } from "chai";
import { hexlify, randomBytes, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { DepositContract__MockForBeaconChainDepositor, StakingRouter } from "typechain-types";

import { certainAddress, ether, proxify } from "lib";

import { Snapshot } from "test/suite";

describe("StakingRouter.sol:misc", () => {
  let deployer: HardhatEthersSigner;
  let proxyAdmin: HardhatEthersSigner;
  let stakingRouterAdmin: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let stakingRouterImpl: StakingRouter;
  let stakingRouter: StakingRouter;

  let originalState: string;

  const lido = certainAddress("test:staking-router:lido");
  const withdrawalCredentials = hexlify(randomBytes(32));

  before(async () => {
    [deployer, proxyAdmin, stakingRouterAdmin, user] = await ethers.getSigners();

    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);
    stakingRouterImpl = await ethers.deployContract("StakingRouter", [depositContract], deployer);
    [stakingRouter] = await proxify({ impl: stakingRouterImpl, admin: proxyAdmin, caller: user });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("initialize", () => {
    it("Reverts if admin is zero address", async () => {
      await expect(stakingRouter.initialize(ZeroAddress, lido, withdrawalCredentials))
        .to.be.revertedWithCustomError(stakingRouter, "ZeroAddress")
        .withArgs("_admin");
    });

    it("Reverts if lido is zero address", async () => {
      await expect(stakingRouter.initialize(stakingRouterAdmin.address, ZeroAddress, withdrawalCredentials))
        .to.be.revertedWithCustomError(stakingRouter, "ZeroAddress")
        .withArgs("_lido");
    });

    it("Initializes the contract version, sets up roles and variables", async () => {
      await expect(stakingRouter.initialize(stakingRouterAdmin.address, lido, withdrawalCredentials))
        .to.emit(stakingRouter, "ContractVersionSet")
        .withArgs(1)
        .and.to.emit(stakingRouter, "RoleGranted")
        .withArgs(await stakingRouter.DEFAULT_ADMIN_ROLE(), stakingRouterAdmin.address, user.address)
        .and.to.emit(stakingRouter, "WithdrawalCredentialsSet")
        .withArgs(withdrawalCredentials, user.address);

      expect(await stakingRouter.getContractVersion()).to.equal(1);
      expect(await stakingRouter.getLido()).to.equal(lido);
      expect(await stakingRouter.getWithdrawalCredentials()).to.equal(withdrawalCredentials);
    });
  });

  context("receive", () => {
    it("Reverts", async () => {
      await expect(
        user.sendTransaction({
          to: stakingRouter,
          value: ether("1.0"),
        }),
      ).to.be.revertedWithCustomError(stakingRouter, "DirectETHTransfer");
    });
  });

  context("getLido", () => {
    it("Returns zero address before initialization", async () => {
      expect(await stakingRouter.getLido()).to.equal(ZeroAddress);
    });

    it("Returns lido address after initialization", async () => {
      await stakingRouter.initialize(stakingRouterAdmin.address, lido, withdrawalCredentials);

      expect(await stakingRouter.getLido()).to.equal(lido);
    });
  });
});
