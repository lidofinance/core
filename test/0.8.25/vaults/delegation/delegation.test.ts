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
  WETH9__MockForVault,
  WstETH__HarnessForVault,
} from "typechain-types";

import { advanceChainTime, certainAddress, days, ether, findEvents, getNextBlockTimestamp, impersonate } from "lib";

import { Snapshot } from "test/suite";

const BP_BASE = 10000n;
const MAX_FEE = BP_BASE;

describe("Delegation.sol", () => {
  let vaultOwner: HardhatEthersSigner;
  let curator: HardhatEthersSigner;
  let staker: HardhatEthersSigner;
  let tokenMaster: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let claimOperatorDueRole: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let beaconOwner: HardhatEthersSigner;
  let hubSigner: HardhatEthersSigner;
  let rewarder: HardhatEthersSigner;
  const recipient = certainAddress("some-recipient");

  let steth: StETH__MockForDelegation;
  let weth: WETH9__MockForVault;
  let wsteth: WstETH__HarnessForVault;
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
    [vaultOwner, curator, staker, tokenMaster, operator, claimOperatorDueRole, stranger, rewarder, beaconOwner] =
      await ethers.getSigners();

    steth = await ethers.deployContract("StETH__MockForDelegation");
    weth = await ethers.deployContract("WETH9__MockForVault");
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);
    hub = await ethers.deployContract("VaultHub__MockForDelegation", [steth]);

    delegationImpl = await ethers.deployContract("Delegation", [steth, weth, wsteth]);
    expect(await delegationImpl.WETH()).to.equal(weth);
    expect(await delegationImpl.STETH()).to.equal(steth);
    expect(await delegationImpl.WSTETH()).to.equal(wsteth);

    depositContract = await ethers.deployContract("DepositContract__MockForStakingVault");
    vaultImpl = await ethers.deployContract("StakingVault", [hub, depositContract]);
    expect(await vaultImpl.vaultHub()).to.equal(hub);

    beacon = await ethers.deployContract("UpgradeableBeacon", [vaultImpl, beaconOwner]);

    factory = await ethers.deployContract("VaultFactory", [beacon.getAddress(), delegationImpl.getAddress()]);
    expect(await beacon.implementation()).to.equal(vaultImpl);
    expect(await factory.BEACON()).to.equal(beacon);
    expect(await factory.DELEGATION_IMPL()).to.equal(delegationImpl);

    const vaultCreationTx = await factory.connect(vaultOwner).createVaultWithDelegation(
      {
        defaultAdmin: vaultOwner,
        curator,
        staker,
        tokenMaster,
        operator,
        claimOperatorDueRole,
        curatorFee: 0n,
        operatorFee: 0n,
      },
      "0x",
    );

    const vaultCreationReceipt = await vaultCreationTx.wait();
    if (!vaultCreationReceipt) throw new Error("Vault creation receipt not found");

    const vaultCreatedEvents = findEvents(vaultCreationReceipt, "VaultCreated");
    expect(vaultCreatedEvents.length).to.equal(1);

    const stakingVaultAddress = vaultCreatedEvents[0].args.vault;
    vault = await ethers.getContractAt("StakingVault", stakingVaultAddress, vaultOwner);
    expect(await vault.beacon()).to.equal(beacon);

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
      await expect(ethers.deployContract("Delegation", [ethers.ZeroAddress, weth, wsteth]))
        .to.be.revertedWithCustomError(delegation, "ZeroArgument")
        .withArgs("_stETH");
    });

    it("reverts if wETH is zero address", async () => {
      await expect(ethers.deployContract("Delegation", [steth, ethers.ZeroAddress, wsteth]))
        .to.be.revertedWithCustomError(delegation, "ZeroArgument")
        .withArgs("_WETH");
    });

    it("reverts if wstETH is zero address", async () => {
      await expect(ethers.deployContract("Delegation", [steth, weth, ethers.ZeroAddress]))
        .to.be.revertedWithCustomError(delegation, "ZeroArgument")
        .withArgs("_wstETH");
    });

    it("sets the stETH address", async () => {
      const delegation_ = await ethers.deployContract("Delegation", [steth, weth, wsteth]);
      expect(await delegation_.STETH()).to.equal(steth);
    });
  });

  context("initialize", () => {
    it("reverts if staking vault is zero address", async () => {
      const delegation_ = await ethers.deployContract("Delegation", [steth, weth, wsteth]);

      await expect(delegation_.initialize(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(delegation_, "ZeroArgument")
        .withArgs("_stakingVault");
    });

    it("reverts if already initialized", async () => {
      await expect(delegation.initialize(vault)).to.be.revertedWithCustomError(delegation, "AlreadyInitialized");
    });

    it("reverts if called on the implementation", async () => {
      const delegation_ = await ethers.deployContract("Delegation", [steth, weth, wsteth]);

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
      expect(await delegation.hasRole(await delegation.CURATOR_ROLE(), curator)).to.be.true;
      expect(await delegation.getRoleMemberCount(await delegation.CURATOR_ROLE())).to.equal(1);
      expect(await delegation.hasRole(await delegation.STAKER_ROLE(), staker)).to.be.true;
      expect(await delegation.getRoleMemberCount(await delegation.STAKER_ROLE())).to.equal(1);
      expect(await delegation.hasRole(await delegation.TOKEN_MASTER_ROLE(), tokenMaster)).to.be.true;
      expect(await delegation.getRoleMemberCount(await delegation.TOKEN_MASTER_ROLE())).to.equal(1);
      expect(await delegation.hasRole(await delegation.OPERATOR_ROLE(), operator)).to.be.true;
      expect(await delegation.getRoleMemberCount(await delegation.OPERATOR_ROLE())).to.equal(1);
      expect(await delegation.hasRole(await delegation.CLAIM_OPERATOR_DUE_ROLE(), claimOperatorDueRole)).to.be.true;
      expect(await delegation.getRoleMemberCount(await delegation.CLAIM_OPERATOR_DUE_ROLE())).to.equal(1);

      expect(await delegation.curatorFee()).to.equal(0n);
      expect(await delegation.operatorFee()).to.equal(0n);
      expect(await delegation.curatorDue()).to.equal(0n);
      expect(await delegation.operatorDue()).to.equal(0n);
      expect(await delegation.curatorDueClaimedReport()).to.deep.equal([0n, 0n]);
      expect(await delegation.operatorDueClaimedReport()).to.deep.equal([0n, 0n]);
    });
  });

  context("votingCommittee", () => {
    it("returns the correct roles", async () => {
      expect(await delegation.votingCommittee()).to.deep.equal([
        await delegation.CURATOR_ROLE(),
        await delegation.OPERATOR_ROLE(),
      ]);
    });
  });

  context("setVoteLifetime", () => {
    it("reverts if the caller is not a member of the vote lifetime committee", async () => {
      await expect(delegation.connect(stranger).setVoteLifetime(days(10n))).to.be.revertedWithCustomError(
        delegation,
        "NotACommitteeMember",
      );
    });

    it("sets the new vote lifetime", async () => {
      const oldVoteLifetime = await delegation.voteLifetime();
      const newVoteLifetime = days(10n);
      const msgData = delegation.interface.encodeFunctionData("setVoteLifetime", [newVoteLifetime]);
      let voteTimestamp = await getNextBlockTimestamp();

      await expect(delegation.connect(curator).setVoteLifetime(newVoteLifetime))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(curator, await delegation.CURATOR_ROLE(), voteTimestamp, msgData);

      voteTimestamp = await getNextBlockTimestamp();
      await expect(delegation.connect(operator).setVoteLifetime(newVoteLifetime))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(operator, await delegation.OPERATOR_ROLE(), voteTimestamp, msgData)
        .and.to.emit(delegation, "VoteLifetimeSet")
        .withArgs(operator, oldVoteLifetime, newVoteLifetime);

      expect(await delegation.voteLifetime()).to.equal(newVoteLifetime);
    });
  });

  context("claimCuratorDue", () => {
    it("reverts if the caller is not a member of the curator due claim role", async () => {
      await expect(delegation.connect(stranger).claimCuratorDue(stranger))
        .to.be.revertedWithCustomError(delegation, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await delegation.CURATOR_ROLE());
    });

    it("reverts if the recipient is the zero address", async () => {
      await expect(delegation.connect(curator).claimCuratorDue(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(delegation, "ZeroArgument")
        .withArgs("_recipient");
    });

    it("reverts if the due is zero", async () => {
      expect(await delegation.curatorDue()).to.equal(0n);
      await expect(delegation.connect(curator).claimCuratorDue(stranger)).to.be.revertedWithCustomError(
        delegation,
        "NoDueToClaim",
      );
    });

    it("claims the due", async () => {
      const curatorFee = 10_00n; // 10%
      await delegation.connect(curator).setCuratorFee(curatorFee);
      expect(await delegation.curatorFee()).to.equal(curatorFee);

      const rewards = ether("1");
      await vault.connect(hubSigner).report(rewards, 0n, 0n);

      const expectedDue = (rewards * curatorFee) / BP_BASE;
      expect(await delegation.curatorDue()).to.equal(expectedDue);
      expect(await delegation.curatorDue()).to.be.greaterThan(await ethers.provider.getBalance(vault));

      expect(await ethers.provider.getBalance(vault)).to.equal(0n);
      await rewarder.sendTransaction({ to: vault, value: rewards });
      expect(await ethers.provider.getBalance(vault)).to.equal(rewards);

      expect(await ethers.provider.getBalance(recipient)).to.equal(0n);
      await expect(delegation.connect(curator).claimCuratorDue(recipient))
        .to.emit(vault, "Withdrawn")
        .withArgs(delegation, recipient, expectedDue);
      expect(await ethers.provider.getBalance(recipient)).to.equal(expectedDue);
      expect(await ethers.provider.getBalance(vault)).to.equal(rewards - expectedDue);
    });
  });

  context("claimOperatorDue", () => {
    it("reverts if the caller does not have the operator due claim role", async () => {
      await expect(delegation.connect(stranger).claimOperatorDue(stranger)).to.be.revertedWithCustomError(
        delegation,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if the recipient is the zero address", async () => {
      await expect(delegation.connect(claimOperatorDueRole).claimOperatorDue(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(delegation, "ZeroArgument")
        .withArgs("_recipient");
    });

    it("reverts if the due is zero", async () => {
      expect(await delegation.operatorDue()).to.equal(0n);
      await expect(delegation.connect(claimOperatorDueRole).claimOperatorDue(recipient)).to.be.revertedWithCustomError(
        delegation,
        "NoDueToClaim",
      );
    });

    it("claims the due", async () => {
      const operatorFee = 10_00n; // 10%
      await delegation.connect(operator).setOperatorFee(operatorFee);
      await delegation.connect(curator).setOperatorFee(operatorFee);
      expect(await delegation.operatorFee()).to.equal(operatorFee);

      const rewards = ether("1");
      await vault.connect(hubSigner).report(rewards, 0n, 0n);

      const expectedDue = (rewards * operatorFee) / BP_BASE;
      expect(await delegation.operatorDue()).to.equal(expectedDue);
      expect(await delegation.operatorDue()).to.be.greaterThan(await ethers.provider.getBalance(vault));

      expect(await ethers.provider.getBalance(vault)).to.equal(0n);
      await rewarder.sendTransaction({ to: vault, value: rewards });
      expect(await ethers.provider.getBalance(vault)).to.equal(rewards);

      expect(await ethers.provider.getBalance(recipient)).to.equal(0n);
      await expect(delegation.connect(claimOperatorDueRole).claimOperatorDue(recipient))
        .to.emit(vault, "Withdrawn")
        .withArgs(delegation, recipient, expectedDue);
      expect(await ethers.provider.getBalance(recipient)).to.equal(expectedDue);
      expect(await ethers.provider.getBalance(vault)).to.equal(rewards - expectedDue);
    });
  });

  context("unreserved", () => {
    it("initially returns 0", async () => {
      expect(await delegation.unreserved()).to.equal(0n);
    });

    it("returns 0 if locked is greater than valuation", async () => {
      const valuation = ether("2");
      const inOutDelta = 0n;
      const locked = ether("3");
      await vault.connect(hubSigner).report(valuation, inOutDelta, locked);

      expect(await delegation.unreserved()).to.equal(0n);
    });
  });

  context("fund", () => {
    it("reverts if the caller is not a member of the staker role", async () => {
      await expect(delegation.connect(stranger).fund()).to.be.revertedWithCustomError(
        delegation,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("funds the vault", async () => {
      const amount = ether("1");
      expect(await ethers.provider.getBalance(vault)).to.equal(0n);
      expect(await vault.inOutDelta()).to.equal(0n);
      expect(await vault.valuation()).to.equal(0n);

      await expect(delegation.connect(staker).fund({ value: amount }))
        .to.emit(vault, "Funded")
        .withArgs(delegation, amount);

      expect(await ethers.provider.getBalance(vault)).to.equal(amount);
      expect(await vault.inOutDelta()).to.equal(amount);
      expect(await vault.valuation()).to.equal(amount);
    });
  });

  context("withdraw", () => {
    it("reverts if the caller is not a member of the staker role", async () => {
      await expect(delegation.connect(stranger).withdraw(recipient, ether("1"))).to.be.revertedWithCustomError(
        delegation,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if the recipient is the zero address", async () => {
      await expect(delegation.connect(staker).withdraw(ethers.ZeroAddress, ether("1"))).to.be.revertedWithCustomError(
        delegation,
        "ZeroArgument",
      );
    });

    it("reverts if the amount is zero", async () => {
      await expect(delegation.connect(staker).withdraw(recipient, 0n)).to.be.revertedWithCustomError(
        delegation,
        "ZeroArgument",
      );
    });

    it("reverts if the amount is greater than the unreserved amount", async () => {
      const unreserved = await delegation.unreserved();
      await expect(delegation.connect(staker).withdraw(recipient, unreserved + 1n)).to.be.revertedWithCustomError(
        delegation,
        "RequestedAmountExceedsUnreserved",
      );
    });

    it("withdraws the amount", async () => {
      const amount = ether("1");
      await vault.connect(hubSigner).report(amount, 0n, 0n);
      expect(await vault.valuation()).to.equal(amount);
      expect(await vault.unlocked()).to.equal(amount);

      expect(await ethers.provider.getBalance(vault)).to.equal(0n);
      await rewarder.sendTransaction({ to: vault, value: amount });
      expect(await ethers.provider.getBalance(vault)).to.equal(amount);

      expect(await ethers.provider.getBalance(recipient)).to.equal(0n);
      await expect(delegation.connect(staker).withdraw(recipient, amount))
        .to.emit(vault, "Withdrawn")
        .withArgs(delegation, recipient, amount);
      expect(await ethers.provider.getBalance(vault)).to.equal(0n);
      expect(await ethers.provider.getBalance(recipient)).to.equal(amount);
    });
  });

  context("rebalance", () => {
    it("reverts if the caller is not a member of the curator role", async () => {
      await expect(delegation.connect(stranger).rebalanceVault(ether("1"))).to.be.revertedWithCustomError(
        delegation,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("rebalances the vault by transferring ether", async () => {
      const amount = ether("1");
      await delegation.connect(staker).fund({ value: amount });

      await expect(delegation.connect(curator).rebalanceVault(amount))
        .to.emit(hub, "Mock__Rebalanced")
        .withArgs(amount);
    });

    it("funds and rebalances the vault", async () => {
      const amount = ether("1");
      await expect(delegation.connect(curator).rebalanceVault(amount, { value: amount }))
        .to.emit(vault, "Funded")
        .withArgs(delegation, amount)
        .to.emit(hub, "Mock__Rebalanced")
        .withArgs(amount);
    });
  });

  context("mint", () => {
    it("reverts if the caller is not a member of the token master role", async () => {
      await expect(delegation.connect(stranger).mint(recipient, 1n)).to.be.revertedWithCustomError(
        delegation,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("mints the tokens", async () => {
      const amount = 100n;
      await expect(delegation.connect(tokenMaster).mint(recipient, amount))
        .to.emit(steth, "Transfer")
        .withArgs(ethers.ZeroAddress, recipient, amount);
    });
  });

  context("burn", () => {
    it("reverts if the caller is not a member of the token master role", async () => {
      await expect(delegation.connect(stranger).burn(100n)).to.be.revertedWithCustomError(
        delegation,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("burns the tokens", async () => {
      const amount = 100n;
      await delegation.connect(tokenMaster).mint(tokenMaster, amount);

      await expect(delegation.connect(tokenMaster).burn(amount))
        .to.emit(steth, "Transfer")
        .withArgs(tokenMaster, hub, amount)
        .and.to.emit(steth, "Transfer")
        .withArgs(hub, ethers.ZeroAddress, amount);
    });
  });

  context("setCuratorFee", () => {
    it("reverts if caller is not curator", async () => {
      await expect(delegation.connect(stranger).setCuratorFee(1000n))
        .to.be.revertedWithCustomError(delegation, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await delegation.CURATOR_ROLE());
    });

    it("reverts if new fee is greater than max fee", async () => {
      await expect(delegation.connect(curator).setCuratorFee(MAX_FEE + 1n)).to.be.revertedWithCustomError(
        delegation,
        "CombinedFeesExceed100Percent",
      );
    });

    it("sets the curator fee", async () => {
      const newCuratorFee = 1000n;
      await delegation.connect(curator).setCuratorFee(newCuratorFee);
      expect(await delegation.curatorFee()).to.equal(newCuratorFee);
    });
  });

  context("setOperatorFee", () => {
    it("reverts if new fee is greater than max fee", async () => {
      const invalidFee = MAX_FEE + 1n;
      await delegation.connect(curator).setOperatorFee(invalidFee);

      await expect(delegation.connect(operator).setOperatorFee(invalidFee)).to.be.revertedWithCustomError(
        delegation,
        "CombinedFeesExceed100Percent",
      );
    });

    it("reverts if performance due is not zero", async () => {
      // set the performance fee to 5%
      const newOperatorFee = 500n;
      await delegation.connect(curator).setOperatorFee(newOperatorFee);
      await delegation.connect(operator).setOperatorFee(newOperatorFee);
      expect(await delegation.operatorFee()).to.equal(newOperatorFee);

      // bring rewards
      const totalRewards = ether("1");
      const inOutDelta = 0n;
      const locked = 0n;
      await vault.connect(hubSigner).report(totalRewards, inOutDelta, locked);
      expect(await delegation.operatorDue()).to.equal((totalRewards * newOperatorFee) / BP_BASE);

      // attempt to change the performance fee to 6%
      await delegation.connect(curator).setOperatorFee(600n);
      await expect(delegation.connect(operator).setOperatorFee(600n)).to.be.revertedWithCustomError(
        delegation,
        "OperatorDueUnclaimed",
      );
    });

    it("requires both curator and operator to set the operator fee and emits the RoleMemberVoted event", async () => {
      const previousOperatorFee = await delegation.operatorFee();
      const newOperatorFee = 1000n;
      let voteTimestamp = await getNextBlockTimestamp();
      const msgData = delegation.interface.encodeFunctionData("setOperatorFee", [newOperatorFee]);

      await expect(delegation.connect(curator).setOperatorFee(newOperatorFee))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(curator, await delegation.CURATOR_ROLE(), voteTimestamp, msgData);
      // fee is unchanged
      expect(await delegation.operatorFee()).to.equal(previousOperatorFee);
      // check vote
      expect(await delegation.votings(keccak256(msgData), await delegation.CURATOR_ROLE())).to.equal(voteTimestamp);

      voteTimestamp = await getNextBlockTimestamp();
      await expect(delegation.connect(operator).setOperatorFee(newOperatorFee))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(operator, await delegation.OPERATOR_ROLE(), voteTimestamp, msgData)
        .and.to.emit(delegation, "OperatorFeeSet")
        .withArgs(operator, previousOperatorFee, newOperatorFee);

      expect(await delegation.operatorFee()).to.equal(newOperatorFee);

      // resets the votes
      for (const role of await delegation.votingCommittee()) {
        expect(await delegation.votings(keccak256(msgData), role)).to.equal(0n);
      }
    });

    it("reverts if the caller is not a member of the operator fee committee", async () => {
      const newOperatorFee = 1000n;
      await expect(delegation.connect(stranger).setOperatorFee(newOperatorFee)).to.be.revertedWithCustomError(
        delegation,
        "NotACommitteeMember",
      );
    });

    it("doesn't execute if an earlier vote has expired", async () => {
      const previousOperatorFee = await delegation.operatorFee();
      const newOperatorFee = 1000n;
      const msgData = delegation.interface.encodeFunctionData("setOperatorFee", [newOperatorFee]);
      const callId = keccak256(msgData);
      let voteTimestamp = await getNextBlockTimestamp();
      await expect(delegation.connect(curator).setOperatorFee(newOperatorFee))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(curator, await delegation.CURATOR_ROLE(), voteTimestamp, msgData);
      // fee is unchanged
      expect(await delegation.operatorFee()).to.equal(previousOperatorFee);
      // check vote
      expect(await delegation.votings(callId, await delegation.CURATOR_ROLE())).to.equal(voteTimestamp);

      // move time forward
      await advanceChainTime(days(7n) + 1n);
      const expectedVoteTimestamp = await getNextBlockTimestamp();
      expect(expectedVoteTimestamp).to.be.greaterThan(voteTimestamp + days(7n));
      await expect(delegation.connect(operator).setOperatorFee(newOperatorFee))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(operator, await delegation.OPERATOR_ROLE(), expectedVoteTimestamp, msgData);

      // fee is still unchanged
      expect(await delegation.operatorFee()).to.equal(previousOperatorFee);
      // check vote
      expect(await delegation.votings(callId, await delegation.OPERATOR_ROLE())).to.equal(expectedVoteTimestamp);

      // curator has to vote again
      voteTimestamp = await getNextBlockTimestamp();
      await expect(delegation.connect(curator).setOperatorFee(newOperatorFee))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(curator, await delegation.CURATOR_ROLE(), voteTimestamp, msgData)
        .and.to.emit(delegation, "OperatorFeeSet")
        .withArgs(curator, previousOperatorFee, newOperatorFee);
      // fee is now changed
      expect(await delegation.operatorFee()).to.equal(newOperatorFee);
    });
  });

  context("transferStVaultOwnership", () => {
    it("reverts if the caller is not a member of the transfer committee", async () => {
      await expect(delegation.connect(stranger).transferStVaultOwnership(recipient)).to.be.revertedWithCustomError(
        delegation,
        "NotACommitteeMember",
      );
    });

    it("requires both curator and operator to transfer ownership and emits the RoleMemberVoted event", async () => {
      const newOwner = certainAddress("newOwner");
      const msgData = delegation.interface.encodeFunctionData("transferStVaultOwnership", [newOwner]);
      let voteTimestamp = await getNextBlockTimestamp();
      await expect(delegation.connect(curator).transferStVaultOwnership(newOwner))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(curator, await delegation.CURATOR_ROLE(), voteTimestamp, msgData);
      // owner is unchanged
      expect(await vault.owner()).to.equal(delegation);

      voteTimestamp = await getNextBlockTimestamp();
      await expect(delegation.connect(operator).transferStVaultOwnership(newOwner))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(operator, await delegation.OPERATOR_ROLE(), voteTimestamp, msgData);
      // owner changed
      expect(await vault.owner()).to.equal(newOwner);
    });
  });
});
