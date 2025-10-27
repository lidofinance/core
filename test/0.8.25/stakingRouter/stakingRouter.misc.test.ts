import { expect } from "chai";
import { hexlify, randomBytes, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { StakingRouter__Harness } from "typechain-types";

import { certainAddress, ether, SECONDS_PER_SLOT } from "lib";

import { Snapshot } from "test/suite";

import { deployStakingRouter } from "../../deploy/stakingRouter";

describe("StakingRouter.sol:misc", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let stakingRouterAdmin: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let stakingRouter: StakingRouter__Harness;
  let impl: StakingRouter__Harness;

  let originalState: string;

  const lido = certainAddress("test:staking-router:lido");
  const withdrawalCredentials = hexlify(randomBytes(32));

  const GENESIS_TIME = 1606824023n;

  before(async () => {
    [deployer, admin, stakingRouterAdmin, user] = await ethers.getSigners();

    ({ stakingRouter, impl } = await deployStakingRouter(
      { deployer, admin, user },
      {
        secondsPerSlot: SECONDS_PER_SLOT,
        genesisTime: GENESIS_TIME,
      },
    ));
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
      // TODO: add version check
      await expect(stakingRouter.initialize(stakingRouterAdmin.address, lido, withdrawalCredentials))
        .to.emit(stakingRouter, "Initialized")
        .withArgs(4)
        .and.to.emit(stakingRouter, "RoleGranted")
        .withArgs(await stakingRouter.DEFAULT_ADMIN_ROLE(), stakingRouterAdmin.address, user.address)
        .and.to.emit(stakingRouter, "WithdrawalCredentialsSet")
        .withArgs(withdrawalCredentials, user.address);

      expect(await stakingRouter.getContractVersion()).to.equal(4);
      expect(await stakingRouter.getLido()).to.equal(lido);
      expect(await stakingRouter.getWithdrawalCredentials()).to.equal(withdrawalCredentials);

      // fails with InvalidInitialization error when called on deployed from scratch SRv3
      await expect(stakingRouter.migrateUpgrade_v4()).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });
  });

  context("migrateUpgrade_v4()", () => {
    beforeEach(async () => {
      await stakingRouter.testing_initializeV3();
    });

    it("fails with InvalidInitialization error when called on implementation", async () => {
      await expect(impl.migrateUpgrade_v4()).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });

    it("sets correct contract version and withdrawal credentials", async () => {
      // there are no version in this slot before
      expect(await stakingRouter.getContractVersion()).to.equal(0);
      await expect(stakingRouter.migrateUpgrade_v4()).to.emit(stakingRouter, "Initialized").withArgs(4);
      expect(await stakingRouter.getContractVersion()).to.be.equal(4);
      expect(await stakingRouter.getWithdrawalCredentials()).to.equal(await stakingRouter.WC_01_MOCK());
      expect(await stakingRouter.getLido()).to.equal(await stakingRouter.getLido());
      expect(await stakingRouter.testing_getLastModuleId()).to.equal(await stakingRouter.LAST_STAKING_MODULE_ID_MOCK());
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
