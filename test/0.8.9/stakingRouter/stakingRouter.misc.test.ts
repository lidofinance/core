import { expect } from "chai";
import { hexlify, randomBytes, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForBeaconChainDepositor,
  DepositContract__MockForBeaconChainDepositor__factory,
  MinFirstAllocationStrategy__factory,
  StakingRouter,
  StakingRouter__factory,
} from "typechain-types";
import { StakingRouterLibraryAddresses } from "typechain-types/factories/contracts/0.8.9/StakingRouter__factory";

import { certainAddress, ether, proxify } from "lib";

describe("StakingRouter", () => {
  let deployer: HardhatEthersSigner;
  let proxyAdmin: HardhatEthersSigner;
  let stakingRouterAdmin: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let stakingRouter: StakingRouter;

  const lido = certainAddress("test:staking-router:lido");
  const withdrawalCredentials = hexlify(randomBytes(32));

  beforeEach(async () => {
    [deployer, proxyAdmin, stakingRouterAdmin, user] = await ethers.getSigners();

    depositContract = await new DepositContract__MockForBeaconChainDepositor__factory(deployer).deploy();

    const allocLib = await new MinFirstAllocationStrategy__factory(deployer).deploy();
    const allocLibAddr: StakingRouterLibraryAddresses = {
      ["contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy"]: await allocLib.getAddress(),
    };

    const impl = await new StakingRouter__factory(allocLibAddr, deployer).deploy(depositContract);
    [stakingRouter] = await proxify({ impl, admin: proxyAdmin, caller: user });
  });

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
        .withArgs(2)
        .and.to.emit(stakingRouter, "RoleGranted")
        .withArgs(await stakingRouter.DEFAULT_ADMIN_ROLE(), stakingRouterAdmin.address, user.address)
        .and.to.emit(stakingRouter, "WithdrawalCredentialsSet")
        .withArgs(withdrawalCredentials, user.address);

      expect(await stakingRouter.getContractVersion()).to.equal(2);
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
