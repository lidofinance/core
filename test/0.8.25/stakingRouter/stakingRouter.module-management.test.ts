import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { LidoLocator, StakingRouter } from "typechain-types";

import { certainAddress, getNextBlock, randomString, randomWCType1, WithdrawalCredentialsType } from "lib";

import { deployLidoLocator } from "test/deploy";

import { deployStakingRouter } from "../../deploy/stakingRouter";

const UINT64_MAX = 2n ** 64n - 1n;

describe("StakingRouter.sol:module-management", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let locator: LidoLocator;
  let stakingRouter: StakingRouter;

  const withdrawalCredentials = randomWCType1();
  const lido = certainAddress("test:staking-router-modules:lido"); // mock lido address
  const topUpGateway = certainAddress("test:staking-router:topUpGateway");
  const depositSecurityModule = certainAddress("test:staking-router:depositSecurityModule");

  beforeEach(async () => {
    [deployer, admin, user] = await ethers.getSigners();

    locator = await deployLidoLocator({
      lido,
      topUpGateway,
      depositSecurityModule,
    });

    ({ stakingRouter } = await deployStakingRouter({ deployer, admin }, { lidoLocator: locator }));

    // initialize staking router
    await stakingRouter.initialize(admin, withdrawalCredentials);

    // grant roles
    await stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin);
  });

  context("addStakingModule", () => {
    const NAME = "StakingModule";
    const ADDRESS = certainAddress("test:staking-router:staking-module");
    const STAKE_SHARE_LIMIT = 1_00n;
    const PRIORITY_EXIT_SHARE_THRESHOLD = STAKE_SHARE_LIMIT;
    const MODULE_FEE = 5_00n;
    const TREASURY_FEE = 5_00n;
    const MAX_DEPOSITS_PER_BLOCK = 150n;
    const MIN_DEPOSIT_BLOCK_DISTANCE = 25n;

    const stakingModuleConfig = {
      /// @notice Maximum stake share that can be allocated to a module, in BP.
      /// @dev Must be less than or equal to TOTAL_BASIS_POINTS (10_000 BP = 100%).
      stakeShareLimit: STAKE_SHARE_LIMIT,
      /// @notice Module's share threshold, upon crossing which, exits of validators from the module will be prioritized, in BP.
      /// @dev Must be less than or equal to TOTAL_BASIS_POINTS (10_000 BP = 100%) and
      ///      greater than or equal to `stakeShareLimit`.
      priorityExitShareThreshold: PRIORITY_EXIT_SHARE_THRESHOLD,
      /// @notice Part of the fee taken from staking rewards that goes to the staking module, in BP.
      /// @dev Together with `treasuryFee`, must not exceed TOTAL_BASIS_POINTS.
      stakingModuleFee: MODULE_FEE,
      /// @notice Part of the fee taken from staking rewards that goes to the treasury, in BP.
      /// @dev Together with `stakingModuleFee`, must not exceed TOTAL_BASIS_POINTS.
      treasuryFee: TREASURY_FEE,
      /// @notice The maximum number of validators that can be deposited in a single block.
      /// @dev Must be harmonized with `OracleReportSanityChecker.appearedValidatorsPerDayLimit`.
      ///      Value must not exceed type(uint64).max.
      maxDepositsPerBlock: MAX_DEPOSITS_PER_BLOCK,
      /// @notice The minimum distance between deposits in blocks.
      /// @dev Must be harmonized with `OracleReportSanityChecker.appearedValidatorsPerDayLimit`.
      ///      Value must be > 0 and ≤ type(uint64).max.
      minDepositBlockDistance: MIN_DEPOSIT_BLOCK_DISTANCE,
      /// @notice The type of withdrawal credentials for creation of validators.
      /// @dev 1 = 0x01 withdrawals, 2 = 0x02 withdrawals.
      withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
    };

    it("Reverts if the caller does not have the role", async () => {
      await expect(stakingRouter.connect(user).addStakingModule(NAME, ADDRESS, stakingModuleConfig))
        .to.be.revertedWithCustomError(stakingRouter, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, await stakingRouter.STAKING_MODULE_MANAGE_ROLE());
    });

    it("Reverts if the target share is greater than 100%", async () => {
      const STAKE_SHARE_LIMIT_OVER_100 = 100_01;

      await expect(
        stakingRouter.addStakingModule(NAME, ADDRESS, {
          ...stakingModuleConfig,
          stakeShareLimit: STAKE_SHARE_LIMIT_OVER_100,
        }),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidStakeShareLimit");
    });

    it("Reverts if the sum of module and treasury fees is greater than 100%", async () => {
      const MODULE_FEE_INVALID = 100_01n - TREASURY_FEE;

      await expect(
        stakingRouter.addStakingModule(NAME, ADDRESS, {
          ...stakingModuleConfig,
          stakingModuleFee: MODULE_FEE_INVALID,
        }),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidFeeSum");

      const TREASURY_FEE_INVALID = 100_01n - MODULE_FEE;

      await expect(
        stakingRouter.addStakingModule(NAME, ADDRESS, {
          ...stakingModuleConfig,
          treasuryFee: TREASURY_FEE_INVALID,
        }),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidFeeSum");
    });

    it("Reverts if the staking module address is zero address", async () => {
      await expect(
        stakingRouter.addStakingModule(NAME, ZeroAddress, stakingModuleConfig),
      ).to.be.revertedWithCustomError(stakingRouter, "ZeroAddress");
    });

    it("Reverts if the staking module name is empty string", async () => {
      const NAME_EMPTY_STRING = "";

      await expect(
        stakingRouter.addStakingModule(NAME_EMPTY_STRING, ADDRESS, stakingModuleConfig),
      ).to.be.revertedWithCustomError(stakingRouter, "StakingModuleWrongName");
    });

    it("Reverts if the staking module name is too long", async () => {
      const MAX_STAKING_MODULE_NAME_LENGTH = await stakingRouter.MAX_STAKING_MODULE_NAME_LENGTH();
      const NAME_TOO_LONG = randomString(Number(MAX_STAKING_MODULE_NAME_LENGTH + 1n));

      await expect(
        stakingRouter.addStakingModule(NAME_TOO_LONG, ADDRESS, stakingModuleConfig),
      ).to.be.revertedWithCustomError(stakingRouter, "StakingModuleWrongName");
    });

    it("Reverts if the max number of staking modules is reached", async () => {
      const MAX_STAKING_MODULES_COUNT = await stakingRouter.MAX_STAKING_MODULES_COUNT();

      const moduleConfig = {
        stakeShareLimit: 100,
        priorityExitShareThreshold: 100,
        stakingModuleFee: 100,
        treasuryFee: 100,
        maxDepositsPerBlock: MAX_DEPOSITS_PER_BLOCK,
        minDepositBlockDistance: MIN_DEPOSIT_BLOCK_DISTANCE,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
      };

      for (let i = 0; i < MAX_STAKING_MODULES_COUNT; i++) {
        await stakingRouter.addStakingModule(
          randomString(8),
          certainAddress(`test:staking-router:staking-module-${i}`),
          moduleConfig,
        );
      }

      expect(await stakingRouter.getStakingModulesCount()).to.equal(MAX_STAKING_MODULES_COUNT);

      await expect(stakingRouter.addStakingModule(NAME, ADDRESS, stakingModuleConfig)).to.be.revertedWithCustomError(
        stakingRouter,
        "StakingModulesLimitExceeded",
      );
    });

    it("Reverts if adding a module with the same address", async () => {
      await stakingRouter.addStakingModule(NAME, ADDRESS, stakingModuleConfig);

      await expect(stakingRouter.addStakingModule(NAME, ADDRESS, stakingModuleConfig)).to.be.revertedWithCustomError(
        stakingRouter,
        "StakingModuleAddressExists",
      );
    });

    it("Reverts if the module fee sum differs from existing modules", async () => {
      await stakingRouter.addStakingModule(NAME, ADDRESS, stakingModuleConfig);

      await expect(
        stakingRouter.addStakingModule("StakingModule2", certainAddress("test:staking-router:staking-module-2"), {
          ...stakingModuleConfig,
          stakingModuleFee: MODULE_FEE + 1n,
        }),
      ).to.be.revertedWithCustomError(stakingRouter, "InconsistentFeeSum");
    });

    it("Adds the module to stakingRouter and emits events", async () => {
      const stakingModuleId = (await stakingRouter.getStakingModulesCount()) + 1n;
      const moduleAddedBlock = await getNextBlock();

      await expect(stakingRouter.addStakingModule(NAME, ADDRESS, stakingModuleConfig))
        .to.be.emit(stakingRouter, "StakingRouterETHDeposited")
        .withArgs(stakingModuleId, 0)
        .and.to.be.emit(stakingRouter, "StakingModuleAdded")
        .withArgs(stakingModuleId, ADDRESS, NAME, admin.address)
        .and.to.be.emit(stakingRouter, "StakingModuleShareLimitSet")
        .withArgs(stakingModuleId, STAKE_SHARE_LIMIT, PRIORITY_EXIT_SHARE_THRESHOLD, admin.address)
        .and.to.be.emit(stakingRouter, "StakingModuleFeesSet")
        .withArgs(stakingModuleId, MODULE_FEE, TREASURY_FEE, admin.address);

      expect(await stakingRouter.getStakingModule(stakingModuleId)).to.deep.equal([
        stakingModuleId,
        ADDRESS,
        MODULE_FEE,
        TREASURY_FEE,
        STAKE_SHARE_LIMIT,
        0n, // status active
        NAME,
        moduleAddedBlock.timestamp,
        moduleAddedBlock.number,
        0n, // exited validators,
        PRIORITY_EXIT_SHARE_THRESHOLD,
        MAX_DEPOSITS_PER_BLOCK,
        MIN_DEPOSIT_BLOCK_DISTANCE,
        WithdrawalCredentialsType.WC0x01,
        0,
      ]);
    });
  });

  context("updateStakingModule", () => {
    const NAME = "StakingModule";
    const ADDRESS = certainAddress("test:staking-router-modules:staking-module");
    const STAKE_SHARE_LIMIT = 1_00n;
    const PRIORITY_EXIT_SHARE_THRESHOLD = STAKE_SHARE_LIMIT;
    const MODULE_FEE = 5_00n;
    const TREASURY_FEE = 5_00n;
    const MAX_DEPOSITS_PER_BLOCK = 150n;
    const MIN_DEPOSIT_BLOCK_DISTANCE = 25n;

    let ID: bigint;

    const NEW_STAKE_SHARE_LIMIT = 2_00n;
    const NEW_PRIORITY_EXIT_SHARE_THRESHOLD = NEW_STAKE_SHARE_LIMIT;

    const NEW_MODULE_FEE = 6_00n;
    const NEW_TREASURY_FEE = 4_00n;

    const NEW_MAX_DEPOSITS_PER_BLOCK = 100n;
    const NEW_MIN_DEPOSIT_BLOCK_DISTANCE = 20n;

    const stakingModuleConfig = {
      stakeShareLimit: STAKE_SHARE_LIMIT,
      priorityExitShareThreshold: PRIORITY_EXIT_SHARE_THRESHOLD,
      stakingModuleFee: MODULE_FEE,
      treasuryFee: TREASURY_FEE,
      maxDepositsPerBlock: MAX_DEPOSITS_PER_BLOCK,
      minDepositBlockDistance: MIN_DEPOSIT_BLOCK_DISTANCE,
      withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
    };

    beforeEach(async () => {
      await stakingRouter.addStakingModule(NAME, ADDRESS, stakingModuleConfig);
      ID = await stakingRouter.getStakingModulesCount();
    });

    it("Reverts if the caller does not have the role", async () => {
      stakingRouter = stakingRouter.connect(user);

      await expect(
        stakingRouter.updateStakingModule(
          ID,
          NEW_STAKE_SHARE_LIMIT,
          NEW_PRIORITY_EXIT_SHARE_THRESHOLD,
          NEW_MODULE_FEE,
          NEW_TREASURY_FEE,
          NEW_MAX_DEPOSITS_PER_BLOCK,
          NEW_MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, await stakingRouter.STAKING_MODULE_MANAGE_ROLE());
    });

    it("Reverts if the new target share is greater than 100%", async () => {
      const NEW_STAKE_SHARE_LIMIT_OVER_100 = 100_01;
      await expect(
        stakingRouter.updateStakingModule(
          ID,
          NEW_STAKE_SHARE_LIMIT_OVER_100,
          NEW_PRIORITY_EXIT_SHARE_THRESHOLD,
          NEW_MODULE_FEE,
          NEW_TREASURY_FEE,
          NEW_MAX_DEPOSITS_PER_BLOCK,
          NEW_MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidStakeShareLimit");
    });

    it("Reverts if the new priority exit share is greater than 100%", async () => {
      const NEW_PRIORITY_EXIT_SHARE_THRESHOLD_OVER_100 = 100_01;
      await expect(
        stakingRouter.updateStakingModule(
          ID,
          NEW_STAKE_SHARE_LIMIT,
          NEW_PRIORITY_EXIT_SHARE_THRESHOLD_OVER_100,
          NEW_MODULE_FEE,
          NEW_TREASURY_FEE,
          NEW_MAX_DEPOSITS_PER_BLOCK,
          NEW_MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidPriorityExitShareThreshold");
    });

    it("Reverts if the new priority exit share is less than stake share limit", async () => {
      const UPGRADED_STAKE_SHARE_LIMIT = 55_00n;
      const UPGRADED_PRIORITY_EXIT_SHARE_THRESHOLD = 50_00n;
      await expect(
        stakingRouter.updateStakingModule(
          ID,
          UPGRADED_STAKE_SHARE_LIMIT,
          UPGRADED_PRIORITY_EXIT_SHARE_THRESHOLD,
          NEW_MODULE_FEE,
          NEW_TREASURY_FEE,
          NEW_MAX_DEPOSITS_PER_BLOCK,
          NEW_MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidPriorityExitShareThreshold");
    });

    it("Reverts if the new deposit block distance is zero", async () => {
      await expect(
        stakingRouter.updateStakingModule(
          ID,
          NEW_STAKE_SHARE_LIMIT,
          NEW_PRIORITY_EXIT_SHARE_THRESHOLD,
          NEW_MODULE_FEE,
          NEW_TREASURY_FEE,
          NEW_MAX_DEPOSITS_PER_BLOCK,
          0n,
        ),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidMinDepositBlockDistance");
    });

    it("Reverts if the new deposit block distance is great then uint64 max", async () => {
      await stakingRouter.updateStakingModule(
        ID,
        NEW_STAKE_SHARE_LIMIT,
        NEW_PRIORITY_EXIT_SHARE_THRESHOLD,
        NEW_MODULE_FEE,
        NEW_TREASURY_FEE,
        NEW_MAX_DEPOSITS_PER_BLOCK,
        UINT64_MAX,
      );

      expect((await stakingRouter.getStakingModule(ID)).minDepositBlockDistance).to.be.equal(UINT64_MAX);

      await expect(
        stakingRouter.updateStakingModule(
          ID,
          NEW_STAKE_SHARE_LIMIT,
          NEW_PRIORITY_EXIT_SHARE_THRESHOLD,
          NEW_MODULE_FEE,
          NEW_TREASURY_FEE,
          NEW_MAX_DEPOSITS_PER_BLOCK,
          UINT64_MAX + 1n,
        ),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidMinDepositBlockDistance");
    });

    it("Reverts if the new max deposits per block is great then uint64 max", async () => {
      await stakingRouter.updateStakingModule(
        ID,
        NEW_STAKE_SHARE_LIMIT,
        NEW_PRIORITY_EXIT_SHARE_THRESHOLD,
        NEW_MODULE_FEE,
        NEW_TREASURY_FEE,
        UINT64_MAX,
        NEW_MIN_DEPOSIT_BLOCK_DISTANCE,
      );

      expect((await stakingRouter.getStakingModule(ID)).maxDepositsPerBlock).to.be.equal(UINT64_MAX);

      await expect(
        stakingRouter.updateStakingModule(
          ID,
          NEW_STAKE_SHARE_LIMIT,
          NEW_PRIORITY_EXIT_SHARE_THRESHOLD,
          NEW_MODULE_FEE,
          NEW_TREASURY_FEE,
          UINT64_MAX + 1n,
          NEW_MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidMaxDepositPerBlockValue");
    });

    it("Reverts if the sum of the new module and treasury fees is greater than 100%", async () => {
      const NEW_MODULE_FEE_INVALID = 100_01n - TREASURY_FEE;

      await expect(
        stakingRouter.updateStakingModule(
          ID,
          STAKE_SHARE_LIMIT,
          PRIORITY_EXIT_SHARE_THRESHOLD,
          NEW_MODULE_FEE_INVALID,
          TREASURY_FEE,
          MAX_DEPOSITS_PER_BLOCK,
          MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidFeeSum");

      const NEW_TREASURY_FEE_INVALID = 100_01n - MODULE_FEE;
      await expect(
        stakingRouter.updateStakingModule(
          ID,
          STAKE_SHARE_LIMIT,
          PRIORITY_EXIT_SHARE_THRESHOLD,
          MODULE_FEE,
          NEW_TREASURY_FEE_INVALID,
          MAX_DEPOSITS_PER_BLOCK,
          MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidFeeSum");
    });

    it("Reverts if the new fee sum differs from other modules", async () => {
      await stakingRouter.addStakingModule(
        "StakingModule2",
        certainAddress("test:staking-router-modules:staking-module-2"),
        {
          ...stakingModuleConfig,
        },
      );

      await expect(
        stakingRouter.updateStakingModule(
          ID,
          STAKE_SHARE_LIMIT,
          PRIORITY_EXIT_SHARE_THRESHOLD,
          MODULE_FEE + 1n,
          TREASURY_FEE,
          MAX_DEPOSITS_PER_BLOCK,
          MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      ).to.be.revertedWithCustomError(stakingRouter, "InconsistentFeeSum");
    });

    it("Update target share, module and treasury fees and emits events", async () => {
      await expect(
        stakingRouter.updateStakingModule(
          ID,
          NEW_STAKE_SHARE_LIMIT,
          NEW_PRIORITY_EXIT_SHARE_THRESHOLD,
          NEW_MODULE_FEE,
          NEW_TREASURY_FEE,
          NEW_MAX_DEPOSITS_PER_BLOCK,
          NEW_MIN_DEPOSIT_BLOCK_DISTANCE,
        ),
      )
        .to.be.emit(stakingRouter, "StakingModuleShareLimitSet")
        .withArgs(ID, NEW_STAKE_SHARE_LIMIT, NEW_PRIORITY_EXIT_SHARE_THRESHOLD, admin.address)
        .and.to.be.emit(stakingRouter, "StakingModuleFeesSet")
        .withArgs(ID, NEW_MODULE_FEE, NEW_TREASURY_FEE, admin.address);
    });
  });

  context("updateModuleShares", () => {
    const NAME = "StakingModule";
    const ADDRESS = certainAddress("test:staking-router-modules:staking-module-shares");
    const STAKE_SHARE_LIMIT = 1_00n;
    const PRIORITY_EXIT_SHARE_THRESHOLD = STAKE_SHARE_LIMIT;
    const MODULE_FEE = 5_00n;
    const TREASURY_FEE = 5_00n;
    const MAX_DEPOSITS_PER_BLOCK = 150n;
    const MIN_DEPOSIT_BLOCK_DISTANCE = 25n;

    let ID: bigint;

    const NEW_STAKE_SHARE_LIMIT = 2_00;
    const NEW_PRIORITY_EXIT_SHARE_THRESHOLD = 3_00;

    const stakingModuleConfig = {
      stakeShareLimit: STAKE_SHARE_LIMIT,
      priorityExitShareThreshold: PRIORITY_EXIT_SHARE_THRESHOLD,
      stakingModuleFee: MODULE_FEE,
      treasuryFee: TREASURY_FEE,
      maxDepositsPerBlock: MAX_DEPOSITS_PER_BLOCK,
      minDepositBlockDistance: MIN_DEPOSIT_BLOCK_DISTANCE,
      withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
    };

    beforeEach(async () => {
      await stakingRouter.addStakingModule(NAME, ADDRESS, stakingModuleConfig);
      ID = await stakingRouter.getStakingModulesCount();

      // grant the STAKING_MODULE_SHARE_MANAGE_ROLE to admin
      await stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_SHARE_MANAGE_ROLE(), admin);
    });

    it("Reverts if the caller does not have the role", async () => {
      await expect(
        stakingRouter.connect(user).updateModuleShares(ID, NEW_STAKE_SHARE_LIMIT, NEW_PRIORITY_EXIT_SHARE_THRESHOLD),
      )
        .to.be.revertedWithCustomError(stakingRouter, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, await stakingRouter.STAKING_MODULE_SHARE_MANAGE_ROLE());
    });

    it("Reverts if the staking module id does not exist", async () => {
      const NON_EXISTENT_MODULE_ID = 999;
      await expect(
        stakingRouter.updateModuleShares(
          NON_EXISTENT_MODULE_ID,
          NEW_STAKE_SHARE_LIMIT,
          NEW_PRIORITY_EXIT_SHARE_THRESHOLD,
        ),
      ).to.be.revertedWithCustomError(stakingRouter, "StakingModuleUnregistered");
    });

    it("Reverts if the new stake share limit is greater than 100%", async () => {
      const STAKE_SHARE_LIMIT_OVER_100 = 100_01;
      await expect(
        stakingRouter.updateModuleShares(ID, STAKE_SHARE_LIMIT_OVER_100, STAKE_SHARE_LIMIT_OVER_100),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidStakeShareLimit");
    });

    it("Reverts if the new priority exit share threshold is greater than 100%", async () => {
      const PRIORITY_EXIT_SHARE_THRESHOLD_OVER_100 = 100_01;
      await expect(
        stakingRouter.updateModuleShares(ID, NEW_STAKE_SHARE_LIMIT, PRIORITY_EXIT_SHARE_THRESHOLD_OVER_100),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidPriorityExitShareThreshold");
    });

    it("Reverts if the new priority exit share threshold is less than stake share limit", async () => {
      const HIGHER_STAKE_SHARE_LIMIT = 55_00;
      const LOWER_PRIORITY_EXIT_SHARE_THRESHOLD = 50_00;
      await expect(
        stakingRouter.updateModuleShares(ID, HIGHER_STAKE_SHARE_LIMIT, LOWER_PRIORITY_EXIT_SHARE_THRESHOLD),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidPriorityExitShareThreshold");
    });

    it("Updates share params and emits StakingModuleShareLimitSet event", async () => {
      await expect(stakingRouter.updateModuleShares(ID, NEW_STAKE_SHARE_LIMIT, NEW_PRIORITY_EXIT_SHARE_THRESHOLD))
        .to.emit(stakingRouter, "StakingModuleShareLimitSet")
        .withArgs(ID, NEW_STAKE_SHARE_LIMIT, NEW_PRIORITY_EXIT_SHARE_THRESHOLD, admin.address);

      const moduleAfter = await stakingRouter.getStakingModule(ID);
      expect(moduleAfter.stakeShareLimit).to.equal(NEW_STAKE_SHARE_LIMIT);
      expect(moduleAfter.priorityExitShareThreshold).to.equal(NEW_PRIORITY_EXIT_SHARE_THRESHOLD);
    });

    it("Does not modify other module params (fees, deposits config)", async () => {
      const moduleBefore = await stakingRouter.getStakingModule(ID);

      await stakingRouter.updateModuleShares(ID, NEW_STAKE_SHARE_LIMIT, NEW_PRIORITY_EXIT_SHARE_THRESHOLD);

      const moduleAfter = await stakingRouter.getStakingModule(ID);

      // share params should change
      expect(moduleAfter.stakeShareLimit).to.equal(NEW_STAKE_SHARE_LIMIT);
      expect(moduleAfter.priorityExitShareThreshold).to.equal(NEW_PRIORITY_EXIT_SHARE_THRESHOLD);

      // other params should remain unchanged
      expect(moduleAfter.stakingModuleFee).to.equal(moduleBefore.stakingModuleFee);
      expect(moduleAfter.treasuryFee).to.equal(moduleBefore.treasuryFee);
      expect(moduleAfter.stakingModuleAddress).to.equal(moduleBefore.stakingModuleAddress);
      expect(moduleAfter.maxDepositsPerBlock).to.equal(moduleBefore.maxDepositsPerBlock);
      expect(moduleAfter.minDepositBlockDistance).to.equal(moduleBefore.minDepositBlockDistance);
    });

    it("Allows setting stake share limit and priority exit share threshold to the same value", async () => {
      const SAME_VALUE = 50_00;
      await expect(stakingRouter.updateModuleShares(ID, SAME_VALUE, SAME_VALUE))
        .to.emit(stakingRouter, "StakingModuleShareLimitSet")
        .withArgs(ID, SAME_VALUE, SAME_VALUE, admin.address);

      const moduleAfter = await stakingRouter.getStakingModule(ID);
      expect(moduleAfter.stakeShareLimit).to.equal(SAME_VALUE);
      expect(moduleAfter.priorityExitShareThreshold).to.equal(SAME_VALUE);
    });

    it("Allows setting both values to zero", async () => {
      await expect(stakingRouter.updateModuleShares(ID, 0, 0))
        .to.emit(stakingRouter, "StakingModuleShareLimitSet")
        .withArgs(ID, 0, 0, admin.address);

      const moduleAfter = await stakingRouter.getStakingModule(ID);
      expect(moduleAfter.stakeShareLimit).to.equal(0);
      expect(moduleAfter.priorityExitShareThreshold).to.equal(0);
    });

    it("Allows setting both values to 100%", async () => {
      const MAX_BP = 100_00;
      await expect(stakingRouter.updateModuleShares(ID, MAX_BP, MAX_BP))
        .to.emit(stakingRouter, "StakingModuleShareLimitSet")
        .withArgs(ID, MAX_BP, MAX_BP, admin.address);

      const moduleAfter = await stakingRouter.getStakingModule(ID);
      expect(moduleAfter.stakeShareLimit).to.equal(MAX_BP);
      expect(moduleAfter.priorityExitShareThreshold).to.equal(MAX_BP);
    });
  });

  context("updateAllStakingModulesFees", () => {
    const MODULE_ONE_NAME = "StakingModule1";
    const MODULE_TWO_NAME = "StakingModule2";
    const MODULE_ONE_ADDRESS = certainAddress("test:staking-router-modules:staking-module-batch-1");
    const MODULE_TWO_ADDRESS = certainAddress("test:staking-router-modules:staking-module-batch-2");
    const STAKE_SHARE_LIMIT = 1_00n;
    const PRIORITY_EXIT_SHARE_THRESHOLD = STAKE_SHARE_LIMIT;
    const MODULE_FEE = 5_00n;
    const TREASURY_FEE = 5_00n;
    const MAX_DEPOSITS_PER_BLOCK = 150n;
    const MIN_DEPOSIT_BLOCK_DISTANCE = 25n;

    const stakingModuleConfig = {
      stakeShareLimit: STAKE_SHARE_LIMIT,
      priorityExitShareThreshold: PRIORITY_EXIT_SHARE_THRESHOLD,
      stakingModuleFee: MODULE_FEE,
      treasuryFee: TREASURY_FEE,
      maxDepositsPerBlock: MAX_DEPOSITS_PER_BLOCK,
      minDepositBlockDistance: MIN_DEPOSIT_BLOCK_DISTANCE,
      withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
    };

    beforeEach(async () => {
      await stakingRouter.addStakingModule(MODULE_ONE_NAME, MODULE_ONE_ADDRESS, stakingModuleConfig);
      await stakingRouter.addStakingModule(MODULE_TWO_NAME, MODULE_TWO_ADDRESS, stakingModuleConfig);
    });

    it("Reverts if the caller does not have the role", async () => {
      await expect(stakingRouter.connect(user).updateAllStakingModulesFees([6_00n, 7_00n], [4_00n, 3_00n]))
        .to.be.revertedWithCustomError(stakingRouter, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, await stakingRouter.STAKING_MODULE_MANAGE_ROLE());
    });

    it("Reverts if batch arrays length differs from modules count", async () => {
      await expect(stakingRouter.updateAllStakingModulesFees([6_00n], [4_00n])).to.be.revertedWithCustomError(
        stakingRouter,
        "ArraysLengthMismatch",
      );

      await expect(stakingRouter.updateAllStakingModulesFees([6_00n, 7_00n], [4_00n])).to.be.revertedWithCustomError(
        stakingRouter,
        "ArraysLengthMismatch",
      );
    });

    it("Reverts if any fee sum is greater than 100%", async () => {
      await expect(
        stakingRouter.updateAllStakingModulesFees([100_01n, 7_00n], [0n, 3_00n]),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidFeeSum");
    });

    it("Reverts if fee sums differ inside the batch", async () => {
      await expect(
        stakingRouter.updateAllStakingModulesFees([6_00n, 7_00n], [4_00n, 4_00n]),
      ).to.be.revertedWithCustomError(stakingRouter, "InconsistentFeeSum");
    });

    it("Updates fees for all modules atomically and emits events", async () => {
      await expect(stakingRouter.updateAllStakingModulesFees([6_00n, 7_00n], [4_00n, 3_00n]))
        .to.be.emit(stakingRouter, "StakingModuleFeesSet")
        .withArgs(1n, 6_00n, 4_00n, admin.address)
        .and.to.be.emit(stakingRouter, "StakingModuleFeesSet")
        .withArgs(2n, 7_00n, 3_00n, admin.address);

      const moduleOne = await stakingRouter.getStakingModule(1n);
      expect(moduleOne.stakingModuleFee).to.equal(6_00n);
      expect(moduleOne.treasuryFee).to.equal(4_00n);
      expect(moduleOne.stakeShareLimit).to.equal(STAKE_SHARE_LIMIT);
      expect(moduleOne.maxDepositsPerBlock).to.equal(MAX_DEPOSITS_PER_BLOCK);
      expect(moduleOne.minDepositBlockDistance).to.equal(MIN_DEPOSIT_BLOCK_DISTANCE);

      const moduleTwo = await stakingRouter.getStakingModule(2n);
      expect(moduleTwo.stakingModuleFee).to.equal(7_00n);
      expect(moduleTwo.treasuryFee).to.equal(3_00n);
      expect(moduleTwo.stakeShareLimit).to.equal(STAKE_SHARE_LIMIT);
      expect(moduleTwo.maxDepositsPerBlock).to.equal(MAX_DEPOSITS_PER_BLOCK);
      expect(moduleTwo.minDepositBlockDistance).to.equal(MIN_DEPOSIT_BLOCK_DISTANCE);
    });
  });
});
