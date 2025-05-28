import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  LidoLocator,
  NodeOperatorFee__Harness,
  StakingVault__MockForNodeOperatorFee,
  StETH__MockForNodeOperatorFee,
  UpgradeableBeacon,
  VaultFactory__MockForNodeOperatorFee,
  VaultHub__MockForNodeOperatorFee,
  WstETH__HarnessForVault,
} from "typechain-types";

import {
  advanceChainTime,
  days,
  ether,
  findEvents,
  getCurrentBlockTimestamp,
  getNextBlockTimestamp,
} from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";
import { ZeroAddress } from "ethers";

const BP_BASE = 10000n;

describe("NodeOperatorFee.sol", () => {
  let deployer: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let nodeOperatorManager: HardhatEthersSigner;
  let nodeOperatorRewardAdjuster: HardhatEthersSigner;
  let vaultDepositor: HardhatEthersSigner;

  let stranger: HardhatEthersSigner;

  let lidoLocator: LidoLocator;
  let steth: StETH__MockForNodeOperatorFee;
  let wsteth: WstETH__HarnessForVault;
  let hub: VaultHub__MockForNodeOperatorFee;
  let vaultImpl: StakingVault__MockForNodeOperatorFee;
  let nodeOperatorFeeImpl: NodeOperatorFee__Harness;
  let factory: VaultFactory__MockForNodeOperatorFee;
  let vault: StakingVault__MockForNodeOperatorFee;
  let nodeOperatorFee: NodeOperatorFee__Harness;
  let beacon: UpgradeableBeacon;

  let originalState: string;

  const nodeOperatorFeeRate = 10_00n; // 10%
  const initialConfirmExpiry = days(7n);

  before(async () => {
    [deployer, vaultOwner, stranger, vaultDepositor, nodeOperatorManager, nodeOperatorRewardAdjuster] =
      await ethers.getSigners();

    steth = await ethers.deployContract("StETH__MockForNodeOperatorFee");
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);

    lidoLocator = await deployLidoLocator({ lido: steth, wstETH: wsteth, predepositGuarantee: vaultDepositor });
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
      .grantRole(await nodeOperatorFee.NODE_OPERATOR_REWARDS_ADJUST_ROLE(), nodeOperatorRewardAdjuster);
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  it("hello", async () => {
    expect(await nodeOperatorFee.VAULT_HUB()).to.equal(hub);
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
      ).to.be.revertedWithCustomError(nodeOperatorFeeImpl_, "NonProxyCallsForbidden");
    });
  });

  context("initialized state", () => {
    it("initializes the contract correctly", async () => {
      await assertSoleMember(vaultOwner, await nodeOperatorFee.DEFAULT_ADMIN_ROLE());
      await assertSoleMember(nodeOperatorManager, await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE());
      expect(await nodeOperatorFee.getRoleAdmin(await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE())).to.equal(
        await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(),
      );
      expect(await nodeOperatorFee.getRoleAdmin(await nodeOperatorFee.NODE_OPERATOR_REWARDS_ADJUST_ROLE())).to.equal(
        await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(),
      );

      expect(await nodeOperatorFee.getConfirmExpiry()).to.equal(initialConfirmExpiry);
      expect(await nodeOperatorFee.nodeOperatorFeeRate()).to.equal(nodeOperatorFeeRate);
      expect(await nodeOperatorFee.nodeOperatorDisbursableFee()).to.equal(0n);
      expect(await nodeOperatorFee.feePeriodStartReport()).to.deep.equal([0n, 0n]);
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
      let confirmTimestamp = (await getNextBlockTimestamp()) + (await nodeOperatorFee.getConfirmExpiry());

      await expect(nodeOperatorFee.connect(vaultOwner).setConfirmExpiry(newConfirmExpiry))
        .to.emit(nodeOperatorFee, "RoleMemberConfirmed")
        .withArgs(vaultOwner, await nodeOperatorFee.DEFAULT_ADMIN_ROLE(), confirmTimestamp, msgData);

      confirmTimestamp = (await getNextBlockTimestamp()) + (await nodeOperatorFee.getConfirmExpiry());
      await expect(nodeOperatorFee.connect(nodeOperatorManager).setConfirmExpiry(newConfirmExpiry))
        .to.emit(nodeOperatorFee, "RoleMemberConfirmed")
        .withArgs(nodeOperatorManager, await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(), confirmTimestamp, msgData)
        .and.to.emit(nodeOperatorFee, "ConfirmExpirySet")
        .withArgs(nodeOperatorManager, oldConfirmExpiry, newConfirmExpiry);

      expect(await nodeOperatorFee.getConfirmExpiry()).to.equal(newConfirmExpiry);
    });
  });

  context("setNodeOperatorFeeRecipient", () => {
    it("reverts if the caller is not a member of the node operator manager role", async () => {
      await expect(nodeOperatorFee.connect(stranger).setNodeOperatorFeeRecipient(stranger))
        .to.be.revertedWithCustomError(nodeOperatorFee, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE());
    });

    it("reverts if the new node operator fee recipient is the zero address", async () => {
      await expect(nodeOperatorFee.connect(nodeOperatorManager).setNodeOperatorFeeRecipient(ZeroAddress))
        .to.be.revertedWithCustomError(nodeOperatorFee, "ZeroArgument")
        .withArgs("nodeOperatorFeeRecipient");
    });

    it("sets the new node operator fee recipient", async () => {
      await expect(nodeOperatorFee.connect(nodeOperatorManager).setNodeOperatorFeeRecipient(stranger))
        .to.emit(nodeOperatorFee, "NodeOperatorFeeRecipientSet")
        .withArgs(nodeOperatorManager, nodeOperatorManager, stranger);

      expect(await nodeOperatorFee.nodeOperatorFeeRecipient()).to.equal(stranger);
    });
  });

  context("disburseNodeOperatorFee", () => {
    it("claims the fee", async () => {
      // deposited 100 ETH, earned 1 ETH, fee is 10%
      const report = {
        totalValue: ether("101"),
        inOutDelta: ether("100"),
      };

      await hub.setReport(report, await getCurrentBlockTimestamp(), true);

      // at 10%, the fee is 0.1 ETH
      const expectedNodeOperatorFee = ((report.totalValue - report.inOutDelta) * nodeOperatorFeeRate) / BP_BASE;

      await expect(nodeOperatorFee.disburseNodeOperatorFee())
        .to.emit(hub, "Mock__Withdrawn")
        .withArgs(vault, nodeOperatorManager, expectedNodeOperatorFee);

      expect(await nodeOperatorFee.nodeOperatorDisbursableFee()).to.equal(0n);
    });

    it("does not disburse if there is no fee, updates the report", async () => {
      const report = {
        totalValue: ether("100"),
        inOutDelta: ether("100"),
      };

      await hub.setReport(report, await getCurrentBlockTimestamp(), true);

      // totalValue-inOutDelta is 0, so no fee
      await expect(nodeOperatorFee.disburseNodeOperatorFee()).not.to.emit(hub, "Mock__Withdrawn");
    });

    it("eventually settles fees if the actual rewards can cover the adjustment", async () => {
      // side-deposited 1 eth
      const sideDeposit = ether("1");
      await nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseRewardsAdjustment(sideDeposit);

      // also earned 2 eth rewards
      const inOutDelta = ether("10");
      const realRewards = ether("2");
      const report = {
        totalValue: inOutDelta + realRewards, // 12 now, but should be 13, but side deposit is not reflected in the report yet
        inOutDelta,
      };

      await hub.setReport(report, await getCurrentBlockTimestamp(), true);

      // totalValue-inOutDelta-adjustment is 1, at 10%, the fee is 0.1 ETH
      // so the fee for only 1 ETH is disbursed, the vault still owes the node operator the fee for the other 1 eth
      const expectedNodeOperatorFee1 =
        ((report.totalValue - report.inOutDelta - sideDeposit) * nodeOperatorFeeRate) / BP_BASE;
      expect(await nodeOperatorFee.nodeOperatorDisbursableFee()).to.equal(expectedNodeOperatorFee1);

      await expect(nodeOperatorFee.disburseNodeOperatorFee())
        .to.emit(hub, "Mock__Withdrawn")
        .withArgs(vault, nodeOperatorManager, expectedNodeOperatorFee1);

      expect(await nodeOperatorFee.nodeOperatorDisbursableFee()).to.equal(0n);

      // now comes the report that does include the side deposit
      const report2 = {
        totalValue: ether("13"),
        inOutDelta: ether("10"),
      };

      await hub.setReport(report2, await getCurrentBlockTimestamp(), true);

      // now the fee is disbursed
      const expectedNodeOperatorFee2 =
        ((report2.totalValue - report.totalValue - (report2.inOutDelta - report.inOutDelta)) * nodeOperatorFeeRate) /
        BP_BASE;
      expect(await nodeOperatorFee.nodeOperatorDisbursableFee()).to.equal(expectedNodeOperatorFee2);

      expect(expectedNodeOperatorFee1 + expectedNodeOperatorFee2).to.equal(
        (realRewards * nodeOperatorFeeRate) / BP_BASE,
      );
    });

    it("eventually settles fee if the rewards cannot cover the adjustment", async () => {
      // side-deposited 1 eth
      const sideDeposit = ether("2");
      await nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseRewardsAdjustment(sideDeposit);

      const inOutDelta = ether("10");
      const realRewards = ether("1");

      const report = {
        totalValue: inOutDelta + realRewards, // 11 now, but should be 13, but side deposit is not reflected in the report yet
        inOutDelta,
      };

      await hub.setReport(report, await getCurrentBlockTimestamp(), true);

      // 11 - 10 - 2 = -1, NO Rewards
      expect(await nodeOperatorFee.nodeOperatorDisbursableFee()).to.equal(0n);
      await expect(nodeOperatorFee.disburseNodeOperatorFee()).not.to.emit(hub, "Mock__Withdrawn");

      const report2 = {
        totalValue: inOutDelta + realRewards + sideDeposit, // 13 now, it includes the side deposit
        inOutDelta,
      };

      await hub.setReport(report2, await getCurrentBlockTimestamp(), true);

      // now the fee is disbursed
      // 13 - 12 - (10 - 10) = 1, at 10%, the fee is 0.1 ETH
      const expectedNodeOperatorFee = (realRewards * nodeOperatorFeeRate) / BP_BASE;
      expect(await nodeOperatorFee.nodeOperatorDisbursableFee()).to.equal(expectedNodeOperatorFee);

      expect(expectedNodeOperatorFee).to.equal((realRewards * nodeOperatorFeeRate) / BP_BASE);

      await expect(nodeOperatorFee.disburseNodeOperatorFee())
        .to.emit(hub, "Mock__Withdrawn")
        .withArgs(vault, nodeOperatorManager, expectedNodeOperatorFee);

      expect(await nodeOperatorFee.nodeOperatorDisbursableFee()).to.equal(0n);
    });
  });

  context("increaseAccruedRewardsAdjustment", () => {
    beforeEach(async () => {
      await hub.setReport(
        {
          totalValue: ether("100"),
          inOutDelta: ether("100"),
        },
        await getCurrentBlockTimestamp(),
        true,
      );

      const operatorFee = 10_00n; // 10%
      await nodeOperatorFee.connect(nodeOperatorManager).setNodeOperatorFeeRate(operatorFee);
      await nodeOperatorFee.connect(vaultOwner).setNodeOperatorFeeRate(operatorFee);

      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_REWARDS_ADJUST_ROLE(), nodeOperatorRewardAdjuster);
    });

    it("reverts if non NODE_OPERATOR_REWARDS_ADJUST_ROLE sets adjustment", async () => {
      await expect(nodeOperatorFee.connect(stranger).increaseRewardsAdjustment(100n)).to.be.revertedWithCustomError(
        nodeOperatorFee,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("revert for zero increase", async () => {
      await expect(
        nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseRewardsAdjustment(0n),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "SameAdjustment");
    });

    it("reverts if manually adjust more than limit", async () => {
      const LIMIT = await nodeOperatorFee.MANUAL_REWARDS_ADJUSTMENT_LIMIT();
      const increase = ether("1");

      await expect(
        nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseRewardsAdjustment(LIMIT + 1n),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "IncreasedOverLimit");

      expect(await nodeOperatorFee.rewardsAdjustment()).to.deep.equal([0n, 0n]);

      const timestamp = await getNextBlockTimestamp();
      await nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseRewardsAdjustment(increase);
      expect(await nodeOperatorFee.rewardsAdjustment()).to.deep.equal([increase, timestamp]);

      await expect(
        nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseRewardsAdjustment(LIMIT),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "IncreasedOverLimit");

      const timestamp2 = await getNextBlockTimestamp();
      const increase2 = LIMIT - increase;
      await nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseRewardsAdjustment(increase2);
      expect(await nodeOperatorFee.rewardsAdjustment()).to.deep.equal([LIMIT, timestamp2]);

      await expect(
        nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseRewardsAdjustment(1n),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "IncreasedOverLimit");
    });

    it("adjuster can increaseAccruedRewardsAdjustment", async () => {
      const increase = ether("10");

      expect(await nodeOperatorFee.rewardsAdjustment()).to.deep.equal([0n, 0n]);
      const timestamp = await getNextBlockTimestamp();
      const tx = await nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseRewardsAdjustment(increase);

      await expect(tx).to.emit(nodeOperatorFee, "RewardsAdjustmentSet").withArgs(increase, 0n);
      expect(await nodeOperatorFee.rewardsAdjustment()).to.deep.equal([increase, timestamp]);
    });

    it("manual increase can decrease NO fee", async () => {
      const operatorFee = await nodeOperatorFee.nodeOperatorFeeRate();

      const rewards = ether("10");
      await hub.setReport(
        {
          totalValue: rewards,
          inOutDelta: 0n,
        },
        await getCurrentBlockTimestamp(),
        true,
      );

      const expectedFee = (rewards * operatorFee) / BP_BASE;
      expect(await nodeOperatorFee.nodeOperatorDisbursableFee()).to.equal(expectedFee);

      await nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseRewardsAdjustment(rewards / 2n);
      expect(await nodeOperatorFee.nodeOperatorDisbursableFee()).to.equal(expectedFee / 2n);

      await nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseRewardsAdjustment(rewards / 2n);
      expect(await nodeOperatorFee.nodeOperatorDisbursableFee()).to.equal(0n);
    });

    it("adjustment is reset after fee claim", async () => {
      const operatorFee = await nodeOperatorFee.nodeOperatorFeeRate();

      const rewards = ether("10");

      await hub.setReport(
        {
          totalValue: rewards,
          inOutDelta: 0n,
        },
        await getCurrentBlockTimestamp(),
        true,
      );

      const expectedFee = (rewards * operatorFee) / BP_BASE;
      expect(await nodeOperatorFee.nodeOperatorDisbursableFee()).to.equal(expectedFee);

      const adjustment = rewards / 2n;
      const timestamp = await getNextBlockTimestamp();
      await nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseRewardsAdjustment(adjustment);
      expect(await nodeOperatorFee.rewardsAdjustment()).to.deep.equal([adjustment, timestamp]);

      const adjustedFee = expectedFee - (adjustment * operatorFee) / BP_BASE;
      expect(await nodeOperatorFee.nodeOperatorDisbursableFee()).to.equal(adjustedFee);

      await expect(nodeOperatorFee.connect(stranger).disburseNodeOperatorFee())
        .to.emit(nodeOperatorFee, "NodeOperatorFeeDisbursed")
        .withArgs(stranger, adjustedFee);

      expect(await nodeOperatorFee.nodeOperatorDisbursableFee()).to.equal(0n);
    });
  });

  context("setAccruedRewardsAdjustment", () => {
    it("reverts if called by not CONFORMING_ROLE", async () => {
      await expect(nodeOperatorFee.connect(stranger).setRewardsAdjustment(100n, 0n)).to.be.revertedWithCustomError(
        nodeOperatorFee,
        "SenderNotMember",
      );
    });

    it("reverts if trying to set same adjustment", async () => {
      const { amount: current } = await nodeOperatorFee.rewardsAdjustment();
      await nodeOperatorFee.connect(nodeOperatorManager).setRewardsAdjustment(current, current);

      await expect(
        nodeOperatorFee.connect(vaultOwner).setRewardsAdjustment(current, current),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "SameAdjustment");
    });

    it("reverts if trying to set more than limit", async () => {
      const { amount: current } = await nodeOperatorFee.rewardsAdjustment();
      const LIMIT = await nodeOperatorFee.MANUAL_REWARDS_ADJUSTMENT_LIMIT();

      await nodeOperatorFee.connect(nodeOperatorManager).setRewardsAdjustment(LIMIT + 1n, current);

      await expect(
        nodeOperatorFee.connect(vaultOwner).setRewardsAdjustment(LIMIT + 1n, current),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "IncreasedOverLimit");
    });

    it("reverts vote if AccruedRewardsAdjustment changes", async () => {
      const { amount: current } = await nodeOperatorFee.rewardsAdjustment();
      expect(current).to.equal(0n);

      const proposed = 100n;
      const increase = proposed - current + 100n; // 200n
      const postIncrease = current + increase;

      // still the same
      await nodeOperatorFee.connect(nodeOperatorManager).setRewardsAdjustment(proposed, current);
      expect(await nodeOperatorFee.rewardsAdjustment()).to.deep.equal([current, 0n]);

      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_REWARDS_ADJUST_ROLE(), nodeOperatorRewardAdjuster);

      // now the adjustment is updated
      const timestamp = await getNextBlockTimestamp();
      await nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseRewardsAdjustment(increase);
      expect(await nodeOperatorFee.rewardsAdjustment()).to.deep.equal([postIncrease, timestamp]);

      await expect(nodeOperatorFee.connect(vaultOwner).setRewardsAdjustment(proposed, current))
        .to.be.revertedWithCustomError(nodeOperatorFee, "InvalidatedAdjustmentVote")
        .withArgs(postIncrease, current);
    });

    it("allows to set adjustment by committee", async () => {
      const { amount: currentAdjustment } = await nodeOperatorFee.rewardsAdjustment();
      expect(currentAdjustment).to.equal(0n);
      const newAdjustment = 100n;

      const msgData = nodeOperatorFee.interface.encodeFunctionData("setRewardsAdjustment", [
        newAdjustment,
        currentAdjustment,
      ]);

      let confirmTimestamp = (await getNextBlockTimestamp()) + (await nodeOperatorFee.getConfirmExpiry());

      const firstConfirmTx = await nodeOperatorFee
        .connect(nodeOperatorManager)
        .setRewardsAdjustment(newAdjustment, currentAdjustment);

      await expect(firstConfirmTx)
        .to.emit(nodeOperatorFee, "RoleMemberConfirmed")
        .withArgs(nodeOperatorManager, await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(), confirmTimestamp, msgData);

      expect(await nodeOperatorFee.rewardsAdjustment()).to.deep.equal([currentAdjustment, 0n]);

      confirmTimestamp = (await getNextBlockTimestamp()) + (await nodeOperatorFee.getConfirmExpiry());

      const timestamp = await getNextBlockTimestamp();
      const secondConfirmTx = await nodeOperatorFee
        .connect(vaultOwner)
        .setRewardsAdjustment(newAdjustment, currentAdjustment);

      await expect(secondConfirmTx)
        .to.emit(nodeOperatorFee, "RoleMemberConfirmed")
        .withArgs(vaultOwner, await nodeOperatorFee.DEFAULT_ADMIN_ROLE(), confirmTimestamp, msgData)
        .to.emit(nodeOperatorFee, "RewardsAdjustmentSet")
        .withArgs(newAdjustment, currentAdjustment);

      expect(await nodeOperatorFee.rewardsAdjustment()).to.deep.equal([newAdjustment, timestamp]);
    });
  });

  context("setNodeOperatorFeeRate", () => {
    it("reverts if called by not CONFIRMING_ROLE", async () => {
      await expect(nodeOperatorFee.connect(stranger).setNodeOperatorFeeRate(100n)).to.be.revertedWithCustomError(
        nodeOperatorFee,
        "SenderNotMember",
      );
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
        },
        await getCurrentBlockTimestamp(),
        isReportFresh,
      );

      await expect(nodeOperatorFee.connect(vaultOwner).setNodeOperatorFeeRate(100n)).to.be.revertedWithCustomError(
        nodeOperatorFee,
        "ReportStale",
      );
    });

    it("reverts if there is a pending adjustment", async () => {
      // grant vaultOwner the NODE_OPERATOR_MANAGER_ROLE to set the fee rate
      // to simplify the test
      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(), vaultOwner);

      const { amount: currentAdjustment } = await nodeOperatorFee.rewardsAdjustment();

      await hub.setReport(
        {
          totalValue: ether("100"),
          inOutDelta: ether("100"),
        },
        await getNextBlockTimestamp(),
        true,
      );

      await advanceChainTime(1n);

      const newAdjustment = 100n;
      await nodeOperatorFee.setRewardsAdjustment(newAdjustment, currentAdjustment);

      await expect(nodeOperatorFee.connect(vaultOwner).setNodeOperatorFeeRate(100n)).to.be.revertedWithCustomError(
        nodeOperatorFee,
        "AdjustmentNotReported",
      );
    });

    it("reverts if the adjustment is not zero", async () => {
      // grant vaultOwner the NODE_OPERATOR_MANAGER_ROLE to set the fee rate
      // to simplify the test
      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(), vaultOwner);

      const { amount: currentAdjustment } = await nodeOperatorFee.rewardsAdjustment();

      const newAdjustment = 100n;
      await nodeOperatorFee.setRewardsAdjustment(newAdjustment, currentAdjustment);

      await advanceChainTime(1n);

      await hub.setReport(
        {
          totalValue: ether("100"),
          inOutDelta: ether("100"),
        },
        await getNextBlockTimestamp(),
        true,
      );

      await expect(nodeOperatorFee.connect(vaultOwner).setNodeOperatorFeeRate(100n)).to.be.revertedWithCustomError(
        nodeOperatorFee,
        "AdjustmentNotSettled",
      );
    });

    it("reverts if the adjustment is set in the same block (same timestamp)", async () => {
      // grant vaultOwner the NODE_OPERATOR_MANAGER_ROLE to set the fee rate
      // to simplify the test
      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(), vaultOwner);

      const { amount: currentAdjustment } = await nodeOperatorFee.rewardsAdjustment();
      expect(currentAdjustment).to.equal(0n);

      const newAdjustment = 100n;
      await nodeOperatorFee.connect(vaultOwner).setRewardsAdjustment(newAdjustment, currentAdjustment);
      const { latestTimestamp } = await nodeOperatorFee.rewardsAdjustment();

      await hub.setReport(
        {
          totalValue: ether("100"),
          inOutDelta: ether("100"),
        },
        latestTimestamp,
        true,
      );

      expect(await nodeOperatorFee.rewardsAdjustment()).to.deep.equal([newAdjustment, latestTimestamp]);
      expect(await hub.latestVaultReportTimestamp(vault)).to.equal(latestTimestamp);

      await expect(nodeOperatorFee.connect(vaultOwner).setNodeOperatorFeeRate(100n)).to.be.revertedWithCustomError(
        nodeOperatorFee,
        "AdjustmentNotReported",
      );
    });

    it("disburses any pending node operator fee", async () => {
      // grant vaultOwner the NODE_OPERATOR_MANAGER_ROLE to set the fee rate
      // to simplify the test
      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(), vaultOwner);

      const nodeOperatorFeeRate = await nodeOperatorFee.nodeOperatorFeeRate();

      const rewards = ether("1");

      await hub.setReport(
        {
          totalValue: rewards,
          inOutDelta: 0n,
        },
        await getCurrentBlockTimestamp(),
        true,
      );

      const expectedFee = (rewards * nodeOperatorFeeRate) / BP_BASE;

      expect(await nodeOperatorFee.nodeOperatorDisbursableFee()).to.equal(expectedFee);

      const newOperatorFeeRate = 5_00n; // 5%
      await expect(nodeOperatorFee.connect(vaultOwner).setNodeOperatorFeeRate(newOperatorFeeRate))
        .to.emit(nodeOperatorFee, "NodeOperatorFeeDisbursed")
        .withArgs(vaultOwner, expectedFee);

      expect(await nodeOperatorFee.nodeOperatorDisbursableFee()).to.equal(0);
    });
  });

  async function assertSoleMember(account: HardhatEthersSigner, role: string) {
    expect(await nodeOperatorFee.hasRole(role, account)).to.be.true;
    expect(await nodeOperatorFee.getRoleMemberCount(role)).to.equal(1);
  }
});
