import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import type { TopUpGateway__Harness } from "typechain-types";
import { Lido__MockForTopUpGateway, LidoLocator, StakingRouter__MockForTopUpGateway } from "typechain-types";

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
  const MAX_EFFECTIVE_BALANCE_GWEI = 2048n * 10n ** 9n;
  const FAR_FUTURE_EPOCH = (1n << 64n) - 1n;
  const SAMPLE_PUBKEY = `0x${"11".repeat(48)}`;
  const DEFAULT_MAX_VALIDATORS = 5n;
  const DEFAULT_MIN_BLOCK_DISTANCE = 1n;
  const G_INDEX = ethers.zeroPadValue("0x01", 32);
  const ZERO_BYTES_31 = "00".repeat(31);
  const WC_TYPE_02 = `0x02${ZERO_BYTES_31}`;
  const WC_TYPE_01 = `0x01${ZERO_BYTES_31}`;

  type PendingWitness = {
    proof: string[];
    amount: bigint;
    signature: string;
    slot: bigint;
    index: bigint;
  };

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
    balanceWitness: Array<{
      proofBalance: string[];
      balanceGwei: bigint;
    }>;
    pendingWitness: PendingWitness[][];
  };

  beforeEach(async () => {
    [admin, topUpOperator, limitsManager, stranger] = await ethers.getSigners();
    snapshot = await Snapshot.take();

    stakingRouter = await ethers.deployContract("StakingRouter__MockForTopUpGateway");
    lido = await ethers.deployContract("Lido__MockForTopUpGateway");
    locator = await deployLidoLocator({
      stakingRouter: await stakingRouter.getAddress(),
      lido: await lido.getAddress(),
    });

    topUpGateway = await ethers.deployContract("TopUpGateway__Harness", [
      admin.address,
      await locator.getAddress(),
      DEFAULT_MAX_VALIDATORS,
      DEFAULT_MIN_BLOCK_DISTANCE,
      G_INDEX,
      G_INDEX,
      G_INDEX,
      G_INDEX,
      G_INDEX,
      G_INDEX,
      0,
    ]);

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
      balanceWitness: [
        {
          proofBalance: [],
          balanceGwei: 1_000_000_000_000n,
        },
      ],
      pendingWitness: [[]],
    };
  };

  describe("constructor", () => {
    it("initializes config and roles", async () => {
      expect(await topUpGateway.harness_getMaxValidatorsPerTopUp()).to.equal(DEFAULT_MAX_VALIDATORS);
      expect(await topUpGateway.harness_getMinBlockDistance()).to.equal(DEFAULT_MIN_BLOCK_DISTANCE);
      expect(await topUpGateway.getLastTopUpSlot()).to.equal(0n);
      expect(await topUpGateway.hasRole(await topUpGateway.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
      expect(await topUpGateway.hasRole(topUpRole, admin.address)).to.be.false;
      expect(await topUpGateway.harness_getLocator()).to.equal(await locator.getAddress());
    });

    it("reverts when maxValidatorsPerTopUp is zero", async () => {
      const factory = await ethers.getContractFactory("TopUpGateway__Harness");
      await expect(
        factory.deploy(
          admin.address,
          await locator.getAddress(),
          0n,
          DEFAULT_MIN_BLOCK_DISTANCE,
          G_INDEX,
          G_INDEX,
          G_INDEX,
          G_INDEX,
          G_INDEX,
          G_INDEX,
          0,
        ),
      ).to.be.revertedWithCustomError(factory, "ZeroValue");
    });

    it("reverts when minBlockDistance is zero", async () => {
      const factory = await ethers.getContractFactory("TopUpGateway__Harness");
      await expect(
        factory.deploy(
          admin.address,
          await locator.getAddress(),
          DEFAULT_MAX_VALIDATORS,
          0n,
          G_INDEX,
          G_INDEX,
          G_INDEX,
          G_INDEX,
          G_INDEX,
          G_INDEX,
          0,
        ),
      ).to.be.revertedWithCustomError(factory, "ZeroValue");
    });
  });

  describe("limits management", () => {
    it("allows manage limits role to set the max validators per top up", async () => {
      const newLimit = DEFAULT_MAX_VALIDATORS + 1n;
      await expect(topUpGateway.connect(limitsManager).setMaxValidatorsPerTopUp(newLimit))
        .to.emit(topUpGateway, "MaxValidatorsPerReportChanged")
        .withArgs(newLimit);
      expect(await topUpGateway.maxValidatorsPerTopUp()).to.equal(newLimit);
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
      expect(await topUpGateway.minBlockDistance()).to.equal(newDistance);
    });

    it("reverts when non-manager tries to set the min block distance", async () => {
      await expect(topUpGateway.connect(stranger).setMinBlockDistance(DEFAULT_MIN_BLOCK_DISTANCE + 10n))
        .to.be.revertedWithCustomError(topUpGateway, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, manageLimitsRole);
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
      data.balanceWitness = [];
      data.pendingWitness = [];

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
      data.balanceWitness = [data.balanceWitness[0], data.balanceWitness[0]];
      data.pendingWitness = [[], []];

      await expect(topUpGateway.connect(topUpOperator).topUp(data)).to.be.revertedWithCustomError(
        topUpGateway,
        "MaxValidatorsPerTopUpExceeded",
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

    it("reverts when slot does not increase", async () => {
      await topUpGateway.harness_setLastTopUpSlot(500);
      const data = await buildTopUpData();
      data.beaconRootData.slot = 500n;

      await expect(topUpGateway.connect(topUpOperator).topUp(data)).to.be.revertedWithCustomError(
        topUpGateway,
        "SlotNotIncreasing",
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

    it("reverts when balance exceeds the cap", async () => {
      const data = await buildTopUpData();
      data.balanceWitness[0].balanceGwei = MAX_EFFECTIVE_BALANCE_GWEI;

      await expect(topUpGateway.connect(topUpOperator).topUp(data)).to.be.revertedWithCustomError(
        topUpGateway,
        "ActualBalanceExceededMaximum",
      );
    });

    it("reverts when pubkey length is invalid", async () => {
      const data = await buildTopUpData();
      data.validatorWitness[0].pubkey = "0x1234";

      await expect(topUpGateway.connect(topUpOperator).topUp(data)).to.be.revertedWithCustomError(
        topUpGateway,
        "InvalidTopUpPubkeyLength",
      );
    });

    it("calls Lido.topUp and updates last slot", async () => {
      const data = await buildTopUpData();
      const expectedTopUp = MAX_EFFECTIVE_BALANCE_GWEI - data.balanceWitness[0].balanceGwei;

      await expect(topUpGateway.connect(topUpOperator).topUp(data))
        .to.emit(lido, "TopUpCalled")
        .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, SAMPLE_PUBKEY, [expectedTopUp])
        .and.to.emit(topUpGateway, "LastTopUpChanged")
        .withArgs(data.beaconRootData.slot);

      expect(await topUpGateway.getLastTopUpSlot()).to.equal(data.beaconRootData.slot);
      expect(await lido.topUpCalls()).to.equal(1n);
    });

    describe("pending deposits affect top-up limit", () => {
      it("reduces top-up limit by pending deposit amount", async () => {
        const data = await buildTopUpData();
        const pendingAmount = 100n * 10n ** 9n; // 100 Gwei

        data.pendingWitness = [
          [
            {
              proof: [],
              amount: pendingAmount,
              signature: `0x${"00".repeat(96)}`,
              slot: 100n,
              index: 0n,
            },
          ],
        ];

        const expectedTopUp = MAX_EFFECTIVE_BALANCE_GWEI - data.balanceWitness[0].balanceGwei - pendingAmount;

        await expect(topUpGateway.connect(topUpOperator).topUp(data))
          .to.emit(lido, "TopUpCalled")
          .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, SAMPLE_PUBKEY, [expectedTopUp]);
      });

      it("reduces top-up limit by multiple pending deposits", async () => {
        const data = await buildTopUpData();
        const pendingAmount1 = 50n * 10n ** 9n;
        const pendingAmount2 = 30n * 10n ** 9n;
        const pendingAmount3 = 20n * 10n ** 9n;

        data.pendingWitness = [
          [
            {
              proof: [],
              amount: pendingAmount1,
              signature: `0x${"00".repeat(96)}`,
              slot: 100n,
              index: 0n,
            },
            {
              proof: [],
              amount: pendingAmount2,
              signature: `0x${"00".repeat(96)}`,
              slot: 101n,
              index: 1n,
            },
            {
              proof: [],
              amount: pendingAmount3,
              signature: `0x${"00".repeat(96)}`,
              slot: 102n,
              index: 2n,
            },
          ],
        ];

        const totalPending = pendingAmount1 + pendingAmount2 + pendingAmount3;
        const expectedTopUp = MAX_EFFECTIVE_BALANCE_GWEI - data.balanceWitness[0].balanceGwei - totalPending;

        await expect(topUpGateway.connect(topUpOperator).topUp(data))
          .to.emit(lido, "TopUpCalled")
          .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, SAMPLE_PUBKEY, [expectedTopUp]);
      });

      it("returns zero top-up limit when balance + pending >= max effective balance", async () => {
        const data = await buildTopUpData();
        // Set balance close to max
        data.balanceWitness[0].balanceGwei = 2000n * 10n ** 9n; // 2000 Gwei

        // Add pending that would push total over max
        const pendingAmount = 100n * 10n ** 9n; // 100 Gwei
        data.pendingWitness = [
          [
            {
              proof: [],
              amount: pendingAmount,
              signature: `0x${"00".repeat(96)}`,
              slot: 100n,
              index: 0n,
            },
          ],
        ];

        // balance (2000) + pending (100) = 2100 > max (2048), so top-up should be 0
        await expect(topUpGateway.connect(topUpOperator).topUp(data))
          .to.emit(lido, "TopUpCalled")
          .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, SAMPLE_PUBKEY, [0n]);
      });

      it("returns zero top-up limit when balance + pending exactly equals max effective balance", async () => {
        const data = await buildTopUpData();
        // Set balance so that balance + pending = max exactly
        data.balanceWitness[0].balanceGwei = 1948n * 10n ** 9n; // 1948 Gwei

        const pendingAmount = 100n * 10n ** 9n; // 100 Gwei
        data.pendingWitness = [
          [
            {
              proof: [],
              amount: pendingAmount,
              signature: `0x${"00".repeat(96)}`,
              slot: 100n,
              index: 0n,
            },
          ],
        ];

        // balance (1948) + pending (100) = 2048 = max, so top-up should be 0
        await expect(topUpGateway.connect(topUpOperator).topUp(data))
          .to.emit(lido, "TopUpCalled")
          .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, SAMPLE_PUBKEY, [0n]);
      });

      it("handles empty pending deposits array (no pending)", async () => {
        const data = await buildTopUpData();
        data.pendingWitness = [[]]; // explicitly empty

        const expectedTopUp = MAX_EFFECTIVE_BALANCE_GWEI - data.balanceWitness[0].balanceGwei;

        await expect(topUpGateway.connect(topUpOperator).topUp(data))
          .to.emit(lido, "TopUpCalled")
          .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, SAMPLE_PUBKEY, [expectedTopUp]);
      });

      it("returns minimum top-up of 1 Gwei when balance is 1 Gwei below max", async () => {
        const data = await buildTopUpData();
        // Balance = MAX - 1 Gwei
        data.balanceWitness[0].balanceGwei = MAX_EFFECTIVE_BALANCE_GWEI - 1n;

        await expect(topUpGateway.connect(topUpOperator).topUp(data))
          .to.emit(lido, "TopUpCalled")
          .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, SAMPLE_PUBKEY, [1n]);
      });

      it("returns correct top-up for balance just under max with small pending", async () => {
        const data = await buildTopUpData();
        // Balance = MAX - 100 Gwei
        data.balanceWitness[0].balanceGwei = MAX_EFFECTIVE_BALANCE_GWEI - 100n;
        // Pending = 50 Gwei
        data.pendingWitness = [
          [
            {
              proof: [],
              amount: 50n,
              signature: `0x${"00".repeat(96)}`,
              slot: 100n,
              index: 0n,
            },
          ],
        ];

        // Expected top-up = 100 - 50 = 50 Gwei
        await expect(topUpGateway.connect(topUpOperator).topUp(data))
          .to.emit(lido, "TopUpCalled")
          .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, SAMPLE_PUBKEY, [50n]);
      });

      it("returns zero when validator is slashed", async () => {
        const data = await buildTopUpData();
        data.validatorWitness[0].slashed = true;

        await expect(topUpGateway.connect(topUpOperator).topUp(data))
          .to.emit(lido, "TopUpCalled")
          .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, SAMPLE_PUBKEY, [0n]);
      });

      it("returns zero when validator has exitEpoch set", async () => {
        const data = await buildTopUpData();
        data.validatorWitness[0].exitEpoch = 1000n; // not FAR_FUTURE_EPOCH

        await expect(topUpGateway.connect(topUpOperator).topUp(data))
          .to.emit(lido, "TopUpCalled")
          .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, SAMPLE_PUBKEY, [0n]);
      });

      it("returns zero when validator has withdrawableEpoch set", async () => {
        const data = await buildTopUpData();
        data.validatorWitness[0].withdrawableEpoch = 2000n; // not FAR_FUTURE_EPOCH

        await expect(topUpGateway.connect(topUpOperator).topUp(data))
          .to.emit(lido, "TopUpCalled")
          .withArgs(MODULE_ID, data.keyIndices, data.operatorIds, SAMPLE_PUBKEY, [0n]);
      });
    });
  });
});
