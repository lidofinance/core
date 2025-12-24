import { expect } from "chai";
import { hexlify, randomBytes, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { DepositContract__MockForBeaconChainDepositor, StakingRouter__Harness } from "typechain-types";

import { certainAddress, ether, MAX_UINT256, proxify, randomString } from "lib";

import { Snapshot } from "test/suite";

describe("StakingRouter.sol:misc", () => {
  let deployer: HardhatEthersSigner;
  let proxyAdmin: HardhatEthersSigner;
  let stakingRouterAdmin: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let stakingRouter: StakingRouter__Harness;
  let impl: StakingRouter__Harness;

  let originalState: string;

  const lido = certainAddress("test:staking-router:lido");
  const withdrawalCredentials = hexlify(randomBytes(32));

  before(async () => {
    [deployer, proxyAdmin, stakingRouterAdmin, user] = await ethers.getSigners();

    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);
    const allocLib = await ethers.deployContract("MinFirstAllocationStrategy", deployer);
    const stakingRouterFactory = await ethers.getContractFactory("StakingRouter__Harness", {
      libraries: {
        ["contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy"]: await allocLib.getAddress(),
      },
    });

    impl = await stakingRouterFactory.connect(deployer).deploy(depositContract);

    [stakingRouter] = await proxify({ impl, admin: proxyAdmin, caller: user });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("initialize", () => {
    it("Reverts if admin is zero address", async () => {
      await expect(stakingRouter.initialize(ZeroAddress, lido, withdrawalCredentials)).to.be.revertedWithCustomError(
        stakingRouter,
        "ZeroAddressAdmin",
      );
    });

    it("Reverts if lido is zero address", async () => {
      await expect(
        stakingRouter.initialize(stakingRouterAdmin.address, ZeroAddress, withdrawalCredentials),
      ).to.be.revertedWithCustomError(stakingRouter, "ZeroAddressLido");
    });

    it("Initializes the contract version, sets up roles and variables", async () => {
      await expect(stakingRouter.initialize(stakingRouterAdmin.address, lido, withdrawalCredentials))
        .to.emit(stakingRouter, "ContractVersionSet")
        .withArgs(3)
        .and.to.emit(stakingRouter, "RoleGranted")
        .withArgs(await stakingRouter.DEFAULT_ADMIN_ROLE(), stakingRouterAdmin.address, user.address)
        .and.to.emit(stakingRouter, "WithdrawalCredentialsSet")
        .withArgs(withdrawalCredentials, user.address);

      expect(await stakingRouter.getContractVersion()).to.equal(3);
      expect(await stakingRouter.getLido()).to.equal(lido);
      expect(await stakingRouter.getWithdrawalCredentials()).to.equal(withdrawalCredentials);
    });
  });

  context("finalizeUpgrade_v3()", () => {
    const STAKE_SHARE_LIMIT = 1_00n;
    const PRIORITY_EXIT_SHARE_THRESHOLD = STAKE_SHARE_LIMIT;
    const MODULE_FEE = 5_00n;
    const TREASURY_FEE = 5_00n;
    const MAX_DEPOSITS_PER_BLOCK = 150n;
    const MIN_DEPOSIT_BLOCK_DISTANCE = 25n;

    const modulesCount = 3;

    beforeEach(async () => {
      // initialize staking router
      await stakingRouter.initialize(stakingRouterAdmin.address, lido, withdrawalCredentials);
      // grant roles
      await stakingRouter
        .connect(stakingRouterAdmin)
        .grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), stakingRouterAdmin);

      for (let i = 0; i < modulesCount; i++) {
        await stakingRouter
          .connect(stakingRouterAdmin)
          .addStakingModule(
            randomString(8),
            certainAddress(`test:staking-router:staking-module-${i}`),
            STAKE_SHARE_LIMIT,
            PRIORITY_EXIT_SHARE_THRESHOLD,
            MODULE_FEE,
            TREASURY_FEE,
            MAX_DEPOSITS_PER_BLOCK,
            MIN_DEPOSIT_BLOCK_DISTANCE,
          );
      }
      expect(await stakingRouter.getStakingModulesCount()).to.equal(modulesCount);
    });

    it("fails with UnexpectedContractVersion error when called on implementation", async () => {
      await expect(impl.finalizeUpgrade_v3())
        .to.be.revertedWithCustomError(impl, "UnexpectedContractVersion")
        .withArgs(MAX_UINT256, 2);
    });

    it("fails with UnexpectedContractVersion error when called on deployed from scratch SRv2", async () => {
      await expect(stakingRouter.finalizeUpgrade_v3())
        .to.be.revertedWithCustomError(impl, "UnexpectedContractVersion")
        .withArgs(3, 2);
    });

    context("simulate upgrade from v2", () => {
      beforeEach(async () => {
        // reset contract version
        await stakingRouter.testing_setBaseVersion(2);
      });

      it("sets correct contract version", async () => {
        expect(await stakingRouter.getContractVersion()).to.equal(2);
        await stakingRouter.finalizeUpgrade_v3();
        expect(await stakingRouter.getContractVersion()).to.be.equal(3);
      });
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
