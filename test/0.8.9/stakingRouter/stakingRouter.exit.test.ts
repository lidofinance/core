import { expect } from "chai";
import { hexlify, randomBytes } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForBeaconChainDepositor,
  StakingModule__MockForTriggerableWithdrawals,
  StakingRouter__Harness,
} from "typechain-types";

import { certainAddress, ether, proxify, randomString } from "lib";

import { Snapshot } from "test/suite";

describe("StakingRouter.sol:exit", () => {
  let deployer: HardhatEthersSigner;
  let proxyAdmin: HardhatEthersSigner;
  let stakingRouterAdmin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let reporter: HardhatEthersSigner;

  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let stakingRouter: StakingRouter__Harness;
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
    [deployer, proxyAdmin, stakingRouterAdmin, user, reporter] = await ethers.getSigners();

    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);
    const allocLib = await ethers.deployContract("MinFirstAllocationStrategy", deployer);
    const stakingRouterFactory = await ethers.getContractFactory("StakingRouter__Harness", {
      libraries: {
        ["contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy"]: await allocLib.getAddress(),
      },
    });

    const impl = await stakingRouterFactory.connect(deployer).deploy(depositContract);
    [stakingRouter] = await proxify({ impl, admin: proxyAdmin, caller: user });

    // Initialize StakingRouter
    await stakingRouter.initialize(stakingRouterAdmin.address, lido, withdrawalCredentials);

    // Deploy mock staking module
    stakingModule = await ethers.deployContract("StakingModule__MockForTriggerableWithdrawals", deployer);

    // Grant roles to admin
    await stakingRouter
      .connect(stakingRouterAdmin)
      .grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), stakingRouterAdmin);

    // Add staking module
    await stakingRouter
      .connect(stakingRouterAdmin)
      .addStakingModule(
        randomString(8),
        await stakingModule.getAddress(),
        STAKE_SHARE_LIMIT,
        PRIORITY_EXIT_SHARE_THRESHOLD,
        MODULE_FEE,
        TREASURY_FEE,
        MAX_DEPOSITS_PER_BLOCK,
        MIN_DEPOSIT_BLOCK_DISTANCE,
      );

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
      ).to.be.revertedWith(
        `AccessControl: account ${user.address.toLowerCase()} is missing role ${await stakingRouter.REPORT_VALIDATOR_EXITING_STATUS_ROLE()}`,
      );
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
        .to.emit(stakingRouter, "StakingModuleExitNotificationFailed")
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
      ).to.be.revertedWithCustomError(stakingRouter, "UnrecoverableModuleError");
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
      ).to.be.revertedWith(
        `AccessControl: account ${user.address.toLowerCase()} is missing role ${await stakingRouter.REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE()}`,
      );
    });
  });
});
