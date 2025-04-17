import { expect } from "chai";
import { keccak256 } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Delegation,
  DepositContract__MockForStakingVault,
  LidoLocator,
  OperatorGrid,
  OssifiableProxy,
  StakingVault,
  StETH__MockForDelegation,
  UpgradeableBeacon,
  VaultFactory,
  VaultHub__MockForDelegation,
  WETH9__MockForVault,
  WstETH__HarnessForVault,
} from "typechain-types";

import {
  advanceChainTime,
  certainAddress,
  days,
  ether,
  findEvents,
  generatePostDeposit,
  generateValidator,
  getCurrentBlockTimestamp,
  getNextBlockTimestamp,
  impersonate,
} from "lib";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot } from "test/suite";

const BP_BASE = 10000n;
const MAX_FEE = BP_BASE;
const DEFAULT_GROUP_SHARE_LIMIT = ether("1000");

describe("Delegation.sol", () => {
  let vaultOwner: HardhatEthersSigner;
  let funder: HardhatEthersSigner;
  let withdrawer: HardhatEthersSigner;
  let locker: HardhatEthersSigner;
  let minter: HardhatEthersSigner;
  let burner: HardhatEthersSigner;
  let rebalancer: HardhatEthersSigner;
  let depositPauser: HardhatEthersSigner;
  let depositResumer: HardhatEthersSigner;
  let pdgCompensator: HardhatEthersSigner;
  let unknownValidatorProver: HardhatEthersSigner;
  let unguaranteedBeaconChainDepositor: HardhatEthersSigner;
  let validatorExitRequester: HardhatEthersSigner;
  let validatorWithdrawalTriggerer: HardhatEthersSigner;
  let disconnecter: HardhatEthersSigner;
  let lidoVaultHubAuthorizer: HardhatEthersSigner;
  let lidoVaultHubDeauthorizer: HardhatEthersSigner;
  let ossifier: HardhatEthersSigner;
  let depositorSetter: HardhatEthersSigner;
  let lockedResetter: HardhatEthersSigner;
  let nodeOperatorManager: HardhatEthersSigner;
  let nodeOperatorFeeClaimer: HardhatEthersSigner;
  let nodeOperatorRewardAdjuster: HardhatEthersSigner;
  let vaultDepositor: HardhatEthersSigner;
  let dao: HardhatEthersSigner;
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
  let operatorGrid: OperatorGrid;
  let operatorGridImpl: OperatorGrid;
  let proxy: OssifiableProxy;

  let originalState: string;

  before(async () => {
    [
      vaultOwner,
      funder,
      withdrawer,
      locker,
      minter,
      burner,
      rebalancer,
      depositPauser,
      depositResumer,
      pdgCompensator,
      unknownValidatorProver,
      unguaranteedBeaconChainDepositor,
      validatorExitRequester,
      validatorWithdrawalTriggerer,
      disconnecter,
      lidoVaultHubAuthorizer,
      lidoVaultHubDeauthorizer,
      ossifier,
      depositorSetter,
      lockedResetter,
      nodeOperatorManager,
      nodeOperatorFeeClaimer,
      nodeOperatorRewardAdjuster,
      stranger,
      beaconOwner,
      rewarder,
      vaultDepositor,
      dao,
    ] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__MockForDelegation");
    weth = await ethers.deployContract("WETH9__MockForVault");
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);

    lidoLocator = await deployLidoLocator({ lido: steth, wstETH: wsteth, predepositGuarantee: vaultDepositor });
    hub = await ethers.deployContract("VaultHub__MockForDelegation", [lidoLocator, steth]);

    delegationImpl = await ethers.deployContract("Delegation", [weth, lidoLocator]);
    expect(await delegationImpl.WETH()).to.equal(weth);
    expect(await delegationImpl.STETH()).to.equal(steth);
    expect(await delegationImpl.WSTETH()).to.equal(wsteth);

    // OperatorGrid
    operatorGridImpl = await ethers.deployContract("OperatorGrid", [lidoLocator], { from: vaultOwner });
    proxy = await ethers.deployContract(
      "OssifiableProxy",
      [operatorGridImpl, vaultOwner, new Uint8Array()],
      vaultOwner,
    );
    operatorGrid = await ethers.getContractAt("OperatorGrid", proxy, vaultOwner);
    const defaultTierParams = {
      shareLimit: DEFAULT_GROUP_SHARE_LIMIT,
      reserveRatioBP: 2000n,
      rebalanceThresholdBP: 1800n,
      treasuryFeeBP: 500n,
    };
    await operatorGrid.initialize(dao, defaultTierParams);
    await operatorGrid.connect(dao).grantRole(await operatorGrid.REGISTRY_ROLE(), dao);

    await updateLidoLocatorImplementation(await lidoLocator.getAddress(), { operatorGrid });

    depositContract = await ethers.deployContract("DepositContract__MockForStakingVault");
    vaultImpl = await ethers.deployContract("StakingVault", [hub, depositContract]);

    beacon = await ethers.deployContract("UpgradeableBeacon", [vaultImpl, beaconOwner]);

    factory = await ethers.deployContract("VaultFactory", [lidoLocator, beacon, delegationImpl]);
    expect(await beacon.implementation()).to.equal(vaultImpl);
    expect(await factory.BEACON()).to.equal(beacon);
    expect(await factory.DELEGATION_IMPL()).to.equal(delegationImpl);
    expect(await factory.LIDO_LOCATOR()).to.equal(lidoLocator);

    const defaultTierId = await operatorGrid.DEFAULT_TIER_ID();
    await operatorGrid.connect(dao).alterTier(defaultTierId, {
      shareLimit: ether("1000"),
      reserveRatioBP: 1000n,
      rebalanceThresholdBP: 1000n,
      treasuryFeeBP: 1000n,
    });
    const vaultCreationTx = await factory.connect(vaultOwner).createVaultWithDelegation(
      {
        defaultAdmin: vaultOwner,
        nodeOperatorManager,
        confirmExpiry: days(7n),
        nodeOperatorFeeBP: 0n,
        funders: [funder],
        withdrawers: [withdrawer],
        lockers: [locker],
        minters: [minter],
        burners: [burner],
        rebalancers: [rebalancer],
        depositPausers: [depositPauser],
        depositResumers: [depositResumer],
        pdgCompensators: [pdgCompensator],
        unknownValidatorProvers: [unknownValidatorProver],
        unguaranteedBeaconChainDepositors: [unguaranteedBeaconChainDepositor],
        validatorExitRequesters: [validatorExitRequester],
        validatorWithdrawalTriggerers: [validatorWithdrawalTriggerer],
        disconnecters: [disconnecter],
        lidoVaultHubAuthorizers: [lidoVaultHubAuthorizer],
        lidoVaultHubDeauthorizers: [lidoVaultHubDeauthorizer],
        ossifiers: [ossifier],
        depositorSetters: [depositorSetter],
        lockedResetters: [lockedResetter],
        nodeOperatorFeeClaimers: [nodeOperatorFeeClaimer],
        nodeOperatorRewardAdjusters: [nodeOperatorRewardAdjuster],
        assetRecoverer: vaultOwner,
        tierChangers: [vaultOwner],
      },
      "0x",
      { value: ether("1") },
    );

    const vaultCreationReceipt = await vaultCreationTx.wait();
    if (!vaultCreationReceipt) throw new Error("Vault creation receipt not found");

    const vaultCreatedEvents = findEvents(vaultCreationReceipt, "VaultCreated");
    expect(vaultCreatedEvents.length).to.equal(1);

    const stakingVaultAddress = vaultCreatedEvents[0].args.vault;
    vault = await ethers.getContractAt("StakingVault", stakingVaultAddress, vaultOwner);
    expect(await vault.vaultHub()).to.equal(hub);

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
        .withArgs("_wETH");
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
      await expect(delegation.initialize(vaultOwner, days(7n))).to.be.revertedWithCustomError(
        delegation,
        "AlreadyInitialized",
      );
    });

    it("reverts if called on the implementation", async () => {
      const delegation_ = await ethers.deployContract("Delegation", [weth, lidoLocator]);

      await expect(delegation_.initialize(vaultOwner, days(7n))).to.be.revertedWithCustomError(
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
      await assertSoleMember(vaultOwner, await delegation.ASSET_RECOVERY_ROLE());
      await assertSoleMember(funder, await delegation.FUND_ROLE());
      await assertSoleMember(withdrawer, await delegation.WITHDRAW_ROLE());
      await assertSoleMember(minter, await delegation.MINT_ROLE());
      await assertSoleMember(burner, await delegation.BURN_ROLE());
      await assertSoleMember(rebalancer, await delegation.REBALANCE_ROLE());
      await assertSoleMember(depositPauser, await delegation.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE());
      await assertSoleMember(depositResumer, await delegation.RESUME_BEACON_CHAIN_DEPOSITS_ROLE());
      await assertSoleMember(validatorExitRequester, await delegation.REQUEST_VALIDATOR_EXIT_ROLE());
      await assertSoleMember(validatorWithdrawalTriggerer, await delegation.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE());
      await assertSoleMember(disconnecter, await delegation.VOLUNTARY_DISCONNECT_ROLE());
      await assertSoleMember(nodeOperatorManager, await delegation.NODE_OPERATOR_MANAGER_ROLE());
      await assertSoleMember(nodeOperatorFeeClaimer, await delegation.NODE_OPERATOR_FEE_CLAIM_ROLE());
      await assertSoleMember(nodeOperatorRewardAdjuster, await delegation.NODE_OPERATOR_REWARDS_ADJUST_ROLE());
      await assertSoleMember(
        unguaranteedBeaconChainDepositor,
        await delegation.UNGUARANTEED_BEACON_CHAIN_DEPOSIT_ROLE(),
      );
      await assertSoleMember(unknownValidatorProver, await delegation.PDG_PROVE_VALIDATOR_ROLE());
      await assertSoleMember(pdgCompensator, await delegation.PDG_COMPENSATE_PREDEPOSIT_ROLE());

      expect(await delegation.nodeOperatorFeeBP()).to.equal(0n);
      expect(await delegation.nodeOperatorUnclaimedFee()).to.equal(0n);
      expect(await delegation.nodeOperatorFeeClaimedReport()).to.deep.equal([0n, 0n, 0n]);
    });
  });

  context("confirmingRoles", () => {
    it("returns the correct roles", async () => {
      expect(await delegation.confirmingRoles()).to.deep.equal([
        await delegation.DEFAULT_ADMIN_ROLE(),
        await delegation.NODE_OPERATOR_MANAGER_ROLE(),
      ]);
    });
  });

  context("setConfirmExpiry", () => {
    it("reverts if the caller is not a member of the confirm expiry committee", async () => {
      await expect(delegation.connect(stranger).setConfirmExpiry(days(10n))).to.be.revertedWithCustomError(
        delegation,
        "SenderNotMember",
      );
    });

    it("sets the new confirm expiry", async () => {
      const oldConfirmExpiry = await delegation.getConfirmExpiry();
      const newConfirmExpiry = days(10n);
      const msgData = delegation.interface.encodeFunctionData("setConfirmExpiry", [newConfirmExpiry]);
      let confirmTimestamp = (await getNextBlockTimestamp()) + (await delegation.getConfirmExpiry());

      await expect(delegation.connect(vaultOwner).setConfirmExpiry(newConfirmExpiry))
        .to.emit(delegation, "RoleMemberConfirmed")
        .withArgs(vaultOwner, await delegation.DEFAULT_ADMIN_ROLE(), confirmTimestamp, msgData);

      confirmTimestamp = (await getNextBlockTimestamp()) + (await delegation.getConfirmExpiry());
      await expect(delegation.connect(nodeOperatorManager).setConfirmExpiry(newConfirmExpiry))
        .to.emit(delegation, "RoleMemberConfirmed")
        .withArgs(nodeOperatorManager, await delegation.NODE_OPERATOR_MANAGER_ROLE(), confirmTimestamp, msgData)
        .and.to.emit(delegation, "ConfirmExpirySet")
        .withArgs(nodeOperatorManager, oldConfirmExpiry, newConfirmExpiry);

      expect(await delegation.getConfirmExpiry()).to.equal(newConfirmExpiry);
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
      const vaultBalanceBefore = await ethers.provider.getBalance(vault);
      const operatorFee = 10_00n; // 10%
      await delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(operatorFee);
      await delegation.connect(vaultOwner).setNodeOperatorFeeBP(operatorFee);
      expect(await delegation.nodeOperatorFeeBP()).to.equal(operatorFee);

      const rewards = ether("1");
      await vault.connect(hubSigner).report(await getCurrentBlockTimestamp(), rewards, 0n, 0n);

      const expectedDue = (rewards * operatorFee) / BP_BASE;
      expect(await delegation.nodeOperatorUnclaimedFee()).to.equal(expectedDue);
      expect((await delegation.nodeOperatorUnclaimedFee()) + vaultBalanceBefore).to.be.greaterThan(
        await ethers.provider.getBalance(vault),
      );

      expect(await ethers.provider.getBalance(vault)).to.equal(vaultBalanceBefore);
      await rewarder.sendTransaction({ to: vault, value: rewards });
      expect(await ethers.provider.getBalance(vault)).to.equal(rewards + vaultBalanceBefore);

      expect(await ethers.provider.getBalance(recipient)).to.equal(0n);
      await expect(delegation.connect(nodeOperatorFeeClaimer).claimNodeOperatorFee(recipient))
        .to.emit(vault, "Withdrawn")
        .withArgs(delegation, recipient, expectedDue);
      expect(await ethers.provider.getBalance(recipient)).to.equal(expectedDue);
      expect(await ethers.provider.getBalance(vault)).to.equal(rewards - expectedDue + vaultBalanceBefore);
    });
  });

  context("increaseAccruedRewardsAdjustment", () => {
    beforeEach(async () => {
      const operatorFee = 10_00n; // 10%
      await delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(operatorFee);
      await delegation.connect(vaultOwner).setNodeOperatorFeeBP(operatorFee);
    });

    it("reverts if non NODE_OPERATOR_REWARDS_ADJUST_ROLE sets adjustment", async () => {
      await expect(delegation.connect(stranger).increaseAccruedRewardsAdjustment(100n)).to.be.revertedWithCustomError(
        delegation,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("revert for zero increase", async () => {
      await expect(
        delegation.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(0n),
      ).to.be.revertedWithCustomError(delegation, "SameAdjustment");
    });

    it("reverts if manually adjust more than limit", async () => {
      const LIMIT = await delegation.MANUAL_ACCRUED_REWARDS_ADJUSTMENT_LIMIT();
      const increase = ether("1");

      await expect(
        delegation.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(LIMIT + 1n),
      ).to.be.revertedWithCustomError(delegation, "IncreasedOverLimit");

      expect(await delegation.accruedRewardsAdjustment()).to.equal(0n);

      await delegation.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(increase);
      expect(await delegation.accruedRewardsAdjustment()).to.equal(increase);

      await expect(
        delegation.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(LIMIT),
      ).to.be.revertedWithCustomError(delegation, "IncreasedOverLimit");

      const increase2 = LIMIT - increase;
      await delegation.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(increase2);
      expect(await delegation.accruedRewardsAdjustment()).to.equal(LIMIT);

      await expect(
        delegation.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(1n),
      ).to.be.revertedWithCustomError(delegation, "IncreasedOverLimit");
    });

    it("adjuster can increaseAccruedRewardsAdjustment", async () => {
      const increase = ether("10");

      expect(await delegation.accruedRewardsAdjustment()).to.equal(0n);
      const tx = await delegation.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(increase);

      await expect(tx).to.emit(delegation, "AccruedRewardsAdjustmentSet").withArgs(increase, 0n);

      expect(await delegation.accruedRewardsAdjustment()).to.equal(increase);
    });

    it("manual increase can decrease NO fee", async () => {
      const operatorFee = await delegation.nodeOperatorFeeBP();

      const rewards = ether("10");
      await vault.connect(hubSigner).report(await getCurrentBlockTimestamp(), rewards, 0n, 0n);
      const expectedDue = (rewards * operatorFee) / BP_BASE;
      expect(await delegation.nodeOperatorUnclaimedFee()).to.equal(expectedDue);

      await delegation.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(rewards / 2n);
      expect(await delegation.nodeOperatorUnclaimedFee()).to.equal(expectedDue / 2n);

      await delegation.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(rewards / 2n);
      expect(await delegation.nodeOperatorUnclaimedFee()).to.equal(0n);
    });

    it("adjustment is reset after fee claim", async () => {
      const operatorFee = await delegation.nodeOperatorFeeBP();

      const locked = await vault.locked();

      const rewards = ether("10");
      await delegation.connect(funder).fund({ value: rewards });
      await vault.connect(hubSigner).report(await getCurrentBlockTimestamp(), rewards, 0n, locked);
      const expectedDue = (rewards * operatorFee) / BP_BASE;
      expect(await delegation.nodeOperatorUnclaimedFee()).to.equal(expectedDue);

      await delegation.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(rewards / 2n);
      expect(await delegation.accruedRewardsAdjustment()).to.equal(rewards / 2n);

      const adjustedDue = expectedDue / 2n;
      expect(await delegation.nodeOperatorUnclaimedFee()).to.equal(adjustedDue);

      const claimTx = delegation.connect(nodeOperatorFeeClaimer).claimNodeOperatorFee(recipient);
      await expect(claimTx)
        .to.emit(vault, "Withdrawn")
        .withArgs(delegation, recipient, adjustedDue)
        .to.emit(delegation, "AccruedRewardsAdjustmentSet")
        .withArgs(0n, rewards / 2n);

      expect(await ethers.provider.getBalance(recipient)).to.equal(adjustedDue);
      expect(await ethers.provider.getBalance(vault)).to.equal(rewards - adjustedDue + locked);
    });
  });

  context("setAccruedRewardsAdjustment", () => {
    beforeEach(async () => {
      const operatorFee = 10_00n; // 10%
      await delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(operatorFee);
      await delegation.connect(vaultOwner).setNodeOperatorFeeBP(operatorFee);
    });

    it("reverts if called by not CONFORMING_ROLE", async () => {
      await expect(delegation.connect(stranger).setAccruedRewardsAdjustment(100n, 0n)).to.be.revertedWithCustomError(
        delegation,
        "SenderNotMember",
      );
    });

    it("reverts if trying to set same adjustment", async () => {
      const current = await delegation.accruedRewardsAdjustment();
      await delegation.connect(nodeOperatorManager).setAccruedRewardsAdjustment(current, current);

      await expect(
        delegation.connect(vaultOwner).setAccruedRewardsAdjustment(current, current),
      ).to.be.revertedWithCustomError(delegation, "SameAdjustment");
    });

    it("reverts if trying to set more than limit", async () => {
      const current = await delegation.accruedRewardsAdjustment();
      const LIMIT = await delegation.MANUAL_ACCRUED_REWARDS_ADJUSTMENT_LIMIT();

      await delegation.connect(nodeOperatorManager).setAccruedRewardsAdjustment(LIMIT + 1n, current);

      await expect(
        delegation.connect(vaultOwner).setAccruedRewardsAdjustment(LIMIT + 1n, current),
      ).to.be.revertedWithCustomError(delegation, "IncreasedOverLimit");
    });

    it("reverts vote if AccruedRewardsAdjustment changes", async () => {
      const current = await delegation.accruedRewardsAdjustment();
      expect(current).to.equal(0n);
      const proposed = 100n;
      const increase = proposed - current + 100n;
      const postIncrease = current + increase;

      await delegation.connect(nodeOperatorManager).setAccruedRewardsAdjustment(proposed, current);
      expect(await delegation.accruedRewardsAdjustment()).to.equal(current);

      await delegation.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(increase);
      expect(await delegation.accruedRewardsAdjustment()).to.equal(postIncrease);

      await expect(delegation.connect(vaultOwner).setAccruedRewardsAdjustment(proposed, current))
        .to.be.revertedWithCustomError(delegation, "InvalidatedAdjustmentVote")
        .withArgs(postIncrease, current);
    });

    it("allows to set adjustment by committee", async () => {
      const currentAdjustment = await delegation.accruedRewardsAdjustment();
      expect(currentAdjustment).to.equal(0n);
      const newAdjustment = 100n;

      const msgData = delegation.interface.encodeFunctionData("setAccruedRewardsAdjustment", [
        newAdjustment,
        currentAdjustment,
      ]);

      let confirmTimestamp = (await getNextBlockTimestamp()) + (await delegation.getConfirmExpiry());

      const firstConfirmTx = await delegation
        .connect(nodeOperatorManager)
        .setAccruedRewardsAdjustment(newAdjustment, currentAdjustment);

      await expect(firstConfirmTx)
        .to.emit(delegation, "RoleMemberConfirmed")
        .withArgs(nodeOperatorManager, await delegation.NODE_OPERATOR_MANAGER_ROLE(), confirmTimestamp, msgData);

      expect(await delegation.accruedRewardsAdjustment()).to.equal(currentAdjustment);

      confirmTimestamp = (await getNextBlockTimestamp()) + (await delegation.getConfirmExpiry());

      const secondConfrimTx = await delegation
        .connect(vaultOwner)
        .setAccruedRewardsAdjustment(newAdjustment, currentAdjustment);

      await expect(secondConfrimTx)
        .to.emit(delegation, "RoleMemberConfirmed")
        .withArgs(vaultOwner, await delegation.DEFAULT_ADMIN_ROLE(), confirmTimestamp, msgData)
        .to.emit(delegation, "AccruedRewardsAdjustmentSet")
        .withArgs(newAdjustment, currentAdjustment);

      expect(await delegation.accruedRewardsAdjustment()).to.equal(newAdjustment);
    });
  });

  context("trustedWithdrawAndDeposit", () => {
    beforeEach(async () => {
      const operatorFee = 10_00n; // 10%
      await delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(operatorFee);
      await delegation.connect(vaultOwner).setNodeOperatorFeeBP(operatorFee);
    });

    it("reverts if the caller is not a member of the withdrawer role", async () => {
      await expect(delegation.connect(stranger).unguaranteedDepositToBeaconChain([])).to.be.revertedWithCustomError(
        delegation,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if the  deposit is empty", async () => {
      await expect(
        delegation.connect(unguaranteedBeaconChainDepositor).unguaranteedDepositToBeaconChain([]),
      ).to.be.revertedWithCustomError(delegation, "ZeroArgument");

      await expect(
        delegation
          .connect(unguaranteedBeaconChainDepositor)
          .unguaranteedDepositToBeaconChain([generatePostDeposit(generateValidator().container, 0n)]),
      ).to.be.revertedWithCustomError(delegation, "ZeroArgument");
    });

    it("allows to trustedWithdrawAndDeposit and increases accruedRewardsAdjustment", async () => {
      const validator = generateValidator(await vault.withdrawalCredentials()).container;
      const amount = ether("32");
      await delegation.connect(funder).fund({ value: amount });

      const deposit = generatePostDeposit(validator, ether("32"));
      const locked = await vault.locked();

      const withdrawDepositTx = delegation
        .connect(unguaranteedBeaconChainDepositor)
        .unguaranteedDepositToBeaconChain([deposit]);
      await expect(withdrawDepositTx)
        .to.emit(vault, "Withdrawn")
        .withArgs(delegation, delegation, deposit.amount)
        .to.emit(delegation, "UnguaranteedDeposit")
        .withArgs(vault, deposit.pubkey, deposit.amount)
        .to.emit(delegation, "AccruedRewardsAdjustmentSet")
        .withArgs(deposit.amount, 0n);

      expect(await delegation.valuation()).to.equal(locked);
      expect(await delegation.withdrawableEther()).to.equal(0n);
      expect(await delegation.accruedRewardsAdjustment()).to.equal(deposit.amount);
    });

    it("unguaranteedDepositToBeaconChain can increase accruedRewardsAdjustment beyond manual limit", async () => {
      // set adjustment to manual limit
      const LIMIT = await delegation.MANUAL_ACCRUED_REWARDS_ADJUSTMENT_LIMIT();
      await delegation.connect(nodeOperatorRewardAdjuster).increaseAccruedRewardsAdjustment(LIMIT);
      expect(await delegation.accruedRewardsAdjustment()).to.equal(LIMIT);

      // prep for shortcut deposit
      const validator = generateValidator(await vault.withdrawalCredentials()).container;
      const amount = ether("32");
      await delegation.connect(funder).fund({ value: amount });
      const deposit = generatePostDeposit(validator, ether("32"));

      // increase adjustment with unguaranteedDepositToBeaconChain
      const withdrawDepositTx = delegation
        .connect(unguaranteedBeaconChainDepositor)
        .unguaranteedDepositToBeaconChain([deposit]);
      await expect(withdrawDepositTx)
        .to.emit(delegation, "AccruedRewardsAdjustmentSet")
        .withArgs(LIMIT + BigInt(deposit.amount), LIMIT);

      expect(await delegation.accruedRewardsAdjustment()).to.equal(LIMIT + BigInt(deposit.amount));
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
      await vault.connect(hubSigner).report(await getCurrentBlockTimestamp(), valuation, inOutDelta, locked);

      expect(await delegation.unreserved()).to.equal(0n);
    });
  });

  context("withdrawableEther", () => {
    it("returns the correct amount", async () => {
      const amount = ether("1");
      await delegation.connect(funder).fund({ value: amount });
      expect(await delegation.withdrawableEther()).to.equal(amount);
    });

    it("returns the correct amount when balance is less than unreserved", async () => {
      const valuation = ether("3");
      const inOutDelta = 0n;
      const locked = ether("2");

      const amount = ether("1");
      const vaultBalanceBefore = await ethers.provider.getBalance(vault);
      await delegation.connect(funder).fund({ value: amount });
      await vault.connect(hubSigner).report(await getCurrentBlockTimestamp(), valuation, inOutDelta, locked);

      expect(await delegation.withdrawableEther()).to.equal(amount + vaultBalanceBefore);
    });

    it("returns the correct amount when has fees", async () => {
      const amount = ether("6");
      const valuation = ether("3");
      const inOutDelta = ether("1");
      const locked = ether("2");

      const operatorFeeBP = 1000; // 10%
      await delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(operatorFeeBP);

      await delegation.connect(funder).fund({ value: amount });

      await vault.connect(hubSigner).report(await getCurrentBlockTimestamp(), valuation, inOutDelta, locked);
      const unreserved = await delegation.unreserved();

      expect(await delegation.withdrawableEther()).to.equal(unreserved);
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
      const vaultBalanceBefore = await ethers.provider.getBalance(vault);
      expect(await ethers.provider.getBalance(vault)).to.equal(vaultBalanceBefore);
      expect(await vault.inOutDelta()).to.equal(vaultBalanceBefore);
      expect(await vault.valuation()).to.equal(vaultBalanceBefore);

      await expect(delegation.connect(funder).fund({ value: amount }))
        .to.emit(vault, "Funded")
        .withArgs(delegation, amount);

      expect(await ethers.provider.getBalance(vault)).to.equal(amount + vaultBalanceBefore);
      expect(await vault.inOutDelta()).to.equal(amount + vaultBalanceBefore);
      expect(await vault.valuation()).to.equal(amount + vaultBalanceBefore);
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
      const timestamp = await getCurrentBlockTimestamp();
      await vault.connect(hubSigner).report(timestamp, amount, 0n, 0n);
      const vaultBalanceBefore = await ethers.provider.getBalance(vault);
      expect(await vault.valuation()).to.equal(amount + vaultBalanceBefore);
      expect(await vault.unlocked()).to.equal(amount + vaultBalanceBefore);

      expect(await ethers.provider.getBalance(vault)).to.equal(vaultBalanceBefore);
      await rewarder.sendTransaction({ to: vault, value: amount });
      expect(await ethers.provider.getBalance(vault)).to.equal(amount + vaultBalanceBefore);

      expect(await ethers.provider.getBalance(recipient)).to.equal(0n);
      await expect(delegation.connect(withdrawer).withdraw(recipient, amount))
        .to.emit(vault, "Withdrawn")
        .withArgs(delegation, recipient, amount);
      expect(await ethers.provider.getBalance(vault)).to.equal(vaultBalanceBefore);
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

  context("setOperatorFee", () => {
    it("reverts if new fee is greater than max fee", async () => {
      const invalidFee = MAX_FEE + 1n;
      await delegation.connect(vaultOwner).setNodeOperatorFeeBP(invalidFee);

      await expect(
        delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(invalidFee),
      ).to.be.revertedWithCustomError(delegation, "FeeValueExceed100Percent");
    });

    it("reverts if performance due is not zero", async () => {
      // set the performance fee to 5%
      const newOperatorFee = 500n;
      await delegation.connect(vaultOwner).setNodeOperatorFeeBP(newOperatorFee);
      await delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(newOperatorFee);
      expect(await delegation.nodeOperatorFeeBP()).to.equal(newOperatorFee);

      // bring rewards
      const totalRewards = ether("1");
      const inOutDelta = 0n;
      const locked = 0n;
      await vault.connect(hubSigner).report(await getCurrentBlockTimestamp(), totalRewards, inOutDelta, locked);
      expect(await delegation.nodeOperatorUnclaimedFee()).to.equal((totalRewards * newOperatorFee) / BP_BASE);

      // attempt to change the performance fee to 6%
      await delegation.connect(vaultOwner).setNodeOperatorFeeBP(600n);
      await expect(delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(600n)).to.be.revertedWithCustomError(
        delegation,
        "NodeOperatorFeeUnclaimed",
      );
    });

    it("requires both default admin and operator manager to set the operator fee and emits the RoleMemberConfirmed event", async () => {
      const previousOperatorFee = await delegation.nodeOperatorFeeBP();
      const newOperatorFee = 1000n;
      let expiryTimestamp = (await getNextBlockTimestamp()) + (await delegation.getConfirmExpiry());
      const msgData = delegation.interface.encodeFunctionData("setNodeOperatorFeeBP", [newOperatorFee]);

      await expect(delegation.connect(vaultOwner).setNodeOperatorFeeBP(newOperatorFee))
        .to.emit(delegation, "RoleMemberConfirmed")
        .withArgs(vaultOwner, await delegation.DEFAULT_ADMIN_ROLE(), expiryTimestamp, msgData);
      // fee is unchanged
      expect(await delegation.nodeOperatorFeeBP()).to.equal(previousOperatorFee);
      // check confirm
      expect(await delegation.confirmations(msgData, await delegation.DEFAULT_ADMIN_ROLE())).to.equal(expiryTimestamp);

      expiryTimestamp = (await getNextBlockTimestamp()) + (await delegation.getConfirmExpiry());
      await expect(delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(newOperatorFee))
        .to.emit(delegation, "RoleMemberConfirmed")
        .withArgs(nodeOperatorManager, await delegation.NODE_OPERATOR_MANAGER_ROLE(), expiryTimestamp, msgData)
        .and.to.emit(delegation, "NodeOperatorFeeBPSet")
        .withArgs(nodeOperatorManager, previousOperatorFee, newOperatorFee);

      expect(await delegation.nodeOperatorFeeBP()).to.equal(newOperatorFee);

      // resets the confirms
      for (const role of await delegation.confirmingRoles()) {
        expect(await delegation.confirmations(keccak256(msgData), role)).to.equal(0n);
      }
    });

    it("reverts if the caller is not a member of the operator fee committee", async () => {
      const newOperatorFee = 1000n;
      await expect(delegation.connect(stranger).setNodeOperatorFeeBP(newOperatorFee)).to.be.revertedWithCustomError(
        delegation,
        "SenderNotMember",
      );
    });

    it("doesn't execute if an earlier confirm has expired", async () => {
      const previousOperatorFee = await delegation.nodeOperatorFeeBP();
      const newOperatorFee = 1000n;
      const msgData = delegation.interface.encodeFunctionData("setNodeOperatorFeeBP", [newOperatorFee]);
      let expiryTimestamp = (await getNextBlockTimestamp()) + (await delegation.getConfirmExpiry());

      await expect(delegation.connect(vaultOwner).setNodeOperatorFeeBP(newOperatorFee))
        .to.emit(delegation, "RoleMemberConfirmed")
        .withArgs(vaultOwner, await delegation.DEFAULT_ADMIN_ROLE(), expiryTimestamp, msgData);
      // fee is unchanged
      expect(await delegation.nodeOperatorFeeBP()).to.equal(previousOperatorFee);
      // check confirm
      expect(await delegation.confirmations(msgData, await delegation.DEFAULT_ADMIN_ROLE())).to.equal(expiryTimestamp);

      // move time forward
      await advanceChainTime(days(7n) + 1n);
      const expectedExpiryTimestamp = (await getNextBlockTimestamp()) + (await delegation.getConfirmExpiry());
      expect(expectedExpiryTimestamp).to.be.greaterThan(expiryTimestamp + days(7n));
      await expect(delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(newOperatorFee))
        .to.emit(delegation, "RoleMemberConfirmed")
        .withArgs(nodeOperatorManager, await delegation.NODE_OPERATOR_MANAGER_ROLE(), expectedExpiryTimestamp, msgData);

      // fee is still unchanged
      expect(await delegation.nodeOperatorFeeBP()).to.equal(previousOperatorFee);
      // check confirm
      expect(await delegation.confirmations(msgData, await delegation.NODE_OPERATOR_MANAGER_ROLE())).to.equal(
        expectedExpiryTimestamp,
      );

      // curator has to confirm again
      expiryTimestamp = (await getNextBlockTimestamp()) + (await delegation.getConfirmExpiry());
      await expect(delegation.connect(vaultOwner).setNodeOperatorFeeBP(newOperatorFee))
        .to.emit(delegation, "RoleMemberConfirmed")
        .withArgs(vaultOwner, await delegation.DEFAULT_ADMIN_ROLE(), expiryTimestamp, msgData)
        .and.to.emit(delegation, "NodeOperatorFeeBPSet")
        .withArgs(vaultOwner, previousOperatorFee, newOperatorFee);
      // fee is now changed
      expect(await delegation.nodeOperatorFeeBP()).to.equal(newOperatorFee);
    });
  });

  context("transferStakingVaultOwnership", () => {
    it("reverts if the caller is not a member of the transfer committee", async () => {
      await expect(delegation.connect(stranger).transferStakingVaultOwnership(recipient)).to.be.revertedWithCustomError(
        delegation,
        "SenderNotMember",
      );
    });

    it("requires both curator and operator to transfer ownership and emits the RoleMemberConfirmd event", async () => {
      const newOwner = certainAddress("newOwner");
      const msgData = delegation.interface.encodeFunctionData("transferStakingVaultOwnership", [newOwner]);
      let expiryTimestamp = (await getNextBlockTimestamp()) + (await delegation.getConfirmExpiry());
      await expect(delegation.connect(vaultOwner).transferStakingVaultOwnership(newOwner))
        .to.emit(delegation, "RoleMemberConfirmed")
        .withArgs(vaultOwner, await delegation.DEFAULT_ADMIN_ROLE(), expiryTimestamp, msgData);
      // owner is unchanged
      expect(await vault.owner()).to.equal(delegation);

      expiryTimestamp = (await getNextBlockTimestamp()) + (await delegation.getConfirmExpiry());
      await expect(delegation.connect(nodeOperatorManager).transferStakingVaultOwnership(newOwner))
        .to.emit(delegation, "RoleMemberConfirmed")
        .withArgs(nodeOperatorManager, await delegation.NODE_OPERATOR_MANAGER_ROLE(), expiryTimestamp, msgData);
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
