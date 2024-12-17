import { expect } from "chai";
import { keccak256 } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Delegation,
  DepositContract__MockForStakingVault,
  StakingVault,
  StETH__MockForDelegation,
  UpgradeableBeacon,
  VaultFactory,
  VaultHub__MockForDelegation,
} from "typechain-types";

import { advanceChainTime, days, ether, findEvents, getNextBlockTimestamp, impersonate } from "lib";

import { Snapshot } from "test/suite";

const BP_BASE = 10000n;
const MAX_FEE = BP_BASE;

describe("Delegation", () => {
  let vaultOwner: HardhatEthersSigner;
  let manager: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let beaconOwner: HardhatEthersSigner;
  let hubSigner: HardhatEthersSigner;

  let steth: StETH__MockForDelegation;
  let hub: VaultHub__MockForDelegation;
  let depositContract: DepositContract__MockForStakingVault;
  let vaultImpl: StakingVault;
  let delegationImpl: Delegation;
  let factory: VaultFactory;
  let vault: StakingVault;
  let delegation: Delegation;
  let beacon: UpgradeableBeacon;

  let originalState: string;

  before(async () => {
    [vaultOwner, manager, operator, stranger, beaconOwner] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__MockForDelegation");
    delegationImpl = await ethers.deployContract("Delegation", [steth]);
    expect(await delegationImpl.stETH()).to.equal(steth);

    hub = await ethers.deployContract("VaultHub__MockForDelegation");
    depositContract = await ethers.deployContract("DepositContract__MockForStakingVault");
    vaultImpl = await ethers.deployContract("StakingVault", [hub, depositContract]);
    expect(await vaultImpl.vaultHub()).to.equal(hub);

    beacon = await ethers.deployContract("UpgradeableBeacon", [vaultImpl, beaconOwner]);

    factory = await ethers.deployContract("VaultFactory", [beacon.getAddress(), delegationImpl.getAddress()]);
    expect(await beacon.implementation()).to.equal(vaultImpl);
    expect(await factory.BEACON()).to.equal(beacon);
    expect(await factory.DELEGATION_IMPL()).to.equal(delegationImpl);

    const vaultCreationTx = await factory
      .connect(vaultOwner)
      .createVaultWithDelegation(
        { managementFeeBP: 0n, performanceFeeBP: 0n, defaultAdmin: vaultOwner, manager, operator },
        "0x",
      );
    const vaultCreationReceipt = await vaultCreationTx.wait();
    if (!vaultCreationReceipt) throw new Error("Vault creation receipt not found");

    const vaultCreatedEvents = findEvents(vaultCreationReceipt, "VaultCreated");
    expect(vaultCreatedEvents.length).to.equal(1);
    const stakingVaultAddress = vaultCreatedEvents[0].args.vault;
    vault = await ethers.getContractAt("StakingVault", stakingVaultAddress, vaultOwner);
    expect(await vault.beacon()).to.equal(beacon);
    expect(await vault.factory()).to.equal(factory);

    const delegationCreatedEvents = findEvents(vaultCreationReceipt, "DelegationCreated");
    expect(delegationCreatedEvents.length).to.equal(1);
    const delegationAddress = delegationCreatedEvents[0].args.delegation;
    delegation = await ethers.getContractAt("Delegation", delegationAddress, vaultOwner);
    expect(await delegation.stakingVault()).to.equal(vault);

    hubSigner = await impersonate(await hub.getAddress(), ether("100"));
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  context("constructor", () => {
    it("reverts if stETH is zero address", async () => {
      await expect(ethers.deployContract("Delegation", [ethers.ZeroAddress]))
        .to.be.revertedWithCustomError(delegation, "ZeroArgument")
        .withArgs("_stETH");
    });

    it("sets the stETH address", async () => {
      const delegation_ = await ethers.deployContract("Delegation", [steth]);
      expect(await delegation_.stETH()).to.equal(steth);
    });
  });

  context("initialize", () => {
    it("reverts if staking vault is zero address", async () => {
      const delegation_ = await ethers.deployContract("Delegation", [steth]);

      await expect(delegation_.initialize(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(delegation_, "ZeroArgument")
        .withArgs("_stakingVault");
    });

    it("reverts if already initialized", async () => {
      await expect(delegation.initialize(vault)).to.be.revertedWithCustomError(delegation, "AlreadyInitialized");
    });

    it("reverts if called on the implementation", async () => {
      const delegation_ = await ethers.deployContract("Delegation", [steth]);

      await expect(delegation_.initialize(vault)).to.be.revertedWithCustomError(delegation_, "NonProxyCallsForbidden");
    });
  });

  context("initialized state", () => {
    it("initializes the contract correctly", async () => {
      expect(await vault.owner()).to.equal(delegation);
      expect(await vault.operator()).to.equal(operator);

      expect(await delegation.stakingVault()).to.equal(vault);
      expect(await delegation.vaultHub()).to.equal(hub);

      expect(await delegation.hasRole(await delegation.DEFAULT_ADMIN_ROLE(), vaultOwner)).to.be.true;
      expect(await delegation.getRoleMemberCount(await delegation.DEFAULT_ADMIN_ROLE())).to.equal(1);
      expect(await delegation.hasRole(await delegation.MANAGER_ROLE(), manager)).to.be.true;
      expect(await delegation.getRoleMemberCount(await delegation.MANAGER_ROLE())).to.equal(1);
      expect(await delegation.hasRole(await delegation.OPERATOR_ROLE(), operator)).to.be.true;
      expect(await delegation.getRoleMemberCount(await delegation.OPERATOR_ROLE())).to.equal(1);

      expect(await delegation.getRoleMemberCount(await delegation.STAKER_ROLE())).to.equal(0);
      expect(await delegation.getRoleMemberCount(await delegation.TOKEN_MASTER_ROLE())).to.equal(0);

      expect(await delegation.managementFee()).to.equal(0n);
      expect(await delegation.performanceFee()).to.equal(0n);
      expect(await delegation.managementDue()).to.equal(0n);
      expect(await delegation.performanceDue()).to.equal(0n);
      expect(await delegation.lastClaimedReport()).to.deep.equal([0n, 0n]);
    });
  });

  context("withdrawable", () => {
    it("initially returns 0", async () => {
      expect(await delegation.withdrawable()).to.equal(0n);
    });

    it("returns 0 if locked is greater than valuation", async () => {
      const valuation = ether("2");
      const inOutDelta = 0n;
      const locked = ether("3");
      await vault.connect(hubSigner).report(valuation, inOutDelta, locked);

      expect(await delegation.withdrawable()).to.equal(0n);
    });

    it("returns 0 if dues are greater than valuation", async () => {
      const managementFee = 1000n;
      await delegation.connect(manager).setManagementFee(managementFee);
      expect(await delegation.managementFee()).to.equal(managementFee);

      // report rewards
      const valuation = ether("1");
      const inOutDelta = 0n;
      const locked = 0n;
      const expectedManagementDue = (valuation * managementFee) / 365n / BP_BASE;
      await vault.connect(hubSigner).report(valuation, inOutDelta, locked);
      expect(await vault.valuation()).to.equal(valuation);
      expect(await delegation.managementDue()).to.equal(expectedManagementDue);
      expect(await delegation.withdrawable()).to.equal(valuation - expectedManagementDue);

      // zero out the valuation, so that the management due is greater than the valuation
      await vault.connect(hubSigner).report(0n, 0n, 0n);
      expect(await vault.valuation()).to.equal(0n);
      expect(await delegation.managementDue()).to.equal(expectedManagementDue);

      expect(await delegation.withdrawable()).to.equal(0n);
    });
  });

  context("ownershipTransferCommittee", () => {
    it("returns the correct roles", async () => {
      expect(await delegation.ownershipTransferCommittee()).to.deep.equal([
        await delegation.MANAGER_ROLE(),
        await delegation.OPERATOR_ROLE(),
      ]);
    });
  });

  context("performanceFeeCommittee", () => {
    it("returns the correct roles", async () => {
      expect(await delegation.performanceFeeCommittee()).to.deep.equal([
        await delegation.MANAGER_ROLE(),
        await delegation.OPERATOR_ROLE(),
      ]);
    });
  });

  context("setManagementFee", () => {
    it("reverts if caller is not manager", async () => {
      await expect(delegation.connect(stranger).setManagementFee(1000n))
        .to.be.revertedWithCustomError(delegation, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await delegation.MANAGER_ROLE());
    });

    it("reverts if new fee is greater than max fee", async () => {
      await expect(delegation.connect(manager).setManagementFee(MAX_FEE + 1n)).to.be.revertedWithCustomError(
        delegation,
        "NewFeeCannotExceedMaxFee",
      );
    });

    it("sets the management fee", async () => {
      const newManagementFee = 1000n;
      await delegation.connect(manager).setManagementFee(newManagementFee);
      expect(await delegation.managementFee()).to.equal(newManagementFee);
    });
  });

  context("setPerformanceFee", () => {
    it("reverts if new fee is greater than max fee", async () => {
      const invalidFee = MAX_FEE + 1n;
      await delegation.connect(manager).setPerformanceFee(invalidFee);

      await expect(delegation.connect(operator).setPerformanceFee(invalidFee)).to.be.revertedWithCustomError(
        delegation,
        "NewFeeCannotExceedMaxFee",
      );
    });

    it("reverts if performance due is not zero", async () => {
      // set the performance fee to 5%
      const newPerformanceFee = 500n;
      await delegation.connect(manager).setPerformanceFee(newPerformanceFee);
      await delegation.connect(operator).setPerformanceFee(newPerformanceFee);
      expect(await delegation.performanceFee()).to.equal(newPerformanceFee);

      // bring rewards
      const totalRewards = ether("1");
      const inOutDelta = 0n;
      const locked = 0n;
      await vault.connect(hubSigner).report(totalRewards, inOutDelta, locked);
      expect(await delegation.performanceDue()).to.equal((totalRewards * newPerformanceFee) / BP_BASE);

      // attempt to change the performance fee to 6%
      await delegation.connect(manager).setPerformanceFee(600n);
      await expect(delegation.connect(operator).setPerformanceFee(600n)).to.be.revertedWithCustomError(
        delegation,
        "PerformanceDueUnclaimed",
      );
    });

    it("requires both manager and operator to set the performance fee and emits the RoleMemberVoted event", async () => {
      const previousPerformanceFee = await delegation.performanceFee();
      const newPerformanceFee = 1000n;
      let voteTimestamp = await getNextBlockTimestamp();
      const msgData = delegation.interface.encodeFunctionData("setPerformanceFee", [newPerformanceFee]);

      await expect(delegation.connect(manager).setPerformanceFee(newPerformanceFee))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(manager, await delegation.MANAGER_ROLE(), voteTimestamp, msgData);
      // fee is unchanged
      expect(await delegation.performanceFee()).to.equal(previousPerformanceFee);
      // check vote
      expect(await delegation.votings(keccak256(msgData), await delegation.MANAGER_ROLE())).to.equal(voteTimestamp);

      voteTimestamp = await getNextBlockTimestamp();
      await expect(delegation.connect(operator).setPerformanceFee(newPerformanceFee))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(operator, await delegation.OPERATOR_ROLE(), voteTimestamp, msgData);

      expect(await delegation.performanceFee()).to.equal(newPerformanceFee);

      // resets the votes
      for (const role of await delegation.performanceFeeCommittee()) {
        expect(await delegation.votings(keccak256(msgData), role)).to.equal(0n);
      }
    });

    it("reverts if the caller is not a member of the performance fee committee", async () => {
      const newPerformanceFee = 1000n;
      await expect(delegation.connect(stranger).setPerformanceFee(newPerformanceFee)).to.be.revertedWithCustomError(
        delegation,
        "NotACommitteeMember",
      );
    });

    it("doesn't execute if an earlier vote has expired", async () => {
      const previousPerformanceFee = await delegation.performanceFee();
      const newPerformanceFee = 1000n;
      const msgData = delegation.interface.encodeFunctionData("setPerformanceFee", [newPerformanceFee]);
      const callId = keccak256(msgData);
      let voteTimestamp = await getNextBlockTimestamp();
      await expect(delegation.connect(manager).setPerformanceFee(newPerformanceFee))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(manager, await delegation.MANAGER_ROLE(), voteTimestamp, msgData);
      // fee is unchanged
      expect(await delegation.performanceFee()).to.equal(previousPerformanceFee);
      // check vote
      expect(await delegation.votings(callId, await delegation.MANAGER_ROLE())).to.equal(voteTimestamp);

      // move time forward
      await advanceChainTime(days(7n) + 1n);
      const expectedVoteTimestamp = await getNextBlockTimestamp();
      expect(expectedVoteTimestamp).to.be.greaterThan(voteTimestamp + days(7n));
      await expect(delegation.connect(operator).setPerformanceFee(newPerformanceFee))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(operator, await delegation.OPERATOR_ROLE(), expectedVoteTimestamp, msgData);

      // fee is still unchanged
      expect(await delegation.connect(operator).performanceFee()).to.equal(previousPerformanceFee);
      // check vote
      expect(await delegation.votings(callId, await delegation.OPERATOR_ROLE())).to.equal(expectedVoteTimestamp);

      // manager has to vote again
      voteTimestamp = await getNextBlockTimestamp();
      await expect(delegation.connect(manager).setPerformanceFee(newPerformanceFee))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(manager, await delegation.MANAGER_ROLE(), voteTimestamp, msgData);
      // fee is now changed
      expect(await delegation.performanceFee()).to.equal(newPerformanceFee);
    });
  });
});
