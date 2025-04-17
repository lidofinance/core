import { expect } from "chai";
import { hexlify } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Delegation, StakingVault } from "typechain-types";

import {
  certainAddress,
  computeDepositDataRoot,
  generatePostDeposit,
  generatePredeposit,
  generateValidator,
  impersonate,
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

import { getPubkeys } from "../../../lib/protocol/helpers/vaults";
import { ether } from "../../../lib/units";

const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);

describe("Integration: Actions with vault disconnected from hub", () => {
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
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));

  // TODO: take all actions for disconnected vaults and tru to test them and check that they change state as expected

  describe("Funding", () => {
    it("Allows to fund amount less or equal then funder's balance + gas price", async () => {
      const amount = 3n;

      await expect(delegation.connect(roles.funder).fund({ value: amount }))
        .to.emit(stakingVault, "Funded")
        .withArgs(delegation, amount);

      expect(await stakingVault.inOutDelta()).to.equal(amount);
      expect(await stakingVault.valuation()).to.equal(amount);

      expect(await delegation.withdrawableEther()).to.equal(amount);
    });

    // weth contract must be deployed, @Yuri will add to provision, may skip for now
    it.skip("fundWeth");
  });

  describe("Withdrawal", () => {
    it("rejects to withdraw more than not locked", async () => {
      const amount = 10n;
      const lockedAmount = 9n;

      await delegation.connect(roles.funder).fund({ value: amount });
      await delegation.connect(roles.locker).lock(lockedAmount);
      const withdrawableAmount = await delegation.withdrawableEther();

      expect(withdrawableAmount).to.equal(amount - lockedAmount);
      await expect(
        delegation.connect(roles.withdrawer).withdraw(stranger, withdrawableAmount + 1n),
      ).to.be.revertedWithCustomError(delegation, "RequestedAmountExceedsUnreserved");
    });

    it("rejects to lock more than funded", async () => {
      const amount = 10n;

      await delegation.connect(roles.funder).fund({ value: amount });

      await expect(delegation.connect(roles.locker).lock(amount + 1n)).to.be.revertedWithCustomError(
        stakingVault,
        "NewLockedExceedsValuation",
      );
    });

    it("withdraw all funded amount", async () => {
      await expect(delegation.connect(roles.funder).fund({ value: 3n }))
        .to.emit(stakingVault, "Funded")
        .withArgs(delegation, 3n);

      expect(await delegation.withdrawableEther()).to.equal(3n);

      await expect(await delegation.connect(roles.withdrawer).withdraw(stranger, 1n))
        .to.emit(stakingVault, "Withdrawn")
        .withArgs(delegation, stranger, 1n);

      expect(await stakingVault.inOutDelta()).to.equal(2n);
      expect(await stakingVault.valuation()).to.equal(2n);
      expect(await delegation.withdrawableEther()).to.equal(2n);
    });

    // weth contract must be deployed, @Yuri will add to provision, may skip for now
    it.skip("withdrawWETH");

    it("can reset lock and withdraw all the funded amount", async () => {
      const amount = 10n;
      const lockedAmount = 9n;

      await delegation.connect(roles.funder).fund({ value: amount });

      await delegation.connect(roles.locker).lock(lockedAmount);
      await delegation.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();
      expect(await delegation.withdrawableEther()).to.equal(amount - lockedAmount);
      await delegation.connect(roles.lockedResetter).resetLocked();
      expect(await delegation.withdrawableEther()).to.equal(amount);

      await expect(delegation.connect(roles.withdrawer).withdraw(stranger, amount))
        .to.emit(stakingVault, "Withdrawn")
        .withArgs(delegation, stranger, 10n);
    });

    // todo: could not fid out how to send reward in a way it would be withdrawable
    it.skip("may receive rewards and withdraw all the funds with rewards", async () => {
      await stranger.sendTransaction({
        to: stakingVault.getAddress(),
        value: 50n,
      });
      console.log(await ethers.provider.getBalance(stakingVault.getAddress()));
      await delegation.connect(roles.locker).lock(13n);
      expect(await delegation.withdrawableEther()).to.equal(1n);
      await expect(delegation.connect(roles.withdrawer).withdraw(stranger, 2n)).to.emit(stakingVault, "Withdrawn");
    });
  });

  describe("Set depositor / make deposit to beacon chain", () => {
    it("Can't set depositor is vaulthub is authorized", async () => {
      expect(await stakingVault.vaultHubAuthorized()).to.equal(true);
      await expect(
        delegation.connect(roles.depositorSetter).setDepositor(stranger.address),
      ).to.be.revertedWithCustomError(stakingVault, "VaultHubAuthorized");
    });

    it("Can set depositor is vaulthub is not authorized", async () => {
      await delegation.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();
      await expect(delegation.connect(roles.depositorSetter).setDepositor(stranger.address))
        .to.emit(stakingVault, "DepositorSet")
        .withArgs(stranger.address);
    });
  });

  describe("Authorize / Deauthorize Lido VaultHub", () => {
    it("After creation via createVaultWithDelegation vault is authorized", async () => {
      expect(await stakingVault.vaultHubAuthorized()).to.equal(true);
    });

    it("Can deauthorize Lido VaultHub if it's authorized", async () => {
      await expect(delegation.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub())
        .to.emit(stakingVault, "VaultHubAuthorizedSet")
        .withArgs(false);

      expect(await stakingVault.vaultHubAuthorized()).to.equal(false);
    });
    it("Can authorize Lido VaultHub if it's deauthorized", async () => {
      await delegation.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();

      await expect(delegation.connect(roles.lidoVaultHubAuthorizer).authorizeLidoVaultHub())
        .to.emit(stakingVault, "VaultHubAuthorizedSet")
        .withArgs(true);

      expect(await stakingVault.vaultHubAuthorized()).to.equal(true);
    });

    it("Can't authorize or deauthorize Lido VaultHub if it's already in this state", async () => {
      await expect(
        delegation.connect(roles.lidoVaultHubAuthorizer).authorizeLidoVaultHub(),
      ).to.be.revertedWithCustomError(stakingVault, "VaultHubAuthorized");

      await delegation.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();
      await expect(
        delegation.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub(),
      ).to.be.revertedWithCustomError(stakingVault, "VaultHubNotAuthorized");
    });
  });

  describe("Ossify vault", () => {
    it("Can't ossify vault if it's authorized", async () => {
      await expect(delegation.connect(roles.ossifier).ossifyStakingVault()).to.be.revertedWithCustomError(
        stakingVault,
        "VaultHubAuthorized",
      );
    });

    it("Can ossify vault if it's not authorized", async () => {
      await delegation.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();
      await expect(delegation.connect(roles.ossifier).ossifyStakingVault()).to.emit(
        stakingVault,
        "PinnedImplementationUpdated",
      );
      expect(await stakingVault.ossified()).to.equal(true);
    });

    it("Can't ossify vault it's already ossified", async () => {
      await delegation.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();
      await delegation.connect(roles.ossifier).ossifyStakingVault();
      await expect(delegation.connect(roles.ossifier).ossifyStakingVault()).to.be.revertedWithCustomError(
        stakingVault,
        "AlreadyOssified",
      );
    });
  });

  // TODO: test that vault owner can request validator exit and both can trigger exits
  describe("Request / trigger validator exit", () => {
    it("Vault owner can request validator(s) exit", async () => {
      const keys = getPubkeys(2);
      await expect(delegation.connect(roles.validatorExitRequester).requestValidatorExit(keys.stringified))
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(delegation, keys.pubkeys[0], keys.pubkeys[0])
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(delegation, keys.pubkeys[1], keys.pubkeys[1]);
    });

    it("can't perform exit trigger if vault is authorized", async () => {
      expect(await stakingVault.vaultHubAuthorized()).to.equal(true);
      await expect(
        delegation
          .connect(roles.validatorWithdrawalTriggerer)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1")], await owner.getAddress(), {
            value: 1n,
          }),
      ).to.be.revertedWithCustomError(stakingVault, "PartialWithdrawalNotAllowed");
    });

    it("can't perform trigger if withdrawal fee is insufficient", async () => {
      const keysAmount = 3;
      const value = 2n;
      const keys = getPubkeys(keysAmount);
      await delegation.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();
      await expect(
        delegation
          .connect(roles.validatorWithdrawalTriggerer)
          .triggerValidatorWithdrawal(
            keys.stringified,
            [ether("1"), ether("2"), ether("1")],
            await owner.getAddress(),
            {
              value: value,
            },
          ),
      )
        .to.be.revertedWithCustomError(stakingVault, "InsufficientValidatorWithdrawalFee")
        .withArgs(value, keysAmount);
    });

    it("can perform trigger if vault is not authorized", async () => {
      const keysAmount = 2;
      const keys = getPubkeys(keysAmount);
      const value = 100n;
      const ownerAddress = await owner.getAddress();
      await delegation.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();
      await expect(
        delegation
          .connect(roles.validatorWithdrawalTriggerer)
          .triggerValidatorWithdrawal(keys.stringified, [ether("1"), ether("2")], ownerAddress, { value }),
      )
        .to.emit(stakingVault, "ValidatorWithdrawalTriggered")
        .withArgs(delegation, keys.stringified, [ether("1"), ether("2")], ownerAddress, value - BigInt(keysAmount));
    });
  });

  describe("Reverts because not connected", () => {
    it("Reverts on minting stETH", async () => {
      await delegation.connect(roles.funder).fund({ value: ether("1") });
      await delegation.connect(owner).grantRole(await delegation.LOCK_ROLE(), roles.minter.address);

      await expect(delegation.connect(roles.minter).mintStETH(roles.locker, 1n)).to.be.revertedWithCustomError(
        ctx.contracts.vaultHub,
        "NotConnectedToHub",
      );
    });

    it("Reverts on burning stETH", async () => {
      const { lido, vaultHub, locator } = ctx.contracts;

      // suppose user somehow got 1 share and tries to burn it via the delegation contract on disconnected vault
      const accountingSigner = await impersonate(await locator.accounting(), ether("1"));
      await lido.connect(accountingSigner).mintShares(roles.burner, 1n);

      await expect(delegation.connect(roles.burner).burnStETH(1n)).to.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
    });
  });

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
