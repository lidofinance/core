import { expect } from "chai";
import { hexlify, randomBytes } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { StakingModule__MockForTriggerableWithdrawals, StakingRouter__Harness } from "typechain-types";

import { certainAddress, ether, randomString, StakingModuleType } from "lib";

import { Snapshot } from "test/suite";

import { deployStakingRouter, StakingRouterWithLib } from "../../deploy/stakingRouter";

describe("StakingRouter.sol:exit", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let stakingRouterAdmin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let reporter: HardhatEthersSigner;

  let stakingRouter: StakingRouter__Harness;
  let stakingRouterWithLib: StakingRouterWithLib;
  let stakingModule: StakingModule__MockForTriggerableWithdrawals;

  let originalState: string;

  const lido = certainAddress("test:staking-router:lido");
  const withdrawalCredentials = hexlify(randomBytes(32));
  const STAKE_SHARE_LIMIT = 1_00n;
  const PRIORITY_EXIT_SHARE_THRESHOLD = STAKE_SHARE_LIMIT;
  const MODULE_FEE = 5_00n;
  const TREASURY_FEE = 5_00n;
  const MAX_DEPOSITS_PER_BLOCK = 150n;
  const MIN_DEPOSIT_BLOCK_DISTANCE = 25n;
  const STAKING_MODULE_ID = 1n;
  const NODE_OPERATOR_ID = 1n;

  before(async () => {
    [deployer, admin, stakingRouterAdmin, user, reporter] = await ethers.getSigners();

    ({ stakingRouter, stakingRouterWithLib } = await deployStakingRouter({ deployer, admin, user }));

    // Initialize StakingRouter
    await stakingRouter.initialize(stakingRouterAdmin.address, lido, withdrawalCredentials);

    // Deploy mock staking module
    stakingModule = await ethers.deployContract("StakingModule__MockForTriggerableWithdrawals", deployer);

    // Grant roles to admin
    await stakingRouter
      .connect(stakingRouterAdmin)
      .grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), stakingRouterAdmin);

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
      /// @notice The type of module (Legacy/Standard), defines the module interface and withdrawal credentials type.
      /// @dev 0 = Legacy, 0x01 withdrawals, 1 = New, 0x02 withdrawals.
      /// @dev See {StakingModuleType} enum.
      moduleType: StakingModuleType.Legacy,
    };

    // Add staking module
    await stakingRouter
      .connect(stakingRouterAdmin)
      .addStakingModule(randomString(8), await stakingModule.getAddress(), stakingModuleConfig);

    // Grant necessary roles to reporter
    await stakingRouter
      .connect(stakingRouterAdmin)
      .grantRole(await stakingRouter.REPORT_VALIDATOR_EXITING_STATUS_ROLE(), reporter);

    await stakingRouter
      .connect(stakingRouterAdmin)
      .grantRole(await stakingRouter.REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE(), reporter);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("reportValidatorExitDelay", () => {
    const proofSlotTimestamp = Math.floor(Date.now() / 1000);
    const eligibleToExitInSec = 86400; // 1 day
    const publicKey = hexlify(randomBytes(48));

    it("calls reportValidatorExitDelay on the staking module", async () => {
      await expect(
        stakingModule.reportValidatorExitDelay(NODE_OPERATOR_ID, proofSlotTimestamp, publicKey, eligibleToExitInSec),
      ).to.not.be.reverted;

      await expect(
        stakingRouter
          .connect(reporter)
          .reportValidatorExitDelay(
            STAKING_MODULE_ID,
            NODE_OPERATOR_ID,
            proofSlotTimestamp,
            publicKey,
            eligibleToExitInSec,
          ),
      ).to.not.be.reverted;
    });

    it("reverts when called by unauthorized user", async () => {
      await expect(
        stakingRouter
          .connect(user)
          .reportValidatorExitDelay(
            STAKING_MODULE_ID,
            NODE_OPERATOR_ID,
            proofSlotTimestamp,
            publicKey,
            eligibleToExitInSec,
          ),
      ).to.be.revertedWithCustomError(stakingRouter, "AccessControlUnauthorizedAccount");
    });
  });

  context("onValidatorExitTriggered", () => {
    const withdrawalRequestPaidFee = ether("0.01");
    const exitType = 1n;
    const publicKey = hexlify(randomBytes(48));

    it("calls onValidatorExitTriggered on the staking module for each validator", async () => {
      const validatorExitData = [
        {
          stakingModuleId: STAKING_MODULE_ID,
          nodeOperatorId: NODE_OPERATOR_ID,
          pubkey: publicKey,
        },
      ];

      await stakingModule.setOnValidatorExitTriggeredResponse(true);

      await expect(
        stakingRouter.connect(reporter).onValidatorExitTriggered(validatorExitData, withdrawalRequestPaidFee, exitType),
      ).to.not.be.reverted;
    });

    it("emits StakingModuleExitNotificationFailed when staking module reverts", async () => {
      const validatorExitData = [
        {
          stakingModuleId: STAKING_MODULE_ID,
          nodeOperatorId: NODE_OPERATOR_ID,
          pubkey: publicKey,
        },
      ];

      await stakingModule.setOnValidatorExitTriggeredResponse(false);
      await stakingModule.setRevertReason("Test revert reason");

      await expect(
        stakingRouter.connect(reporter).onValidatorExitTriggered(validatorExitData, withdrawalRequestPaidFee, exitType),
      )
        .to.emit(stakingRouterWithLib, "StakingModuleExitNotificationFailed")
        .withArgs(STAKING_MODULE_ID, NODE_OPERATOR_ID, publicKey);
    });

    it("reverts with UnrecoverableModuleError when staking module reverts with empty reason", async () => {
      const validatorExitData = [
        {
          stakingModuleId: STAKING_MODULE_ID,
          nodeOperatorId: NODE_OPERATOR_ID,
          pubkey: publicKey,
        },
      ];

      await stakingModule.setOnValidatorExitTriggeredResponse(false);
      await stakingModule.setRevertWithEmptyReason(true);

      await expect(
        stakingRouter.connect(reporter).onValidatorExitTriggered(validatorExitData, withdrawalRequestPaidFee, exitType),
      ).to.be.revertedWithCustomError(stakingRouterWithLib, "UnrecoverableModuleError");
    });

    it("reverts when called by unauthorized user", async () => {
      const validatorExitData = [
        {
          stakingModuleId: STAKING_MODULE_ID,
          nodeOperatorId: NODE_OPERATOR_ID,
          pubkey: publicKey,
        },
      ];

      await expect(
        stakingRouter.connect(user).onValidatorExitTriggered(validatorExitData, withdrawalRequestPaidFee, exitType),
      ).to.be.revertedWithCustomError(stakingRouter, "AccessControlUnauthorizedAccount");
    });
  });
});
