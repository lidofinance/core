import { expect } from "chai";
import { ContractTransactionReceipt, hexlify } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Delegation, StakingVault, VaultFactory } from "typechain-types";

import {
  certainAddress,
  computeDepositDataRoot,
  days,
  ether,
  generatePostDeposit,
  generatePredeposit,
  generateValidator,
  impersonate,
  prepareLocalMerkleTree,
} from "lib";
import { getProtocolContext, getRandomSigners, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

import { setupLido } from "../../../lib/protocol/vaults";

const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);
const VAULT_NODE_OPERATOR_FEE = 3_00n; // 3% node operator fee

const reserveRatio = 10_00n; // 10% of ETH allocation as reserve
const rebalanceThreshold = 8_00n; // 8% is a threshold to force rebalance on the vault

describe("Scenario: actions on vault creation", () => {
  let ctx: ProtocolContext;

  let delegation: Delegation;
  let stakingVault: StakingVault;

  let delegationWithoutConnect: Delegation;

  let owner: HardhatEthersSigner,
    nodeOperatorManager: HardhatEthersSigner,
    funder: HardhatEthersSigner,
    withdrawer: HardhatEthersSigner,
    locker: HardhatEthersSigner,
    assetRecoverer: HardhatEthersSigner,
    minter: HardhatEthersSigner,
    burner: HardhatEthersSigner,
    rebalancer: HardhatEthersSigner,
    depositPauser: HardhatEthersSigner,
    depositResumer: HardhatEthersSigner,
    validatorExitRequester: HardhatEthersSigner,
    validatorWithdrawalTriggerer: HardhatEthersSigner,
    disconnecter: HardhatEthersSigner,
    nodeOperatorFeeClaimer: HardhatEthersSigner,
    stranger: HardhatEthersSigner;

  let allRoles: HardhatEthersSigner[];
  let snapshot: string;
  let originalSnapshot: string;

  async function createVaultAndDelegation(
    stakingVaultFactory: VaultFactory & { address: string },
  ): Promise<{ stakingVault: StakingVault; delegation: Delegation }> {
    const deployTx = await stakingVaultFactory.connect(owner).createVaultWithDelegation(
      {
        defaultAdmin: owner,
        nodeOperatorManager: nodeOperatorManager,
        assetRecoverer: assetRecoverer,
        nodeOperatorFeeBP: VAULT_NODE_OPERATOR_FEE,
        confirmExpiry: days(7n),
        funders: [funder],
        withdrawers: [withdrawer],
        minters: [minter],
        lockers: [locker],
        burners: [burner],
        rebalancers: [rebalancer],
        depositPausers: [depositPauser],
        depositResumers: [depositResumer],
        validatorExitRequesters: [validatorExitRequester],
        validatorWithdrawalTriggerers: [validatorWithdrawalTriggerer],
        disconnecters: [disconnecter],
        nodeOperatorFeeClaimers: [nodeOperatorFeeClaimer],
      },
      "0x",
    );
    const createVaultTxReceipt = (await deployTx.wait()) as ContractTransactionReceipt;
    const createVaultEvents = ctx.getEvents(createVaultTxReceipt, "VaultCreated");

    expect(createVaultEvents.length).to.equal(1n);

    const stakingVault_ = await ethers.getContractAt("StakingVault", createVaultEvents[0].args?.vault);
    const delegation_ = await ethers.getContractAt("Delegation", createVaultEvents[0].args?.owner);

    return { stakingVault: stakingVault_, delegation: delegation_ };
  }

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    const { depositSecurityModule, stakingVaultFactory } = ctx.contracts;
    await depositSecurityModule.DEPOSIT_CONTRACT();

    allRoles = await getRandomSigners(20);
    [
      owner,
      nodeOperatorManager,
      assetRecoverer,
      funder,
      withdrawer,
      locker,
      minter,
      burner,
      rebalancer,
      depositPauser,
      depositResumer,
      validatorExitRequester,
      validatorWithdrawalTriggerer,
      disconnecter,
      nodeOperatorFeeClaimer,
      stranger,
    ] = allRoles;

    // Owner can create a vault with operator as a node operator
    const { stakingVault: stakingVault_, delegation: delegation_ } =
      await createVaultAndDelegation(stakingVaultFactory);
    const { delegation: delegationWithoutConnect_ } = await createVaultAndDelegation(stakingVaultFactory);

    stakingVault = stakingVault_;
    delegation = delegation_;

    delegationWithoutConnect = delegationWithoutConnect_;

    //connect to vaultHub
    const delegationSigner = await impersonate(await delegation.getAddress(), ether("100"));
    await stakingVault.connect(delegationSigner).fund({ value: ether("1") });
    await stakingVault.connect(delegationSigner).lock(ether("1"));

    const { vaultHub, locator } = ctx.contracts;

    const treasuryFeeBP = 5_00n; // 5% of the treasury fee
    const shareLimit = (await ctx.contracts.lido.getTotalShares()) / 10n; // 10% of total shares

    const deployer = await ctx.getSigner("agent");
    await vaultHub
      .connect(deployer)
      .connectVault(stakingVault, shareLimit, reserveRatio, rebalanceThreshold, treasuryFeeBP);

    const valuations = [await stakingVault.valuation()];
    const inOutDeltas = [await stakingVault.inOutDelta()];
    const locked = [await stakingVault.locked()];
    const treasuryFees = [0n];

    const accountingSigner = await impersonate(await locator.accounting(), ether("100"));
    await vaultHub.connect(accountingSigner).updateVaults(valuations, inOutDeltas, locked, treasuryFees);

    await setupLido(ctx);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));

  async function generateFeesToClaim() {
    const { vaultHub } = ctx.contracts;
    const hubSigner = await impersonate(await vaultHub.getAddress(), ether("100"));
    const rewards = ether("1");
    await stakingVault.connect(hubSigner).report(rewards, 0n, 0n);
  }

  it("Allows fund and withdraw", async () => {
    await expect(delegation.connect(funder).fund({ value: 2n }))
      .to.emit(stakingVault, "Funded")
      .withArgs(delegation, 2n);

    expect(await delegation.withdrawableEther()).to.equal(2n);

    await expect(await delegation.connect(withdrawer).withdraw(stranger, 2n))
      .to.emit(stakingVault, "Withdrawn")
      .withArgs(delegation, stranger, 2n);

    expect(await delegation.withdrawableEther()).to.equal(0);
  });

  it("Allows pause/resume deposits to beacon chain", async () => {
    await expect(delegation.connect(depositPauser).pauseBeaconChainDeposits()).to.emit(
      stakingVault,
      "BeaconChainDepositsPaused",
    );

    await expect(delegation.connect(depositResumer).resumeBeaconChainDeposits()).to.emit(
      stakingVault,
      "BeaconChainDepositsResumed",
    );
  });

  it("Allows ask Node Operator to exit validator(s)", async () => {
    await expect(delegation.connect(validatorExitRequester).requestValidatorExit(SAMPLE_PUBKEY))
      .to.emit(stakingVault, "ValidatorExitRequested")
      .withArgs(delegation, SAMPLE_PUBKEY, SAMPLE_PUBKEY);
  });

  it("Allows trigger validator withdrawal", async () => {
    await expect(
      delegation
        .connect(validatorWithdrawalTriggerer)
        .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1")], validatorWithdrawalTriggerer, { value: 1n }),
    )
      .to.emit(stakingVault, "ValidatorWithdrawalTriggered")
      .withArgs(delegation, SAMPLE_PUBKEY, [ether("1")], validatorWithdrawalTriggerer, 0);

    await expect(
      stakingVault
        .connect(nodeOperatorManager)
        .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1")], validatorWithdrawalTriggerer, { value: 1n }),
    ).to.emit(stakingVault, "ValidatorWithdrawalTriggered");
  });

  context("Disconnected vault", () => {
    it("Reverts on minting stETH", async () => {
      await delegationWithoutConnect.connect(funder).fund({ value: ether("1") });
      await delegationWithoutConnect
        .connect(owner)
        .grantRole(await delegationWithoutConnect.LOCK_ROLE(), minter.address);

      await expect(delegationWithoutConnect.connect(minter).mintStETH(locker, 1n)).to.be.revertedWithCustomError(
        ctx.contracts.vaultHub,
        "NotConnectedToHub",
      );
    });

    it("Reverts on burning stETH", async () => {
      const { lido, vaultHub, locator } = ctx.contracts;

      // suppose user somehow got 1 share and tries to burn it via the delegation contract on disconnected vault
      const accountingSigner = await impersonate(await locator.accounting(), ether("1"));
      await lido.connect(accountingSigner).mintShares(burner, 1n);

      await expect(delegationWithoutConnect.connect(burner).burnStETH(1n)).to.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
    });
  });

  describe("Connected vault", () => {
    it("Allows minting stETH", async () => {
      const { vaultHub } = ctx.contracts;

      // add some stETH to the vault to have valuation
      await delegation.connect(funder).fund({ value: ether("1") });

      await expect(delegation.connect(minter).mintStETH(stranger, 1n))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, 1n);
    });

    it("Allows burning stETH", async () => {
      const { vaultHub, lido } = ctx.contracts;

      // add some stETH to the vault to have valuation, mint shares and approve stETH
      await delegation.connect(funder).fund({ value: ether("1") });
      await delegation.connect(minter).mintStETH(burner, 1n);
      await lido.connect(burner).approve(delegation, 1n);

      await expect(delegation.connect(burner).burnStETH(1n))
        .to.emit(vaultHub, "BurnedSharesOnVault")
        .withArgs(stakingVault, 1n);
    });
  });

  // Node Operator Manager roles actions

  it("Allows claiming NO's fee", async () => {
    await delegation.connect(funder).fund({ value: ether("1") });
    await delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(1n);
    await delegation.connect(owner).setNodeOperatorFeeBP(1n);

    await expect(
      delegation.connect(nodeOperatorFeeClaimer).claimNodeOperatorFee(stranger),
    ).to.be.revertedWithCustomError(ctx.contracts.vaultHub, "ZeroArgument");

    await generateFeesToClaim();

    await expect(delegation.connect(nodeOperatorFeeClaimer).claimNodeOperatorFee(stranger))
      .to.emit(stakingVault, "Withdrawn")
      .withArgs(delegation, stranger, 100000000000000n);
  });

  it("Allows pre and depositing validators to beacon chain", async () => {
    const pdg = ctx.contracts.predepositGuarantee;

    // Pre-requisite: fund the vault to have enough balance to start a validator
    await delegation.connect(funder).fund({ value: ether("32") });

    // Step 1: Top up the node operator balance
    await pdg.connect(nodeOperatorManager).topUpNodeOperatorBalance(nodeOperatorManager, { value: ether("1") });

    // Step 2: Predeposit a validator
    const withdrawalCredentials = await stakingVault.withdrawalCredentials();
    const validator = generateValidator(withdrawalCredentials);
    const predepositData = generatePredeposit(validator);

    await expect(pdg.connect(nodeOperatorManager).predeposit(stakingVault, [predepositData]))
      .to.emit(stakingVault, "DepositedToBeaconChain")
      .withArgs(ctx.contracts.predepositGuarantee.address, 1, ether("1"));

    // Step 3: Prove and deposit the validator
    const slot = await pdg.SLOT_CHANGE_GI_FIRST_VALIDATOR();

    const mockCLtree = await prepareLocalMerkleTree(await pdg.GI_FIRST_VALIDATOR_AFTER_CHANGE());
    const { validatorIndex } = await mockCLtree.addValidator(validator);
    const { childBlockTimestamp, beaconBlockHeader } = await mockCLtree.commitChangesToBeaconRoot(Number(slot) + 100);
    const proof = await mockCLtree.buildProof(validatorIndex, beaconBlockHeader);

    const postdeposit = generatePostDeposit(validator);
    const pubkey = hexlify(validator.pubkey);
    const signature = hexlify(postdeposit.signature);

    postdeposit.depositDataRoot = computeDepositDataRoot(withdrawalCredentials, pubkey, signature, ether("31"));

    const witnesses = [{ proof, pubkey, validatorIndex, childBlockTimestamp }];

    await expect(pdg.connect(nodeOperatorManager).proveAndDeposit(witnesses, [postdeposit], stakingVault))
      .to.emit(stakingVault, "DepositedToBeaconChain")
      .withArgs(ctx.contracts.predepositGuarantee.address, 1, ether("31"));
  });

  // Both Owner and Node Operator Manager role actions

  it("Owner and Node Operator Manager can both vote for transferring ownership of the vault", async () => {
    const newOwner = certainAddress("new-owner");

    await expect(await delegation.connect(nodeOperatorManager).transferStakingVaultOwnership(newOwner)).to.emit(
      delegation,
      "RoleMemberConfirmed",
    );

    await expect(delegation.connect(owner).transferStakingVaultOwnership(newOwner))
      .to.emit(stakingVault, "OwnershipTransferred")
      .withArgs(delegation, newOwner);

    expect(await stakingVault.owner()).to.equal(newOwner);
  });
});
