import { expect } from "chai";
import { hexlify } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault } from "typechain-types";

import {
  certainAddress,
  computeDepositDataRoot,
  ether,
  generatePostDeposit,
  generatePredeposit,
  generateValidator,
  impersonate,
  prepareLocalMerkleTree,
} from "lib";
import {
  createVaultWithDashboard,
  generateFeesToClaim,
  getProtocolContext,
  getPubkeys,
  ProtocolContext,
  setupLido,
  VaultRoles,
} from "lib/protocol";

import { Snapshot } from "test/suite";

const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);

describe("Integration: Actions with vault disconnected from hub", () => {
  let ctx: ProtocolContext;

  let dashboard: Dashboard;
  let stakingVault: StakingVault;
  let roles: VaultRoles;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let snapshot: string;
  let originalSnapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLido(ctx);

    [owner, nodeOperator, stranger] = await ethers.getSigners();

    // Owner can create a vault with operator as a node operator
    ({ stakingVault, dashboard, roles } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
      [],
    ));
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));

  // TODO: take all actions for disconnected vaults and tru to test them and check that they change state as expected

  describe("Funding", () => {
    it("Allows to fund amount less or equal then funder's balance + gas price", async () => {
      const amount = 3n;

      await expect(dashboard.connect(roles.funder).fund({ value: amount }))
        .to.emit(stakingVault, "Funded")
        .withArgs(dashboard, amount);

      expect(await stakingVault.inOutDelta()).to.equal(amount);
      expect(await stakingVault.valuation()).to.equal(amount);

      expect(await dashboard.withdrawableEther()).to.equal(amount);
    });
  });

  describe("Withdrawal", () => {
    it("rejects to withdraw more than not locked", async () => {
      const amount = 10n;
      const lockedAmount = 9n;

      await dashboard.connect(roles.funder).fund({ value: amount });
      await dashboard.connect(roles.locker).lock(lockedAmount);
      const withdrawableAmount = await dashboard.withdrawableEther();

      expect(withdrawableAmount).to.equal(amount - lockedAmount);
      await expect(
        dashboard.connect(roles.withdrawer).withdraw(stranger, withdrawableAmount + 1n),
      ).to.be.revertedWithCustomError(dashboard, "RequestedAmountExceedsUnreserved");
    });

    it("rejects to lock more than funded", async () => {
      const amount = 10n;

      await dashboard.connect(roles.funder).fund({ value: amount });

      await expect(dashboard.connect(roles.locker).lock(amount + 1n)).to.be.revertedWithCustomError(
        stakingVault,
        "NewLockedExceedsValuation",
      );
    });

    it("withdraw all funded amount", async () => {
      await expect(dashboard.connect(roles.funder).fund({ value: 3n }))
        .to.emit(stakingVault, "Funded")
        .withArgs(dashboard, 3n);

      expect(await dashboard.withdrawableEther()).to.equal(3n);

      await expect(await dashboard.connect(roles.withdrawer).withdraw(stranger, 1n))
        .to.emit(stakingVault, "Withdrawn")
        .withArgs(dashboard, stranger, 1n);

      expect(await stakingVault.inOutDelta()).to.equal(2n);
      expect(await stakingVault.valuation()).to.equal(2n);
      expect(await dashboard.withdrawableEther()).to.equal(2n);
    });

    it("can reset lock and withdraw all the funded amount", async () => {
      const amount = 10n;
      const lockedAmount = 9n;

      await dashboard.connect(roles.funder).fund({ value: amount });

      await dashboard.connect(roles.locker).lock(lockedAmount);
      await dashboard.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();
      expect(await dashboard.withdrawableEther()).to.equal(amount - lockedAmount);
      await dashboard.connect(roles.lockedResetter).resetLocked();
      expect(await dashboard.withdrawableEther()).to.equal(amount);

      await expect(dashboard.connect(roles.withdrawer).withdraw(stranger, amount))
        .to.emit(stakingVault, "Withdrawn")
        .withArgs(dashboard, stranger, 10n);
    });

    // todo: could not fid out how to send reward in a way it would be withdrawable
    it.skip("may receive rewards and withdraw all the funds with rewards", async () => {
      await stranger.sendTransaction({
        to: stakingVault.getAddress(),
        value: 50n,
      });
      console.log(await ethers.provider.getBalance(stakingVault.getAddress()));
      await dashboard.connect(roles.locker).lock(13n);
      expect(await dashboard.withdrawableEther()).to.equal(1n);
      await expect(dashboard.connect(roles.withdrawer).withdraw(stranger, 2n)).to.emit(stakingVault, "Withdrawn");
    });
  });

  describe("Set depositor / make deposit to beacon chain", () => {
    it("Can't set depositor is vaulthub is authorized", async () => {
      expect(await stakingVault.vaultHubAuthorized()).to.equal(true);
      await expect(
        dashboard.connect(roles.depositorSetter).setDepositor(stranger.address),
      ).to.be.revertedWithCustomError(stakingVault, "VaultHubAuthorized");
    });

    it("Can set depositor is vaulthub is not authorized", async () => {
      await dashboard.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();
      await expect(dashboard.connect(roles.depositorSetter).setDepositor(stranger.address))
        .to.emit(stakingVault, "DepositorSet")
        .withArgs(stranger.address);
    });
  });

  describe("Authorize / Deauthorize Lido VaultHub", () => {
    it("After creation via createVaultWithDashboard vault is authorized", async () => {
      expect(await stakingVault.vaultHubAuthorized()).to.equal(true);
    });

    it("Can deauthorize Lido VaultHub if it's authorized", async () => {
      await expect(dashboard.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub())
        .to.emit(stakingVault, "VaultHubAuthorizedSet")
        .withArgs(false);

      expect(await stakingVault.vaultHubAuthorized()).to.equal(false);
    });
    it("Can authorize Lido VaultHub if it's deauthorized", async () => {
      await dashboard.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();

      await expect(dashboard.connect(roles.lidoVaultHubAuthorizer).authorizeLidoVaultHub())
        .to.emit(stakingVault, "VaultHubAuthorizedSet")
        .withArgs(true);

      expect(await stakingVault.vaultHubAuthorized()).to.equal(true);
    });

    it("Can't authorize or deauthorize Lido VaultHub if it's already in this state", async () => {
      await expect(
        dashboard.connect(roles.lidoVaultHubAuthorizer).authorizeLidoVaultHub(),
      ).to.be.revertedWithCustomError(stakingVault, "VaultHubAuthorized");

      await dashboard.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();
      await expect(
        dashboard.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub(),
      ).to.be.revertedWithCustomError(stakingVault, "VaultHubNotAuthorized");
    });
  });

  describe("Ossify vault", () => {
    it("Can't ossify vault if it's authorized", async () => {
      await expect(dashboard.connect(roles.ossifier).ossifyStakingVault()).to.be.revertedWithCustomError(
        stakingVault,
        "VaultHubAuthorized",
      );
    });

    it("Can ossify vault if it's not authorized", async () => {
      await dashboard.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();
      await expect(dashboard.connect(roles.ossifier).ossifyStakingVault()).to.emit(
        stakingVault,
        "PinnedImplementationUpdated",
      );
      expect(await stakingVault.ossified()).to.equal(true);
    });

    it("Can't ossify vault it's already ossified", async () => {
      await dashboard.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();
      await dashboard.connect(roles.ossifier).ossifyStakingVault();
      await expect(dashboard.connect(roles.ossifier).ossifyStakingVault()).to.be.revertedWithCustomError(
        stakingVault,
        "AlreadyOssified",
      );
    });
  });

  // TODO: test that vault owner can request validator exit and both can trigger exits
  describe("Request / trigger validator exit", () => {
    it("Vault owner can request validator(s) exit", async () => {
      const keys = getPubkeys(2);
      await expect(dashboard.connect(roles.validatorExitRequester).requestValidatorExit(keys.stringified))
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(dashboard, keys.pubkeys[0], keys.pubkeys[0])
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(dashboard, keys.pubkeys[1], keys.pubkeys[1]);
    });

    it("can't perform exit trigger if vault is authorized", async () => {
      expect(await stakingVault.vaultHubAuthorized()).to.equal(true);
      await expect(
        dashboard
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
      await dashboard.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();
      await expect(
        dashboard
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
      await dashboard.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();
      await expect(
        dashboard
          .connect(roles.validatorWithdrawalTriggerer)
          .triggerValidatorWithdrawal(keys.stringified, [ether("1"), ether("2")], ownerAddress, { value }),
      )
        .to.emit(stakingVault, "ValidatorWithdrawalTriggered")
        .withArgs(dashboard, keys.stringified, [ether("1"), ether("2")], ownerAddress, value - BigInt(keysAmount));
    });
  });

  describe("Reverts because not connected", () => {
    it("Reverts on minting stETH", async () => {
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await dashboard.connect(owner).grantRole(await dashboard.LOCK_ROLE(), roles.minter.address);

      await expect(dashboard.connect(roles.minter).mintStETH(roles.locker, 1n)).to.be.revertedWithCustomError(
        ctx.contracts.vaultHub,
        "NotConnectedToHub",
      );
    });

    it("Reverts on burning stETH", async () => {
      const { lido, vaultHub, locator } = ctx.contracts;

      // suppose user somehow got 1 share and tries to burn it via the delegation contract on disconnected vault
      const accountingSigner = await impersonate(await locator.accounting(), ether("1"));
      await lido.connect(accountingSigner).mintShares(roles.burner, 1n);

      await expect(dashboard.connect(roles.burner).burnStETH(1n)).to.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
    });
  });

  it("Allows pause/resume deposits to beacon chain", async () => {
    await expect(dashboard.connect(roles.depositPauser).pauseBeaconChainDeposits()).to.emit(
      stakingVault,
      "BeaconChainDepositsPaused",
    );

    await expect(dashboard.connect(roles.depositResumer).resumeBeaconChainDeposits()).to.emit(
      stakingVault,
      "BeaconChainDepositsResumed",
    );
  });

  it("Allows ask Node Operator to exit validator(s)", async () => {
    await expect(dashboard.connect(roles.validatorExitRequester).requestValidatorExit(SAMPLE_PUBKEY))
      .to.emit(stakingVault, "ValidatorExitRequested")
      .withArgs(dashboard, SAMPLE_PUBKEY, SAMPLE_PUBKEY);
  });

  it("Allows claiming NO's fee", async () => {
    await dashboard.connect(roles.funder).fund({ value: ether("1") });
    await dashboard.connect(nodeOperator).setNodeOperatorFeeBP(1n);
    await dashboard.connect(owner).setNodeOperatorFeeBP(1n);

    await expect(
      dashboard.connect(roles.nodeOperatorFeeClaimer).claimNodeOperatorFee(stranger),
    ).to.be.revertedWithCustomError(ctx.contracts.vaultHub, "ZeroArgument");

    await generateFeesToClaim(ctx, stakingVault);

    await expect(dashboard.connect(roles.nodeOperatorFeeClaimer).claimNodeOperatorFee(stranger))
      .to.emit(stakingVault, "Withdrawn")
      .withArgs(dashboard, stranger, 100000000000000n);
  });

  it("Allows pre and depositing validators to beacon chain", async () => {
    const { predepositGuarantee } = ctx.contracts;

    // Pre-requisite: fund the vault to have enough balance to start a validator
    await dashboard.connect(roles.funder).fund({ value: ether("32") });

    // Step 1: Top up the node operator balance
    await predepositGuarantee.connect(nodeOperator).topUpNodeOperatorBalance(nodeOperator, {
      value: ether("1"),
    });

    // Step 2: Predeposit a validator
    const withdrawalCredentials = await stakingVault.withdrawalCredentials();
    const validator = generateValidator(withdrawalCredentials);
    const predepositData = await generatePredeposit(validator);

    await expect(
      predepositGuarantee
        .connect(nodeOperator)
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

    await expect(predepositGuarantee.connect(nodeOperator).proveAndDeposit(witnesses, [postdeposit], stakingVault))
      .to.emit(stakingVault, "DepositedToBeaconChain")
      .withArgs(ctx.contracts.predepositGuarantee.address, 1, ether("31"));
  });

  // Both Owner and Node Operator Manager role actions

  it("Owner and Node Operator Manager can both vote for transferring ownership of the vault", async () => {
    const newOwner = certainAddress("new-owner");

    await expect(await dashboard.connect(nodeOperator).transferStakingVaultOwnership(newOwner)).to.emit(
      dashboard,
      "RoleMemberConfirmed",
    );

    await expect(dashboard.connect(owner).transferStakingVaultOwnership(newOwner))
      .to.emit(stakingVault, "OwnershipTransferred")
      .withArgs(dashboard, newOwner);

    expect(await stakingVault.owner()).to.equal(newOwner);
  });
});
