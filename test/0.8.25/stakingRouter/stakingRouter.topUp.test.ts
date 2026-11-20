import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracle__MockForStakingRouter,
  DepositContract__MockForBeaconChainDepositor,
  Lido__MockForStakingRouter,
  LidoLocator,
  StakingModuleV2__MockForStakingRouter,
  StakingRouter__Harness,
} from "typechain-types";

import { findEventsWithInterfaces, randomString, randomWCType1, wcTypeMaxEB } from "lib";
import { ONE_GWEI, WithdrawalCredentialsType } from "lib/constants";

import { deployLidoLocator, deployStakingRouter } from "test/deploy";
import { Snapshot } from "test/suite";

import { CtxConfig, DEFAULT_CONFIG, setupModule } from "./helpers";

describe("StakingRouter.sol:topUp", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let dsmSigner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let locator: LidoLocator;
  let stakingRouter: StakingRouter__Harness;
  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let lidoMock: Lido__MockForStakingRouter;
  let accountingOracle: AccountingOracle__MockForStakingRouter;

  let originalState: string;

  let ctx: CtxConfig;

  const NEW_MEB = wcTypeMaxEB(WithdrawalCredentialsType.WC0x02);
  const WEI_PER_GWEI = 1_000_000_000n;
  const withdrawalCredentials = randomWCType1();

  before(async () => {
    [deployer, admin, dsmSigner, stranger] = await ethers.getSigners();
    // Deploy Lido mock
    lidoMock = await ethers.deployContract("Lido__MockForStakingRouter", deployer);

    // deploy oracle
    accountingOracle = await ethers.deployContract("AccountingOracle__MockForStakingRouter", deployer);

    locator = await deployLidoLocator({
      lido: lidoMock,
      depositSecurityModule: await dsmSigner.getAddress(),
      accountingOracle,
    });

    // deploy staking router
    ({ stakingRouter, depositContract } = await deployStakingRouter(
      { deployer, admin },
      { lidoLocator: locator, lido: lidoMock },
    ));

    await lidoMock.setStakingRouter(await stakingRouter.getAddress());

    // initialize staking router with the mock lido; the DepositSecurityModule is a signer
    await stakingRouter.initialize(admin, withdrawalCredentials);

    // grant roles
    await Promise.all([stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin)]);

    ctx = {
      deployer,
      admin,
      stakingRouter,
    };
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  context("topUp", () => {
    const KEY_INDEX = 0n;
    const OPERATOR_ID = 1n;
    const TOP_UP_GWEI = 10n * ONE_GWEI; // 10 ETH in ONE_GWEI, top-up limit for a validator set by the top-up depositor

    function makeValidTopUpData() {
      const keyIndices = [KEY_INDEX];
      const operatorIds = [OPERATOR_ID];
      // topUpLimits are now in wei (TOP_UP_LIMIT_GWEI is already 10 ETH in gwei, convert to wei)
      const topUpLimits = [TOP_UP_GWEI * WEI_PER_GWEI];
      const pubkeys = [randomString(48)];

      return { keyIndices, operatorIds, topUpLimits, pubkeys };
    }

    it("Reverts if caller is not the DepositSecurityModule", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      };

      const [, id] = await setupModule(ctx, config);
      const { keyIndices, operatorIds, topUpLimits, pubkeys } = makeValidTopUpData();

      for (const caller of [stranger, admin]) {
        await expect(
          stakingRouter.connect(caller).topUp(id, keyIndices, operatorIds, pubkeys, topUpLimits),
        ).to.be.revertedWithCustomError(stakingRouter, "NotAuthorized");
      }
    });

    it("Accepts more keys than maxDepositsPerBlock", async () => {
      const [stakingModule, id] = await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        maxDepositsPerBlock: 2n,
        deposited: 100n,
        totalModuleStake: 100n * 32n * 10n ** 18n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const topUpWei = [10n * 10n ** 18n, 20n * 10n ** 18n, 30n * 10n ** 18n];
      await stakingModule.mock__allocateDeposits(topUpWei);
      await lidoMock.setDepositableEther(100n * NEW_MEB);
      await lidoMock.fund({ value: 60n * 10n ** 18n });

      const pubkeys = [randomString(48), randomString(48), randomString(48)];
      const tx = await stakingRouter.connect(dsmSigner).topUp(id, [0n, 1n, 2n], [0n, 0n, 0n], pubkeys, topUpWei);

      await expect(tx)
        .to.emit(stakingRouter, "StakingRouterETHTopUp")
        .withArgs(id, 60n * 10n ** 18n);
    });

    it("Caps the module budget by maxDepositsPerBlock seed deposits", async () => {
      const [stakingModule, id] = await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        maxDepositsPerBlock: 2n,
        deposited: 100n,
        totalModuleStake: 100n * 32n * 10n ** 18n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const topUpWei = [10n * 10n ** 18n, 20n * 10n ** 18n];
      await stakingModule.mock__allocateDeposits(topUpWei);
      await lidoMock.setDepositableEther(100n * NEW_MEB);
      await lidoMock.fund({ value: 30n * 10n ** 18n });

      const pubkeys = [randomString(48), randomString(48)];
      const tx = await stakingRouter.connect(dsmSigner).topUp(id, [0n, 1n], [0n, 0n], pubkeys, topUpWei);

      const receipt = await tx.wait();
      const topUpEvents = findEventsWithInterfaces(receipt!, "TopUpData", [stakingModule.interface]);
      expect(topUpEvents[0].args._amount).to.equal(2n * 32n * 10n ** 18n);
    });

    it("Updates the module last deposit block and time without `StakingRouterETHDeposited`", async () => {
      const [stakingModule, id] = await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        deposited: 100n,
        totalModuleStake: 100n * 32n * 10n ** 18n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const topUpWei = [10n * 10n ** 18n];
      await stakingModule.mock__allocateDeposits(topUpWei);
      await lidoMock.setDepositableEther(100n * NEW_MEB);
      await lidoMock.fund({ value: topUpWei[0] });

      const lastDepositBlockBefore = await stakingRouter.getStakingModuleLastDepositBlock(id);

      const tx = await stakingRouter.connect(dsmSigner).topUp(id, [0n], [0n], [randomString(48)], topUpWei);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      expect(receipt!.blockNumber).to.be.greaterThan(lastDepositBlockBefore);
      expect(await stakingRouter.getStakingModuleLastDepositBlock(id)).to.equal(receipt!.blockNumber);
      expect((await stakingRouter.getStakingModule(id)).lastDepositAt).to.equal(block!.timestamp);

      await expect(tx).to.emit(stakingRouter, "StakingRouterETHTopUp").withArgs(id, topUpWei[0]);
      await expect(tx).not.to.emit(stakingRouter, "StakingRouterETHDeposited");
    });

    it("Writes the module last deposit block before it calls the module", async () => {
      const [stakingModule, id] = await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        deposited: 100n,
        totalModuleStake: 100n * 32n * 10n ** 18n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const topUpWei = [10n * 10n ** 18n];
      await stakingModule.mock__allocateDeposits(topUpWei);
      await stakingModule.mock__probeLastDepositBlock(id);
      await lidoMock.setDepositableEther(100n * NEW_MEB);
      await lidoMock.fund({ value: topUpWei[0] });

      const tx = await stakingRouter.connect(dsmSigner).topUp(id, [0n], [0n], [randomString(48)], topUpWei);
      const receipt = await tx.wait();

      await expect(tx).to.emit(stakingModule, "Mock__LastDepositBlockSeen").withArgs(receipt!.blockNumber);
    });

    it("Reverts if the module does not exist", async () => {
      const { keyIndices, operatorIds, topUpLimits, pubkeys } = makeValidTopUpData();

      await expect(
        stakingRouter.connect(dsmSigner).topUp(1n, keyIndices, operatorIds, pubkeys, topUpLimits),
      ).to.be.revertedWithCustomError(stakingRouter, "StakingModuleUnregistered");
    });

    it("Reverts if the module is Legacy (top-ups only supported for 0x02)", async () => {
      const [, id] = await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
      });

      const { keyIndices, operatorIds, topUpLimits, pubkeys } = makeValidTopUpData();

      await expect(
        stakingRouter.connect(dsmSigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpLimits),
      ).to.be.revertedWithCustomError(stakingRouter, "WrongWithdrawalCredentialsType");
    });

    it("Reverts if keyIndices array is empty", async () => {
      const [, id] = await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const keyIndices: bigint[] = [];
      const operatorIds: bigint[] = [];
      const topUpLimits: bigint[] = [];
      const pubkeys: string[] = [];

      await expect(
        stakingRouter.connect(dsmSigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpLimits),
      ).to.be.revertedWithCustomError(stakingRouter, "EmptyKeysList");
    });

    it("Reverts if pubkeys array length doesn't match keyIndices count", async () => {
      const [, id] = await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const keyIndices = [0n, 1n];
      const operatorIds = [0n, 0n];
      const topUpLimits = [10n * ONE_GWEI * WEI_PER_GWEI, 20n * ONE_GWEI * WEI_PER_GWEI]; // in wei
      const pubkeys = [randomString(48)]; // Only 1 key, but 2 expected

      await expect(
        stakingRouter.connect(dsmSigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpLimits),
      ).to.be.revertedWithCustomError(stakingRouter, "ArraysLengthMismatch");
    });

    it("happy path", async () => {
      const [stakingModule, id] = await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        deposited: 100n,
        totalModuleStake: 100n * 32n * 10n ** 18n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      // topUpLimits are now in wei
      const topUpWei = [
        10n * 10n ** 18n, // 10 ETH in wei
        20n * 10n ** 18n, // 20 ETH in wei
        30n * 10n ** 18n, // 30 ETH in wei
      ];

      const pubkeys = [randomString(48), randomString(48), randomString(48)];

      // Mock module to return these allocations (in wei)
      await stakingModule.mock__allocateDeposits(topUpWei);

      const totalTopUpWei = topUpWei.reduce((acc, v) => acc + v, 0n);

      // Set depositable ether in lido mock
      await lidoMock.setDepositableEther(100n * NEW_MEB);
      // Fund lido mock with ETH
      await lidoMock.fund({ value: totalTopUpWei });

      const keyIndices = [0n, 1n, 2n];
      const operatorIds = [0n, 0n, 0n];

      const tx = await stakingRouter.connect(dsmSigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpWei);

      const receipt = await tx.wait();
      const depositEvents = findEventsWithInterfaces(receipt!, "Deposited__MockEvent", [depositContract.interface]);
      expect(depositEvents.length).to.equal(topUpWei.length);

      // The module allocation (100 * 2048 - 100 * 32 ETH) is higher than the module seed batch,
      // so the budget is maxDepositsPerBlock * 32 ETH
      const topUpEvents = findEventsWithInterfaces(receipt!, "TopUpData", [stakingModule.interface]);
      expect(topUpEvents[0].args._amount).to.equal(DEFAULT_CONFIG.maxDepositsPerBlock * 32n * 10n ** 18n);

      // StakingRouter emits StakingRouterETHTopUp with the sum of module-returned allocations
      // (i.e. what is actually pulled from Lido and deposited), not the budget passed to allocateDeposits.
      await expect(tx).to.emit(stakingRouter, "StakingRouterETHTopUp").withArgs(id, totalTopUpWei);
    });

    it("Caps the module budget by the module allocation when it is below the seed batch", async () => {
      const [stakingModule, id] = await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        deposited: 100n,
        totalModuleStake: 100n * 32n * 10n ** 18n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      // topUpLimits are now in wei
      const topUpWei = [
        10n * 10n ** 18n, // 10 ETH in wei
        20n * 10n ** 18n, // 20 ETH in wei
        30n * 10n ** 18n, // 30 ETH in wei
      ];

      const pubkeys = [randomString(48), randomString(48), randomString(48)];

      // Mock module to return these allocations (in wei)
      await stakingModule.mock__allocateDeposits(topUpWei);

      const totalTopUpWei = topUpWei.reduce((acc, v) => acc + v, 0n);

      // Only 20 * 32 ETH is depositable, below the module seed batch (150 * 32 ETH)
      await lidoMock.setDepositableEther(20n * 32n * 10n ** 18n);
      // Fund lido mock with ETH
      await lidoMock.fund({ value: totalTopUpWei });

      const keyIndices = [0n, 1n, 2n];
      const operatorIds = [0n, 0n, 0n];

      const tx = await stakingRouter.connect(dsmSigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpWei);

      const receipt = await tx.wait();
      const depositEvents = findEventsWithInterfaces(receipt!, "Deposited__MockEvent", [depositContract.interface]);
      expect(depositEvents.length).to.equal(topUpWei.length);

      // min(module allocation = 640 ETH, module seed batch = 4,800 ETH) = 640 ETH
      const topUpEvents = findEventsWithInterfaces(receipt!, "TopUpData", [stakingModule.interface]);
      expect(topUpEvents[0].args._amount).to.equal(20n * 32n * 10n ** 18n);
    });

    it("if sum of top up is 0 execute allocateDeposits but no top up happen", async () => {
      const [stakingModule, id] = await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        deposited: 100n,
        totalModuleStake: 100n * 2048n * 10n ** 18n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      // Set depositable ether to 0 (no ETH available)
      await lidoMock.setDepositableEther(0n);

      const pubkeys = [randomString(48)];

      // Mock module returns 0 allocations
      await stakingModule.mock__allocateDeposits([0n]);

      const keyIndices = [0n];
      const operatorIds = [0n];
      const topUpLimits = [10n * ONE_GWEI * WEI_PER_GWEI]; // in wei

      const tx = await stakingRouter.connect(dsmSigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpLimits);

      const receipt = await tx.wait();
      const depositEvents = findEventsWithInterfaces(receipt!, "Deposited__MockEvent", [depositContract.interface]);

      expect(depositEvents.length).to.equal(0);

      // allocateDeposits MUST be called even when the budget is 0 (so CSM queue cursor can advance).
      const topUpEvents = findEventsWithInterfaces(receipt!, "TopUpData", [stakingModule.interface]);
      expect(topUpEvents.length).to.equal(1);
      expect(topUpEvents[0].args._amount).to.equal(0n);

      // StakingRouterETHTopUp is emitted unconditionally for off-chain observability,
      // mirroring StakingRouterETHDeposited behavior in deposit().
      await expect(tx).to.emit(stakingRouter, "StakingRouterETHTopUp").withArgs(id, 0n);

      // The module last deposit block is updated also for a zero amount
      expect(await stakingRouter.getStakingModuleLastDepositBlock(id)).to.equal(receipt!.blockNumber);
    });

    it("reverts with LidoDepositsPaused when budget is 0 and Lido cannot deposit", async () => {
      const [, id] = await setupModule(ctx, {
        ...DEFAULT_CONFIG,
        deposited: 100n,
        totalModuleStake: 100n * 2048n * 10n ** 18n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      // smDepositableEthAmountRounded ends up at 0:
      await lidoMock.setDepositableEther(0n);
      // and Lido is paused
      await lidoMock.setCanDeposit(false);

      const pubkeys = [randomString(48)];
      const keyIndices = [0n];
      const operatorIds = [0n];
      const topUpLimits = [10n * ONE_GWEI * WEI_PER_GWEI];

      await expect(
        stakingRouter.connect(dsmSigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpLimits),
      ).to.be.revertedWithCustomError(stakingRouter, "LidoDepositsPaused");
    });

    // tests group below - topUp execution depends on module result
    describe("processing staking module allocateDeposits method  result ", async () => {
      it("Reverts when allocation exceeds module's target", async () => {
        const [stakingModule, id] = (await setupModule(ctx, {
          ...DEFAULT_CONFIG,
          stakeShareLimit: 50_00n, // 50%
          priorityExitShareThreshold: 50_00n,
          depositable: 2n,
          withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        })) as [StakingModuleV2__MockForStakingRouter, bigint];

        // Add second module to split allocation
        await setupModule(ctx, {
          ...DEFAULT_CONFIG,
          stakeShareLimit: 50_00n,
          priorityExitShareThreshold: 50_00n,
          depositable: 2n,
          withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        });

        // Mock module returns allocations that exceed target (in wei)
        const pubkeys = [randomString(48), randomString(48)];
        // These allocations will exceed 50% of depositableEth
        const topUpWei = [1500n * ONE_GWEI * WEI_PER_GWEI, 1500n * ONE_GWEI * WEI_PER_GWEI]; // 3000 ETH total, but module only gets 50% = 2048 ETH
        await stakingModule.mock__allocateDeposits(topUpWei);

        const depositableEth = 2n * NEW_MEB;
        await lidoMock.setDepositableEther(depositableEth);

        const keyIndices = [0n, 1n];
        const operatorIds = [0n, 0n];

        await expect(
          stakingRouter.connect(dsmSigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpWei),
        ).to.be.revertedWithCustomError(stakingRouter, "ModuleReturnExceedTarget");
      });

      it("Reverts when allocation for a key exceeds its top-up limit", async () => {
        const [stakingModule, id] = await setupModule(ctx, {
          ...DEFAULT_CONFIG,
          deposited: 100n,
          totalModuleStake: 100n * 32n * 10n ** 18n,
          withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        });

        const pubkeys = [randomString(48)];
        const topUpLimits = [10n * 10n ** 18n]; // per-key limit: 10 ETH
        // Module returns 11 ETH for the key, above its 10 ETH limit but well below
        // smDepositableEthAmountRounded, so AllocationExceedsLimit fires first.
        const allocations = [11n * 10n ** 18n];
        await stakingModule.mock__allocateDeposits(allocations);

        await lidoMock.setDepositableEther(100n * NEW_MEB);
        await lidoMock.fund({ value: 11n * 10n ** 18n });

        const keyIndices = [0n];
        const operatorIds = [0n];

        await expect(
          stakingRouter.connect(dsmSigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpLimits),
        ).to.be.revertedWithCustomError(stakingRouter, "AllocationExceedsLimit");
      });

      it("Reverts when top up amount for key is below 1 ETH", async () => {
        const reducedBalanceGwei = (100n * NEW_MEB - 64n * 10n ** 18n) / 10n ** 9n;

        const [stakingModule, id] = await setupModule(ctx, {
          ...DEFAULT_CONFIG,
          deposited: 100n,
          depositable: 100n,
          withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
          validatorsBalanceGwei: reducedBalanceGwei,
        });

        const pubkeys = [randomString(48)];
        const topUpWei = [500_000_000n * WEI_PER_GWEI]; // 0.5 ETH in wei
        await stakingModule.mock__allocateDeposits(topUpWei);

        const depositableEth = 100n * NEW_MEB;
        await lidoMock.setDepositableEther(depositableEth);
        await lidoMock.fund({ value: depositableEth });

        const keyIndices = [0n];
        const operatorIds = [0n];

        const beaconChainDepositor = await ethers.getContractFactory("BeaconChainDepositor");

        await expect(
          stakingRouter.connect(dsmSigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpWei),
        ).to.be.revertedWithCustomError(beaconChainDepositor, "DepositAmountTooLow");
      });

      it("Zero from module result in no deposits", async () => {
        const [stakingModule, id] = await setupModule(ctx, {
          ...DEFAULT_CONFIG,
          depositable: 100n,
          withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        });

        const pubkeys = [randomString(48)];
        // Mock module returns 0 allocation
        await stakingModule.mock__allocateDeposits([0n]);

        await lidoMock.setDepositableEther(100n * NEW_MEB);

        const keyIndices = [0n];
        const operatorIds = [0n];
        const topUpLimits = [10n * ONE_GWEI * WEI_PER_GWEI]; // in wei

        const tx = await stakingRouter.connect(dsmSigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpLimits);

        const receipt = await tx.wait();
        const depositEvents = findEventsWithInterfaces(receipt!, "Deposited__MockEvent", [depositContract.interface]);

        expect(depositEvents.length).to.equal(0);

        // The module has no deposited keys, so its top-up allocation and the budget are 0.
        // The module is still called.
        const topUpEvents = findEventsWithInterfaces(receipt!, "TopUpData", [stakingModule.interface]);
        expect(topUpEvents.length).to.equal(1);
        expect(topUpEvents[0].args._amount).to.equal(0n);
      });
    });
  });
});
