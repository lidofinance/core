import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import type { TopUpGateway__Harness } from "typechain-types";
import { Lido__MockForTopUpGateway, LidoLocator, StakingRouter__MockForTopUpGateway } from "typechain-types";

import { proxify } from "lib/proxy";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("TopUpGateway.sol", () => {
  let admin: HardhatEthersSigner;
  let topUpOperator: HardhatEthersSigner;
  let limitsManager: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let lido: Lido__MockForTopUpGateway;
  let locator: LidoLocator;
  let stakingRouter: StakingRouter__MockForTopUpGateway;
  let topUpGateway: TopUpGateway__Harness;

  let snapshot: string;
  let topUpRole: string;
  let manageLimitsRole: string;

  const MODULE_ID = 1n;
  const FAR_FUTURE_EPOCH = (1n << 64n) - 1n;
  const SAMPLE_PUBKEY = `0x${"11".repeat(48)}`;
  const DEFAULT_MAX_VALIDATORS = 5n;
  const DEFAULT_MIN_BLOCK_DISTANCE = 1n;
  const DEFAULT_MAX_ROOT_AGE = 300n;
  const G_INDEX = ethers.zeroPadValue("0x01", 32);
  const ZERO_BYTES_31 = "00".repeat(31);
  const WC_TYPE_02 = `0x02${ZERO_BYTES_31}`;
  const WC_TYPE_01 = `0x01${ZERO_BYTES_31}`;
  // Mainnet-like values: targetBalance = 2046.75 ETH, minTopUp = 1 ETH
  const DEFAULT_TARGET_BALANCE_GWEI = 204675n * 10n ** 7n; // 2046.75 ETH in Gwei
  const DEFAULT_MIN_TOP_UP_GWEI = 1n * 10n ** 9n; // 1 ETH in Gwei
  const SLOTS_PER_EPOCH = 32n;

  type TopUpData = {
    moduleId: bigint;
    keyIndices: bigint[];
    operatorIds: bigint[];
    validatorIndices: bigint[];
    beaconRootData: {
      childBlockTimestamp: bigint;
      slot: bigint;
      proposerIndex: bigint;
    };
    validatorWitness: Array<{
      proofValidator: string[];
      pubkey: string;
      effectiveBalance: bigint;
      slashed: boolean;
      activationEligibilityEpoch: bigint;
      activationEpoch: bigint;
      exitEpoch: bigint;
      withdrawableEpoch: bigint;
    }>;
    pendingBalanceGwei: bigint[];
  };

  beforeEach(async () => {
    [admin, topUpOperator, limitsManager, stranger] = await ethers.getSigners();
    snapshot = await Snapshot.take();
    lido = await ethers.deployContract("Lido__MockForTopUpGateway");
    stakingRouter = await ethers.deployContract("StakingRouter__MockForTopUpGateway");
    locator = await deployLidoLocator({
      stakingRouter: await stakingRouter.getAddress(),
      lido: await lido.getAddress(),
    });

    const impl = await ethers.deployContract("TopUpGateway__Harness", [
      await locator.getAddress(),
      G_INDEX,
      G_INDEX,
      0,
      SLOTS_PER_EPOCH,
    ]);

    [topUpGateway] = await proxify<TopUpGateway__Harness>({ impl, admin });

    await topUpGateway.initialize(
      admin.address,
      DEFAULT_MAX_VALIDATORS,
      DEFAULT_MIN_BLOCK_DISTANCE,
      DEFAULT_MAX_ROOT_AGE,
      DEFAULT_TARGET_BALANCE_GWEI,
      DEFAULT_MIN_TOP_UP_GWEI,
    );

    topUpRole = await topUpGateway.TOP_UP_ROLE();
    manageLimitsRole = await topUpGateway.MANAGE_LIMITS_ROLE();
    await topUpGateway.grantRole(topUpRole, topUpOperator.address);
    await topUpGateway.grantRole(manageLimitsRole, limitsManager.address);
    await stakingRouter.setWithdrawalCredentials(MODULE_ID, WC_TYPE_02);
  });

  afterEach(async () => {
    await Snapshot.restore(snapshot);
  });

  const buildTopUpData = async (): Promise<TopUpData> => {
    const timestamp = BigInt(await time.latest());

    return {
      moduleId: MODULE_ID,
      keyIndices: [1n],
      operatorIds: [1n],
      validatorIndices: [1n],
      beaconRootData: {
        childBlockTimestamp: timestamp,
        slot: 123n,
        proposerIndex: 1n,
      },
      validatorWitness: [
        {
          proofValidator: [],
          pubkey: SAMPLE_PUBKEY,
          effectiveBalance: 32n * 10n ** 9n,
          slashed: false,
          activationEligibilityEpoch: 0n,
          activationEpoch: 0n,
          exitEpoch: FAR_FUTURE_EPOCH,
          withdrawableEpoch: FAR_FUTURE_EPOCH,
        },
      ],
      pendingBalanceGwei: [0n],
    };
  };

  describe("initialize", () => {
    it("initializes config and roles", async () => {
      expect(await topUpGateway.getMaxValidatorsPerTopUp()).to.equal(DEFAULT_MAX_VALIDATORS);
      expect(await topUpGateway.getMinBlockDistance()).to.equal(DEFAULT_MIN_BLOCK_DISTANCE);
      expect(await topUpGateway.getLastTopUpTimestamp()).to.equal(0n);
      expect(await topUpGateway.hasRole(await topUpGateway.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
      expect(await topUpGateway.hasRole(topUpRole, admin.address)).to.be.false;
      expect(await topUpGateway.harness_getLocator()).to.equal(await locator.getAddress());
    });

    it("reverts on double initialization", async () => {
      await expect(
        topUpGateway.initialize(
          admin.address,
          DEFAULT_MAX_VALIDATORS,
          DEFAULT_MIN_BLOCK_DISTANCE,
          DEFAULT_MAX_ROOT_AGE,
          DEFAULT_TARGET_BALANCE_GWEI,
          DEFAULT_MIN_TOP_UP_GWEI,
        ),
      ).to.be.revertedWithCustomError(topUpGateway, "InvalidInitialization");
    });

    it("reverts when maxValidatorsPerTopUp is zero", async () => {
      const impl = await ethers.deployContract("TopUpGateway__Harness", [
        await locator.getAddress(),
        G_INDEX,
        G_INDEX,
        0,
        SLOTS_PER_EPOCH,
      ]);
      const [gateway] = await proxify<TopUpGateway__Harness>({ impl, admin });
      await expect(
        gateway.initialize(
          admin.address,
          0n,
          DEFAULT_MIN_BLOCK_DISTANCE,
          DEFAULT_MAX_ROOT_AGE,
          DEFAULT_TARGET_BALANCE_GWEI,
          DEFAULT_MIN_TOP_UP_GWEI,
        ),
      ).to.be.revertedWithCustomError(gateway, "ZeroValue");
    });

    it("reverts when minBlockDistance is zero", async () => {
      const impl = await ethers.deployContract("TopUpGateway__Harness", [
        await locator.getAddress(),
        G_INDEX,
        G_INDEX,
        0,
        SLOTS_PER_EPOCH,
      ]);
      const [gateway] = await proxify<TopUpGateway__Harness>({ impl, admin });
      await expect(
        gateway.initialize(
          admin.address,
          DEFAULT_MAX_VALIDATORS,
          0n,
          DEFAULT_MAX_ROOT_AGE,
          DEFAULT_TARGET_BALANCE_GWEI,
          DEFAULT_MIN_TOP_UP_GWEI,
        ),
      ).to.be.revertedWithCustomError(gateway, "ZeroValue");
    });

    it("reverts when admin is zero address", async () => {
      const impl = await ethers.deployContract("TopUpGateway__Harness", [
        await locator.getAddress(),
        G_INDEX,
        G_INDEX,
        0,
        SLOTS_PER_EPOCH,
      ]);
      const [gateway] = await proxify<TopUpGateway__Harness>({ impl, admin });
      await expect(
        gateway.initialize(
          ethers.ZeroAddress,
          DEFAULT_MAX_VALIDATORS,
          DEFAULT_MIN_BLOCK_DISTANCE,
          DEFAULT_MAX_ROOT_AGE,
          DEFAULT_TARGET_BALANCE_GWEI,
          DEFAULT_MIN_TOP_UP_GWEI,
        ),
      )
        .to.be.revertedWithCustomError(gateway, "ZeroArgument")
        .withArgs("_admin");
    });

    it("reverts when lidoLocator is zero address (constructor)", async () => {
      await expect(
        ethers.deployContract("TopUpGateway__Harness", [ethers.ZeroAddress, G_INDEX, G_INDEX, 0, SLOTS_PER_EPOCH]),
      )
        .to.be.revertedWithCustomError(await ethers.getContractFactory("TopUpGateway__Harness"), "ZeroArgument")
        .withArgs("_lidoLocator");
    });

    it("reverts when calling initialize on the implementation directly", async () => {
      const impl = await ethers.deployContract("TopUpGateway__Harness", [
        await locator.getAddress(),
        G_INDEX,
        G_INDEX,
        0,
        SLOTS_PER_EPOCH,
      ]);
      await expect(
        impl.initialize(
          admin.address,
          DEFAULT_MAX_VALIDATORS,
          DEFAULT_MIN_BLOCK_DISTANCE,
          DEFAULT_MAX_ROOT_AGE,
          DEFAULT_TARGET_BALANCE_GWEI,
          DEFAULT_MIN_TOP_UP_GWEI,
        ),
      ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });
  });

  describe("limits management", () => {
    it("allows manage limits role to set the max validators per top up", async () => {
      const newLimit = DEFAULT_MAX_VALIDATORS + 1n;
      await expect(topUpGateway.connect(limitsManager).setMaxValidatorsPerTopUp(newLimit))
        .to.emit(topUpGateway, "MaxValidatorsPerTopUpChanged")
        .withArgs(newLimit);
      expect(await topUpGateway.getMaxValidatorsPerTopUp()).to.equal(newLimit);
    });

    it("reverts when non-manager tries to set the max validators per top up", async () => {
      await expect(topUpGateway.connect(stranger).setMaxValidatorsPerTopUp(DEFAULT_MAX_VALIDATORS + 1n))
        .to.be.revertedWithCustomError(topUpGateway, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, manageLimitsRole);
    });

    it("allows manage limits role to set the min block distance", async () => {
      const newDistance = DEFAULT_MIN_BLOCK_DISTANCE + 10n;
      await expect(topUpGateway.connect(limitsManager).setMinBlockDistance(newDistance))
        .to.emit(topUpGateway, "MinBlockDistanceChanged")
        .withArgs(newDistance);
      expect(await topUpGateway.getMinBlockDistance()).to.equal(newDistance);
    });

    it("reverts when non-manager tries to set the min block distance", async () => {
      await expect(topUpGateway.connect(stranger).setMinBlockDistance(DEFAULT_MIN_BLOCK_DISTANCE + 10n))
        .to.be.revertedWithCustomError(topUpGateway, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, manageLimitsRole);
    });

    it("allows manage limits role to set top-up balance limits", async () => {
      const newTarget = DEFAULT_TARGET_BALANCE_GWEI + 10n ** 9n;
      const newMinTopUp = DEFAULT_MIN_TOP_UP_GWEI + 10n ** 8n;
      await expect(topUpGateway.connect(limitsManager).setTopUpBalanceLimits(newTarget, newMinTopUp))
        .to.emit(topUpGateway, "TopUpBalanceLimitsChanged")
        .withArgs(newTarget, newMinTopUp);
      expect(await topUpGateway.getTargetBalanceGwei()).to.equal(newTarget);
      expect(await topUpGateway.getMinTopUpGwei()).to.equal(newMinTopUp);
    });

    it("reverts when non-manager tries to set top-up balance limits", async () => {
      await expect(
        topUpGateway.connect(stranger).setTopUpBalanceLimits(DEFAULT_TARGET_BALANCE_GWEI, DEFAULT_MIN_TOP_UP_GWEI),
      )
        .to.be.revertedWithCustomError(topUpGateway, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, manageLimitsRole);
    });

    it("reverts when minTopUp exceeds targetBalance", async () => {
      await expect(topUpGateway.connect(limitsManager).setTopUpBalanceLimits(100n, 200n)).to.be.revertedWithCustomError(
        topUpGateway,
        "MinTopUpExceedsTarget",
      );
    });
  });

  describe("topUp", () => {
    it("reverts when caller lacks the role", async () => {
      const data = await buildTopUpData();
      await expect(topUpGateway.connect(stranger).topUp(data))
        .to.be.revertedWithCustomError(topUpGateway, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, topUpRole);
    });

    it("reverts when validator list is empty", async () => {
      const data = await buildTopUpData();
      data.validatorIndices = [];
      data.keyIndices = [];
      data.operatorIds = [];
      data.validatorWitness = [];

      await expect(topUpGateway.connect(topUpOperator).topUp(data)).to.be.revertedWithCustomError(
        topUpGateway,
        "WrongArrayLength",
      );
    });

    it("reverts when array lengths mismatch", async () => {
      const data = await buildTopUpData();
      data.keyIndices = [1n, 2n];
      await expect(topUpGateway.connect(topUpOperator).topUp(data)).to.be.revertedWithCustomError(
        topUpGateway,
        "WrongArrayLength",
      );
    });

    it("reverts when validators count exceeds the limit", async () => {
      await topUpGateway.connect(limitsManager).setMaxValidatorsPerTopUp(1n);
      const data = await buildTopUpData();
      data.validatorIndices = [1n, 2n];
      data.keyIndices = [1n, 2n];
      data.operatorIds = [1n, 2n];
      const secondPubkey = `0x${"22".repeat(48)}`;
      data.validatorWitness = [
        data.validatorWitness[0],
        {
          ...data.validatorWitness[0],
          pubkey: secondPubkey,
        },
      ];
      data.pendingBalanceGwei = [0n, 0n];

      await expect(topUpGateway.connect(topUpOperator).topUp(data)).to.be.revertedWithCustomError(
        topUpGateway,
        "MaxValidatorsPerTopUpExceeded",
      );
    });
    it("reverts when validatorIndices contain duplicates", async () => {
      const data = await buildTopUpData();
      data.validatorIndices = [1n, 1n];
      data.keyIndices = [1n, 1n];
      data.operatorIds = [1n, 1n];
      const secondPubkey = `0x${"22".repeat(48)}`;
      data.validatorWitness = [
        data.validatorWitness[0],
        {
          ...data.validatorWitness[0],
          pubkey: secondPubkey,
        },
      ];
      data.pendingBalanceGwei = [0n, 0n];

      await expect(topUpGateway.connect(topUpOperator).topUp(data)).to.be.revertedWithCustomError(
        topUpGateway,
        "InvalidValidatorIndicesSortOrder",
      );
    });

    it("reverts when beacon data is too old", async () => {
      await time.increase(400);
      const now = BigInt(await time.latest());
      const data = await buildTopUpData();
      data.beaconRootData.childBlockTimestamp = now - 400n;

      await expect(topUpGateway.connect(topUpOperator).topUp(data)).to.be.revertedWithCustomError(
        topUpGateway,
        "RootIsTooOld",
      );
    });

    it("reverts when root precedes last top up", async () => {
      const timestamp = BigInt(await time.latest());
      await topUpGateway.harness_setLastTopUpTimestamp(timestamp);
      const data = await buildTopUpData();
      data.beaconRootData.childBlockTimestamp = timestamp;

      await expect(topUpGateway.connect(topUpOperator).topUp(data)).to.be.revertedWithCustomError(
        topUpGateway,
        "RootPrecedesLastTopUp",
      );
    });

    it("reverts when withdrawal credentials type is not 0x02", async () => {
      await stakingRouter.setWithdrawalCredentials(MODULE_ID, WC_TYPE_01);
      const data = await buildTopUpData();

      await expect(topUpGateway.connect(topUpOperator).topUp(data)).to.be.revertedWithCustomError(
        topUpGateway,
        "WrongWithdrawalCredentials",
      );
    });

    it("reverts when block distance is not met", async () => {
      // Set a large min block distance so we can test the revert
      await topUpGateway.connect(limitsManager).setMinBlockDistance(100n);

      // First successful top-up sets lastTopUpBlock
      const data = await buildTopUpData();
      await topUpGateway.connect(topUpOperator).topUp(data);

      // Immediately try again - should fail since we haven't mined enough blocks
      const data2 = await buildTopUpData();
      data2.beaconRootData.slot = data.beaconRootData.slot + 1n;

      await expect(topUpGateway.connect(topUpOperator).topUp(data2)).to.be.revertedWithCustomError(
        topUpGateway,
        "MinBlockDistanceNotMet",
      );
    });

    it("returns zero top-up limit when balance exceeds target", async () => {
      const data = await buildTopUpData();
      data.validatorWitness[0].effectiveBalance = DEFAULT_TARGET_BALANCE_GWEI - DEFAULT_MIN_TOP_UP_GWEI + 1n;
      data.pendingBalanceGwei = [0n];

      await expect(topUpGateway.connect(topUpOperator).topUp(data))
        .to.emit(stakingRouter, "TopUpCalled")
        .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, [SAMPLE_PUBKEY], [0n]);
    });

    it("reverts when pubkey length is invalid", async () => {
      const data = await buildTopUpData();
      data.validatorWitness[0].pubkey = "0x1234";

      await expect(topUpGateway.connect(topUpOperator).topUp(data)).to.be.revertedWithCustomError(
        topUpGateway,
        "WrongPubkeyLength",
      );
    });

    it("calls StakingRouter.topUp and updates last timestamp", async () => {
      const data = await buildTopUpData();
      data.pendingBalanceGwei = [0n];
      // topUp = targetBalance - currentTotal
      const expectedTopUpGwei = DEFAULT_TARGET_BALANCE_GWEI - data.validatorWitness[0].effectiveBalance;
      const expectedTopUpWei = expectedTopUpGwei * 1_000_000_000n;

      await expect(topUpGateway.connect(topUpOperator).topUp(data))
        .to.emit(stakingRouter, "TopUpCalled")
        .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, [SAMPLE_PUBKEY], [expectedTopUpWei])
        .and.to.emit(topUpGateway, "LastTopUpChanged");

      const lastTimestamp = await topUpGateway.getLastTopUpTimestamp();
      expect(lastTimestamp).to.be.gt(0n);
      expect(await stakingRouter.topUpCalls()).to.equal(1n);
    });

    it("reduces top-up limit by pending deposit amount", async () => {
      const data = await buildTopUpData();
      const pendingAmount = 100n * 10n ** 9n;
      data.pendingBalanceGwei = [pendingAmount]; // 100 Gwei

      const expectedTopUpGwei = DEFAULT_TARGET_BALANCE_GWEI - data.validatorWitness[0].effectiveBalance - pendingAmount;
      // topUpLimits are now in wei
      const expectedTopUpWei = expectedTopUpGwei * 1_000_000_000n;

      await expect(topUpGateway.connect(topUpOperator).topUp(data))
        .to.emit(stakingRouter, "TopUpCalled")
        .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, [SAMPLE_PUBKEY], [expectedTopUpWei]);
    });

    it("returns zero when topUp < minTopUp (balance + pending just below target)", async () => {
      const data = await buildTopUpData();
      // Set balance so that topUp = targetBalance - currentTotal < minTopUp
      // targetBalance = 2046.75 ETH, minTopUp = 1 ETH → threshold = 2045.75 ETH
      data.validatorWitness[0].effectiveBalance = DEFAULT_TARGET_BALANCE_GWEI - DEFAULT_MIN_TOP_UP_GWEI + 1n;
      data.pendingBalanceGwei = [0n];

      await expect(topUpGateway.connect(topUpOperator).topUp(data))
        .to.emit(stakingRouter, "TopUpCalled")
        .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, [SAMPLE_PUBKEY], [0n]);
    });

    it("returns zero when balance + pending exactly equals target", async () => {
      const data = await buildTopUpData();
      data.validatorWitness[0].effectiveBalance = 2045n * 10n ** 9n;
      data.pendingBalanceGwei[0] = DEFAULT_TARGET_BALANCE_GWEI - data.validatorWitness[0].effectiveBalance;

      await expect(topUpGateway.connect(topUpOperator).topUp(data))
        .to.emit(stakingRouter, "TopUpCalled")
        .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, [SAMPLE_PUBKEY], [0n]);
    });

    it("returns exactly minTopUp when balance is at threshold", async () => {
      const data = await buildTopUpData();
      // Set balance so topUp = exactly minTopUp (= 1 ETH)
      data.validatorWitness[0].effectiveBalance = DEFAULT_TARGET_BALANCE_GWEI - DEFAULT_MIN_TOP_UP_GWEI;
      data.pendingBalanceGwei = [0n];

      const expectedTopUpWei = DEFAULT_MIN_TOP_UP_GWEI * 1_000_000_000n;
      await expect(topUpGateway.connect(topUpOperator).topUp(data))
        .to.emit(stakingRouter, "TopUpCalled")
        .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, [SAMPLE_PUBKEY], [expectedTopUpWei]);
    });

    it("returns zero when validator is slashed", async () => {
      const data = await buildTopUpData();
      data.validatorWitness[0].slashed = true;

      await expect(topUpGateway.connect(topUpOperator).topUp(data))
        .to.emit(stakingRouter, "TopUpCalled")
        .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, [SAMPLE_PUBKEY], [0n]);
    });

    it("returns zero when validator has exitEpoch set", async () => {
      const data = await buildTopUpData();
      data.validatorWitness[0].exitEpoch = 1000n; // not FAR_FUTURE_EPOCH

      await expect(topUpGateway.connect(topUpOperator).topUp(data))
        .to.emit(stakingRouter, "TopUpCalled")
        .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, [SAMPLE_PUBKEY], [0n]);
    });

    it("returns zero when validator has withdrawableEpoch set", async () => {
      const data = await buildTopUpData();
      data.validatorWitness[0].withdrawableEpoch = 2000n; // not FAR_FUTURE_EPOCH

      await expect(topUpGateway.connect(topUpOperator).topUp(data))
        .to.emit(stakingRouter, "TopUpCalled")
        .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, [SAMPLE_PUBKEY], [0n]);
    });

    it("revert if validator is not active", async () => {
      const data = await buildTopUpData();
      const epoch = data.beaconRootData.slot / SLOTS_PER_EPOCH;
      // Validator should be activated earlier than current epoch
      data.validatorWitness[0].activationEpoch = epoch + 1n;

      await expect(topUpGateway.connect(topUpOperator).topUp(data)).to.be.revertedWithCustomError(
        topUpGateway,
        "ValidatorIsNotActivated",
      );
    });
  });

  describe("role management", () => {
    it("DEFAULT_ADMIN_ROLE can grant roles", async () => {
      expect(await topUpGateway.hasRole(topUpRole, stranger.address)).to.be.false;
      await topUpGateway.connect(admin).grantRole(topUpRole, stranger.address);
      expect(await topUpGateway.hasRole(topUpRole, stranger.address)).to.be.true;
    });

    it("DEFAULT_ADMIN_ROLE can revoke roles", async () => {
      await topUpGateway.connect(admin).grantRole(topUpRole, stranger.address);
      expect(await topUpGateway.hasRole(topUpRole, stranger.address)).to.be.true;
      await topUpGateway.connect(admin).revokeRole(topUpRole, stranger.address);
      expect(await topUpGateway.hasRole(topUpRole, stranger.address)).to.be.false;
    });

    it("non-admin cannot grant roles", async () => {
      await expect(topUpGateway.connect(stranger).grantRole(topUpRole, stranger.address))
        .to.be.revertedWithCustomError(topUpGateway, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, await topUpGateway.DEFAULT_ADMIN_ROLE());
    });
  });

  describe("pausable", () => {
    let pauseRole: string;
    let resumeRole: string;

    beforeEach(async () => {
      pauseRole = await topUpGateway.PAUSE_ROLE();
      resumeRole = await topUpGateway.RESUME_ROLE();
      await topUpGateway.connect(admin).grantRole(pauseRole, admin.address);
      await topUpGateway.connect(admin).grantRole(resumeRole, admin.address);
    });

    describe("resume", () => {
      it("should revert if the sender does not have the RESUME_ROLE", async () => {
        await topUpGateway.connect(admin).pauseFor(1000n);

        await expect(topUpGateway.connect(stranger).resume())
          .to.be.revertedWithCustomError(topUpGateway, "AccessControlUnauthorizedAccount")
          .withArgs(stranger.address, resumeRole);
      });

      it("should revert if the contract is not paused", async () => {
        await expect(topUpGateway.connect(admin).resume()).to.be.revertedWithCustomError(
          topUpGateway,
          "PausedExpected",
        );
      });

      it("should resume the contract when paused and emit Resumed event", async () => {
        await topUpGateway.connect(admin).pauseFor(1000n);
        expect(await topUpGateway.isPaused()).to.equal(true);

        await expect(topUpGateway.connect(admin).resume()).to.emit(topUpGateway, "Resumed");

        expect(await topUpGateway.isPaused()).to.equal(false);
      });
    });

    describe("pauseFor", () => {
      it("should revert if the sender does not have the PAUSE_ROLE", async () => {
        await expect(topUpGateway.connect(stranger).pauseFor(1000n))
          .to.be.revertedWithCustomError(topUpGateway, "AccessControlUnauthorizedAccount")
          .withArgs(stranger.address, pauseRole);
      });

      it("should revert if the contract is already paused", async () => {
        await topUpGateway.connect(admin).pauseFor(1000n);

        await expect(topUpGateway.connect(admin).pauseFor(500n)).to.be.revertedWithCustomError(
          topUpGateway,
          "ResumedExpected",
        );
      });

      it("should revert if pause duration is zero", async () => {
        await expect(topUpGateway.connect(admin).pauseFor(0n)).to.be.revertedWithCustomError(
          topUpGateway,
          "ZeroPauseDuration",
        );
      });

      it("should pause the contract for the specified duration and emit Paused event", async () => {
        await expect(topUpGateway.connect(admin).pauseFor(1000n)).to.emit(topUpGateway, "Paused").withArgs(1000n);

        expect(await topUpGateway.isPaused()).to.equal(true);
      });

      it("should pause the contract indefinitely with PAUSE_INFINITELY", async () => {
        const pauseInfinitely = await topUpGateway.PAUSE_INFINITELY();

        await expect(topUpGateway.connect(admin).pauseFor(pauseInfinitely))
          .to.emit(topUpGateway, "Paused")
          .withArgs(pauseInfinitely);

        expect(await topUpGateway.isPaused()).to.equal(true);

        await time.increase(1_000_000_000);

        expect(await topUpGateway.isPaused()).to.equal(true);
      });

      it("should automatically resume after the pause duration passes", async () => {
        await topUpGateway.connect(admin).pauseFor(100n);
        expect(await topUpGateway.isPaused()).to.equal(true);

        await time.increase(101);

        expect(await topUpGateway.isPaused()).to.equal(false);
      });
    });

    describe("pauseUntil", () => {
      it("should revert if the sender does not have the PAUSE_ROLE", async () => {
        const timestamp = BigInt(await time.latest());
        await expect(topUpGateway.connect(stranger).pauseUntil(timestamp + 1000n))
          .to.be.revertedWithCustomError(topUpGateway, "AccessControlUnauthorizedAccount")
          .withArgs(stranger.address, pauseRole);
      });

      it("should revert if the contract is already paused", async () => {
        const timestamp = BigInt(await time.latest());
        await topUpGateway.connect(admin).pauseFor(1000n);

        await expect(topUpGateway.connect(admin).pauseUntil(timestamp + 1000n)).to.be.revertedWithCustomError(
          topUpGateway,
          "ResumedExpected",
        );
      });

      it("should revert if timestamp is in the past", async () => {
        const timestamp = BigInt(await time.latest());

        await expect(topUpGateway.connect(admin).pauseUntil(timestamp - 1000n)).to.be.revertedWithCustomError(
          topUpGateway,
          "PauseUntilMustBeInFuture",
        );
      });

      it("should pause the contract until the specified timestamp and emit Paused event", async () => {
        const timestamp = BigInt(await time.latest());
        const pauseUntil = timestamp + 1000n;

        await expect(topUpGateway.connect(admin).pauseUntil(pauseUntil))
          .to.emit(topUpGateway, "Paused")
          .withArgs(pauseUntil - timestamp);

        expect(await topUpGateway.isPaused()).to.equal(true);
      });

      it("should pause the contract indefinitely with PAUSE_INFINITELY", async () => {
        const pauseInfinitely = await topUpGateway.PAUSE_INFINITELY();

        await expect(topUpGateway.connect(admin).pauseUntil(pauseInfinitely))
          .to.emit(topUpGateway, "Paused")
          .withArgs(pauseInfinitely);

        expect(await topUpGateway.isPaused()).to.equal(true);

        await time.increase(1_000_000_000);

        expect(await topUpGateway.isPaused()).to.equal(true);
      });

      it("should automatically resume after the pause timestamp passes", async () => {
        const timestamp = BigInt(await time.latest());
        const pauseUntil = timestamp + 100n;

        await topUpGateway.connect(admin).pauseUntil(pauseUntil);
        expect(await topUpGateway.isPaused()).to.equal(true);

        await time.increase(101);

        expect(await topUpGateway.isPaused()).to.equal(false);
      });
    });

    describe("Interaction with topUp", () => {
      it("pauseFor: should prevent topUp immediately after pausing", async () => {
        const data = await buildTopUpData();
        await topUpGateway.connect(admin).pauseFor(1000n);

        await expect(topUpGateway.connect(topUpOperator).topUp(data)).to.be.revertedWithCustomError(
          topUpGateway,
          "ResumedExpected",
        );
      });

      it("pauseUntil: should prevent topUp immediately after pausing", async () => {
        const timestamp = BigInt(await time.latest());
        const data = await buildTopUpData();

        await topUpGateway.connect(admin).pauseUntil(timestamp + 1000n);

        await expect(topUpGateway.connect(topUpOperator).topUp(data)).to.be.revertedWithCustomError(
          topUpGateway,
          "ResumedExpected",
        );
      });

      it("pauseFor: should allow topUp immediately after resuming", async () => {
        await topUpGateway.connect(admin).pauseFor(1000n);
        await topUpGateway.connect(admin).resume();

        const data = await buildTopUpData();
        await topUpGateway.connect(topUpOperator).topUp(data);
      });

      it("pauseUntil: should allow topUp immediately after resuming", async () => {
        const timestamp = BigInt(await time.latest());

        await topUpGateway.connect(admin).pauseUntil(timestamp + 1000n);
        await topUpGateway.connect(admin).resume();

        const data = await buildTopUpData();
        await topUpGateway.connect(topUpOperator).topUp(data);
      });

      it("pauseFor: should allow topUp after pause duration automatically expires", async () => {
        await topUpGateway.connect(admin).pauseFor(100n);

        await time.increase(101);

        const data = await buildTopUpData();
        await topUpGateway.connect(topUpOperator).topUp(data);
      });

      it("pauseUntil: should allow topUp after pause duration automatically expires", async () => {
        const timestamp = BigInt(await time.latest());

        await topUpGateway.connect(admin).pauseUntil(timestamp + 100n);

        await time.increase(101);

        const data = await buildTopUpData();
        await topUpGateway.connect(topUpOperator).topUp(data);
      });
    });
  });

  describe("canTopUp", () => {
    it("returns false when module is not registered", async () => {
      expect(await topUpGateway.canTopUp(999n)).to.equal(false);
    });

    it("returns false when module is inactive", async () => {
      await stakingRouter.setModuleActive(MODULE_ID, false);
      expect(await topUpGateway.canTopUp(MODULE_ID)).to.equal(false);
    });

    it("returns false when block distance is not met", async () => {
      await topUpGateway.connect(limitsManager).setMinBlockDistance(DEFAULT_MIN_BLOCK_DISTANCE + 1n);
      await topUpGateway.harness_setLastTopUpData();
      expect(await topUpGateway.canTopUp(MODULE_ID)).to.equal(false);
    });

    it("returns false when Lido cannot deposit", async () => {
      await lido.setCanDeposit(false);
      expect(await topUpGateway.canTopUp(MODULE_ID)).to.equal(false);
    });

    it("returns false when withdrawal credentials are not 0x02", async () => {
      await stakingRouter.setWithdrawalCredentials(MODULE_ID, WC_TYPE_01);
      expect(await topUpGateway.canTopUp(MODULE_ID)).to.equal(false);
    });

    it("returns true when all conditions are satisfied", async () => {
      expect(await topUpGateway.canTopUp(MODULE_ID)).to.equal(true);
    });
  });
});
