import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { AccountingOracle__MockForStakingRouter, LidoLocator, StakingRouter__Harness } from "typechain-types";

import { certainAddress, ether, randomAddress, randomBytes32, randomWCType1 } from "lib";

import { deployLidoLocator, deployStakingRouter } from "test/deploy";
import { Snapshot } from "test/suite";

describe("StakingRouter.sol:misc", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let stakingRouterAdmin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let locator: LidoLocator;
  let accountingOracle: AccountingOracle__MockForStakingRouter;
  let stakingRouter: StakingRouter__Harness;
  let impl: StakingRouter__Harness;

  let originalState: string;

  const lido = certainAddress("test:staking-router:lido");
  const topUpGateway = certainAddress("test:staking-router:topUpGateway");
  const depositSecurityModule = certainAddress("test:staking-router:depositSecurityModule");
  const accounting = certainAddress("test:staking-router:accounting");
  const withdrawalCredentials = randomWCType1();

  before(async () => {
    [deployer, admin, stakingRouterAdmin, user] = await ethers.getSigners();

    accountingOracle = await ethers.deployContract("AccountingOracle__MockForStakingRouter", deployer);
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
      await expect(stakingRouter.finalizeUpgrade_v4()).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });
  });

  context("finalizeUpgrade_v4()", () => {
    let DEFAULT_ADMIN_ROLE: string;
    let STAKING_MODULE_MANAGE_ROLE: string;
    let REPORT_EXITED_VALIDATORS_ROLE: string;
    let REPORT_REWARDS_MINTED_ROLE: string;
    let MANAGE_WITHDRAWAL_CREDENTIALS_ROLE: string;
    let STAKING_MODULE_UNVETTING_ROLE: string;
    let REPORT_VALIDATOR_EXITING_STATUS_ROLE: string;
    let REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE: string;
    let UNSAFE_SET_EXITED_VALIDATORS_ROLE: string;
    let roles: string[];

    beforeEach(async () => {
      // Simulate old 0.8.9 StakingRouter state (v3):
      // sets WITHDRAWAL_CREDENTIALS_POSITION, LIDO_POSITION, LAST_STAKING_MODULE_ID_POSITION,
      // STAKING_MODULES_COUNT_POSITION, CONTRACT_VERSION_POSITION
      await stakingRouter.testing_initializeV3();

      // simulate old OZ v4.4 AccessControl state: admin has DEFAULT_ADMIN_ROLE and STAKING_MODULE_MANAGE_ROLE
      DEFAULT_ADMIN_ROLE = await stakingRouter.DEFAULT_ADMIN_ROLE();
      STAKING_MODULE_MANAGE_ROLE = await stakingRouter.STAKING_MODULE_MANAGE_ROLE();
      // AccountingOracle
      REPORT_EXITED_VALIDATORS_ROLE = await stakingRouter.REPORT_EXITED_VALIDATORS_ROLE();
      // Accounting
      REPORT_REWARDS_MINTED_ROLE = await stakingRouter.REPORT_REWARDS_MINTED_ROLE();

      MANAGE_WITHDRAWAL_CREDENTIALS_ROLE = await stakingRouter.MANAGE_WITHDRAWAL_CREDENTIALS_ROLE();
      // DSM
      STAKING_MODULE_UNVETTING_ROLE = await stakingRouter.STAKING_MODULE_UNVETTING_ROLE();
      // VEBO
      REPORT_VALIDATOR_EXITING_STATUS_ROLE = await stakingRouter.REPORT_VALIDATOR_EXITING_STATUS_ROLE();
      // TW
      REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE = await stakingRouter.REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE();
      UNSAFE_SET_EXITED_VALIDATORS_ROLE = await stakingRouter.UNSAFE_SET_EXITED_VALIDATORS_ROLE();

      roles = [
        // DEFAULT_ADMIN_ROLE,
        STAKING_MODULE_MANAGE_ROLE,
        REPORT_EXITED_VALIDATORS_ROLE,
        REPORT_REWARDS_MINTED_ROLE,
        MANAGE_WITHDRAWAL_CREDENTIALS_ROLE,
        STAKING_MODULE_UNVETTING_ROLE,
        REPORT_VALIDATOR_EXITING_STATUS_ROLE,
        REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE,
        UNSAFE_SET_EXITED_VALIDATORS_ROLE,
      ];

      await stakingRouter.testing_grantRoleOld(DEFAULT_ADMIN_ROLE, stakingRouterAdmin.address);
      await stakingRouter.testing_grantRoleOld(STAKING_MODULE_MANAGE_ROLE, stakingRouterAdmin.address);
      await stakingRouter.testing_grantRoleOld(REPORT_EXITED_VALIDATORS_ROLE, accountingOracle);
      await stakingRouter.testing_grantRoleOld(REPORT_REWARDS_MINTED_ROLE, accounting);

      // simulate oracle report
      await accountingOracle.mock_setProcessingState(1, true, true);
    });

    it("fails with InvalidInitialization error when called on implementation", async () => {
      await expect(impl.finalizeUpgrade_v4()).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });

    it("revert migration if oracle extra data was not submitted yet", async () => {
      await accountingOracle.mock_setProcessingState(1, true, false);
      await expect(stakingRouter.finalizeUpgrade_v4()).to.be.revertedWithCustomError(
        stakingRouter,
        "OracleExtraDataNotSubmitted",
      );
    });

    it("sets correct contract version, withdrawal credentials and admin role", async () => {
      // OZ Initializable slot is 0 before migration (old Versioned used a different slot)
      expect(await stakingRouter.getContractVersion()).to.equal(0);
      // but old Versioned slot has v3
      expect(await stakingRouter.testing_getOldContractVersion()).to.equal(3);

      await expect(stakingRouter.finalizeUpgrade_v4())
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
      await stakingRouter.finalizeUpgrade_v4();

      // all old unstructured storage slots should be zeroed
      expect(await stakingRouter.testing_getOldLidoPosition()).to.equal(ZeroAddress);
      expect(await stakingRouter.testing_getOldWcPosition()).to.equal(ethers.ZeroHash);
      expect(await stakingRouter.testing_getOldContractVersion()).to.equal(0);
      expect(await stakingRouter.testing_getOldLastModuleIdPosition()).to.equal(0);
      expect(await stakingRouter.testing_getOldModulesCountPosition()).to.equal(0);
    });

    it("migrate all defined AccessControl role and skip undefined", async () => {
      const someAccount = randomAddress();
      const someNewRole = randomBytes32();

      for (const role of roles) {
        await stakingRouter.testing_grantRoleOld(role, someAccount);
      }
      // grant undefined role
      await stakingRouter.testing_grantRoleOld(someNewRole, someAccount);

      // old slots are populated
      for (const role of roles) {
        expect(await stakingRouter.testing_hasRoleOld(role, someAccount)).to.be.true;
      }
      expect(await stakingRouter.testing_hasRoleOld(someNewRole, someAccount)).to.be.true;

      // but new OZ 5.2 hasRole() reads from a different ERC-7201 slot — roles are invisible
      expect(await stakingRouter.hasRole(DEFAULT_ADMIN_ROLE, stakingRouterAdmin.address)).to.be.false;
      for (const role of roles) {
        expect(await stakingRouter.hasRole(role, someAccount)).to.be.false;
      }
      expect(await stakingRouter.hasRole(someNewRole, someAccount)).to.be.false;

      // migration writes DEFAULT_ADMIN_ROLE to the NEW slot, but does NOT touch old slots
      await stakingRouter.finalizeUpgrade_v4();

      // after migration:  all roles should be reassigned
      expect(await stakingRouter.hasRole(DEFAULT_ADMIN_ROLE, stakingRouterAdmin.address)).to.be.true;
      for (const role of roles) {
        expect(await stakingRouter.hasRole(role, someAccount)).to.be.true;
      }
      // undefined role is not migrated
      expect(await stakingRouter.hasRole(someNewRole, someAccount)).to.be.false;

      // old AccessControl slots are NOT cleaned up (orphaned, inaccessible by new code)
      for (const role of roles) {
        expect(await stakingRouter.testing_hasRoleOld(role, someAccount)).to.be.true;
      }
      expect(await stakingRouter.testing_hasRoleOld(someNewRole, someAccount)).to.be.true;
    });

    it("cannot be called twice", async () => {
      await stakingRouter.finalizeUpgrade_v4();
      await expect(stakingRouter.finalizeUpgrade_v4()).to.be.revertedWithCustomError(impl, "InvalidInitialization");
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
