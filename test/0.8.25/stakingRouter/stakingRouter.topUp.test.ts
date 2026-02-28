import { expect } from "chai";
import { hexlify, randomBytes } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracle__MockForLidoFastLane,
  DepositContract__MockForBeaconChainDepositor,
  Lido__MockForStakingRouter,
  LidoLocator,
  StakingModuleV2__MockForStakingRouter,
  StakingRouter__Harness,
} from "typechain-types";

import { findEventsWithInterfaces } from "lib";
import { getModuleMEB, StakingModuleStatus, TOTAL_BASIS_POINTS, WithdrawalCredentialsType } from "lib/constants";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

import { deployStakingRouter } from "../../deploy/stakingRouter";

describe("StakingRouter.sol:topUp", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let topUpGatewaySigner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let locator: LidoLocator;
  let stakingRouter: StakingRouter__Harness;
  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let lidoMock: Lido__MockForStakingRouter;
  let accountingOracle: AccountingOracle__MockForLidoFastLane;

  let originalState: string;

  const DEFAULT_CONFIG: ModuleConfig = {
    stakeShareLimit: TOTAL_BASIS_POINTS,
    priorityExitShareThreshold: TOTAL_BASIS_POINTS,
    moduleFee: 5_00n,
    treasuryFee: 5_00n,
    maxDepositsPerBlock: 150n,
    minDepositBlockDistance: 25n,
    withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
  };

  const GWEI = 1_000_000_000n;
  const NEW_MEB = getModuleMEB(WithdrawalCredentialsType.WC0x02);
  const WEI_PER_GWEI = 1_000_000_000n;
  const withdrawalCredentials = hexlify(randomBytes(32));
  const depositSecurityModule = "0x0000000000000000000000000000000000000002";

  before(async () => {
    [deployer, admin, topUpGatewaySigner, stranger] = await ethers.getSigners();
    // Deploy Lido mock
    lidoMock = await ethers.deployContract("Lido__MockForStakingRouter", deployer);

    // deploy oracle
    accountingOracle = await ethers.deployContract("AccountingOracle__MockForLidoFastLane", deployer);

    locator = await deployLidoLocator({
      lido: lidoMock,
      topUpGateway: await topUpGatewaySigner.getAddress(),
      depositSecurityModule,
      accountingOracle,
    });

    // deploy staking router
    ({ stakingRouter, depositContract } = await deployStakingRouter(
      { deployer, admin },
      { lidoLocator: locator, lido: lidoMock },
    ));

    await lidoMock.setStakingRouter(await stakingRouter.getAddress());

    // initialize staking router with the mock lido and topUpGateway as a signer
    await stakingRouter.initialize(admin, withdrawalCredentials);

    // grant roles
    await Promise.all([stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin)]);
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
    const TOP_UP_LIMIT_GWEI = 10n * GWEI; // 10 ETH in GWEI

    function makeValidTopUpData() {
      const keyIndices = [KEY_INDEX];
      const operatorIds = [OPERATOR_ID];
      // topUpLimits are now in wei (TOP_UP_LIMIT_GWEI is already 10 ETH in gwei, convert to wei)
      const topUpLimits = [TOP_UP_LIMIT_GWEI * WEI_PER_GWEI];
      const pubkeys = [hexlify(randomBytes(48))];

      return { keyIndices, operatorIds, topUpLimits, pubkeys };
    }

    it("Reverts if caller is not TopUpGateway", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      };

      const [, id] = await setupModule(config);
      const { keyIndices, operatorIds, topUpLimits, pubkeys } = makeValidTopUpData();

      await expect(
        stakingRouter.connect(stranger).topUp(id, keyIndices, operatorIds, pubkeys, topUpLimits),
      ).to.be.revertedWithCustomError(stakingRouter, "AppAuthFailed");
    });

    it("Reverts if the module does not exist", async () => {
      const { keyIndices, operatorIds, topUpLimits, pubkeys } = makeValidTopUpData();

      await expect(
        stakingRouter.connect(topUpGatewaySigner).topUp(1n, keyIndices, operatorIds, pubkeys, topUpLimits),
      ).to.be.revertedWithCustomError(stakingRouter, "StakingModuleUnregistered");
    });

    it("Reverts if the module is Legacy (top-ups only supported for 0x02)", async () => {
      const [, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x01,
      });

      const { keyIndices, operatorIds, topUpLimits, pubkeys } = makeValidTopUpData();

      await expect(
        stakingRouter.connect(topUpGatewaySigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpLimits),
      ).to.be.revertedWithCustomError(stakingRouter, "WrongWithdrawalCredentialsType");
    });

    it("Reverts if keyIndices array is empty", async () => {
      const [, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const keyIndices: bigint[] = [];
      const operatorIds: bigint[] = [];
      const topUpLimits: bigint[] = [];
      const pubkeys: string[] = [];

      await expect(
        stakingRouter.connect(topUpGatewaySigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpLimits),
      ).to.be.revertedWithCustomError(stakingRouter, "EmptyKeysList");
    });

    it("Reverts if pubkeys array length doesn't match keyIndices count", async () => {
      const [, id] = await setupModule({
        ...DEFAULT_CONFIG,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const keyIndices = [0n, 1n];
      const operatorIds = [0n, 0n];
      const topUpLimits = [10n * GWEI * WEI_PER_GWEI, 20n * GWEI * WEI_PER_GWEI]; // in wei
      const pubkeys = [hexlify(randomBytes(48))]; // Only 1 key, but 2 expected

      await expect(
        stakingRouter.connect(topUpGatewaySigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpLimits),
      ).to.be.revertedWithCustomError(stakingRouter, "WrongArrayLength");
    });

    it("Does not perform deposits when module allocation is 0", async () => {
      const [stakingModule, id] = await setupModule({
        ...DEFAULT_CONFIG,
        depositable: 0n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      // Set depositable ether to 0 (no ETH available)
      await lidoMock.setDepositableEther(0n);

      const pubkeys = [hexlify(randomBytes(48))];
      // Mock module returns 0 allocations
      await stakingModule.mock__setTopUpDepositData([0n]);

      const keyIndices = [0n];
      const operatorIds = [0n];
      const topUpLimits = [10n * GWEI * WEI_PER_GWEI]; // in wei

      const tx = await stakingRouter
        .connect(topUpGatewaySigner)
        .topUp(id, keyIndices, operatorIds, pubkeys, topUpLimits);

      const receipt = await tx.wait();
      const depositEvents = findEventsWithInterfaces(receipt!, "Deposited__MockEvent", [depositContract.interface]);

      expect(depositEvents.length).to.equal(0);
    });

    it("Performs top-up for a New module for all keys", async () => {
      const [stakingModule, id] = await setupModule({
        ...DEFAULT_CONFIG,
        deposited: 100n,
        activeBalanceGwei: 100n * 32n * 10n ** 9n, //100 x 32 eth / 1 gwei
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      // topUpLimits are now in wei
      const topUpWei = [
        10n * 10n ** 18n, // 10 ETH in wei
        20n * 10n ** 18n, // 20 ETH in wei
        30n * 10n ** 18n, // 30 ETH in wei
      ];

      const pubkeys = [hexlify(randomBytes(48)), hexlify(randomBytes(48)), hexlify(randomBytes(48))];

      // Mock module to return these allocations (in wei)
      await stakingModule.mock__setTopUpDepositData(topUpWei);

      const totalTopUpWei = topUpWei.reduce((acc, v) => acc + v, 0n);

      // Set depositable ether in lido mock
      await lidoMock.setDepositableEther(100n * NEW_MEB);
      // Fund lido mock with ETH
      await lidoMock.fund({ value: totalTopUpWei });

      const keyIndices = [0n, 1n, 2n];
      const operatorIds = [0n, 0n, 0n];

      const tx = await stakingRouter.connect(topUpGatewaySigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpWei);

      const receipt = await tx.wait();
      const depositEvents = findEventsWithInterfaces(receipt!, "Deposited__MockEvent", [depositContract.interface]);

      expect(depositEvents.length).to.equal(topUpWei.length);
    });

    it("Reverts when allocation exceeds module's target", async () => {
      const [stakingModule, id] = await setupModule({
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n, // 50%
        priorityExitShareThreshold: 50_00n,
        depositable: 2n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      // Add second module to split allocation
      await setupModule({
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        depositable: 2n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const depositableEth = 2n * NEW_MEB;

      // Mock module returns allocations that exceed target (in wei)
      const pubkeys = [hexlify(randomBytes(48)), hexlify(randomBytes(48))];
      // These allocations will exceed 50% of depositableEth
      const topUpWei = [1500n * GWEI * WEI_PER_GWEI, 1500n * GWEI * WEI_PER_GWEI]; // 3000 ETH total, but module only gets 50% = 2048 ETH
      await stakingModule.mock__setTopUpDepositData(topUpWei);

      await lidoMock.setDepositableEther(depositableEth);

      const keyIndices = [0n, 1n];
      const operatorIds = [0n, 0n];

      await expect(
        stakingRouter.connect(topUpGatewaySigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpWei),
      ).to.be.revertedWithCustomError(stakingRouter, "ModuleReturnExceedTarget");
    });

    it("Reverts when top up amount for key is below 1 ETH", async () => {
      const reducedBalanceGwei = (100n * NEW_MEB - 64n * 10n ** 18n) / 10n ** 9n;

      const [stakingModule, id] = await setupModule({
        ...DEFAULT_CONFIG,
        deposited: 100n,
        depositable: 100n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
        activeBalanceGwei: reducedBalanceGwei,
      });

      const pubkeys = [hexlify(randomBytes(48))];
      const topUpWei = [500_000_000n * WEI_PER_GWEI]; // 0.5 ETH in wei
      await stakingModule.mock__setTopUpDepositData(topUpWei);

      const depositableEth = 100n * NEW_MEB;
      await lidoMock.setDepositableEther(depositableEth);
      await lidoMock.fund({ value: depositableEth });

      const keyIndices = [0n];
      const operatorIds = [0n];

      const beaconChainDepositor = await ethers.getContractFactory("BeaconChainDepositor");
      await expect(
        stakingRouter.connect(topUpGatewaySigner).topUp(id, keyIndices, operatorIds, pubkeys, topUpWei),
      ).to.be.revertedWithCustomError(beaconChainDepositor, "DepositAmountTooLow");
    });

    it("Zero allocations from module result in no deposits", async () => {
      const [stakingModule, id] = await setupModule({
        ...DEFAULT_CONFIG,
        depositable: 100n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      });

      const pubkeys = [hexlify(randomBytes(48))];
      // Mock module returns 0 allocation
      await stakingModule.mock__setTopUpDepositData([0n]);

      await lidoMock.setDepositableEther(100n * NEW_MEB);

      const keyIndices = [0n];
      const operatorIds = [0n];
      const topUpLimits = [10n * GWEI * WEI_PER_GWEI]; // in wei

      const tx = await stakingRouter
        .connect(topUpGatewaySigner)
        .topUp(id, keyIndices, operatorIds, pubkeys, topUpLimits);

      const receipt = await tx.wait();
      const depositEvents = findEventsWithInterfaces(receipt!, "Deposited__MockEvent", [depositContract.interface]);

      expect(depositEvents.length).to.equal(0);
    });
  });

  async function setupModule({
    stakeShareLimit,
    priorityExitShareThreshold,
    moduleFee,
    treasuryFee,
    maxDepositsPerBlock,
    minDepositBlockDistance,
    exited = 0n,
    deposited = 0n,
    depositable = 0n,
    status = StakingModuleStatus.Active,
    withdrawalCredentialsType = WithdrawalCredentialsType.WC0x01,
    activeBalanceGwei = 0n,
    pendingBalanceGwei = 0n,
  }: ModuleConfig): Promise<[StakingModuleV2__MockForStakingRouter, bigint]> {
    const modulesCount = await stakingRouter.getStakingModulesCount();
    const module = await ethers.deployContract("StakingModuleV2__MockForStakingRouter", deployer);

    const stakingModuleConfig = {
      stakeShareLimit,
      priorityExitShareThreshold,
      stakingModuleFee: moduleFee,
      treasuryFee,
      maxDepositsPerBlock,
      minDepositBlockDistance,
      withdrawalCredentialsType,
    };

    await stakingRouter
      .connect(admin)
      .addStakingModule(randomBytes(8).toString(), await module.getAddress(), stakingModuleConfig);

    const moduleId = modulesCount + 1n;
    expect(await stakingRouter.getStakingModulesCount()).to.equal(modulesCount + 1n);

    await module.mock__getStakingModuleSummary(exited, deposited, depositable);
    if (activeBalanceGwei == 0n && deposited > 0n) {
      activeBalanceGwei = (deposited * getModuleMEB(withdrawalCredentialsType)) / 1_000_000_000n; // in gwei
    }
    await stakingRouter.testing_setStakingModuleAccounting(moduleId, activeBalanceGwei, pendingBalanceGwei, exited);

    if (status != StakingModuleStatus.Active) {
      await stakingRouter.setStakingModuleStatus(moduleId, status);
    }

    return [module, moduleId];
  }
});

interface ModuleConfig {
  stakeShareLimit: bigint;
  priorityExitShareThreshold: bigint;
  moduleFee: bigint;
  treasuryFee: bigint;
  maxDepositsPerBlock: bigint;
  minDepositBlockDistance: bigint;
  withdrawalCredentialsType: WithdrawalCredentialsType;
  exited?: bigint;
  deposited?: bigint;
  depositable?: bigint;
  status?: StakingModuleStatus;
  activeBalanceGwei?: bigint;
  pendingBalanceGwei?: bigint;
}
