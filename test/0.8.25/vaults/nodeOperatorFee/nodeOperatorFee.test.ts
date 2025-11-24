import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  LazyOracle__MockForNodeOperatorFee,
  LidoLocator,
  NodeOperatorFee__Harness,
  StakingVault__MockForNodeOperatorFee,
  StETH__MockForNodeOperatorFee,
  UpgradeableBeacon,
  VaultFactory__MockForNodeOperatorFee,
  VaultHub__MockForNodeOperatorFee,
  WstETH__Harness,
} from "typechain-types";

import {
  ABNORMALLY_HIGH_FEE_THRESHOLD_BP,
  advanceChainTime,
  days,
  ether,
  findEvents,
  getCurrentBlockTimestamp,
  getNextBlockTimestamp,
  MAX_UINT256,
  TOTAL_BASIS_POINTS,
} from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

const BP_BASE = 10000n;

describe("NodeOperatorFee.sol", () => {
  let deployer: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let nodeOperatorManager: HardhatEthersSigner;
  let nodeOperatorFeeExempter: HardhatEthersSigner;
  let vaultDepositor: HardhatEthersSigner;

  let stranger: HardhatEthersSigner;

  let lidoLocator: LidoLocator;
  let steth: StETH__MockForNodeOperatorFee;
  let wsteth: WstETH__Harness;
  let hub: VaultHub__MockForNodeOperatorFee;
  let vaultImpl: StakingVault__MockForNodeOperatorFee;
  let nodeOperatorFeeImpl: NodeOperatorFee__Harness;
  let factory: VaultFactory__MockForNodeOperatorFee;
  let vault: StakingVault__MockForNodeOperatorFee;
  let nodeOperatorFee: NodeOperatorFee__Harness;
  let beacon: UpgradeableBeacon;
  let lazyOracle: LazyOracle__MockForNodeOperatorFee;

  let originalState: string;

  const nodeOperatorFeeRate = 10_00n; // 10%
  const initialConfirmExpiry = days(7n);

  before(async () => {
    [deployer, vaultOwner, stranger, vaultDepositor, nodeOperatorManager, nodeOperatorFeeExempter] =
      await ethers.getSigners();

    steth = await ethers.deployContract("StETH__MockForNodeOperatorFee");
    wsteth = await ethers.deployContract("WstETH__Harness", [steth]);
    lazyOracle = await ethers.deployContract("LazyOracle__MockForNodeOperatorFee");

    lidoLocator = await deployLidoLocator({
      lido: steth,
      wstETH: wsteth,
      predepositGuarantee: vaultDepositor,
      lazyOracle,
    });
    hub = await ethers.deployContract("VaultHub__MockForNodeOperatorFee", [lidoLocator, steth]);

    nodeOperatorFeeImpl = await ethers.deployContract("NodeOperatorFee__Harness", [hub, lidoLocator]);

    vaultImpl = await ethers.deployContract("StakingVault__MockForNodeOperatorFee", [hub]);

    beacon = await ethers.deployContract("UpgradeableBeacon", [vaultImpl, deployer]);

    factory = await ethers.deployContract("VaultFactory__MockForNodeOperatorFee", [beacon, nodeOperatorFeeImpl]);
    expect(await beacon.implementation()).to.equal(vaultImpl);
    expect(await factory.BEACON()).to.equal(beacon);
    expect(await factory.NODE_OPERATOR_FEE_IMPL()).to.equal(nodeOperatorFeeImpl);

    const vaultCreationTx = await factory
      .connect(vaultOwner)
      .createVaultWithNodeOperatorFee(vaultOwner, nodeOperatorManager, nodeOperatorFeeRate, initialConfirmExpiry);

    const vaultCreationReceipt = await vaultCreationTx.wait();
    if (!vaultCreationReceipt) throw new Error("Vault creation receipt not found");

    const vaultCreatedEvents = findEvents(vaultCreationReceipt, "VaultCreated");
    expect(vaultCreatedEvents.length).to.equal(1);

    const stakingVaultAddress = vaultCreatedEvents[0].args.vault;
    vault = await ethers.getContractAt("StakingVault__MockForNodeOperatorFee", stakingVaultAddress, vaultOwner);
    expect(await vault.vaultHub()).to.equal(hub);

    const nodeOperatorFeeAddress = vaultCreatedEvents[0].args.nodeOperatorFee;
    nodeOperatorFee = await ethers.getContractAt("NodeOperatorFee__Harness", nodeOperatorFeeAddress, vaultOwner);
    expect(await nodeOperatorFee.stakingVault()).to.equal(vault);

    await nodeOperatorFee
      .connect(nodeOperatorManager)
      .grantRole(await nodeOperatorFee.NODE_OPERATOR_FEE_EXEMPT_ROLE(), nodeOperatorFeeExempter);
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  context("initialize", () => {
    it("reverts if already initialized", async () => {
      await expect(
        nodeOperatorFee.initialize(vaultOwner, nodeOperatorManager, 0n, days(7n)),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "AlreadyInitialized");
    });

    it("reverts if called on the implementation", async () => {
      const nodeOperatorFeeImpl_ = await ethers.deployContract("NodeOperatorFee__Harness", [hub, lidoLocator]);

      await expect(
        nodeOperatorFeeImpl_.initialize(vaultOwner, nodeOperatorManager, 0n, days(7n)),
      ).to.be.revertedWithCustomError(nodeOperatorFeeImpl_, "AlreadyInitialized");
    });
  });

  context("initialized state", () => {
    it("initializes the contract correctly", async () => {
      await assertSoleMember(vaultOwner, await nodeOperatorFee.DEFAULT_ADMIN_ROLE());
      await assertSoleMember(nodeOperatorManager, await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE());
      expect(await nodeOperatorFee.getRoleAdmin(await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE())).to.equal(
        await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(),
      );
      expect(await nodeOperatorFee.getRoleAdmin(await nodeOperatorFee.NODE_OPERATOR_FEE_EXEMPT_ROLE())).to.equal(
        await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(),
      );
      expect(
        await nodeOperatorFee.getRoleAdmin(await nodeOperatorFee.NODE_OPERATOR_UNGUARANTEED_DEPOSIT_ROLE()),
      ).to.equal(await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE());
      expect(
        await nodeOperatorFee.getRoleAdmin(await nodeOperatorFee.NODE_OPERATOR_PROVE_UNKNOWN_VALIDATOR_ROLE()),
      ).to.equal(await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE());

      expect(await nodeOperatorFee.getConfirmExpiry()).to.equal(initialConfirmExpiry);
      expect(await nodeOperatorFee.feeRate()).to.equal(nodeOperatorFeeRate);
      expect(await nodeOperatorFee.accruedFee()).to.equal(0n);
      expect(await nodeOperatorFee.settledGrowth()).to.equal(0n);
      expect(await nodeOperatorFee.latestCorrectionTimestamp()).to.equal(0n);
    });
  });

  context("confirmingRoles", () => {
    it("returns the correct roles", async () => {
      expect(await nodeOperatorFee.confirmingRoles()).to.deep.equal([
        await nodeOperatorFee.DEFAULT_ADMIN_ROLE(),
        await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(),
      ]);
    });
  });

  context("setConfirmExpiry", () => {
    it("reverts if the caller is not a member of the confirm expiry committee", async () => {
      await expect(nodeOperatorFee.connect(stranger).setConfirmExpiry(days(10n))).to.be.revertedWithCustomError(
        nodeOperatorFee,
        "SenderNotMember",
      );
    });

    it("sets the new confirm expiry", async () => {
      const oldConfirmExpiry = await nodeOperatorFee.getConfirmExpiry();
      const newConfirmExpiry = days(10n);
      const msgData = nodeOperatorFee.interface.encodeFunctionData("setConfirmExpiry", [newConfirmExpiry]);
      let confirmTimestamp = await getNextBlockTimestamp();
      let expiryTimestamp = confirmTimestamp + (await nodeOperatorFee.getConfirmExpiry());

      await expect(nodeOperatorFee.connect(vaultOwner).setConfirmExpiry(newConfirmExpiry))
        .to.emit(nodeOperatorFee, "RoleMemberConfirmed")
        .withArgs(vaultOwner, await nodeOperatorFee.DEFAULT_ADMIN_ROLE(), confirmTimestamp, expiryTimestamp, msgData);

      confirmTimestamp = await getNextBlockTimestamp();
      expiryTimestamp = confirmTimestamp + (await nodeOperatorFee.getConfirmExpiry());
      await expect(nodeOperatorFee.connect(nodeOperatorManager).setConfirmExpiry(newConfirmExpiry))
        .to.emit(nodeOperatorFee, "RoleMemberConfirmed")
        .withArgs(
          nodeOperatorManager,
          await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(),
          confirmTimestamp,
          expiryTimestamp,
          msgData,
        )
        .and.to.emit(nodeOperatorFee, "ConfirmExpirySet")
        .withArgs(nodeOperatorManager, oldConfirmExpiry, newConfirmExpiry);

      expect(await nodeOperatorFee.getConfirmExpiry()).to.equal(newConfirmExpiry);
    });
  });

  context("setFeeRecipient", () => {
    it("reverts if the caller is not a member of the node operator manager role", async () => {
      await expect(nodeOperatorFee.connect(stranger).setFeeRecipient(stranger))
        .to.be.revertedWithCustomError(nodeOperatorFee, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE());
    });

    it("reverts if the new node operator fee recipient is the zero address", async () => {
      await expect(
        nodeOperatorFee.connect(nodeOperatorManager).setFeeRecipient(ZeroAddress),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "ZeroAddress");
    });

    it("sets the new node operator fee recipient", async () => {
      await expect(nodeOperatorFee.connect(nodeOperatorManager).setFeeRecipient(stranger))
        .to.emit(nodeOperatorFee, "FeeRecipientSet")
        .withArgs(nodeOperatorManager, nodeOperatorManager, stranger);

      expect(await nodeOperatorFee.feeRecipient()).to.equal(stranger);
    });
  });

  context("disburseFee", () => {
    it("claims the fee", async () => {
      // deposited 100 ETH, earned 1 ETH, fee is 10%
      const report1 = {
        totalValue: ether("101"),
        inOutDelta: ether("100"),
        timestamp: await getCurrentBlockTimestamp(),
      };

      await hub.setReport(report1, true);

      // at 10%, the fee is 0.1 ETH
      const expectedNodeOperatorFee = ((report1.totalValue - report1.inOutDelta) * nodeOperatorFeeRate) / BP_BASE;

      await expect(nodeOperatorFee.disburseFee())
        .to.emit(hub, "Mock__Withdrawn")
        .withArgs(vault, nodeOperatorManager, expectedNodeOperatorFee);

      expect(await nodeOperatorFee.accruedFee()).to.equal(0n);
    });

    it("does not disburse if there is no fee, updates the report", async () => {
      const report1 = {
        totalValue: ether("100"),
        inOutDelta: ether("100"),
        timestamp: await getCurrentBlockTimestamp(),
      };

      await hub.setReport(report1, true);

      // totalValue-inOutDelta is 0, so no fee
      await expect(nodeOperatorFee.disburseFee()).not.to.emit(hub, "Mock__Withdrawn");
    });

    it("eventually settles fees if the actual rewards can cover the adjustment", async () => {
      // side-deposited 1 eth
      const sideDeposit = ether("1");
      await nodeOperatorFee.connect(nodeOperatorFeeExempter).addFeeExemption(sideDeposit);

      // also earned 2 eth rewards
      const inOutDelta = ether("10");
      const realRewards = ether("2");
      const report1 = {
        totalValue: inOutDelta + realRewards, // 12 now, but should be 13, but side deposit is not reflected in the report yet
        inOutDelta,
        timestamp: await getCurrentBlockTimestamp(),
      };

      await hub.setReport(report1, true);

      // totalValue-inOutDelta-adjustment is 1, at 10%, the fee is 0.1 ETH
      // so the fee for only 1 ETH is disbursed, the vault still owes the node operator the fee for the other 1 eth
      const expectedNodeOperatorFee1 =
        ((report1.totalValue - report1.inOutDelta - sideDeposit) * nodeOperatorFeeRate) / BP_BASE;
      expect(await nodeOperatorFee.accruedFee()).to.equal(expectedNodeOperatorFee1);

      await expect(nodeOperatorFee.disburseFee())
        .to.emit(hub, "Mock__Withdrawn")
        .withArgs(vault, nodeOperatorManager, expectedNodeOperatorFee1);

      expect(await nodeOperatorFee.accruedFee()).to.equal(0n);

      // now comes the report that does include the side deposit
      const report2 = {
        totalValue: ether("13"),
        inOutDelta: ether("10"),
        timestamp: await getCurrentBlockTimestamp(),
      };

      await hub.setReport(report2, true);

      // now the fee is disbursed
      const expectedNodeOperatorFee2 =
        ((report2.totalValue - report1.totalValue - (report2.inOutDelta - report1.inOutDelta)) * nodeOperatorFeeRate) /
        BP_BASE;
      expect(await nodeOperatorFee.accruedFee()).to.equal(expectedNodeOperatorFee2);

      expect(expectedNodeOperatorFee1 + expectedNodeOperatorFee2).to.equal(
        (realRewards * nodeOperatorFeeRate) / BP_BASE,
      );
    });

    it("eventually settles fee if the rewards cannot cover the adjustment", async () => {
      // side-deposited 1 eth
      const sideDeposit = ether("2");
      await nodeOperatorFee.connect(nodeOperatorFeeExempter).addFeeExemption(sideDeposit);

      const inOutDelta = ether("10");
      const realRewards = ether("1");

      const report1 = {
        totalValue: inOutDelta + realRewards, // 11 now, but should be 13, but side deposit is not reflected in the report yet
        inOutDelta,
        timestamp: await getCurrentBlockTimestamp(),
      };

      await hub.setReport(report1, true);

      // 11 - 10 - 2 = -1, NO Rewards
      expect(await nodeOperatorFee.accruedFee()).to.equal(0n);
      await expect(nodeOperatorFee.disburseFee()).not.to.emit(hub, "Mock__Withdrawn");

      const report2 = {
        totalValue: inOutDelta + realRewards + sideDeposit, // 13 now, it includes the side deposit
        inOutDelta,
        timestamp: await getCurrentBlockTimestamp(),
      };

      await hub.setReport(report2, true);

      // now the fee is disbursed
      // 13 - 12 - (10 - 10) = 1, at 10%, the fee is 0.1 ETH
      const expectedNodeOperatorFee = (realRewards * nodeOperatorFeeRate) / BP_BASE;
      expect(await nodeOperatorFee.accruedFee()).to.equal(expectedNodeOperatorFee);

      expect(expectedNodeOperatorFee).to.equal((realRewards * nodeOperatorFeeRate) / BP_BASE);

      await expect(nodeOperatorFee.disburseFee())
        .to.emit(hub, "Mock__Withdrawn")
        .withArgs(vault, nodeOperatorManager, expectedNodeOperatorFee);

      expect(await nodeOperatorFee.accruedFee()).to.equal(0n);
    });

    it("reverts if the fee is abnormally high", async () => {
      const feeRate = await nodeOperatorFee.feeRate();
      const totalValue = ether("100");
      const pauseThreshold = (totalValue * ABNORMALLY_HIGH_FEE_THRESHOLD_BP) / TOTAL_BASIS_POINTS;
      const valueOverThreshold = 10n;
      const rewards = (pauseThreshold * TOTAL_BASIS_POINTS) / feeRate + valueOverThreshold;
      const inOutDelta = totalValue - rewards;
      const expectedFee = (rewards * nodeOperatorFeeRate) / BP_BASE;
      expect(expectedFee).to.be.greaterThan(
        ((inOutDelta + rewards) * ABNORMALLY_HIGH_FEE_THRESHOLD_BP) / TOTAL_BASIS_POINTS,
      );

      await hub.setReport(
        {
          totalValue,
          inOutDelta,
          timestamp: await getCurrentBlockTimestamp(),
        },
        true,
      );

      expect(await nodeOperatorFee.accruedFee()).to.equal(expectedFee);
      await expect(nodeOperatorFee.disburseFee()).to.be.revertedWithCustomError(nodeOperatorFee, "AbnormallyHighFee");
    });

    it("disburse abnormally high fee", async () => {
      const feeRate = await nodeOperatorFee.feeRate();
      const totalValue = ether("100");
      const pauseThreshold = (totalValue * ABNORMALLY_HIGH_FEE_THRESHOLD_BP) / TOTAL_BASIS_POINTS;
      const valueOverThreshold = 10n;
      const rewards = (pauseThreshold * TOTAL_BASIS_POINTS) / feeRate + valueOverThreshold;
      const inOutDelta = totalValue - rewards;
      const expectedFee = (rewards * nodeOperatorFeeRate) / BP_BASE;
      expect(expectedFee).to.be.greaterThan(
        ((inOutDelta + rewards) * ABNORMALLY_HIGH_FEE_THRESHOLD_BP) / TOTAL_BASIS_POINTS,
      );

      await hub.setReport(
        {
          totalValue,
          inOutDelta,
          timestamp: await getCurrentBlockTimestamp(),
        },
        true,
      );

      expect(await nodeOperatorFee.accruedFee()).to.equal(expectedFee);
      await expect(nodeOperatorFee.connect(vaultOwner).disburseAbnormallyHighFee()).to.emit(
        nodeOperatorFee,
        "FeeDisbursed",
      );
      expect(await nodeOperatorFee.accruedFee()).to.equal(0n);
    });
  });

  context("addFeeExemption", () => {
    beforeEach(async () => {
      await hub.setReport(
        {
          totalValue: ether("100"),
          inOutDelta: ether("100"),
          timestamp: await getCurrentBlockTimestamp(),
        },
        true,
      );
      await lazyOracle.mock__setLatestReportTimestamp(await getCurrentBlockTimestamp());

      const operatorFee = 10_00n; // 10%
      await nodeOperatorFee.connect(nodeOperatorManager).setFeeRate(operatorFee);
      await nodeOperatorFee.connect(vaultOwner).setFeeRate(operatorFee);

      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_FEE_EXEMPT_ROLE(), nodeOperatorFeeExempter);
    });

    it("reverts if non NODE_OPERATOR_FEE_EXEMPT_ROLE adds exemption", async () => {
      await expect(nodeOperatorFee.connect(stranger).addFeeExemption(100n)).to.be.revertedWithCustomError(
        nodeOperatorFee,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("revert for zero increase", async () => {
      await expect(nodeOperatorFee.connect(nodeOperatorFeeExempter).addFeeExemption(0n)).to.be.revertedWithCustomError(
        nodeOperatorFee,
        "SameSettledGrowth",
      );
    });

    it("reverts if the amount is too large", async () => {
      await expect(
        nodeOperatorFee.connect(nodeOperatorFeeExempter).addFeeExemption(MAX_UINT256),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "UnexpectedFeeExemptionAmount");
    });

    it("adjuster can addFeeExemption", async () => {
      const increase = ether("10");

      expect(await nodeOperatorFee.settledGrowth()).to.deep.equal(0n);
      const timestamp = await getNextBlockTimestamp();
      const tx = await nodeOperatorFee.connect(nodeOperatorFeeExempter).addFeeExemption(increase);

      await expect(tx)
        .to.emit(nodeOperatorFee, "CorrectionTimestampUpdated")
        .withArgs(timestamp)
        .and.to.emit(nodeOperatorFee, "SettledGrowthSet")
        .withArgs(0, increase);
      expect(await nodeOperatorFee.settledGrowth()).to.deep.equal(increase);
    });

    it("manual increase can decrease NO fee", async () => {
      const operatorFee = await nodeOperatorFee.feeRate();

      const rewards = ether("10");
      await hub.setReport(
        {
          totalValue: rewards,
          inOutDelta: 0n,
          timestamp: await getCurrentBlockTimestamp(),
        },
        true,
      );

      const expectedFee = (rewards * operatorFee) / BP_BASE;
      expect(await nodeOperatorFee.accruedFee()).to.equal(expectedFee);

      await nodeOperatorFee.connect(nodeOperatorFeeExempter).addFeeExemption(rewards / 2n);
      expect(await nodeOperatorFee.accruedFee()).to.equal(expectedFee / 2n);

      await nodeOperatorFee.connect(nodeOperatorFeeExempter).addFeeExemption(rewards / 2n);
      expect(await nodeOperatorFee.accruedFee()).to.equal(0n);
    });

    it("settledGrowth is updated fee claim", async () => {
      const totalValue = ether("100");
      const operatorFee = await nodeOperatorFee.feeRate();
      const rewards = ether("0.01");
      const adjustment = ether("32"); // e.g. side deposit

      await hub.setReport(
        {
          totalValue: totalValue + rewards + adjustment,
          inOutDelta: totalValue,
          timestamp: await getCurrentBlockTimestamp(),
        },
        true,
      );

      const expectedFee = ((rewards + adjustment) * operatorFee) / BP_BASE;
      expect(await nodeOperatorFee.accruedFee()).to.equal(expectedFee);

      const timestamp = await getNextBlockTimestamp();
      await nodeOperatorFee.connect(nodeOperatorFeeExempter).addFeeExemption(adjustment);
      expect(await nodeOperatorFee.settledGrowth()).to.deep.equal(adjustment);
      expect(await nodeOperatorFee.latestCorrectionTimestamp()).to.deep.equal(timestamp);

      const adjustedFee = expectedFee - (adjustment * operatorFee) / BP_BASE;
      expect(await nodeOperatorFee.accruedFee()).to.equal(adjustedFee);

      await expect(nodeOperatorFee.connect(stranger).disburseFee())
        .to.emit(nodeOperatorFee, "FeeDisbursed")
        .withArgs(stranger, adjustedFee, await nodeOperatorFee.feeRecipient())
        .and.to.emit(nodeOperatorFee, "SettledGrowthSet");

      expect(await nodeOperatorFee.accruedFee()).to.equal(0n);
    });
  });

  context("correctSettledGrowth", () => {
    it("reverts if called by not CONFIRMING_ROLE", async () => {
      await expect(nodeOperatorFee.connect(stranger).correctSettledGrowth(100n, 0n)).to.be.revertedWithCustomError(
        nodeOperatorFee,
        "SenderNotMember",
      );
    });

    it("reverts if trying to set same adjustment", async () => {
      const current = await nodeOperatorFee.settledGrowth();
      await nodeOperatorFee.connect(nodeOperatorManager).correctSettledGrowth(current, current);

      await expect(
        nodeOperatorFee.connect(vaultOwner).correctSettledGrowth(current, current),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "SameSettledGrowth");
    });

    it("reverts vote if AccruedRewardsAdjustment changes", async () => {
      const current = await nodeOperatorFee.settledGrowth();
      expect(current).to.equal(0n);

      const proposed = 100n;
      const increase = proposed - current + 100n; // 200n
      const postIncrease = current + increase;

      // still the same
      await nodeOperatorFee.connect(nodeOperatorManager).correctSettledGrowth(proposed, current);
      expect(await nodeOperatorFee.settledGrowth()).to.deep.equal(0n);

      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_FEE_EXEMPT_ROLE(), nodeOperatorFeeExempter);

      // now the adjustment is updated
      const timestamp = await getNextBlockTimestamp();
      await nodeOperatorFee.connect(nodeOperatorFeeExempter).addFeeExemption(increase);
      expect(await nodeOperatorFee.settledGrowth()).to.equal(postIncrease);
      expect(await nodeOperatorFee.latestCorrectionTimestamp()).to.equal(timestamp);

      await expect(
        nodeOperatorFee.connect(vaultOwner).correctSettledGrowth(proposed, current),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "UnexpectedSettledGrowth");
    });

    it("allows to set adjustment by committee", async () => {
      const currentSettledGrowth = await nodeOperatorFee.settledGrowth();
      expect(currentSettledGrowth).to.equal(0n);
      const newSettledGrowth = 100n;

      const msgData = nodeOperatorFee.interface.encodeFunctionData("correctSettledGrowth", [
        newSettledGrowth,
        currentSettledGrowth,
      ]);

      let confirmTimestamp = await getNextBlockTimestamp();
      let expiryTimestamp = confirmTimestamp + (await nodeOperatorFee.getConfirmExpiry());

      const firstConfirmTx = await nodeOperatorFee
        .connect(nodeOperatorManager)
        .correctSettledGrowth(newSettledGrowth, currentSettledGrowth);

      await expect(firstConfirmTx)
        .to.emit(nodeOperatorFee, "RoleMemberConfirmed")
        .withArgs(
          nodeOperatorManager,
          await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(),
          confirmTimestamp,
          expiryTimestamp,
          msgData,
        );

      expect(await nodeOperatorFee.settledGrowth()).to.equal(currentSettledGrowth);

      confirmTimestamp = await getNextBlockTimestamp();
      expiryTimestamp = confirmTimestamp + (await nodeOperatorFee.getConfirmExpiry());

      const timestamp = await getNextBlockTimestamp();
      const secondConfirmTx = await nodeOperatorFee
        .connect(vaultOwner)
        .correctSettledGrowth(newSettledGrowth, currentSettledGrowth);

      await expect(secondConfirmTx)
        .to.emit(nodeOperatorFee, "RoleMemberConfirmed")
        .withArgs(vaultOwner, await nodeOperatorFee.DEFAULT_ADMIN_ROLE(), confirmTimestamp, expiryTimestamp, msgData)
        .to.emit(nodeOperatorFee, "SettledGrowthSet")
        .withArgs(currentSettledGrowth, newSettledGrowth);

      expect(await nodeOperatorFee.settledGrowth()).to.deep.equal(newSettledGrowth);
      expect(await nodeOperatorFee.latestCorrectionTimestamp()).to.deep.equal(timestamp);
    });
  });

  context("setNodeOperatorFeeRate", () => {
    beforeEach(async () => {
      // set non-zero ts for the latest report
      await lazyOracle.mock__setLatestReportTimestamp(1);
    });

    it("reverts if report is stale", async () => {
      // grant vaultOwner the NODE_OPERATOR_MANAGER_ROLE to set the fee rate
      // to simplify the test
      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(), vaultOwner);

      const isReportFresh = false;
      await hub.setReport(
        {
          totalValue: ether("100"),
          inOutDelta: ether("100"),
          timestamp: await getCurrentBlockTimestamp(),
        },
        isReportFresh,
      );

      await expect(nodeOperatorFee.connect(vaultOwner).setFeeRate(100n)).to.be.revertedWithCustomError(
        nodeOperatorFee,
        "ReportStale",
      );
    });

    it("reverts if called by not CONFIRMING_ROLE", async () => {
      await hub.setReport(
        {
          totalValue: ether("100"),
          inOutDelta: ether("100"),
          timestamp: await getNextBlockTimestamp(),
        },
        true,
      );

      await expect(nodeOperatorFee.connect(stranger).setFeeRate(100n)).to.be.revertedWithCustomError(
        nodeOperatorFee,
        "SenderNotMember",
      );
    });

    it("reverts if there is a pending adjustment", async () => {
      // grant vaultOwner the NODE_OPERATOR_MANAGER_ROLE to set the fee rate
      // to simplify the test
      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(), vaultOwner);

      const currentAdjustment = await nodeOperatorFee.settledGrowth();

      await hub.setReport(
        {
          totalValue: ether("100"),
          inOutDelta: ether("100"),
          timestamp: await getNextBlockTimestamp(),
        },
        true,
      );

      await advanceChainTime(1n);

      const newAdjustment = 100n;
      await nodeOperatorFee.correctSettledGrowth(newAdjustment, currentAdjustment);

      await expect(nodeOperatorFee.connect(vaultOwner).setFeeRate(100n)).to.be.revertedWithCustomError(
        nodeOperatorFee,
        "CorrectionAfterReport",
      );
    });

    it("reverts if the adjustment is set in the same block (same timestamp)", async () => {
      // grant vaultOwner the NODE_OPERATOR_MANAGER_ROLE to set the fee rate
      // to simplify the test
      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(), vaultOwner);

      const currentAdjustment = await nodeOperatorFee.settledGrowth();
      expect(currentAdjustment).to.equal(0n);

      const newAdjustment = 100n;
      await nodeOperatorFee.connect(vaultOwner).correctSettledGrowth(newAdjustment, currentAdjustment);
      const latestTimestamp = await nodeOperatorFee.latestCorrectionTimestamp();

      await hub.setReport(
        {
          totalValue: ether("100"),
          inOutDelta: ether("100"),
          timestamp: latestTimestamp,
        },
        true,
      );

      expect(await nodeOperatorFee.settledGrowth()).to.deep.equal(newAdjustment);

      await expect(nodeOperatorFee.connect(vaultOwner).setFeeRate(100n)).to.be.revertedWithCustomError(
        nodeOperatorFee,
        "CorrectionAfterReport",
      );
    });

    it("works if the vault is quarantined", async () => {
      // grant vaultOwner the NODE_OPERATOR_MANAGER_ROLE to set the fee rate
      // to simplify the test
      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(), vaultOwner);

      const noFeeRate = await nodeOperatorFee.feeRate();

      const rewards = ether("0.01");

      await hub.setReport(
        {
          totalValue: ether("1") + rewards,
          inOutDelta: ether("1"),
          timestamp: await getCurrentBlockTimestamp(),
        },
        true,
      );

      const expectedFee = (rewards * noFeeRate) / BP_BASE;

      expect(await nodeOperatorFee.accruedFee()).to.equal(expectedFee);

      await lazyOracle.mock__setQuarantineValue(1n);

      await expect(nodeOperatorFee.connect(vaultOwner).setFeeRate(100n))
        .to.emit(nodeOperatorFee, "FeeRateSet")
        .withArgs(vaultOwner, noFeeRate, 100n)
        .to.emit(nodeOperatorFee, "FeeDisbursed")
        .withArgs(vaultOwner, expectedFee, await nodeOperatorFee.feeRecipient());

      expect(await nodeOperatorFee.accruedFee()).to.equal(0n);
    });

    it("works and disburses any pending node operator fee", async () => {
      // grant vaultOwner the NODE_OPERATOR_MANAGER_ROLE to set the fee rate
      // to simplify the test
      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(), vaultOwner);

      const noFeeRate = await nodeOperatorFee.feeRate();

      const totalValue = ether("100");
      const rewards = ether("0.1");

      await hub.setReport(
        {
          totalValue: totalValue + rewards,
          inOutDelta: totalValue,
          timestamp: await getCurrentBlockTimestamp(),
        },
        true,
      );

      const expectedFee = (rewards * noFeeRate) / BP_BASE;

      expect(await nodeOperatorFee.accruedFee()).to.equal(expectedFee);

      const newOperatorFeeRate = 5_00n; // 5%
      await expect(nodeOperatorFee.connect(vaultOwner).setFeeRate(newOperatorFeeRate))
        .to.emit(nodeOperatorFee, "FeeDisbursed")
        .withArgs(vaultOwner, expectedFee, await nodeOperatorFee.feeRecipient());

      expect(await nodeOperatorFee.accruedFee()).to.equal(0);
    });

    it("settles growth event if fee rate is 0", async () => {
      const report1 = {
        totalValue: ether("100"),
        inOutDelta: ether("100"),
        timestamp: await getCurrentBlockTimestamp(),
      };
      await hub.setReport(report1, true); //fresh report to set fees

      await nodeOperatorFee.connect(nodeOperatorManager).setFeeRate(0n);
      await nodeOperatorFee.connect(vaultOwner).setFeeRate(0n);

      // deposited 100 ETH, earned 1 ETH, fee is 0
      const report2 = {
        totalValue: ether("101"),
        inOutDelta: ether("100"),
        timestamp: await getCurrentBlockTimestamp(),
      };
      await hub.setReport(report2, true);

      expect(await nodeOperatorFee.accruedFee()).to.equal(0n);
      expect(await nodeOperatorFee.settledGrowth()).to.equal(0n);

      await expect(nodeOperatorFee.disburseFee())
        .to.emit(nodeOperatorFee, "SettledGrowthSet")
        .withArgs(0n, ether("1"))
        .not.to.emit(hub, "Mock__Withdrawn")
        .not.to.emit(nodeOperatorFee, "FeeDisbursed");

      expect(await nodeOperatorFee.settledGrowth()).to.equal(ether("1"));
    });
  });

  async function assertSoleMember(account: HardhatEthersSigner, role: string) {
    expect(await nodeOperatorFee.hasRole(role, account)).to.be.true;
    expect(await nodeOperatorFee.getRoleMemberCount(role)).to.equal(1);
  }
});
