import { expect } from "chai";
import { keccak256 } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Delegation,
  DepositContract__MockForStakingVault,
  LidoLocator,
  StakingVault,
  StETH__MockForDelegation,
  UpgradeableBeacon,
  VaultFactory,
  VaultHub__MockForDelegation,
  WETH9__MockForVault,
  WstETH__HarnessForVault,
} from "typechain-types";

import { advanceChainTime, certainAddress, days, ether, findEvents, getNextBlockTimestamp, impersonate } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

const BP_BASE = 10000n;
const MAX_FEE = BP_BASE;

describe("Delegation.sol", () => {
  let vaultOwner: HardhatEthersSigner;
  let funder: HardhatEthersSigner;
  let withdrawer: HardhatEthersSigner;
  let minter: HardhatEthersSigner;
  let burner: HardhatEthersSigner;
  let rebalancer: HardhatEthersSigner;
  let depositPauser: HardhatEthersSigner;
  let depositResumer: HardhatEthersSigner;
  let exitRequester: HardhatEthersSigner;
  let disconnecter: HardhatEthersSigner;
  let curator: HardhatEthersSigner;
  let nodeOperatorManager: HardhatEthersSigner;
  let nodeOperatorFeeClaimer: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let beaconOwner: HardhatEthersSigner;
  let hubSigner: HardhatEthersSigner;
  let rewarder: HardhatEthersSigner;
  const recipient = certainAddress("some-recipient");

  let lidoLocator: LidoLocator;
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
    [
      vaultOwner,
      funder,
      withdrawer,
      minter,
      burner,
      rebalancer,
      depositPauser,
      depositResumer,
      exitRequester,
      disconnecter,
      curator,
      nodeOperatorManager,
      nodeOperatorFeeClaimer,
      stranger,
      beaconOwner,
      rewarder,
    ] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__MockForDelegation");
    weth = await ethers.deployContract("WETH9__MockForVault");
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);
    hub = await ethers.deployContract("VaultHub__MockForDelegation", [steth]);
    lidoLocator = await deployLidoLocator({ lido: steth, wstETH: wsteth });

    delegationImpl = await ethers.deployContract("Delegation", [weth, lidoLocator]);
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
        funder,
        withdrawer,
        minter,
        burner,
        rebalancer,
        depositPauser,
        depositResumer,
        exitRequester,
        disconnecter,
        curator,
        nodeOperatorManager,
        nodeOperatorFeeClaimer,
        curatorFeeBP: 0n,
        nodeOperatorFeeBP: 0n,
      },
      "0x",
    );

    const vaultCreationReceipt = await vaultCreationTx.wait();
    if (!vaultCreationReceipt) throw new Error("Vault creation receipt not found");

    const vaultCreatedEvents = findEvents(vaultCreationReceipt, "VaultCreated");
    expect(vaultCreatedEvents.length).to.equal(1);

    const stakingVaultAddress = vaultCreatedEvents[0].args.vault;
    vault = await ethers.getContractAt("StakingVault", stakingVaultAddress, vaultOwner);

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
      await expect(ethers.deployContract("Delegation", [weth, ethers.ZeroAddress]))
        .to.be.revertedWithCustomError(delegation, "ZeroArgument")
        .withArgs("_lidoLocator");
    });

    it("reverts if wETH is zero address", async () => {
      await expect(ethers.deployContract("Delegation", [ethers.ZeroAddress, lidoLocator]))
        .to.be.revertedWithCustomError(delegation, "ZeroArgument")
        .withArgs("_WETH");
    });

    it("sets the stETH address", async () => {
      const delegation_ = await ethers.deployContract("Delegation", [weth, lidoLocator]);
      expect(await delegation_.STETH()).to.equal(steth);
      expect(await delegation_.WETH()).to.equal(weth);
      expect(await delegation_.WSTETH()).to.equal(wsteth);
    });
  });

  context("initialize", () => {
    it("reverts if already initialized", async () => {
      await expect(delegation.initialize(vaultOwner)).to.be.revertedWithCustomError(delegation, "AlreadyInitialized");
    });

    it("reverts if called on the implementation", async () => {
      const delegation_ = await ethers.deployContract("Delegation", [weth, lidoLocator]);

      await expect(delegation_.initialize(vaultOwner)).to.be.revertedWithCustomError(
        delegation_,
        "NonProxyCallsForbidden",
      );
    });
  });

  context("initialized state", () => {
    it("initializes the contract correctly", async () => {
      expect(await vault.owner()).to.equal(delegation);
      expect(await vault.nodeOperator()).to.equal(nodeOperatorManager);

      expect(await delegation.stakingVault()).to.equal(vault);
      expect(await delegation.vaultHub()).to.equal(hub);

      await assertSoleMember(vaultOwner, await delegation.DEFAULT_ADMIN_ROLE());
      await assertSoleMember(funder, await delegation.FUND_ROLE());
      await assertSoleMember(withdrawer, await delegation.WITHDRAW_ROLE());
      await assertSoleMember(minter, await delegation.MINT_ROLE());
      await assertSoleMember(burner, await delegation.BURN_ROLE());
      await assertSoleMember(rebalancer, await delegation.REBALANCE_ROLE());
      await assertSoleMember(depositPauser, await delegation.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE());
      await assertSoleMember(depositResumer, await delegation.RESUME_BEACON_CHAIN_DEPOSITS_ROLE());
      await assertSoleMember(exitRequester, await delegation.REQUEST_VALIDATOR_EXIT_ROLE());
      await assertSoleMember(disconnecter, await delegation.VOLUNTARY_DISCONNECT_ROLE());
      await assertSoleMember(curator, await delegation.CURATOR_ROLE());
      await assertSoleMember(nodeOperatorManager, await delegation.NODE_OPERATOR_MANAGER_ROLE());
      await assertSoleMember(nodeOperatorFeeClaimer, await delegation.NODE_OPERATOR_FEE_CLAIMER_ROLE());

      expect(await delegation.curatorFeeBP()).to.equal(0n);
      expect(await delegation.nodeOperatorFeeBP()).to.equal(0n);
      expect(await delegation.curatorUnclaimedFee()).to.equal(0n);
      expect(await delegation.nodeOperatorUnclaimedFee()).to.equal(0n);
      expect(await delegation.curatorFeeClaimedReport()).to.deep.equal([0n, 0n]);
      expect(await delegation.nodeOperatorFeeClaimedReport()).to.deep.equal([0n, 0n]);
    });
  });

  context("votingCommittee", () => {
    it("returns the correct roles", async () => {
      expect(await delegation.votingCommittee()).to.deep.equal([
        await delegation.CURATOR_ROLE(),
        await delegation.NODE_OPERATOR_MANAGER_ROLE(),
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
      await expect(delegation.connect(nodeOperatorManager).setVoteLifetime(newVoteLifetime))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(nodeOperatorManager, await delegation.NODE_OPERATOR_MANAGER_ROLE(), voteTimestamp, msgData)
        .and.to.emit(delegation, "VoteLifetimeSet")
        .withArgs(nodeOperatorManager, oldVoteLifetime, newVoteLifetime);

      expect(await delegation.voteLifetime()).to.equal(newVoteLifetime);
    });
  });

  context("claimCuratorFee", () => {
    it("reverts if the caller is not a member of the curator due claim role", async () => {
      await expect(delegation.connect(stranger).claimCuratorFee(stranger))
        .to.be.revertedWithCustomError(delegation, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await delegation.CURATOR_ROLE());
    });

    it("reverts if the recipient is the zero address", async () => {
      await expect(delegation.connect(curator).claimCuratorFee(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(delegation, "ZeroArgument")
        .withArgs("_recipient");
    });

    it("reverts if the due is zero", async () => {
      expect(await delegation.curatorUnclaimedFee()).to.equal(0n);
      await expect(delegation.connect(curator).claimCuratorFee(stranger))
        .to.be.revertedWithCustomError(delegation, "ZeroArgument")
        .withArgs("_fee");
    });

    it("claims the due", async () => {
      const curatorFee = 10_00n; // 10%
      await delegation.connect(vaultOwner).setCuratorFeeBP(curatorFee);
      expect(await delegation.curatorFeeBP()).to.equal(curatorFee);

      const rewards = ether("1");
      await vault.connect(hubSigner).report(rewards, 0n, 0n);

      const expectedDue = (rewards * curatorFee) / BP_BASE;
      expect(await delegation.curatorUnclaimedFee()).to.equal(expectedDue);
      expect(await delegation.curatorUnclaimedFee()).to.be.greaterThan(await ethers.provider.getBalance(vault));

      expect(await ethers.provider.getBalance(vault)).to.equal(0n);
      await rewarder.sendTransaction({ to: vault, value: rewards });
      expect(await ethers.provider.getBalance(vault)).to.equal(rewards);

      expect(await ethers.provider.getBalance(recipient)).to.equal(0n);
      await expect(delegation.connect(curator).claimCuratorFee(recipient))
        .to.emit(vault, "Withdrawn")
        .withArgs(delegation, recipient, expectedDue);
      expect(await ethers.provider.getBalance(recipient)).to.equal(expectedDue);
      expect(await ethers.provider.getBalance(vault)).to.equal(rewards - expectedDue);
    });
  });

  context("claimNodeOperatorFee", () => {
    it("reverts if the caller does not have the operator due claim role", async () => {
      await expect(delegation.connect(stranger).claimNodeOperatorFee(stranger)).to.be.revertedWithCustomError(
        delegation,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if the recipient is the zero address", async () => {
      await expect(delegation.connect(nodeOperatorFeeClaimer).claimNodeOperatorFee(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(delegation, "ZeroArgument")
        .withArgs("_recipient");
    });

    it("reverts if the due is zero", async () => {
      expect(await delegation.nodeOperatorUnclaimedFee()).to.equal(0n);
      await expect(delegation.connect(nodeOperatorFeeClaimer).claimNodeOperatorFee(recipient))
        .to.be.revertedWithCustomError(delegation, "ZeroArgument")
        .withArgs("_fee");
    });

    it("claims the due", async () => {
      const operatorFee = 10_00n; // 10%
      await delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(operatorFee);
      await delegation.connect(curator).setNodeOperatorFeeBP(operatorFee);
      expect(await delegation.nodeOperatorFeeBP()).to.equal(operatorFee);

      const rewards = ether("1");
      await vault.connect(hubSigner).report(rewards, 0n, 0n);

      const expectedDue = (rewards * operatorFee) / BP_BASE;
      expect(await delegation.nodeOperatorUnclaimedFee()).to.equal(expectedDue);
      expect(await delegation.nodeOperatorUnclaimedFee()).to.be.greaterThan(await ethers.provider.getBalance(vault));

      expect(await ethers.provider.getBalance(vault)).to.equal(0n);
      await rewarder.sendTransaction({ to: vault, value: rewards });
      expect(await ethers.provider.getBalance(vault)).to.equal(rewards);

      expect(await ethers.provider.getBalance(recipient)).to.equal(0n);
      await expect(delegation.connect(nodeOperatorFeeClaimer).claimNodeOperatorFee(recipient))
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

      await expect(delegation.connect(funder).fund({ value: amount }))
        .to.emit(vault, "Funded")
        .withArgs(delegation, amount);

      expect(await ethers.provider.getBalance(vault)).to.equal(amount);
      expect(await vault.inOutDelta()).to.equal(amount);
      expect(await vault.valuation()).to.equal(amount);
    });
  });

  context("withdraw", () => {
    it("reverts if the caller is not a member of the withdrawer role", async () => {
      await delegation.connect(funder).fund({ value: ether("1") });

      await expect(delegation.connect(stranger).withdraw(recipient, ether("1"))).to.be.revertedWithCustomError(
        delegation,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if the recipient is the zero address", async () => {
      await delegation.connect(funder).fund({ value: ether("1") });

      await expect(delegation.connect(withdrawer).withdraw(ethers.ZeroAddress, ether("1")))
        .to.be.revertedWithCustomError(delegation, "ZeroArgument")
        .withArgs("_recipient");
    });

    it("reverts if the amount is zero", async () => {
      await expect(delegation.connect(withdrawer).withdraw(recipient, 0n))
        .to.be.revertedWithCustomError(delegation, "ZeroArgument")
        .withArgs("_ether");
    });

    it("reverts if the amount is greater than the unreserved amount", async () => {
      await delegation.connect(funder).fund({ value: ether("1") });
      const unreserved = await delegation.unreserved();
      await expect(delegation.connect(withdrawer).withdraw(recipient, unreserved + 1n)).to.be.revertedWithCustomError(
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
      await expect(delegation.connect(withdrawer).withdraw(recipient, amount))
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
      await delegation.connect(funder).fund({ value: amount });

      await expect(delegation.connect(rebalancer).rebalanceVault(amount))
        .to.emit(hub, "Mock__Rebalanced")
        .withArgs(amount);
    });

    it("funds and rebalances the vault", async () => {
      const amount = ether("1");
      await delegation.connect(vaultOwner).grantRole(await delegation.FUND_ROLE(), rebalancer);
      await expect(delegation.connect(rebalancer).rebalanceVault(amount, { value: amount }))
        .to.emit(vault, "Funded")
        .withArgs(delegation, amount)
        .to.emit(hub, "Mock__Rebalanced")
        .withArgs(amount);
    });
  });

  context("mint", () => {
    it("reverts if the caller is not a member of the token master role", async () => {
      await expect(delegation.connect(stranger).mintShares(recipient, 1n)).to.be.revertedWithCustomError(
        delegation,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("mints the tokens", async () => {
      const amount = 100n;
      await expect(delegation.connect(minter).mintShares(recipient, amount))
        .to.emit(steth, "Transfer")
        .withArgs(ethers.ZeroAddress, recipient, amount);
    });
  });

  context("burn", () => {
    it("reverts if the caller is not a member of the token master role", async () => {
      await delegation.connect(funder).fund({ value: ether("1") });
      await delegation.connect(minter).mintShares(stranger, 100n);

      await expect(delegation.connect(stranger).burnShares(100n)).to.be.revertedWithCustomError(
        delegation,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("burns the tokens", async () => {
      const amount = 100n;
      await delegation.connect(minter).mintShares(burner, amount);

      await expect(delegation.connect(burner).burnShares(amount))
        .to.emit(steth, "Transfer")
        .withArgs(burner, hub, amount)
        .and.to.emit(steth, "Transfer")
        .withArgs(hub, ethers.ZeroAddress, amount);
    });
  });

  context("setCuratorFeeBP", () => {
    it("reverts if caller is not curator", async () => {
      await expect(delegation.connect(stranger).setCuratorFeeBP(1000n))
        .to.be.revertedWithCustomError(delegation, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await delegation.DEFAULT_ADMIN_ROLE());
    });

    it("reverts if curator fee is not zero", async () => {
      // set the curator fee to 5%
      const newCuratorFee = 500n;
      await delegation.connect(vaultOwner).setCuratorFeeBP(newCuratorFee);
      expect(await delegation.curatorFeeBP()).to.equal(newCuratorFee);

      // bring rewards
      const totalRewards = ether("1");
      const inOutDelta = 0n;
      const locked = 0n;
      await vault.connect(hubSigner).report(totalRewards, inOutDelta, locked);
      expect(await delegation.curatorUnclaimedFee()).to.equal((totalRewards * newCuratorFee) / BP_BASE);

      // attempt to change the performance fee to 6%
      await expect(delegation.connect(vaultOwner).setCuratorFeeBP(600n)).to.be.revertedWithCustomError(
        delegation,
        "CuratorFeeUnclaimed",
      );
    });

    it("reverts if new fee is greater than max fee", async () => {
      await expect(delegation.connect(vaultOwner).setCuratorFeeBP(MAX_FEE + 1n)).to.be.revertedWithCustomError(
        delegation,
        "CombinedFeesExceed100Percent",
      );
    });

    it("sets the curator fee", async () => {
      const newCuratorFee = 1000n;
      await delegation.connect(vaultOwner).setCuratorFeeBP(newCuratorFee);
      expect(await delegation.curatorFeeBP()).to.equal(newCuratorFee);
    });
  });

  context("setOperatorFee", () => {
    it("reverts if new fee is greater than max fee", async () => {
      const invalidFee = MAX_FEE + 1n;
      await delegation.connect(curator).setNodeOperatorFeeBP(invalidFee);

      await expect(
        delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(invalidFee),
      ).to.be.revertedWithCustomError(delegation, "CombinedFeesExceed100Percent");
    });

    it("reverts if performance due is not zero", async () => {
      // set the performance fee to 5%
      const newOperatorFee = 500n;
      await delegation.connect(curator).setNodeOperatorFeeBP(newOperatorFee);
      await delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(newOperatorFee);
      expect(await delegation.nodeOperatorFeeBP()).to.equal(newOperatorFee);

      // bring rewards
      const totalRewards = ether("1");
      const inOutDelta = 0n;
      const locked = 0n;
      await vault.connect(hubSigner).report(totalRewards, inOutDelta, locked);
      expect(await delegation.nodeOperatorUnclaimedFee()).to.equal((totalRewards * newOperatorFee) / BP_BASE);

      // attempt to change the performance fee to 6%
      await delegation.connect(curator).setNodeOperatorFeeBP(600n);
      await expect(delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(600n)).to.be.revertedWithCustomError(
        delegation,
        "NodeOperatorFeeUnclaimed",
      );
    });

    it("requires both curator and operator to set the operator fee and emits the RoleMemberVoted event", async () => {
      const previousOperatorFee = await delegation.nodeOperatorFeeBP();
      const newOperatorFee = 1000n;
      let voteTimestamp = await getNextBlockTimestamp();
      const msgData = delegation.interface.encodeFunctionData("setNodeOperatorFeeBP", [newOperatorFee]);

      await expect(delegation.connect(curator).setNodeOperatorFeeBP(newOperatorFee))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(curator, await delegation.CURATOR_ROLE(), voteTimestamp, msgData);
      // fee is unchanged
      expect(await delegation.nodeOperatorFeeBP()).to.equal(previousOperatorFee);
      // check vote
      expect(await delegation.votings(keccak256(msgData), await delegation.CURATOR_ROLE())).to.equal(voteTimestamp);

      voteTimestamp = await getNextBlockTimestamp();
      await expect(delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(newOperatorFee))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(nodeOperatorManager, await delegation.NODE_OPERATOR_MANAGER_ROLE(), voteTimestamp, msgData)
        .and.to.emit(delegation, "NodeOperatorFeeBPSet")
        .withArgs(nodeOperatorManager, previousOperatorFee, newOperatorFee);

      expect(await delegation.nodeOperatorFeeBP()).to.equal(newOperatorFee);

      // resets the votes
      for (const role of await delegation.votingCommittee()) {
        expect(await delegation.votings(keccak256(msgData), role)).to.equal(0n);
      }
    });

    it("reverts if the caller is not a member of the operator fee committee", async () => {
      const newOperatorFee = 1000n;
      await expect(delegation.connect(stranger).setNodeOperatorFeeBP(newOperatorFee)).to.be.revertedWithCustomError(
        delegation,
        "NotACommitteeMember",
      );
    });

    it("doesn't execute if an earlier vote has expired", async () => {
      const previousOperatorFee = await delegation.nodeOperatorFeeBP();
      const newOperatorFee = 1000n;
      const msgData = delegation.interface.encodeFunctionData("setNodeOperatorFeeBP", [newOperatorFee]);
      const callId = keccak256(msgData);
      let voteTimestamp = await getNextBlockTimestamp();
      await expect(delegation.connect(curator).setNodeOperatorFeeBP(newOperatorFee))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(curator, await delegation.CURATOR_ROLE(), voteTimestamp, msgData);
      // fee is unchanged
      expect(await delegation.nodeOperatorFeeBP()).to.equal(previousOperatorFee);
      // check vote
      expect(await delegation.votings(callId, await delegation.CURATOR_ROLE())).to.equal(voteTimestamp);

      // move time forward
      await advanceChainTime(days(7n) + 1n);
      const expectedVoteTimestamp = await getNextBlockTimestamp();
      expect(expectedVoteTimestamp).to.be.greaterThan(voteTimestamp + days(7n));
      await expect(delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(newOperatorFee))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(nodeOperatorManager, await delegation.NODE_OPERATOR_MANAGER_ROLE(), expectedVoteTimestamp, msgData);

      // fee is still unchanged
      expect(await delegation.nodeOperatorFeeBP()).to.equal(previousOperatorFee);
      // check vote
      expect(await delegation.votings(callId, await delegation.NODE_OPERATOR_MANAGER_ROLE())).to.equal(
        expectedVoteTimestamp,
      );

      // curator has to vote again
      voteTimestamp = await getNextBlockTimestamp();
      await expect(delegation.connect(curator).setNodeOperatorFeeBP(newOperatorFee))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(curator, await delegation.CURATOR_ROLE(), voteTimestamp, msgData)
        .and.to.emit(delegation, "NodeOperatorFeeBPSet")
        .withArgs(curator, previousOperatorFee, newOperatorFee);
      // fee is now changed
      expect(await delegation.nodeOperatorFeeBP()).to.equal(newOperatorFee);
    });
  });

  context("transferStakingVaultOwnership", () => {
    it("reverts if the caller is not a member of the transfer committee", async () => {
      await expect(delegation.connect(stranger).transferStakingVaultOwnership(recipient)).to.be.revertedWithCustomError(
        delegation,
        "NotACommitteeMember",
      );
    });

    it("requires both curator and operator to transfer ownership and emits the RoleMemberVoted event", async () => {
      const newOwner = certainAddress("newOwner");
      const msgData = delegation.interface.encodeFunctionData("transferStakingVaultOwnership", [newOwner]);
      let voteTimestamp = await getNextBlockTimestamp();
      await expect(delegation.connect(curator).transferStakingVaultOwnership(newOwner))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(curator, await delegation.CURATOR_ROLE(), voteTimestamp, msgData);
      // owner is unchanged
      expect(await vault.owner()).to.equal(delegation);

      voteTimestamp = await getNextBlockTimestamp();
      await expect(delegation.connect(nodeOperatorManager).transferStakingVaultOwnership(newOwner))
        .to.emit(delegation, "RoleMemberVoted")
        .withArgs(nodeOperatorManager, await delegation.NODE_OPERATOR_MANAGER_ROLE(), voteTimestamp, msgData);
      // owner changed
      expect(await vault.owner()).to.equal(newOwner);
    });
  });

  context("pauseBeaconChainDeposits", () => {
    it("reverts if the caller is not a curator", async () => {
      await expect(delegation.connect(stranger).pauseBeaconChainDeposits()).to.be.revertedWithCustomError(
        delegation,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if the beacon deposits are already paused", async () => {
      await delegation.connect(depositPauser).pauseBeaconChainDeposits();

      await expect(delegation.connect(depositPauser).pauseBeaconChainDeposits()).to.be.revertedWithCustomError(
        vault,
        "BeaconChainDepositsResumeExpected",
      );
    });

    it("pauses the beacon deposits", async () => {
      await expect(delegation.connect(depositPauser).pauseBeaconChainDeposits()).to.emit(
        vault,
        "BeaconChainDepositsPaused",
      );
      expect(await vault.beaconChainDepositsPaused()).to.be.true;
    });
  });

  context("resumeBeaconChainDeposits", () => {
    it("reverts if the caller is not a curator", async () => {
      await expect(delegation.connect(stranger).resumeBeaconChainDeposits()).to.be.revertedWithCustomError(
        delegation,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if the beacon deposits are already resumed", async () => {
      await expect(delegation.connect(depositResumer).resumeBeaconChainDeposits()).to.be.revertedWithCustomError(
        vault,
        "BeaconChainDepositsPauseExpected",
      );
    });

    it("resumes the beacon deposits", async () => {
      await delegation.connect(depositPauser).pauseBeaconChainDeposits();

      await expect(delegation.connect(depositResumer).resumeBeaconChainDeposits()).to.emit(
        vault,
        "BeaconChainDepositsResumed",
      );
      expect(await vault.beaconChainDepositsPaused()).to.be.false;
    });
  });

  async function assertSoleMember(account: HardhatEthersSigner, role: string) {
    expect(await delegation.hasRole(role, account)).to.be.true;
    expect(await delegation.getRoleMemberCount(role)).to.equal(1);
  }
});
