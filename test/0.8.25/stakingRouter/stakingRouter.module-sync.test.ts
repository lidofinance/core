import { bigintToHex, bufToHex } from "bigint-conversion";
import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracle__MockForLidoFastLane,
  DepositContract__MockForBeaconChainDepositor,
  Lido__MockForStakingRouter,
  LidoLocator,
  StakingModule__MockForStakingRouter,
  StakingRouter__Harness,
} from "typechain-types";
import { ValidatorsCountsCorrectionStruct } from "typechain-types/contracts/0.8.25/sr/StakingRouter";

import {
  ether,
  getNextBlock,
  impersonate,
  randomString,
  randomWCType1,
  StakingModuleStatus,
  wcTypeMaxEB,
  WithdrawalCredentialsType,
} from "lib";

import { deployLidoLocator, deployStakingRouter } from "test/deploy";
import { Snapshot } from "test/suite";

describe("StakingRouter.sol:module-sync", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let dsmSigner: HardhatEthersSigner;

  let stakingRouter: StakingRouter__Harness;
  let stakingModule: StakingModule__MockForStakingRouter;
  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let accountingOracle: AccountingOracle__MockForLidoFastLane;

  let locator: LidoLocator;
  let lidoMock: Lido__MockForStakingRouter;

  let moduleId: bigint;
  let stakingModuleAddress: string;
  let lastDepositAt: bigint;
  let lastDepositBlock: bigint;

  // module params
  const name = "myStakingModule";
  const stakingModuleFee = 5_00n;
  const treasuryFee = 5_00n;
  const stakeShareLimit = 100_00n;
  const priorityExitShareThreshold = 100_00n;
  const maxDepositsPerBlock = 150n;
  const minDepositBlockDistance = 25n;

  const withdrawalCredentials = randomWCType1();
  const topUpGateway = "0x0000000000000000000000000000000000000001";
  const depositSecurityModule = "0x0000000000000000000000000000000000000002";

  let originalState: string;

  before(async () => {
    [deployer, admin, user] = await ethers.getSigners();

    // Deploy Lido mock
    lidoMock = await ethers.deployContract("Lido__MockForStakingRouter", deployer);

    // deploy oracle
    accountingOracle = await ethers.deployContract("AccountingOracle__MockForLidoFastLane", deployer);

    locator = await deployLidoLocator({
      lido: lidoMock,
      topUpGateway,
      depositSecurityModule,
      accountingOracle,
    });

    ({ stakingRouter, depositContract } = await deployStakingRouter(
      { deployer, admin },
      { lidoLocator: locator, lido: lidoMock },
    ));

    // initialize staking router with Lido mock
    await stakingRouter.initialize(admin, withdrawalCredentials);

    // Set staking router address on Lido mock so it can send ETH
    await lidoMock.setStakingRouter(await stakingRouter.getAddress());

    // Get DSM signer for deposit tests
    dsmSigner = await impersonate(depositSecurityModule, ether("10.0"));

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
    stakingModule = await ethers.deployContract("StakingModule__MockForStakingRouter", deployer);
    stakingModuleAddress = await stakingModule.getAddress();
    const { timestamp, number } = await getNextBlock();
    lastDepositAt = timestamp;
    lastDepositBlock = number;

    const stakingModuleConfig = {
      stakeShareLimit,
      priorityExitShareThreshold,
      stakingModuleFee,
      treasuryFee,
      maxDepositsPerBlock,
      minDepositBlockDistance,
      withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
    };

    await stakingRouter.addStakingModule(name, stakingModuleAddress, stakingModuleConfig);

    moduleId = await stakingRouter.getStakingModulesCount();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

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
      number,
    ];

    // module mock state
    const exitedValidators = 100n;
    const depositedValidators = 1000n;
    const depositableValidators = 200n;
    const stakingModuleSummary: Parameters<StakingModule__MockForStakingRouter["mock__getStakingModuleSummary"]> = [
      exitedValidators, // exitedValidators
      depositedValidators, // depositedValidators
      depositableValidators, // depositableValidators
    ];

    const balance = _getBalanceByValidatorsCount(
      WithdrawalCredentialsType.WC0x01,
      depositedValidators - exitedValidators,
    );
    const stakingModuleAccounting: Parameters<StakingRouter__Harness["testing_setStakingModuleAccounting"]> = [
      0n, // moduleId
      balance, // effectiveBalanceGwei
      balance, // pendingBalanceGwei
      exitedValidators, // exitedValidators
    ];

    const nodeOperatorSummary: Parameters<StakingModule__MockForStakingRouter["mock__getNodeOperatorSummary"]> = [
      0, // targetLimitMode
      0n, // targetValidatorsCount
      0n, // stuckValidatorsCount
      0n, // refundedValidatorsCount
      0n, // stuckPenaltyEndTimestamp
      exitedValidators, // totalExitedValidators
      depositedValidators, // totalDepositedValidators
      depositableValidators, // depositableValidatorsCount
    ];

    const nodeOperatorsCounts: Parameters<StakingModule__MockForStakingRouter["mock__nodeOperatorsCount"]> = [
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
        StakingModuleStatus.Active,
        name,
        lastDepositAt,
        lastDepositBlock,
        exitedValidators,
        priorityExitShareThreshold,
        maxDepositsPerBlock,
        minDepositBlockDistance,
        WithdrawalCredentialsType.WC0x01,
      ];

      // mocking module state
      await stakingModule.mock__getStakingModuleSummary(...stakingModuleSummary);
      stakingModuleAccounting[0] = moduleId;
      await stakingRouter.testing_setStakingModuleAccounting(...stakingModuleAccounting);
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
        const [exited, deposited] = stakingModuleSummary;

        expect(await stakingRouter.getStakingModuleActiveValidatorsCount(moduleId)).to.equal(
          Number(deposited) - Number(exited),
        );
      });
    });
  });

  context("setWithdrawalCredentials", () => {
    it("Reverts if the caller does not have the role", async () => {
      await expect(stakingRouter.connect(user).setWithdrawalCredentials(randomWCType1()))
        .to.be.revertedWithCustomError(stakingRouter, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, await stakingRouter.MANAGE_WITHDRAWAL_CREDENTIALS_ROLE());
    });

    it("Reverts if withdrawal credentials are empty", async () => {
      await expect(
        stakingRouter.connect(admin).setWithdrawalCredentials(bigintToHex(0n, true, 32)),
      ).to.be.revertedWithCustomError(stakingRouter, "ZeroAddress");
    });

    it("Set new withdrawal credentials and informs modules", async () => {
      const newWithdrawalCredentials = randomWCType1();

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

      await expect(stakingRouter.setWithdrawalCredentials(randomWCType1()))
        .to.emit(stakingRouter, "WithdrawalsCredentialsChangeFailed")
        .withArgs(moduleId, revertReasonEncoded);
    });

    it("Reverts if the module hook fails without reason, e.g. ran out of gas", async () => {
      const shouldRunOutOfGas = true;
      await stakingModule.mock__onWithdrawalCredentialsChanged(false, shouldRunOutOfGas);

      await expect(stakingRouter.setWithdrawalCredentials(randomWCType1())).to.be.revertedWithCustomError(
        stakingRouter,
        "UnrecoverableModuleError",
      );
    });
  });

  context("updateTargetValidatorsLimits", () => {
    const NODE_OPERATOR_ID = 0n;
    const TARGET_LIMIT_MODE = 1; // 1 - soft, i.e. on WQ request; 2 - boosted
    const TARGET_LIMIT = 100n;

    it("Reverts if the caller does not have the role", async () => {
      await expect(
        stakingRouter
          .connect(user)
          .updateTargetValidatorsLimits(moduleId, NODE_OPERATOR_ID, TARGET_LIMIT_MODE, TARGET_LIMIT),
      )
        .to.be.revertedWithCustomError(stakingRouter, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, await stakingRouter.STAKING_MODULE_MANAGE_ROLE());
    });

    it("Redirects the call to the staking module", async () => {
      await expect(
        stakingRouter.updateTargetValidatorsLimits(moduleId, NODE_OPERATOR_ID, TARGET_LIMIT_MODE, TARGET_LIMIT),
      )
        .to.emit(stakingModule, "Mock__TargetValidatorsLimitsUpdated")
        .withArgs(NODE_OPERATOR_ID, TARGET_LIMIT_MODE, TARGET_LIMIT);
    });
  });

  context("reportRewardsMinted", () => {
    it("Reverts if the caller does not have the role", async () => {
      await expect(stakingRouter.connect(user).reportRewardsMinted([moduleId], [0n]))
        .to.be.revertedWithCustomError(stakingRouter, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, await stakingRouter.REPORT_REWARDS_MINTED_ROLE());
    });

    it("Reverts if the arrays have different lengths", async () => {
      await expect(stakingRouter.reportRewardsMinted([moduleId], [0n, 1n])).to.be.revertedWithCustomError(
        stakingRouter,
        "ArraysLengthMismatch",
      );
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
      await expect(stakingRouter.connect(user).updateExitedValidatorsCountByStakingModule([moduleId], [0n]))
        .to.be.revertedWithCustomError(stakingRouter, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, await stakingRouter.REPORT_EXITED_VALIDATORS_ROLE());
    });

    it("Reverts if the array lengths are different", async () => {
      await expect(
        stakingRouter.updateExitedValidatorsCountByStakingModule([moduleId], [0n, 1n]),
      ).to.be.revertedWithCustomError(stakingRouter, "ArraysLengthMismatch");
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
      )
        .to.be.revertedWithCustomError(stakingRouter, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, await stakingRouter.REPORT_EXITED_VALIDATORS_ROLE());
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
      targetLimitMode: 0,
      targetValidatorsCount: 0n,
      stuckValidatorsCount: 0n,
      refundedValidatorsCount: 0n,
      stuckPenaltyEndTimestamp: 0n,
      totalExitedValidators: 3n,
      totalDepositedValidators: 5n,
      depositableValidatorsCount: 1n,
    };

    const correction: ValidatorsCountsCorrectionStruct = {
      currentModuleExitedValidatorsCount: moduleSummary.totalExitedValidators,
      currentNodeOperatorExitedValidatorsCount: operatorSummary.totalExitedValidators,
      newModuleExitedValidatorsCount: moduleSummary.totalExitedValidators,
      newNodeOperatorExitedValidatorsCount: operatorSummary.totalExitedValidators + 1n,
    };

    beforeEach(async () => {
      await stakingModule.mock__getStakingModuleSummary(
        moduleSummary.totalExitedValidators,
        moduleSummary.totalDepositedValidators,
        moduleSummary.depositableValidatorsCount,
      );
      const balance = _getBalanceByValidatorsCount(
        WithdrawalCredentialsType.WC0x01,
        moduleSummary.totalDepositedValidators - moduleSummary.totalExitedValidators,
      );
      await stakingRouter.testing_setStakingModuleAccounting(
        moduleId,
        balance,
        balance,
        moduleSummary.totalExitedValidators,
      );

      const nodeOperatorSummary: Parameters<StakingModule__MockForStakingRouter["mock__getNodeOperatorSummary"]> = [
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
      )
        .to.be.revertedWithCustomError(stakingRouter, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, await stakingRouter.UNSAFE_SET_EXITED_VALIDATORS_ROLE());
    });

    it("Reverts if the number of exited validators in the module does not match what is stored on the contract", async () => {
      await expect(
        stakingRouter.unsafeSetExitedValidatorsCount(moduleId, nodeOperatorId, true, {
          ...correction,
          currentModuleExitedValidatorsCount: 1n,
        }),
      )
        .to.be.revertedWithCustomError(stakingRouter, "UnexpectedCurrentValidatorsCount")
        .withArgs(correction.currentModuleExitedValidatorsCount, correction.currentNodeOperatorExitedValidatorsCount);
    });

    it("Reverts if the number of exited validators of the operator does not match what is stored on the contract", async () => {
      await expect(
        stakingRouter.unsafeSetExitedValidatorsCount(moduleId, nodeOperatorId, true, {
          ...correction,
          currentNodeOperatorExitedValidatorsCount: 1n,
        }),
      )
        .to.be.revertedWithCustomError(stakingRouter, "UnexpectedCurrentValidatorsCount")
        .withArgs(correction.currentModuleExitedValidatorsCount, correction.currentNodeOperatorExitedValidatorsCount);
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
        .withArgs(moduleId, correction.newNodeOperatorExitedValidatorsCount)
        .and.to.emit(stakingModule, "Mock__onExitedAndStuckValidatorsCountsUpdated");
    });

    it("Update unsafely the number of exited validators on the staking module", async () => {
      const triggerHook = false;

      await expect(
        stakingRouter.unsafeSetExitedValidatorsCount(moduleId, nodeOperatorId, triggerHook, correction),
      ).not.to.emit(stakingModule, "Mock__onExitedAndStuckValidatorsCountsUpdated");
    });
  });

  context("onValidatorsCountsByNodeOperatorReportingFinished", () => {
    it("Reverts if the caller does not have the role", async () => {
      await expect(stakingRouter.connect(user).onValidatorsCountsByNodeOperatorReportingFinished())
        .to.be.revertedWithCustomError(stakingRouter, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, await stakingRouter.REPORT_EXITED_VALIDATORS_ROLE());
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
      )
        .to.be.revertedWithCustomError(stakingRouter, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, await stakingRouter.STAKING_MODULE_UNVETTING_ROLE());
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
      // Set up Lido mock with depositable ether and fund it
      const depositableAmount = ether("320.0"); // Enough for 10 deposits
      await lidoMock.setDepositableEther(depositableAmount);
      await lidoMock.fund({ value: depositableAmount });

      // Set up staking module with depositable validators
      await stakingModule.mock__getStakingModuleSummary(0n, 100n, 10n); // 10 depositable validators
      const balance = _getBalanceByValidatorsCount(
        WithdrawalCredentialsType.WC0x01,
        100n, // active validators
      );
      await stakingRouter.testing_setStakingModuleAccounting(moduleId, balance, balance, 0);
    });

    it("Reverts if the caller is not DSM", async () => {
      await expect(stakingRouter.connect(user).deposit(moduleId, "0x")).to.be.revertedWithCustomError(
        stakingRouter,
        "NotAuthorized",
      );
    });

    it("Reverts if the staking module is not active", async () => {
      await stakingRouter.connect(admin).setStakingModuleStatus(moduleId, StakingModuleStatus.DepositsPaused);

      await expect(stakingRouter.connect(dsmSigner).deposit(moduleId, "0x")).to.be.revertedWithCustomError(
        stakingRouter,
        "CannotDeposit",
      );
    });

    it("Revert when 0 deposits", async () => {
      // Set depositable ether to 0
      await lidoMock.setDepositableEther(0n);
      await expect(stakingRouter.connect(dsmSigner).deposit(moduleId, "0x")).to.be.revertedWithCustomError(
        stakingRouter,
        "ZeroDeposits",
      );
    });

    it("Successfully deposits when depositable ether is available", async () => {
      await expect(stakingRouter.connect(dsmSigner).deposit(moduleId, "0x")).to.emit(
        depositContract,
        "Deposited__MockEvent",
      );
    });

    it("Successfully deposits for module type 0x02 (New)", async () => {
      const stakingRouterAsAdmin = stakingRouter.connect(admin);

      const newStakingModule = await ethers.deployContract("StakingModule__MockForStakingRouter", deployer);
      const newStakingModuleAddress = await newStakingModule.getAddress();
      const withdrawalCredentialsType = WithdrawalCredentialsType.WC0x02;
      const stakingModuleConfigNew = {
        stakeShareLimit,
        priorityExitShareThreshold,
        stakingModuleFee,
        treasuryFee,
        maxDepositsPerBlock,
        minDepositBlockDistance,
        withdrawalCredentialsType,
      };

      await stakingRouterAsAdmin.addStakingModule(`${name}-new`, newStakingModuleAddress, stakingModuleConfigNew);

      const newModuleId = await stakingRouter.getStakingModulesCount();

      // Set up the new module with depositable validators
      const exitedValidators = 0n;
      const depositedValidators = 0n;
      const depositableValidators = 10n;
      await newStakingModule.mock__getStakingModuleSummary(
        exitedValidators,
        depositedValidators,
        depositableValidators,
      ); // 10 depositable validators
      const validatorsBalanceGwei = _getBalanceByValidatorsCount(withdrawalCredentialsType, depositedValidators);
      await stakingRouter.testing_setStakingModuleAccounting(newModuleId, validatorsBalanceGwei, 0n, exitedValidators);

      await expect(stakingRouter.connect(dsmSigner).deposit(newModuleId, "0x")).to.emit(
        depositContract,
        "Deposited__MockEvent",
      );
    });

    it("Reverts if module returns pubkeys with invalid length (not divisible by 48)", async () => {
      // Mock the module to return pubkeys with invalid length (47 bytes instead of 48)
      const invalidPubkeys = randomString(47); // Not divisible by PUBKEY_LENGTH (48)
      const signatures = randomString(96); // Valid signature length

      await stakingModule.mock__obtainDepositData(invalidPubkeys, signatures);

      await expect(stakingRouter.connect(dsmSigner).deposit(moduleId, "0x")).to.be.revertedWithCustomError(
        stakingRouter,
        "WrongPubkeyLength",
      );
    });
  });
});

function _getBalanceByValidatorsCount(wcType: WithdrawalCredentialsType, validatorsCount: bigint): bigint {
  return (validatorsCount * wcTypeMaxEB(wcType)) / 1_000_000_000n; // in gwei
}
