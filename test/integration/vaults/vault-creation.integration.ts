import { expect } from "chai";
import { hexlify } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Delegation, StakingVault } from "typechain-types";

import {
  certainAddress,
  computeDepositDataRoot,
  ether,
  generatePostDeposit,
  generatePredeposit,
  generateValidator,
  prepareLocalMerkleTree,
} from "lib";
import {
  createVaultWithDelegation,
  generateFeesToClaim,
  getProtocolContext,
  ProtocolContext,
  setupLido,
  VaultRoles,
} from "lib/protocol";

import { Snapshot } from "test/suite";

const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);

describe("Scenario: Actions on vault creation", () => {
  let ctx: ProtocolContext;

  let delegation: Delegation;
  let stakingVault: StakingVault;
  let roles: VaultRoles;

  let owner: HardhatEthersSigner;
  let nodeOperatorManager: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let snapshot: string;
  let originalSnapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLido(ctx);

    [owner, nodeOperatorManager, stranger] = await ethers.getSigners();

    // Owner can create a vault with operator as a node operator
    ({ stakingVault, delegation, roles } = await createVaultWithDelegation(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperatorManager,
    ));

    //await connectToHub(ctx, delegation, stakingVault);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));

  it("Allows pause/resume deposits to beacon chain", async () => {
    await expect(delegation.connect(roles.depositPauser).pauseBeaconChainDeposits()).to.emit(
      stakingVault,
      "BeaconChainDepositsPaused",
    );

    await expect(delegation.connect(roles.depositResumer).resumeBeaconChainDeposits()).to.emit(
      stakingVault,
      "BeaconChainDepositsResumed",
    );
  });

  it("Allows ask Node Operator to exit validator(s)", async () => {
    await expect(delegation.connect(roles.validatorExitRequester).requestValidatorExit(SAMPLE_PUBKEY))
      .to.emit(stakingVault, "ValidatorExitRequested")
      .withArgs(delegation, SAMPLE_PUBKEY, SAMPLE_PUBKEY);
  });

  // Node Operator Manager roles actions

  it("Allows claiming NO's fee", async () => {
    await delegation.connect(roles.funder).fund({ value: ether("1") });
    await delegation.connect(nodeOperatorManager).setNodeOperatorFeeBP(1n);
    await delegation.connect(owner).setNodeOperatorFeeBP(1n);

    await expect(
      delegation.connect(roles.nodeOperatorFeeClaimer).claimNodeOperatorFee(stranger),
    ).to.be.revertedWithCustomError(ctx.contracts.vaultHub, "ZeroArgument");

    await generateFeesToClaim(ctx, stakingVault);

    await expect(delegation.connect(roles.nodeOperatorFeeClaimer).claimNodeOperatorFee(stranger))
      .to.emit(stakingVault, "Withdrawn")
      .withArgs(delegation, stranger, 100000000000000n);
  });

  it("Allows pre and depositing validators to beacon chain", async () => {
    const { predepositGuarantee } = ctx.contracts;

    // Pre-requisite: fund the vault to have enough balance to start a validator
    await delegation.connect(roles.funder).fund({ value: ether("32") });

    // Step 1: Top up the node operator balance
    await predepositGuarantee.connect(nodeOperatorManager).topUpNodeOperatorBalance(nodeOperatorManager, {
      value: ether("1"),
    });

    // Step 2: Predeposit a validator
    const withdrawalCredentials = await stakingVault.withdrawalCredentials();
    const validator = generateValidator(withdrawalCredentials);
    const predepositData = await generatePredeposit(validator);

    await expect(
      predepositGuarantee
        .connect(nodeOperatorManager)
        .predeposit(stakingVault, [predepositData.deposit], [predepositData.depositY]),
    )
      .to.emit(stakingVault, "DepositedToBeaconChain")
      .withArgs(ctx.contracts.predepositGuarantee.address, 1, ether("1"));

    // Step 3: Prove and deposit the validator
    const slot = await predepositGuarantee.SLOT_CHANGE_GI_FIRST_VALIDATOR();

    const mockCLtree = await prepareLocalMerkleTree(await predepositGuarantee.GI_FIRST_VALIDATOR_AFTER_CHANGE());
    const { validatorIndex } = await mockCLtree.addValidator(validator.container);
    const { childBlockTimestamp, beaconBlockHeader } = await mockCLtree.commitChangesToBeaconRoot(Number(slot) + 100);
    const proof = await mockCLtree.buildProof(validatorIndex, beaconBlockHeader);

    const postdeposit = generatePostDeposit(validator.container);
    const pubkey = hexlify(validator.container.pubkey);
    const signature = hexlify(postdeposit.signature);

    postdeposit.depositDataRoot = computeDepositDataRoot(withdrawalCredentials, pubkey, signature, ether("31"));

    const witnesses = [{ proof, pubkey, validatorIndex, childBlockTimestamp }];

    await expect(
      predepositGuarantee.connect(nodeOperatorManager).proveAndDeposit(witnesses, [postdeposit], stakingVault),
    )
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
