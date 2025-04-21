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

import { certainAddress, days, ether, findEvents, getCurrentBlockTimestamp, getNextBlockTimestamp } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

const BP_BASE = 10000n;

describe("NodeOperatorFee.sol", () => {
  let deployer: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let nodeOperatorManager: HardhatEthersSigner;
  let nodeOperatorFeeClaimer: HardhatEthersSigner;
  let nodeOperatorRewardAdjuster: HardhatEthersSigner;
  let vaultDepositor: HardhatEthersSigner;

  let stranger: HardhatEthersSigner;
  const recipient = certainAddress("some-recipient");

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

  const initialNodeOperatorFeeBP = 0n;
  const initialConfirmExpiry = days(7n);

  before(async () => {
    [
      deployer,
      vaultOwner,
      stranger,
      vaultDepositor,
      nodeOperatorManager,
      nodeOperatorRewardAdjuster,
      nodeOperatorFeeClaimer,
    ] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__MockForNodeOperatorFee");
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);

    lidoLocator = await deployLidoLocator({ lido: steth, wstETH: wsteth, predepositGuarantee: vaultDepositor });
    hub = await ethers.deployContract("VaultHub__MockForNodeOperatorFee", [lidoLocator, steth]);

    nodeOperatorFeeImpl = await ethers.deployContract("NodeOperatorFee__Harness", [hub]);

    vaultImpl = await ethers.deployContract("StakingVault__MockForNodeOperatorFee", [hub]);

    beacon = await ethers.deployContract("UpgradeableBeacon", [vaultImpl, deployer]);

    factory = await ethers.deployContract("VaultFactory__MockForNodeOperatorFee", [beacon, nodeOperatorFeeImpl]);
    expect(await beacon.implementation()).to.equal(vaultImpl);
    expect(await factory.BEACON()).to.equal(beacon);
    expect(await factory.NODE_OPERATOR_FEE_IMPL()).to.equal(nodeOperatorFeeImpl);

    const vaultCreationTx = await factory
      .connect(vaultOwner)
      .createVaultWithNodeOperatorFee(vaultOwner, nodeOperatorManager, initialNodeOperatorFeeBP, initialConfirmExpiry);

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
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  it("hello", async () => {
    expect(await vault.vaultHub()).to.equal(hub);
  });

  context("initialize", () => {
    it("reverts if already initialized", async () => {
      await expect(
        nodeOperatorFee.initialize(vaultOwner, nodeOperatorManager, 0n, days(7n)),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "AlreadyInitialized");
    });

    it("reverts if called on the implementation", async () => {
      const nodeOperatorFeeImpl_ = await ethers.deployContract("NodeOperatorFee__Harness", [hub]);

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
      expect(await nodeOperatorFee.getRoleAdmin(await nodeOperatorFee.NODE_OPERATOR_FEE_CLAIM_ROLE())).to.equal(
        await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(),
      );
      expect(await nodeOperatorFee.getRoleAdmin(await nodeOperatorFee.NODE_OPERATOR_REWARDS_ADJUST_ROLE())).to.equal(
        await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(),
      );

      expect(await nodeOperatorFee.getConfirmExpiry()).to.equal(initialConfirmExpiry);
      expect(await nodeOperatorFee.nodeOperatorFeeBP()).to.equal(initialNodeOperatorFeeBP);
      expect(await nodeOperatorFee.nodeOperatorUnclaimedFee()).to.equal(0n);
      expect(await nodeOperatorFee.nodeOperatorFeeClaimedReport()).to.deep.equal([0n, 0n, 0n]);
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

  context("claimNodeOperatorFee", () => {
    beforeEach(async () => {
      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_FEE_CLAIM_ROLE(), nodeOperatorFeeClaimer);
    });

    it("reverts if the caller does not have the operator due claim role", async () => {
      await expect(nodeOperatorFee.connect(stranger).claimNodeOperatorFee(stranger)).to.be.revertedWithCustomError(
        nodeOperatorFee,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if the recipient is the zero address", async () => {
      await expect(nodeOperatorFee.connect(nodeOperatorFeeClaimer).claimNodeOperatorFee(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(nodeOperatorFee, "ZeroArgument")
        .withArgs("_recipient");
    });

    it("reverts if there is no fee accumulated", async () => {
      expect(await nodeOperatorFee.nodeOperatorUnclaimedFee()).to.equal(0n);

      await expect(
        nodeOperatorFee.connect(nodeOperatorFeeClaimer).claimNodeOperatorFee(recipient),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "NoUnclaimedFee");
    });

    it("claims the fee", async () => {
      const operatorFee = 10_00n; // 10%
      await nodeOperatorFee.connect(vaultOwner).setNodeOperatorFeeBP(operatorFee);
      await nodeOperatorFee.connect(nodeOperatorManager).setNodeOperatorFeeBP(operatorFee);
      expect(await nodeOperatorFee.nodeOperatorFeeBP()).to.equal(operatorFee);

      const report = {
        totalValue: ether("1.1"),
        inOutDelta: ether("1"),
        timestamp: await getCurrentBlockTimestamp(),
      };

      await vault.setLatestReport(report);

      const expectedNodeOperatorFee = ((report.totalValue - report.inOutDelta) * operatorFee) / BP_BASE;

      await expect(nodeOperatorFee.connect(nodeOperatorFeeClaimer).claimNodeOperatorFee(recipient))
        .to.emit(vault, "Mock__Withdrawn")
        .withArgs(nodeOperatorFee, recipient, expectedNodeOperatorFee);

      expect(await nodeOperatorFee.nodeOperatorUnclaimedFee()).to.equal(0n);
    });
  });

  context("increaseAccruedRewardsAdjustment", () => {
    beforeEach(async () => {
      const operatorFee = 10_00n; // 10%
      await nodeOperatorFee.connect(nodeOperatorManager).setNodeOperatorFeeBP(operatorFee);
      await nodeOperatorFee.connect(vaultOwner).setNodeOperatorFeeBP(operatorFee);

      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_REWARDS_ADJUST_ROLE(), nodeOperatorRewardAdjuster);
    });

    it("reverts if non NODE_OPERATOR_REWARDS_ADJUST_ROLE sets adjustment", async () => {
      await expect(
        nodeOperatorFee.connect(stranger).increaseAccruedRewardsAdjustment(100n),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "AccessControlUnauthorizedAccount");
    });

    it("revert for zero increase", async () => {
      await expect(
        nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(0n),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "SameAdjustment");
    });

    it("reverts if manually adjust more than limit", async () => {
      const LIMIT = await nodeOperatorFee.MANUAL_ACCRUED_REWARDS_ADJUSTMENT_LIMIT();
      const increase = ether("1");

      await expect(
        nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(LIMIT + 1n),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "IncreasedOverLimit");

      expect(await nodeOperatorFee.accruedRewardsAdjustment()).to.equal(0n);

      await nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(increase);
      expect(await nodeOperatorFee.accruedRewardsAdjustment()).to.equal(increase);

      await expect(
        nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(LIMIT),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "IncreasedOverLimit");

      const increase2 = LIMIT - increase;
      await nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(increase2);
      expect(await nodeOperatorFee.accruedRewardsAdjustment()).to.equal(LIMIT);

      await expect(
        nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(1n),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "IncreasedOverLimit");
    });

    it("adjuster can increaseAccruedRewardsAdjustment", async () => {
      const increase = ether("10");

      expect(await nodeOperatorFee.accruedRewardsAdjustment()).to.equal(0n);
      const tx = await nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(increase);

      await expect(tx).to.emit(nodeOperatorFee, "AccruedRewardsAdjustmentSet").withArgs(increase, 0n);

      expect(await nodeOperatorFee.accruedRewardsAdjustment()).to.equal(increase);
    });

    it("manual increase can decrease NO fee", async () => {
      const operatorFee = await nodeOperatorFee.nodeOperatorFeeBP();

      const rewards = ether("10");
      await vault.setLatestReport({
        totalValue: rewards,
        inOutDelta: 0n,
        timestamp: await getCurrentBlockTimestamp(),
      });

      const expectedDue = (rewards * operatorFee) / BP_BASE;
      expect(await nodeOperatorFee.nodeOperatorUnclaimedFee()).to.equal(expectedDue);

      await nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(rewards / 2n);
      expect(await nodeOperatorFee.nodeOperatorUnclaimedFee()).to.equal(expectedDue / 2n);

      await nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(rewards / 2n);
      expect(await nodeOperatorFee.nodeOperatorUnclaimedFee()).to.equal(0n);
    });

    it("adjustment is reset after fee claim", async () => {
      const operatorFee = await nodeOperatorFee.nodeOperatorFeeBP();

      const rewards = ether("10");

      await vault.setLatestReport({
        totalValue: rewards,
        inOutDelta: 0n,
        timestamp: await getCurrentBlockTimestamp(),
      });
      const expectedDue = (rewards * operatorFee) / BP_BASE;
      expect(await nodeOperatorFee.nodeOperatorUnclaimedFee()).to.equal(expectedDue);

      await nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(rewards / 2n);
      expect(await nodeOperatorFee.accruedRewardsAdjustment()).to.equal(rewards / 2n);

      const adjustedDue = expectedDue / 2n;
      expect(await nodeOperatorFee.nodeOperatorUnclaimedFee()).to.equal(adjustedDue);

      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_FEE_CLAIM_ROLE(), nodeOperatorFeeClaimer);

      await expect(nodeOperatorFee.connect(nodeOperatorFeeClaimer).claimNodeOperatorFee(recipient))
        .to.emit(vault, "Mock__Withdrawn")
        .withArgs(nodeOperatorFee, recipient, adjustedDue)
        .to.emit(nodeOperatorFee, "AccruedRewardsAdjustmentSet")
        .withArgs(0n, rewards / 2n);
    });
  });

  context("setAccruedRewardsAdjustment", () => {
    beforeEach(async () => {
      const operatorFee = 10_00n; // 10%
      await nodeOperatorFee.connect(nodeOperatorManager).setNodeOperatorFeeBP(operatorFee);
      await nodeOperatorFee.connect(vaultOwner).setNodeOperatorFeeBP(operatorFee);
    });

    it("reverts if called by not CONFORMING_ROLE", async () => {
      await expect(
        nodeOperatorFee.connect(stranger).setAccruedRewardsAdjustment(100n, 0n),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "SenderNotMember");
    });

    it("reverts if trying to set same adjustment", async () => {
      const current = await nodeOperatorFee.accruedRewardsAdjustment();
      await nodeOperatorFee.connect(nodeOperatorManager).setAccruedRewardsAdjustment(current, current);

      await expect(
        nodeOperatorFee.connect(vaultOwner).setAccruedRewardsAdjustment(current, current),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "SameAdjustment");
    });

    it("reverts if trying to set more than limit", async () => {
      const current = await nodeOperatorFee.accruedRewardsAdjustment();
      const LIMIT = await nodeOperatorFee.MANUAL_ACCRUED_REWARDS_ADJUSTMENT_LIMIT();

      await nodeOperatorFee.connect(nodeOperatorManager).setAccruedRewardsAdjustment(LIMIT + 1n, current);

      await expect(
        nodeOperatorFee.connect(vaultOwner).setAccruedRewardsAdjustment(LIMIT + 1n, current),
      ).to.be.revertedWithCustomError(nodeOperatorFee, "IncreasedOverLimit");
    });

    it("reverts vote if AccruedRewardsAdjustment changes", async () => {
      const current = await nodeOperatorFee.accruedRewardsAdjustment();
      expect(current).to.equal(0n);
      const proposed = 100n;
      const increase = proposed - current + 100n;
      const postIncrease = current + increase;

      await nodeOperatorFee.connect(nodeOperatorManager).setAccruedRewardsAdjustment(proposed, current);
      expect(await nodeOperatorFee.accruedRewardsAdjustment()).to.equal(current);

      await nodeOperatorFee
        .connect(nodeOperatorManager)
        .grantRole(await nodeOperatorFee.NODE_OPERATOR_REWARDS_ADJUST_ROLE(), nodeOperatorRewardAdjuster);

      await nodeOperatorFee.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(increase);
      expect(await nodeOperatorFee.accruedRewardsAdjustment()).to.equal(postIncrease);

      await expect(nodeOperatorFee.connect(vaultOwner).setAccruedRewardsAdjustment(proposed, current))
        .to.be.revertedWithCustomError(nodeOperatorFee, "InvalidatedAdjustmentVote")
        .withArgs(postIncrease, current);
    });

    it("allows to set adjustment by committee", async () => {
      const currentAdjustment = await nodeOperatorFee.accruedRewardsAdjustment();
      expect(currentAdjustment).to.equal(0n);
      const newAdjustment = 100n;

      const msgData = nodeOperatorFee.interface.encodeFunctionData("setAccruedRewardsAdjustment", [
        newAdjustment,
        currentAdjustment,
      ]);

      let confirmTimestamp = (await getNextBlockTimestamp()) + (await nodeOperatorFee.getConfirmExpiry());

      const firstConfirmTx = await nodeOperatorFee
        .connect(nodeOperatorManager)
        .setAccruedRewardsAdjustment(newAdjustment, currentAdjustment);

      await expect(firstConfirmTx)
        .to.emit(nodeOperatorFee, "RoleMemberConfirmed")
        .withArgs(nodeOperatorManager, await nodeOperatorFee.NODE_OPERATOR_MANAGER_ROLE(), confirmTimestamp, msgData);

      expect(await nodeOperatorFee.accruedRewardsAdjustment()).to.equal(currentAdjustment);

      confirmTimestamp = (await getNextBlockTimestamp()) + (await nodeOperatorFee.getConfirmExpiry());

      const secondConfirmTx = await nodeOperatorFee
        .connect(vaultOwner)
        .setAccruedRewardsAdjustment(newAdjustment, currentAdjustment);

      await expect(secondConfirmTx)
        .to.emit(nodeOperatorFee, "RoleMemberConfirmed")
        .withArgs(vaultOwner, await nodeOperatorFee.DEFAULT_ADMIN_ROLE(), confirmTimestamp, msgData)
        .to.emit(nodeOperatorFee, "AccruedRewardsAdjustmentSet")
        .withArgs(newAdjustment, currentAdjustment);

      expect(await nodeOperatorFee.accruedRewardsAdjustment()).to.equal(newAdjustment);
    });
  });

  async function assertSoleMember(account: HardhatEthersSigner, role: string) {
    expect(await nodeOperatorFee.hasRole(role, account)).to.be.true;
    expect(await nodeOperatorFee.getRoleMemberCount(role)).to.equal(1);
  }
});
