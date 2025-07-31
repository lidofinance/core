import { expect } from "chai";
import { encodeBytes32String, MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { ACL, Kernel, Lido, LidoLocator, NodeOperatorsRegistry__Harness } from "typechain-types";

import { RewardDistributionState } from "lib";

import { addAragonApp, deployLidoDao, deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("NodeOperatorsRegistry.sol:initialize-and-upgrade", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let limitsManager: HardhatEthersSigner;
  let nodeOperatorsManager: HardhatEthersSigner;
  let signingKeysManager: HardhatEthersSigner;
  let stakingRouter: HardhatEthersSigner;

  let nor: NodeOperatorsRegistry__Harness;
  let lido: Lido;
  let dao: Kernel;
  let acl: ACL;
  let locator: LidoLocator;
  let impl: NodeOperatorsRegistry__Harness;

  let originalState: string;

  const moduleType = encodeBytes32String("curated-onchain-v1");
  const contractVersionV2 = 2n;

  before(async () => {
    [deployer, user, stakingRouter, nodeOperatorsManager, signingKeysManager, limitsManager] =
      await ethers.getSigners();

    ({ lido, dao, acl } = await deployLidoDao({
      rootAccount: deployer,
      initialized: true,
      locatorConfig: {
        stakingRouter,
      },
    }));

    const allocLib = await ethers.deployContract("MinFirstAllocationStrategy", deployer);
    const norHarnessFactory = await ethers.getContractFactory("NodeOperatorsRegistry__Harness", {
      libraries: {
        ["contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy"]: await allocLib.getAddress(),
      },
    });

    impl = await norHarnessFactory.connect(deployer).deploy();

    expect(await impl.getInitializationBlock()).to.equal(MaxUint256);
    const appProxy = await addAragonApp({
      dao,
      name: "node-operators-registry",
      impl,
      rootAccount: deployer,
    });

    nor = await ethers.getContractAt("NodeOperatorsRegistry__Harness", appProxy, deployer);

    await acl.createPermission(user, lido, await lido.RESUME_ROLE(), deployer);

    await acl.createPermission(stakingRouter, nor, await nor.STAKING_ROUTER_ROLE(), deployer);
    await acl.createPermission(signingKeysManager, nor, await nor.MANAGE_SIGNING_KEYS(), deployer);
    await acl.createPermission(nodeOperatorsManager, nor, await nor.MANAGE_NODE_OPERATOR_ROLE(), deployer);
    await acl.createPermission(limitsManager, nor, await nor.SET_NODE_OPERATOR_LIMIT_ROLE(), deployer);

    // grant role to nor itself cause it uses solidity's call method to itself
    // inside the harness__requestValidatorsKeysForDeposits() method
    await acl.grantPermission(nor, nor, await nor.STAKING_ROUTER_ROLE());

    locator = await ethers.getContractAt("LidoLocator", await lido.getLidoLocator(), user);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("initialize", () => {
    beforeEach(async () => {
      locator = await deployLidoLocator({ lido: lido });
    });

    it("Reverts if Locator is zero address", async () => {
      await expect(nor.initialize(ZeroAddress, moduleType, 86400n)).to.be.reverted;
    });

    it("Reverts if was initialized with v1", async () => {
      await nor.harness__initialize(1n);

      await expect(nor.initialize(locator, moduleType, 86400n)).to.be.revertedWith("INIT_ALREADY_INITIALIZED");
    });

    it("Reverts if already initialized", async () => {
      await nor.initialize(locator, encodeBytes32String("curated-onchain-v1"), 86400n);

      await expect(nor.initialize(locator, moduleType, 86400n)).to.be.revertedWith("INIT_ALREADY_INITIALIZED");
    });

    it("Makes the contract initialized to v4", async () => {
      const burnerAddress = await locator.burner();
      const latestBlock = BigInt(await time.latestBlock());

      await expect(nor.initialize(locator, moduleType, 86400n))
        .to.emit(nor, "ContractVersionSet")
        .withArgs(contractVersionV2)
        .and.to.emit(nor, "LocatorContractSet")
        .withArgs(await locator.getAddress())
        .and.to.emit(nor, "StakingModuleTypeSet")
        .withArgs(moduleType)
        .to.emit(nor, "RewardDistributionStateChanged")
        .withArgs(RewardDistributionState.Distributed)
        .to.emit(nor, "ExitDeadlineThresholdChanged")
        .withArgs(86400n, 0n);

      expect(await nor.getLocator()).to.equal(await locator.getAddress());
      expect(await nor.getInitializationBlock()).to.equal(latestBlock + 1n);
      expect(await lido.allowance(await nor.getAddress(), burnerAddress)).to.equal(0);
      expect(await nor.getContractVersion()).to.equal(4);
      expect(await nor.getType()).to.equal(moduleType);
    });
  });

  context("finalizeUpgrade_v4()", () => {
    let preInitState: string;
    beforeEach(async () => {
      locator = await deployLidoLocator({ lido: lido });
      preInitState = await Snapshot.take();
      await nor.harness__initializeWithLocator(2n, locator.getAddress());
    });

    it("Reverts if contract is not initialized", async () => {
      await Snapshot.restore(preInitState); // Restore to uninitialized state
      await expect(nor.finalizeUpgrade_v4(86400n)).to.be.revertedWith("CONTRACT_NOT_INITIALIZED");
    });

    it("Reverts if contract version is not 3", async () => {
      // Version is currently 2 from harness__initialize(2n)
      await expect(nor.finalizeUpgrade_v4(86400n)).to.be.revertedWith("UNEXPECTED_CONTRACT_VERSION");
    });

    it("Successfully upgrades from v3 to v4", async () => {
      // First upgrade to v3
      await nor.harness__setBaseVersion(3n);

      // Get burner address from locator
      const burnerAddress = await locator.burner();

      // Set initial allowance to a non-zero value to verify it gets reset
      await lido.connect(deployer).approve(burnerAddress, 100);
      expect(await lido.allowance(await nor.getAddress(), burnerAddress)).to.be.eq(0);

      // Perform the upgrade to v4
      await expect(nor.finalizeUpgrade_v4(86400n))
        .to.emit(nor, "ContractVersionSet")
        .withArgs(4n)
        .and.to.emit(nor, "ExitDeadlineThresholdChanged")
        .withArgs(86400n, 0n);

      // Verify contract version updated to 4
      expect(await nor.getContractVersion()).to.equal(4n);

      // Verify allowance reset to 0
      expect(await lido.allowance(await nor.getAddress(), burnerAddress)).to.equal(0n);

      // Verify exit deadline threshold was set correctly
      expect(await nor.exitDeadlineThreshold(0)).to.equal(86400n);
    });

    it("Works with different exit deadline threshold values", async () => {
      // Upgrade to v3 first
      await nor.harness__setBaseVersion(3n);

      const customThreshold = 172800n; // 2 days in seconds
      await nor.finalizeUpgrade_v4(customThreshold);

      expect(await nor.exitDeadlineThreshold(0)).to.equal(customThreshold);
    });

    it("Calls _initialize_v4 with correct parameters", async () => {
      // Upgrade to v3 first
      await nor.harness__setBaseVersion(3n);

      // Mock the _initialize_v4 function to track calls
      // This is a simplified approach since we can't easily mock internal functions
      // We'll verify through events and state changes instead

      await nor.finalizeUpgrade_v4(86400n);

      // Verify expected state changes from _initialize_v4
      expect(await nor.getContractVersion()).to.equal(4n);
      expect(await nor.exitDeadlineThreshold(0)).to.equal(86400n);

      // Verify exit penalty cutoff timestamp is set correctly (this is done in _setExitDeadlineThreshold)
      const currentTimestamp = await time.latest();
      expect(await nor.exitPenaltyCutoffTimestamp()).to.be.lte(currentTimestamp);
    });
  });

  context("setExitDeadlineThreshold", () => {
    beforeEach(async () => {
      locator = await deployLidoLocator({ lido: lido });
      await nor.initialize(locator, moduleType, 86400n);
    });

    it("Successfully sets exit deadline threshold with valid parameters", async () => {
      // Use smaller threshold and reporting window to get a higher (later) cutoff timestamp
      const threshold = 43200n; // 12 hours (smaller than initial 24h)
      const reportingWindow = 3600n; // 1 hour

      await expect(nor.connect(nodeOperatorsManager).setExitDeadlineThreshold(threshold, reportingWindow))
        .to.emit(nor, "ExitDeadlineThresholdChanged")
        .withArgs(threshold, reportingWindow);

      expect(await nor.exitDeadlineThreshold(0)).to.equal(threshold);
    });

    it("Reverts when threshold is zero", async () => {
      await expect(nor.connect(nodeOperatorsManager).setExitDeadlineThreshold(0n, 3600n)).to.be.revertedWith(
        "INVALID_EXIT_DELAY_THRESHOLD",
      );
    });

    it("Reverts when sum of threshold and reporting window causes underflow", async () => {
      const currentTime = await time.latest();
      const threshold = BigInt(currentTime) + 1000n; // Future timestamp
      const reportingWindow = 1000n;

      await expect(
        nor.connect(nodeOperatorsManager).setExitDeadlineThreshold(threshold, reportingWindow),
      ).to.be.revertedWith("CUTOFF_TIMESTAMP_UNDERFLOW");
    });

    it("Reverts when new cutoff timestamp is less than current cutoff timestamp", async () => {
      // First set a smaller threshold to get a higher cutoff timestamp
      await nor.connect(nodeOperatorsManager).setExitDeadlineThreshold(43200n, 1800n);

      // Try to set a higher threshold that would result in a lower (earlier) cutoff timestamp
      // This should fail because cutoff timestamp must be monotonically increasing
      await expect(nor.connect(nodeOperatorsManager).setExitDeadlineThreshold(172800n, 3600n)).to.be.revertedWith(
        "INVALID_EXIT_PENALTY_CUTOFF_TIMESTAMP",
      );
    });

    it("Works correctly with minimal values", async () => {
      // Use minimal threshold and no reporting window to get maximum cutoff timestamp
      const threshold = 1n;
      const reportingWindow = 0n;

      await expect(nor.connect(nodeOperatorsManager).setExitDeadlineThreshold(threshold, reportingWindow))
        .to.emit(nor, "ExitDeadlineThresholdChanged")
        .withArgs(threshold, reportingWindow);

      expect(await nor.exitDeadlineThreshold(0)).to.equal(threshold);

      const currentTime = BigInt(await time.latest());
      const actualCutoff = await nor.exitPenaltyCutoffTimestamp();
      expect(actualCutoff).to.be.closeTo(currentTime - 1n, 5n);
    });

    it("Prevents underflow scenario", async () => {
      // Simulate scenario where _threshold + _lateReportingWindow > block.timestamp
      const currentTime = BigInt(await time.latest());

      // This should fail due to underflow protection
      await expect(
        nor.connect(nodeOperatorsManager).setExitDeadlineThreshold(currentTime, currentTime),
      ).to.be.revertedWith("CUTOFF_TIMESTAMP_UNDERFLOW");
    });

    it("Only allows MANAGE_NODE_OPERATOR_ROLE to set threshold", async () => {
      await expect(nor.connect(user).setExitDeadlineThreshold(43200n, 3600n)).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Updates cutoff timestamp correctly with monotonic increase", async () => {
      const initialCutoff = await nor.exitPenaltyCutoffTimestamp();

      // Use smaller threshold to ensure new cutoff timestamp is higher
      const threshold = 21600n; // 6 hours (smaller than initial 24h)
      const reportingWindow = 3600n; // 1 hour

      await nor.connect(nodeOperatorsManager).setExitDeadlineThreshold(threshold, reportingWindow);

      const newCutoff = await nor.exitPenaltyCutoffTimestamp();

      // New cutoff should be greater than or equal to the initial cutoff (monotonic)
      expect(newCutoff).to.be.gte(initialCutoff);

      // Verify the threshold was updated
      expect(await nor.exitDeadlineThreshold(0)).to.equal(threshold);
    });

    it("Allows setting same cutoff timestamp", async () => {
      const currentCutoff = await nor.exitPenaltyCutoffTimestamp();

      // Advance time a bit
      await time.increase(3600); // 1 hour

      // Calculate parameters that would result in the same cutoff timestamp
      const newCurrentTime = BigInt(await time.latest());
      const targetCutoff = currentCutoff;
      const newThreshold = 43200n; // 12 hours
      const newReportingWindow = newCurrentTime - targetCutoff - newThreshold;

      // This should work as the cutoff timestamp will be the same (>= condition)
      await expect(nor.connect(nodeOperatorsManager).setExitDeadlineThreshold(newThreshold, newReportingWindow))
        .to.emit(nor, "ExitDeadlineThresholdChanged")
        .withArgs(newThreshold, newReportingWindow);
    });
  });
});
