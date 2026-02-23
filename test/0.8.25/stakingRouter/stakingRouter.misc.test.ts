import { expect } from "chai";
import { hexlify, randomBytes, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { LidoLocator, StakingRouter__Harness } from "typechain-types";

import { certainAddress, ether } from "lib";

import { deployLidoLocator, deployStakingRouter } from "test/deploy";
import { Snapshot } from "test/suite";

describe("StakingRouter.sol:misc", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let stakingRouterAdmin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let locator: LidoLocator;

  let stakingRouter: StakingRouter__Harness;
  let impl: StakingRouter__Harness;

  let originalState: string;

  const lido = certainAddress("test:staking-router:lido");
  const topUpGateway = certainAddress("test:staking-router:topUpGateway");
  const depositSecurityModule = certainAddress("test:staking-router:depositSecurityModule");
  const accountingOracle = certainAddress("test:staking-router:accountingOracle");
  const withdrawalCredentials = hexlify(randomBytes(32));

  before(async () => {
    [deployer, admin, stakingRouterAdmin, user] = await ethers.getSigners();

    locator = await deployLidoLocator({
      lido,
      topUpGateway,
      depositSecurityModule,
      accountingOracle,
    });

    ({ stakingRouter, impl } = await deployStakingRouter(
      { deployer, admin, user },
      {
        lidoLocator: locator,
      },
    ));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("initialize", () => {
    it("Reverts if admin is zero address", async () => {
      await expect(stakingRouter.initialize(ZeroAddress, withdrawalCredentials)).to.be.revertedWithCustomError(
        stakingRouter,
        "ZeroAddress",
      );
    });

    it("Initializes the contract version, sets up roles and variables", async () => {
      await expect(stakingRouter.initialize(stakingRouterAdmin.address, withdrawalCredentials))
        .to.emit(stakingRouter, "Initialized")
        .withArgs(4)
        .and.to.emit(stakingRouter, "RoleGranted")
        .withArgs(await stakingRouter.DEFAULT_ADMIN_ROLE(), stakingRouterAdmin.address, user.address)
        .and.to.emit(stakingRouter, "WithdrawalCredentialsSet")
        .withArgs(withdrawalCredentials, user.address);

      expect(await stakingRouter.getContractVersion()).to.equal(4);
      expect(await stakingRouter.LIDO_LOCATOR()).to.equal(locator);
      expect(await stakingRouter.getWithdrawalCredentials()).to.equal(withdrawalCredentials);

      // fails with InvalidInitialization error when called after initialize
      await expect(stakingRouter.migrateUpgrade_v4(stakingRouterAdmin.address)).to.be.revertedWithCustomError(
        impl,
        "InvalidInitialization",
      );
    });
  });

  context("migrateUpgrade_v4()", () => {
    beforeEach(async () => {
      // Simulate old 0.8.9 StakingRouter state (v3):
      // sets WITHDRAWAL_CREDENTIALS_POSITION, LIDO_POSITION, LAST_STAKING_MODULE_ID_POSITION,
      // STAKING_MODULES_COUNT_POSITION, CONTRACT_VERSION_POSITION
      await stakingRouter.testing_initializeV3();
    });

    it("fails with InvalidInitialization error when called on implementation", async () => {
      await expect(impl.migrateUpgrade_v4(stakingRouterAdmin.address)).to.be.revertedWithCustomError(
        impl,
        "InvalidInitialization",
      );
    });

    it("sets correct contract version, withdrawal credentials and admin role", async () => {
      // OZ Initializable slot is 0 before migration (old Versioned used a different slot)
      expect(await stakingRouter.getContractVersion()).to.equal(0);
      // but old Versioned slot has v3
      expect(await stakingRouter.testing_getOldContractVersion()).to.equal(3);

      await expect(stakingRouter.migrateUpgrade_v4(stakingRouterAdmin.address))
        .to.emit(stakingRouter, "Initialized")
        .withArgs(4)
        .and.to.emit(stakingRouter, "RoleGranted")
        .withArgs(await stakingRouter.DEFAULT_ADMIN_ROLE(), stakingRouterAdmin.address, user.address);

      // new OZ version is set
      expect(await stakingRouter.getContractVersion()).to.be.equal(4);

      // data migrated correctly
      expect(await stakingRouter.getWithdrawalCredentials()).to.equal(await stakingRouter.WC_01_MOCK());
      expect(await stakingRouter.testing_getLastModuleId()).to.equal(await stakingRouter.LAST_STAKING_MODULE_ID_MOCK());

      // admin role granted
      expect(await stakingRouter.hasRole(await stakingRouter.DEFAULT_ADMIN_ROLE(), stakingRouterAdmin.address)).to.be
        .true;
    });

    it("cleans up old storage slots after migration", async () => {
      await stakingRouter.migrateUpgrade_v4(stakingRouterAdmin.address);

      // all old unstructured storage slots should be zeroed
      expect(await stakingRouter.testing_getOldLidoPosition()).to.equal(ZeroAddress);
      expect(await stakingRouter.testing_getOldWcPosition()).to.equal(ethers.ZeroHash);
      expect(await stakingRouter.testing_getOldContractVersion()).to.equal(0);
      expect(await stakingRouter.testing_getOldLastModuleIdPosition()).to.equal(0);
      expect(await stakingRouter.testing_getOldModulesCountPosition()).to.equal(0);
    });

    it("does not clean up old AccessControl role storage slots", async () => {
      const DEFAULT_ADMIN_ROLE = await stakingRouter.DEFAULT_ADMIN_ROLE();
      const STAKING_MODULE_MANAGE_ROLE = await stakingRouter.STAKING_MODULE_MANAGE_ROLE();

      // simulate old 0.8.9 AccessControl state: admin has DEFAULT_ADMIN_ROLE and STAKING_MODULE_MANAGE_ROLE
      await stakingRouter.testing_setOldRole(DEFAULT_ADMIN_ROLE, stakingRouterAdmin.address, true);
      await stakingRouter.testing_setOldRole(STAKING_MODULE_MANAGE_ROLE, stakingRouterAdmin.address, true);

      // old slots are populated
      expect(await stakingRouter.testing_getOldRole(DEFAULT_ADMIN_ROLE, stakingRouterAdmin.address)).to.be.true;
      expect(await stakingRouter.testing_getOldRole(STAKING_MODULE_MANAGE_ROLE, stakingRouterAdmin.address)).to.be.true;

      // but new OZ 5.2 hasRole() reads from a different ERC-7201 slot — roles are invisible
      expect(await stakingRouter.hasRole(DEFAULT_ADMIN_ROLE, stakingRouterAdmin.address)).to.be.false;
      expect(await stakingRouter.hasRole(STAKING_MODULE_MANAGE_ROLE, stakingRouterAdmin.address)).to.be.false;

      // migration writes DEFAULT_ADMIN_ROLE to the NEW slot, but does NOT touch old slots
      await stakingRouter.migrateUpgrade_v4(stakingRouterAdmin.address);

      // after migration: only DEFAULT_ADMIN_ROLE is visible via hasRole() (granted in new slot)
      expect(await stakingRouter.hasRole(DEFAULT_ADMIN_ROLE, stakingRouterAdmin.address)).to.be.true;
      // STAKING_MODULE_MANAGE_ROLE was NOT re-granted — must be done via Vote Script
      expect(await stakingRouter.hasRole(STAKING_MODULE_MANAGE_ROLE, stakingRouterAdmin.address)).to.be.false;

      // old AccessControl slots are NOT cleaned up (orphaned, inaccessible by new code)
      expect(await stakingRouter.testing_getOldRole(DEFAULT_ADMIN_ROLE, stakingRouterAdmin.address)).to.be.true;
      expect(await stakingRouter.testing_getOldRole(STAKING_MODULE_MANAGE_ROLE, stakingRouterAdmin.address)).to.be.true;
    });

    it("cannot be called twice", async () => {
      await stakingRouter.migrateUpgrade_v4(stakingRouterAdmin.address);
      await expect(stakingRouter.migrateUpgrade_v4(stakingRouterAdmin.address)).to.be.revertedWithCustomError(
        impl,
        "InvalidInitialization",
      );
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
});
