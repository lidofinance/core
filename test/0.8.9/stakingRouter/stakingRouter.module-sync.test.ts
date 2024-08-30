import { bigintToHex, bufToHex } from "bigint-conversion";
import { expect } from "chai";
import { hexlify, randomBytes } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForBeaconChainDepositor,
  DepositContract__MockForBeaconChainDepositor__factory,
  MinFirstAllocationStrategy__factory,
  StakingModule__Mock,
  StakingModule__Mock__factory,
  StakingRouter,
  StakingRouter__factory,
} from "typechain-types";
import { StakingRouterLibraryAddresses } from "typechain-types/factories/contracts/0.8.9/StakingRouter__factory";

import { ether, getNextBlock, proxify } from "lib";

describe("StakingRouter:module-sync", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let lido: HardhatEthersSigner;

  let stakingRouter: StakingRouter;
  let stakingModule: StakingModule__Mock;
  let depositContract: DepositContract__MockForBeaconChainDepositor;

  let moduleId: bigint;
  let stakingModuleAddress: string;
  let lastDepositAt: bigint;
  let lastDepositBlock: bigint;

  // module params
  const name = "myStakingModule";
  const stakingModuleFee = 5_00n;
  const treasuryFee = 5_00n;
  const stakeShareLimit = 1_00n;
  const priorityExitShareThreshold = 2_00n;
  const maxDepositsPerBlock = 150n;
  const minDepositBlockDistance = 25n;

  beforeEach(async () => {
    [deployer, admin, user, lido] = await ethers.getSigners();

    depositContract = await new DepositContract__MockForBeaconChainDepositor__factory(deployer).deploy();

    const allocLib = await new MinFirstAllocationStrategy__factory(deployer).deploy();
    const allocLibAddr: StakingRouterLibraryAddresses = {
      ["contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy"]: await allocLib.getAddress(),
    };

    const impl = await new StakingRouter__factory(allocLibAddr, deployer).deploy(depositContract);

    [stakingRouter] = await proxify({ impl, admin });

    // initialize staking router
    await stakingRouter.initialize(
      admin,
      lido,
      hexlify(randomBytes(32)), // mock withdrawal credentials
    );

    // grant roles

    await Promise.all([
      stakingRouter.grantRole(await stakingRouter.MANAGE_WITHDRAWAL_CREDENTIALS_ROLE(), admin),
      stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin),
      stakingRouter.grantRole(await stakingRouter.REPORT_EXITED_VALIDATORS_ROLE(), admin),
      stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_UNVETTING_ROLE(), admin),
      stakingRouter.grantRole(await stakingRouter.UNSAFE_SET_EXITED_VALIDATORS_ROLE(), admin),
      stakingRouter.grantRole(await stakingRouter.REPORT_REWARDS_MINTED_ROLE(), admin),
    ]);

    // add staking module
    stakingModule = await new StakingModule__Mock__factory(deployer).deploy();
    stakingModuleAddress = await stakingModule.getAddress();
    const { timestamp, number } = await getNextBlock();
    lastDepositAt = timestamp;
    lastDepositBlock = number;

    await stakingRouter.addStakingModule(
      name,
      stakingModuleAddress,
      stakeShareLimit,
      priorityExitShareThreshold,
      stakingModuleFee,
      treasuryFee,
      maxDepositsPerBlock,
      minDepositBlockDistance,
    );

    moduleId = await stakingRouter.getStakingModulesCount();
  });

  context("Getters", () => {
    let stakingModuleInfo: [
      bigint,
      string,
      bigint,
      bigint,
      bigint,
      number,
      string,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];

    // module mock state
    const stakingModuleSummary: Parameters<StakingModule__Mock["mock__getStakingModuleSummary"]> = [
      100n, // exitedValidators
      1000, // depositedValidators
      200, // depositableValidators
    ];

    const nodeOperatorSummary: Parameters<StakingModule__Mock["mock__getNodeOperatorSummary"]> = [
      1, // targetLimitMode
      100n, // targetValidatorsCount
      1n, // stuckValidatorsCount
      5n, // refundedValidatorsCount
      0n, // stuckPenaltyEndTimestamp
      50, // totalExitedValidators
      1000n, // totalDepositedValidators
      200n, // depositableValidatorsCount
    ];

    const nodeOperatorsCounts: Parameters<StakingModule__Mock["mock__nodeOperatorsCount"]> = [
      100n, // nodeOperatorsCount
      95n, // activeNodeOperatorsCount
    ];

    const nodeOperatorsIds = [0n];

    beforeEach(async () => {
      stakingModuleInfo = [
        moduleId,
        stakingModuleAddress,
        stakingModuleFee,
        treasuryFee,
        stakeShareLimit,
        Status.Active,
        name,
        lastDepositAt,
        lastDepositBlock,
        0n, // exitedValidatorsCount,
        priorityExitShareThreshold,
        maxDepositsPerBlock,
        minDepositBlockDistance,
      ];

      // mocking module state
      await stakingModule.mock__getStakingModuleSummary(...stakingModuleSummary);
      await stakingModule.mock__getNodeOperatorSummary(...nodeOperatorSummary);
      await stakingModule.mock__nodeOperatorsCount(...nodeOperatorsCounts);
      await stakingModule.mock__getNodeOperatorIds(nodeOperatorsIds);
    });

    context("getStakingModules", () => {
      it("Returns an array of staking module structs", async () => {
        expect(await stakingRouter.getStakingModules()).to.deep.equal([stakingModuleInfo]);
      });
    });

    context("getStakingModuleIds", () => {
      it("Returns an array of staking module ids", async () => {
        expect(await stakingRouter.getStakingModuleIds()).to.deep.equal([moduleId]);
      });
    });

    context("getStakingModule", () => {
      it("Returns the staking module struct by its id", async () => {
        expect(await stakingRouter.getStakingModule(moduleId)).to.deep.equal(stakingModuleInfo);
      });
    });

    context("getStakingModulesCount", () => {
      it("Returns the number of staking modules registered", async () => {
        expect(await stakingRouter.getStakingModulesCount()).to.deep.equal(1n);
      });
    });

    context("hasStakingModule", () => {
      it("Returns true if a staking module with a given id exists", async () => {
        expect(await stakingRouter.hasStakingModule(moduleId)).to.equal(true);
      });

      it("Returns false if a staking module with a given id does not exist", async () => {
        expect(await stakingRouter.hasStakingModule(moduleId + 1n)).to.equal(false);
      });
    });

    context("getStakingModuleStatus", () => {
      it("Returns the status of the staking module", async () => {
        expect(await stakingRouter.getStakingModuleStatus(moduleId)).to.equal(0n);
      });
    });

    context("getStakingModuleSummary", () => {
      it("Returns the staking module summary", async () => {
        expect(await stakingRouter.getStakingModuleSummary(moduleId)).to.deep.equal(stakingModuleSummary);
      });
    });

    context("getNodeOperatorSummary", () => {
      it("Returns the node operator summary", async () => {
        expect(await stakingRouter.getNodeOperatorSummary(moduleId, 1n)).to.deep.equal(nodeOperatorSummary);
      });
    });

    context("getAllStakingModuleDigests", () => {
      it("Returns the digests of the specified staking modules", async () => {
        expect(await stakingRouter.getAllStakingModuleDigests()).to.deep.equal([
          [...nodeOperatorsCounts, stakingModuleInfo, stakingModuleSummary],
        ]);
      });
    });

    context("getStakingModuleDigests", () => {
      it("Returns the digests of the specified staking modules", async () => {
        expect(await stakingRouter.getStakingModuleDigests([moduleId])).to.deep.equal([
          [...nodeOperatorsCounts, stakingModuleInfo, stakingModuleSummary],
        ]);
      });
    });

    context("getAllNodeOperatorDigests", () => {
      it("Returns all node operator digests", async () => {
        expect(await stakingRouter.getAllNodeOperatorDigests(moduleId)).to.deep.equal([
          [0n, true, nodeOperatorSummary],
        ]);
      });
    });

    context("getNodeOperatorDigests (by offset)", () => {
      it("Returns node operator digests by offset and limit", async () => {
        expect(await stakingRouter["getNodeOperatorDigests(uint256,uint256,uint256)"](moduleId, 0n, 1n)).to.deep.equal([
          [0n, true, nodeOperatorSummary],
        ]);
      });
    });

    context("getNodeOperatorDigests (by ids)", () => {
      it("Returns node operator digests by ids", async () => {
        expect(await stakingRouter["getNodeOperatorDigests(uint256,uint256[])"](moduleId, [0n])).to.deep.equal([
          [0n, true, nodeOperatorSummary],
        ]);
      });
    });

    context("getStakingModuleNonce", () => {
      it("Returns 0 initially", async () => {
        expect(await stakingRouter.getStakingModuleNonce(moduleId)).to.equal(0n);
      });

      it("Returns the updated nonce", async () => {
        await stakingModule.mock__getNonce(1n);

        expect(await stakingRouter.getStakingModuleNonce(moduleId)).to.equal(1n);
      });
    });

    context("getStakingModuleLastDepositBlock", () => {
      it("Returns initially the register block number", async () => {
        expect(await stakingRouter.getStakingModuleLastDepositBlock(moduleId)).to.equal(lastDepositBlock);
      });
    });

    context("getStakingModuleMinDepositBlockDistance", () => {
      it("Returns the minimum deposit block distance", async () => {
        expect(await stakingRouter.getStakingModuleMinDepositBlockDistance(moduleId)).to.equal(minDepositBlockDistance);
      });
    });

    context("getStakingModuleMaxDepositsPerBlock", () => {
      it("Returns the maximum deposits per block", async () => {
        expect(await stakingRouter.getStakingModuleMaxDepositsPerBlock(moduleId)).to.equal(maxDepositsPerBlock);
      });
    });

    context("getStakingModuleActiveValidatorsCount", () => {
      it("Returns the number of active validators in the module", async () => {
        const [exitedValidators, depositedValidators] = stakingModuleSummary;

        expect(await stakingRouter.getStakingModuleActiveValidatorsCount(moduleId)).to.equal(
          Number(depositedValidators) - Number(exitedValidators),
        );
      });
    });
  });

  context("setWithdrawalCredentials", () => {
    it("Reverts if the caller does not have the role", async () => {
      await expect(
        stakingRouter.connect(user).setWithdrawalCredentials(hexlify(randomBytes(32))),
      ).to.be.revertedWithOZAccessControlError(user.address, await stakingRouter.MANAGE_WITHDRAWAL_CREDENTIALS_ROLE());
    });

    it("Set new withdrawal credentials and informs modules", async () => {
      const newWithdrawalCredentials = hexlify(randomBytes(32));

      await expect(stakingRouter.setWithdrawalCredentials(newWithdrawalCredentials))
        .to.emit(stakingRouter, "WithdrawalCredentialsSet")
        .withArgs(newWithdrawalCredentials, admin.address)
        .and.to.emit(stakingModule, "Mock__WithdrawalCredentialsChanged");
    });

    it("Emits an event if the module hook fails with a revert data", async () => {
      const shouldRevert = true;
      await stakingModule.mock__onWithdrawalCredentialsChanged(shouldRevert, false);

      // "revert reason" abi-encoded
      const revertReasonEncoded = [
        "0x08c379a0", // string type
        "0000000000000000000000000000000000000000000000000000000000000020",
        "000000000000000000000000000000000000000000000000000000000000000d",
        "72657665727420726561736f6e00000000000000000000000000000000000000",
      ].join("");

      await expect(stakingRouter.setWithdrawalCredentials(hexlify(randomBytes(32))))
        .to.emit(stakingRouter, "WithdrawalsCredentialsChangeFailed")
        .withArgs(moduleId, revertReasonEncoded);
    });

    it("Reverts if the module hook fails without reason, e.g. ran out of gas", async () => {
      const shouldRunOutOfGas = true;
      await stakingModule.mock__onWithdrawalCredentialsChanged(false, shouldRunOutOfGas);

      await expect(stakingRouter.setWithdrawalCredentials(hexlify(randomBytes(32)))).to.be.revertedWithCustomError(
        stakingRouter,
        "UnrecoverableModuleError",
      );
    });
  });

  context("updateTargetValidatorsLimits", () => {
    const NODE_OPERATOR_ID = 0n;
    const TARGET_LIMIT_MODE = 1; // 1 - soft, i.e. on WQ request; 2 - forced
    const TARGET_LIMIT = 100n;

    it("Reverts if the caller does not have the role", async () => {
      await expect(
        stakingRouter
          .connect(user)
          .updateTargetValidatorsLimits(moduleId, NODE_OPERATOR_ID, TARGET_LIMIT_MODE, TARGET_LIMIT),
      ).to.be.revertedWithOZAccessControlError(user.address, await stakingRouter.STAKING_MODULE_MANAGE_ROLE());
    });

    it("Redirects the call to the staking module", async () => {
      await expect(
        stakingRouter.updateTargetValidatorsLimits(moduleId, NODE_OPERATOR_ID, TARGET_LIMIT_MODE, TARGET_LIMIT),
      )
        .to.emit(stakingModule, "Mock__TargetValidatorsLimitsUpdated")
        .withArgs(NODE_OPERATOR_ID, TARGET_LIMIT_MODE, TARGET_LIMIT);
    });
  });

  context("updateRefundedValidatorsCount", () => {
    const NODE_OPERATOR_ID = 0n;
    const REFUNDED_VALIDATORS_COUNT = 10n;

    it("Reverts if the caller does not have the role", async () => {
      await expect(
        stakingRouter
          .connect(user)
          .updateRefundedValidatorsCount(moduleId, NODE_OPERATOR_ID, REFUNDED_VALIDATORS_COUNT),
      ).to.be.revertedWithOZAccessControlError(user.address, await stakingRouter.STAKING_MODULE_MANAGE_ROLE());
    });

    it("Redirects the call to the staking module", async () => {
      await expect(stakingRouter.updateRefundedValidatorsCount(moduleId, NODE_OPERATOR_ID, REFUNDED_VALIDATORS_COUNT))
        .to.emit(stakingModule, "Mock__RefundedValidatorsCountUpdated")
        .withArgs(NODE_OPERATOR_ID, REFUNDED_VALIDATORS_COUNT);
    });
  });

  context("reportRewardsMinted", () => {
    it("Reverts if the caller does not have the role", async () => {
      await expect(
        stakingRouter.connect(user).reportRewardsMinted([moduleId], [0n]),
      ).to.be.revertedWithOZAccessControlError(user.address, await stakingRouter.REPORT_REWARDS_MINTED_ROLE());
    });

    it("Reverts if the arrays have different lengths", async () => {
      await expect(stakingRouter.reportRewardsMinted([moduleId], [0n, 1n]))
        .to.be.revertedWithCustomError(stakingRouter, "ArraysLengthMismatch")
        .withArgs(1n, 2n);
    });

    it("Does nothing if the total shares is 0", async () => {
      await expect(stakingRouter.reportRewardsMinted([moduleId], [0n])).not.to.emit(
        stakingModule,
        "Mock__OnRewardsMinted",
      );
    });

    it("Does nothing if the total shares is 0", async () => {
      await expect(stakingRouter.reportRewardsMinted([moduleId], [0n])).not.to.emit(
        stakingModule,
        "Mock__OnRewardsMinted",
      );
    });

    it("Calls the hook on the staking module if the total shares is greater than 0", async () => {
      await expect(stakingRouter.reportRewardsMinted([moduleId], [1n]))
        .to.emit(stakingModule, "Mock__OnRewardsMinted")
        .withArgs(1n);
    });

    it("Emits an event if the module hook fails with a revert data", async () => {
      const shouldRevert = true;
      await stakingModule.mock__revertOnRewardsMinted(shouldRevert, false);

      // "revert reason" abi-encoded
      const revertReasonEncoded = [
        "0x08c379a0", // string type
        "0000000000000000000000000000000000000000000000000000000000000020",
        "000000000000000000000000000000000000000000000000000000000000000d",
        "72657665727420726561736f6e00000000000000000000000000000000000000",
      ].join("");

      await expect(stakingRouter.reportRewardsMinted([moduleId], [1n]))
        .to.emit(stakingRouter, "RewardsMintedReportFailed")
        .withArgs(moduleId, revertReasonEncoded);
    });

    it("Reverts if the module hook fails without reason, e.g. ran out of gas", async () => {
      const shouldRunOutOfGas = true;
      await stakingModule.mock__revertOnRewardsMinted(false, shouldRunOutOfGas);

      await expect(stakingRouter.reportRewardsMinted([moduleId], [1n])).to.be.revertedWithCustomError(
        stakingRouter,
        "UnrecoverableModuleError",
      );
    });
  });

  context("updateExitedValidatorsCountByStakingModule", () => {
    it("Reverts if the caller does not have the role", async () => {
      await expect(
        stakingRouter.connect(user).updateExitedValidatorsCountByStakingModule([moduleId], [0n]),
      ).to.be.revertedWithOZAccessControlError(user.address, await stakingRouter.REPORT_EXITED_VALIDATORS_ROLE());
    });

    it("Reverts if the array lengths are different", async () => {
      await expect(stakingRouter.updateExitedValidatorsCountByStakingModule([moduleId], [0n, 1n]))
        .to.be.revertedWithCustomError(stakingRouter, "ArraysLengthMismatch")
        .withArgs(1n, 2n);
    });

    it("Reverts if the new number of exited validators is less than the previous one", async () => {
      const totalExitedValidators = 5n;
      const totalDepositedValidators = 10n;
      const depositableValidatorsCount = 2n;

      await stakingModule.mock__getStakingModuleSummary(
        totalExitedValidators,
        totalDepositedValidators,
        depositableValidatorsCount,
      );

      await stakingRouter.updateExitedValidatorsCountByStakingModule([moduleId], [totalExitedValidators]);

      await expect(
        stakingRouter.updateExitedValidatorsCountByStakingModule([moduleId], [totalExitedValidators - 1n]),
      ).to.be.revertedWithCustomError(stakingRouter, "ExitedValidatorsCountCannotDecrease");
    });

    it("Reverts if the new number of exited validators exceeds the number of deposited", async () => {
      const totalExitedValidators = 5n;
      const totalDepositedValidators = 10n;
      const depositableValidatorsCount = 2n;

      await stakingModule.mock__getStakingModuleSummary(
        totalExitedValidators,
        totalDepositedValidators,
        depositableValidatorsCount,
      );

      await stakingRouter.updateExitedValidatorsCountByStakingModule([moduleId], [totalExitedValidators]);

      const newExitedValidatorsExceedingDeposited = totalDepositedValidators + 1n;
      await expect(
        stakingRouter.updateExitedValidatorsCountByStakingModule([moduleId], [newExitedValidatorsExceedingDeposited]),
      )
        .to.be.revertedWithCustomError(stakingRouter, "ReportedExitedValidatorsExceedDeposited")
        .withArgs(newExitedValidatorsExceedingDeposited, totalDepositedValidators);
    });

    it("Logs an event if the total exited validators is less than the previously reported number", async () => {
      const totalExitedValidators = 5n;
      const totalDepositedValidators = 10n;
      const depositableValidatorsCount = 2n;

      await stakingModule.mock__getStakingModuleSummary(
        totalExitedValidators,
        totalDepositedValidators,
        depositableValidatorsCount,
      );

      const previouslyReportedTotalExitedValidators = totalExitedValidators + 1n;
      await stakingRouter.updateExitedValidatorsCountByStakingModule([moduleId], [totalExitedValidators + 1n]);

      const newTotalExitedValidators = totalExitedValidators + 1n;

      await expect(stakingRouter.updateExitedValidatorsCountByStakingModule([moduleId], [newTotalExitedValidators]))
        .to.be.emit(stakingRouter, "StakingModuleExitedValidatorsIncompleteReporting")
        .withArgs(moduleId, previouslyReportedTotalExitedValidators - totalExitedValidators);
    });

    it("Logs an event if the total exited validators is less than the previously reported number", async () => {
      const totalExitedValidators = 5n;
      const totalDepositedValidators = 10n;
      const depositableValidatorsCount = 2n;

      await stakingModule.mock__getStakingModuleSummary(
        totalExitedValidators,
        totalDepositedValidators,
        depositableValidatorsCount,
      );

      await stakingRouter.updateExitedValidatorsCountByStakingModule([moduleId], [totalExitedValidators]);

      const newTotalExitedValidators = totalExitedValidators + 1n;

      const newlyExitedValidatorsCount = await stakingRouter.updateExitedValidatorsCountByStakingModule.staticCall(
        [moduleId],
        [newTotalExitedValidators],
      );

      expect(newlyExitedValidatorsCount).to.equal(1n);
    });
  });

  context("reportStakingModuleExitedValidatorsCountByNodeOperator", () => {
    const NODE_OPERATOR_IDS = bigintToHex(1n, true, 8);
    const VALIDATORS_COUNTS = bigintToHex(100n, true, 16);

    it("Reverts if the caller does not have the role", async () => {
      await expect(
        stakingRouter
          .connect(user)
          .reportStakingModuleExitedValidatorsCountByNodeOperator(moduleId, NODE_OPERATOR_IDS, VALIDATORS_COUNTS),
      ).to.be.revertedWithOZAccessControlError(user.address, await stakingRouter.REPORT_EXITED_VALIDATORS_ROLE());
    });

    it("Reverts if the node operators ids are packed incorrectly", async () => {
      const incorrectlyPackedNodeOperatorIds = bufToHex(new Uint8Array([1]), true, 7);

      await expect(
        stakingRouter.reportStakingModuleExitedValidatorsCountByNodeOperator(
          moduleId,
          incorrectlyPackedNodeOperatorIds,
          VALIDATORS_COUNTS,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "InvalidReportData")
        .withArgs(3n);
    });

    it("Reverts if the validator counts are packed incorrectly", async () => {
      const incorrectlyPackedValidatorCounts = bufToHex(new Uint8Array([100]), true, 15);

      await expect(
        stakingRouter.reportStakingModuleExitedValidatorsCountByNodeOperator(
          moduleId,
          NODE_OPERATOR_IDS,
          incorrectlyPackedValidatorCounts,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "InvalidReportData")
        .withArgs(3n);
    });

    it("Reverts if the number of node operators does not match validator counts", async () => {
      const tooManyValidatorCounts = VALIDATORS_COUNTS + bigintToHex(101n, false, 16);

      await expect(
        stakingRouter.reportStakingModuleExitedValidatorsCountByNodeOperator(
          moduleId,
          NODE_OPERATOR_IDS,
          tooManyValidatorCounts,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "InvalidReportData")
        .withArgs(2n);
    });

    it("Reverts if the number of node operators does not match validator counts", async () => {
      const tooManyValidatorCounts = VALIDATORS_COUNTS + bigintToHex(101n, false, 16);

      await expect(
        stakingRouter.reportStakingModuleExitedValidatorsCountByNodeOperator(
          moduleId,
          NODE_OPERATOR_IDS,
          tooManyValidatorCounts,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "InvalidReportData")
        .withArgs(2n);
    });

    it("Reverts if the node operators ids is empty", async () => {
      await expect(stakingRouter.reportStakingModuleExitedValidatorsCountByNodeOperator(moduleId, "0x", "0x"))
        .to.be.revertedWithCustomError(stakingRouter, "InvalidReportData")
        .withArgs(1n);
    });

    it("Updates exited validator count on the module", async () => {
      await expect(
        stakingRouter.reportStakingModuleExitedValidatorsCountByNodeOperator(
          moduleId,
          NODE_OPERATOR_IDS,
          VALIDATORS_COUNTS,
        ),
      )
        .to.emit(stakingModule, "Mock__ExitedValidatorsCountUpdated")
        .withArgs(NODE_OPERATOR_IDS, VALIDATORS_COUNTS);
    });
  });

  context("unsafeSetExitedValidatorsCount", () => {
    const nodeOperatorId = 1n;

    const moduleSummary = {
      totalExitedValidators: 5n,
      totalDepositedValidators: 10n,
      depositableValidatorsCount: 2n,
    };

    const operatorSummary = {
      targetLimitMode: 1,
      targetValidatorsCount: 100n,
      stuckValidatorsCount: 0n,
      refundedValidatorsCount: 0n,
      stuckPenaltyEndTimestamp: 0n,
      totalExitedValidators: 3n,
      totalDepositedValidators: 5n,
      depositableValidatorsCount: 1n,
    };

    const correction: StakingRouter.ValidatorsCountsCorrectionStruct = {
      currentModuleExitedValidatorsCount: moduleSummary.totalExitedValidators,
      currentNodeOperatorExitedValidatorsCount: operatorSummary.totalExitedValidators,
      currentNodeOperatorStuckValidatorsCount: operatorSummary.stuckValidatorsCount,
      newModuleExitedValidatorsCount: moduleSummary.totalExitedValidators,
      newNodeOperatorExitedValidatorsCount: operatorSummary.totalExitedValidators + 1n,
      newNodeOperatorStuckValidatorsCount: operatorSummary.stuckValidatorsCount + 1n,
    };

    beforeEach(async () => {
      await stakingModule.mock__getStakingModuleSummary(
        moduleSummary.totalExitedValidators,
        moduleSummary.totalDepositedValidators,
        moduleSummary.depositableValidatorsCount,
      );

      const nodeOperatorSummary: Parameters<StakingModule__Mock["mock__getNodeOperatorSummary"]> = [
        operatorSummary.targetLimitMode,
        operatorSummary.targetValidatorsCount,
        operatorSummary.stuckValidatorsCount,
        operatorSummary.refundedValidatorsCount,
        operatorSummary.stuckPenaltyEndTimestamp,
        operatorSummary.totalExitedValidators,
        operatorSummary.totalDepositedValidators,
        operatorSummary.depositableValidatorsCount,
      ];

      await stakingModule.mock__getNodeOperatorSummary(...nodeOperatorSummary);

      await stakingRouter.updateExitedValidatorsCountByStakingModule([moduleId], [moduleSummary.totalExitedValidators]);
    });

    it("Reverts if the caller does not have the role", async () => {
      await expect(
        stakingRouter.connect(user).unsafeSetExitedValidatorsCount(moduleId, nodeOperatorId, true, correction),
      ).to.be.revertedWithOZAccessControlError(user.address, await stakingRouter.UNSAFE_SET_EXITED_VALIDATORS_ROLE());
    });

    it("Reverts if the number of exited validators in the module does not match what is stored on the contract", async () => {
      await expect(
        stakingRouter.unsafeSetExitedValidatorsCount(moduleId, nodeOperatorId, true, {
          ...correction,
          currentModuleExitedValidatorsCount: 1n,
        }),
      )
        .to.be.revertedWithCustomError(stakingRouter, "UnexpectedCurrentValidatorsCount")
        .withArgs(
          correction.currentModuleExitedValidatorsCount,
          correction.currentNodeOperatorExitedValidatorsCount,
          correction.currentNodeOperatorStuckValidatorsCount,
        );
    });

    it("Reverts if the number of exited validators of the operator does not match what is stored on the contract", async () => {
      await expect(
        stakingRouter.unsafeSetExitedValidatorsCount(moduleId, nodeOperatorId, true, {
          ...correction,
          currentNodeOperatorExitedValidatorsCount: 1n,
        }),
      )
        .to.be.revertedWithCustomError(stakingRouter, "UnexpectedCurrentValidatorsCount")
        .withArgs(
          correction.currentModuleExitedValidatorsCount,
          correction.currentNodeOperatorExitedValidatorsCount,
          correction.currentNodeOperatorStuckValidatorsCount,
        );
    });

    it("Reverts if the number of stuck validators of the operator does not match what is stored on the contract", async () => {
      await expect(
        stakingRouter.unsafeSetExitedValidatorsCount(moduleId, nodeOperatorId, true, {
          ...correction,
          currentNodeOperatorStuckValidatorsCount: 1n,
        }),
      )
        .to.be.revertedWithCustomError(stakingRouter, "UnexpectedCurrentValidatorsCount")
        .withArgs(
          correction.currentModuleExitedValidatorsCount,
          correction.currentNodeOperatorExitedValidatorsCount,
          correction.currentNodeOperatorStuckValidatorsCount,
        );
    });

    it("Reverts if the total exited validators exceed the module's deposited validators", async () => {
      const newModuleExitedValidatorsCount = 50n;

      await expect(
        stakingRouter.unsafeSetExitedValidatorsCount(moduleId, nodeOperatorId, true, {
          ...correction,
          newModuleExitedValidatorsCount,
        }),
      )
        .to.be.revertedWithCustomError(stakingRouter, "ReportedExitedValidatorsExceedDeposited")
        .withArgs(newModuleExitedValidatorsCount, moduleSummary.totalDepositedValidators);
    });

    it("Reverts if the total exited validators count in the staking module does not match the staking router after the final update", async () => {
      const newModuleExitedValidatorsCount = 10n;

      await expect(
        stakingRouter.unsafeSetExitedValidatorsCount(moduleId, nodeOperatorId, true, {
          ...correction,
          newModuleExitedValidatorsCount,
        }),
      )
        .to.be.revertedWithCustomError(stakingRouter, "UnexpectedFinalExitedValidatorsCount")
        .withArgs(moduleSummary.totalExitedValidators, newModuleExitedValidatorsCount);
    });

    it("Update unsafely the number of exited validators on the staking module with finalization hook triggering", async () => {
      await expect(stakingRouter.unsafeSetExitedValidatorsCount(moduleId, nodeOperatorId, true, correction))
        .to.be.emit(stakingModule, "Mock__ValidatorsCountUnsafelyUpdated")
        .withArgs(
          moduleId,
          correction.newNodeOperatorExitedValidatorsCount,
          correction.newNodeOperatorStuckValidatorsCount,
        )
        .and.to.emit(stakingModule, "Mock__onExitedAndStuckValidatorsCountsUpdated");
    });

    it("Update unsafely the number of exited validators on the staking module", async () => {
      const triggerHook = false;

      await expect(
        stakingRouter.unsafeSetExitedValidatorsCount(moduleId, nodeOperatorId, triggerHook, correction),
      ).not.to.emit(stakingModule, "Mock__onExitedAndStuckValidatorsCountsUpdated");
    });
  });

  context("reportStakingModuleStuckValidatorsCountByNodeOperator", () => {
    const NODE_OPERATOR_IDS = bigintToHex(1n, true, 8);
    const STUCK_VALIDATOR_COUNTS = bigintToHex(100n, true, 16);

    it("Reverts if the caller does not have the role", async () => {
      await expect(
        stakingRouter
          .connect(user)
          .reportStakingModuleStuckValidatorsCountByNodeOperator(moduleId, NODE_OPERATOR_IDS, STUCK_VALIDATOR_COUNTS),
      ).to.be.revertedWithOZAccessControlError(user.address, await stakingRouter.REPORT_EXITED_VALIDATORS_ROLE());
    });

    it("Reverts if the node operators ids are packed incorrectly", async () => {
      const incorrectlyPackedNodeOperatorIds = bufToHex(new Uint8Array([1]), true, 7);

      await expect(
        stakingRouter.reportStakingModuleStuckValidatorsCountByNodeOperator(
          moduleId,
          incorrectlyPackedNodeOperatorIds,
          STUCK_VALIDATOR_COUNTS,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "InvalidReportData")
        .withArgs(3n);
    });

    it("Reverts if the validator counts are packed incorrectly", async () => {
      const incorrectlyPackedValidatorCounts = bufToHex(new Uint8Array([100]), true, 15);

      await expect(
        stakingRouter.reportStakingModuleStuckValidatorsCountByNodeOperator(
          moduleId,
          NODE_OPERATOR_IDS,
          incorrectlyPackedValidatorCounts,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "InvalidReportData")
        .withArgs(3n);
    });

    it("Reverts if the number of node operators does not match validator counts", async () => {
      const tooManyValidatorCounts = STUCK_VALIDATOR_COUNTS + bigintToHex(101n, false, 16);

      await expect(
        stakingRouter.reportStakingModuleStuckValidatorsCountByNodeOperator(
          moduleId,
          NODE_OPERATOR_IDS,
          tooManyValidatorCounts,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "InvalidReportData")
        .withArgs(2n);
    });

    it("Reverts if the number of node operators does not match validator counts", async () => {
      const tooManyValidatorCounts = STUCK_VALIDATOR_COUNTS + bigintToHex(101n, false, 16);

      await expect(
        stakingRouter.reportStakingModuleStuckValidatorsCountByNodeOperator(
          moduleId,
          NODE_OPERATOR_IDS,
          tooManyValidatorCounts,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "InvalidReportData")
        .withArgs(2n);
    });

    it("Reverts if the node operators ids is empty", async () => {
      await expect(stakingRouter.reportStakingModuleStuckValidatorsCountByNodeOperator(moduleId, "0x", "0x"))
        .to.be.revertedWithCustomError(stakingRouter, "InvalidReportData")
        .withArgs(1n);
    });

    it("Updates stuck validators count on the module", async () => {
      await expect(
        stakingRouter.reportStakingModuleStuckValidatorsCountByNodeOperator(
          moduleId,
          NODE_OPERATOR_IDS,
          STUCK_VALIDATOR_COUNTS,
        ),
      )
        .to.emit(stakingModule, "Mock__StuckValidatorsCountUpdated")
        .withArgs(NODE_OPERATOR_IDS, STUCK_VALIDATOR_COUNTS);
    });
  });

  context("onValidatorsCountsByNodeOperatorReportingFinished", () => {
    it("Reverts if the caller does not have the role", async () => {
      await expect(
        stakingRouter.connect(user).onValidatorsCountsByNodeOperatorReportingFinished(),
      ).to.be.revertedWithOZAccessControlError(user.address, await stakingRouter.REPORT_EXITED_VALIDATORS_ROLE());
    });

    it("Calls the hook on the staking module", async () => {
      await expect(stakingRouter.onValidatorsCountsByNodeOperatorReportingFinished()).to.emit(
        stakingModule,
        "Mock__onExitedAndStuckValidatorsCountsUpdated",
      );
    });

    it("Does nothing if there is a mismatch between exited validators count on the module and the router cache", async () => {
      await stakingModule.mock__getStakingModuleSummary(1n, 0n, 0n);

      await expect(stakingRouter.onValidatorsCountsByNodeOperatorReportingFinished()).not.to.emit(
        stakingModule,
        "Mock__onExitedAndStuckValidatorsCountsUpdated",
      );
    });

    it("Emits an event if the module hook fails with a revert data", async () => {
      const shouldRevert = true;
      await stakingModule.mock__onExitedAndStuckValidatorsCountsUpdated(shouldRevert, false);

      // "revert reason" abi-encoded
      const revertReasonEncoded = [
        "0x08c379a0", // string type
        "0000000000000000000000000000000000000000000000000000000000000020",
        "000000000000000000000000000000000000000000000000000000000000000d",
        "72657665727420726561736f6e00000000000000000000000000000000000000",
      ].join("");

      await expect(stakingRouter.onValidatorsCountsByNodeOperatorReportingFinished())
        .to.emit(stakingRouter, "ExitedAndStuckValidatorsCountsUpdateFailed")
        .withArgs(moduleId, revertReasonEncoded);
    });

    it("Reverts if the module hook fails without reason, e.g. ran out of gas", async () => {
      const shouldRunOutOfGas = true;
      await stakingModule.mock__onExitedAndStuckValidatorsCountsUpdated(false, shouldRunOutOfGas);

      await expect(stakingRouter.onValidatorsCountsByNodeOperatorReportingFinished()).to.be.revertedWithCustomError(
        stakingRouter,
        "UnrecoverableModuleError",
      );
    });
  });

  context("decreaseStakingModuleVettedKeysCountByNodeOperator", () => {
    const NODE_OPERATOR_IDS = bigintToHex(1n, true, 8);
    const VETTED_KEYS_COUNTS = bigintToHex(100n, true, 16);

    it("Reverts if the caller does not have the role", async () => {
      await expect(
        stakingRouter
          .connect(user)
          .decreaseStakingModuleVettedKeysCountByNodeOperator(moduleId, NODE_OPERATOR_IDS, VETTED_KEYS_COUNTS),
      ).to.be.revertedWithOZAccessControlError(user.address, await stakingRouter.STAKING_MODULE_UNVETTING_ROLE());
    });

    it("Reverts if the node operators ids are packed incorrectly", async () => {
      const incorrectlyPackedNodeOperatorIds = bufToHex(new Uint8Array([1]), true, 7);

      await expect(
        stakingRouter.decreaseStakingModuleVettedKeysCountByNodeOperator(
          moduleId,
          incorrectlyPackedNodeOperatorIds,
          VETTED_KEYS_COUNTS,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "InvalidReportData")
        .withArgs(3n);
    });

    it("Reverts if the validator counts are packed incorrectly", async () => {
      const incorrectlyPackedValidatorCounts = bufToHex(new Uint8Array([100]), true, 15);

      await expect(
        stakingRouter.decreaseStakingModuleVettedKeysCountByNodeOperator(
          moduleId,
          NODE_OPERATOR_IDS,
          incorrectlyPackedValidatorCounts,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "InvalidReportData")
        .withArgs(3n);
    });

    it("Reverts if the number of node operators does not match validator counts", async () => {
      const tooManyValidatorCounts = VETTED_KEYS_COUNTS + bigintToHex(101n, false, 16);

      await expect(
        stakingRouter.decreaseStakingModuleVettedKeysCountByNodeOperator(
          moduleId,
          NODE_OPERATOR_IDS,
          tooManyValidatorCounts,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "InvalidReportData")
        .withArgs(2n);
    });

    it("Reverts if the number of node operators does not match validator counts", async () => {
      const tooManyValidatorCounts = VETTED_KEYS_COUNTS + bigintToHex(101n, false, 16);

      await expect(
        stakingRouter.decreaseStakingModuleVettedKeysCountByNodeOperator(
          moduleId,
          NODE_OPERATOR_IDS,
          tooManyValidatorCounts,
        ),
      )
        .to.be.revertedWithCustomError(stakingRouter, "InvalidReportData")
        .withArgs(2n);
    });

    it("Reverts if the node operators ids is empty", async () => {
      await expect(stakingRouter.decreaseStakingModuleVettedKeysCountByNodeOperator(moduleId, "0x", "0x"))
        .to.be.revertedWithCustomError(stakingRouter, "InvalidReportData")
        .withArgs(1n);
    });

    it("Updates stuck validators count on the module", async () => {
      await expect(
        stakingRouter.decreaseStakingModuleVettedKeysCountByNodeOperator(
          moduleId,
          NODE_OPERATOR_IDS,
          VETTED_KEYS_COUNTS,
        ),
      )
        .to.emit(stakingModule, "Mock__VettedSigningKeysCountDecreased")
        .withArgs(NODE_OPERATOR_IDS, VETTED_KEYS_COUNTS);
    });
  });

  context("deposit", () => {
    beforeEach(async () => {
      stakingRouter = stakingRouter.connect(lido);
    });

    it("Reverts if the caller is not Lido", async () => {
      await expect(stakingRouter.connect(user).deposit(100n, moduleId, "0x")).to.be.revertedWithCustomError(
        stakingRouter,
        "AppAuthLidoFailed",
      );
    });

    it("Reverts if withdrawal credentials are not set", async () => {
      await stakingRouter.connect(admin).setWithdrawalCredentials(bigintToHex(0n, true, 32));

      await expect(stakingRouter.deposit(100n, moduleId, "0x")).to.be.revertedWithCustomError(
        stakingRouter,
        "EmptyWithdrawalsCredentials",
      );
    });

    it("Reverts if the staking module is not active", async () => {
      await stakingRouter.connect(admin).setStakingModuleStatus(moduleId, Status.DepositsPaused);

      await expect(stakingRouter.deposit(100n, moduleId, "0x")).to.be.revertedWithCustomError(
        stakingRouter,
        "StakingModuleNotActive",
      );
    });

    it("Reverts if ether does correspond to the number of deposits", async () => {
      const deposits = 2n;
      const depositValue = ether("32.0");
      const correctAmount = deposits * depositValue;
      const etherToSend = correctAmount + 1n;

      await expect(
        stakingRouter.deposit(deposits, moduleId, "0x", {
          value: etherToSend,
        }),
      )
        .to.be.revertedWithCustomError(stakingRouter, "InvalidDepositsValue")
        .withArgs(etherToSend, deposits);
    });

    it("Does not submit 0 deposits", async () => {
      await expect(stakingRouter.deposit(0n, moduleId, "0x")).not.to.emit(depositContract, "Deposited__MockEvent");
    });

    it("Reverts if ether does correspond to the number of deposits", async () => {
      const deposits = 2n;
      const depositValue = ether("32.0");
      const correctAmount = deposits * depositValue;

      await expect(
        stakingRouter.deposit(deposits, moduleId, "0x", {
          value: correctAmount,
        }),
      ).to.emit(depositContract, "Deposited__MockEvent");
    });
  });
});

enum Status {
  Active,
  DepositsPaused,
  Stopped,
}
