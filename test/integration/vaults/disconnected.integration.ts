import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault } from "typechain-types";

import {
  certainAddress,
  days,
  ether,
  generatePostDeposit,
  generateValidator,
  getNextBlockTimestamp,
  impersonate,
} from "lib";
import {
  createVaultWithDashboard,
  disconnectFromHub,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLido,
  VaultRoles,
} from "lib/protocol";
import {
  generatePredepositData,
  getProofAndDepositData,
  getPubkeys,
  VAULT_CONNECTION_DEPOSIT,
} from "lib/protocol/helpers/vaults";

import { Snapshot } from "test/suite";

const VAULT_NODE_OPERATOR_FEE = 200n;
const DEFAULT_CONFIRM_EXPIRY = days(7n);

describe("Integration: Actions with vault disconnected from hub", () => {
  let ctx: ProtocolContext;

  let dashboard: Dashboard;
  let stakingVault: StakingVault;
  let roles: VaultRoles;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let depositor: HardhatEthersSigner;

  let snapshot: string;
  let originalSnapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLido(ctx);

    [owner, nodeOperator, stranger, depositor] = await ethers.getSigners();

    // Owner can create a vault with operator as a node operator
    ({ stakingVault, dashboard, roles } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
      [],
      VAULT_NODE_OPERATOR_FEE,
      DEFAULT_CONFIRM_EXPIRY,
    ));
    await disconnectFromHub(ctx, stakingVault);
    await reportVaultDataWithProof(stakingVault);

    // Extra step to make sure that vault is disconnected from hub
    await dashboard.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub();
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Fund", () => {
    it("Allows to fund any amount", async () => {
      const amount = ether("1000");
      await expect(dashboard.connect(roles.funder).fund({ value: amount }))
        .to.emit(stakingVault, "Funded")
        .withArgs(dashboard, amount);

      expect(await stakingVault.inOutDelta()).to.equal(VAULT_CONNECTION_DEPOSIT + amount);
      expect(await stakingVault.totalValue()).to.equal(VAULT_CONNECTION_DEPOSIT + amount);

      expect(await dashboard.withdrawableEther()).to.equal(VAULT_CONNECTION_DEPOSIT + amount);
    });
  });

  describe("Withdrawal", () => {
    it("Rejects to withdraw more than unreserved", async () => {
      const amount = ether("10");
      const lockedAmount = ether("9");

      await dashboard.connect(roles.funder).fund({ value: amount });
      await dashboard.connect(roles.locker).lock(VAULT_CONNECTION_DEPOSIT + lockedAmount);

      const withdrawableAmount = await dashboard.withdrawableEther();

      expect(withdrawableAmount).to.equal(amount - lockedAmount);
      await expect(
        dashboard.connect(roles.withdrawer).withdraw(stranger, withdrawableAmount + 1n),
      ).to.be.revertedWithCustomError(dashboard, "WithdrawalAmountExceedsUnreserved");
    });

    it("Withdraws all the funds with the connection deposit", async () => {
      const amount = ether("10");

      await expect(dashboard.connect(roles.funder).fund({ value: amount }))
        .to.emit(stakingVault, "Funded")
        .withArgs(dashboard, amount);

      const withdrawableAmount = VAULT_CONNECTION_DEPOSIT + amount;
      expect(await dashboard.withdrawableEther()).to.equal(withdrawableAmount);

      // Zero out the balance of the vault
      await expect(await dashboard.connect(roles.withdrawer).withdraw(stranger, withdrawableAmount))
        .to.emit(stakingVault, "Withdrawn")
        .withArgs(dashboard, stranger, withdrawableAmount);

      expect(await stakingVault.inOutDelta()).to.equal(0);
      expect(await stakingVault.totalValue()).to.equal(0);
      expect(await dashboard.withdrawableEther()).to.equal(0);
    });

    it("Can reset lock and withdraw all the funded amount", async () => {
      const amount = ether("10");
      const lockedAmount = ether("9");

      await dashboard.connect(roles.funder).fund({ value: amount });
      await dashboard.connect(roles.locker).lock(VAULT_CONNECTION_DEPOSIT + lockedAmount);

      expect(await dashboard.withdrawableEther()).to.equal(amount - lockedAmount);

      await dashboard.connect(roles.lockedResetter).resetLocked();
      const withdrawableAmount = VAULT_CONNECTION_DEPOSIT + amount;
      expect(await dashboard.withdrawableEther()).to.equal(withdrawableAmount);

      await expect(dashboard.connect(roles.withdrawer).withdraw(stranger, withdrawableAmount))
        .to.emit(stakingVault, "Withdrawn")
        .withArgs(dashboard, stranger, withdrawableAmount);

      expect(await stakingVault.inOutDelta()).to.equal(0);
      expect(await stakingVault.totalValue()).to.equal(0);
      expect(await dashboard.withdrawableEther()).to.equal(0);
    });

    it("Can't withdraw rewards if vault is disconnected from hub", async () => {
      const reward = ether("1");

      await stranger.sendTransaction({
        to: stakingVault.getAddress(),
        value: reward,
      });

      expect(await ethers.provider.getBalance(stakingVault.getAddress())).to.equal(VAULT_CONNECTION_DEPOSIT + reward);
      expect(await dashboard.withdrawableEther()).to.equal(VAULT_CONNECTION_DEPOSIT);
    });
  });

  it("Can change the tier", async () => {
    const { operatorGrid } = ctx.contracts;
    const agentSigner = await ctx.getSigner("agent");

    await operatorGrid.connect(agentSigner).registerGroup(nodeOperator, 1000);
    await operatorGrid.connect(agentSigner).registerTiers(nodeOperator, [
      {
        shareLimit: 1000,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        treasuryFeeBP: 500,
      },
    ]);

    const ownerMemberIndex = ethers.zeroPadValue(await dashboard.getAddress(), 32);
    const operatorMemberIndex = ethers.zeroPadValue(await nodeOperator.getAddress(), 32);
    let expiryTimestamp = (await getNextBlockTimestamp()) + (await operatorGrid.getConfirmExpiry());
    const msgData = operatorGrid.interface.encodeFunctionData("changeTier", [await stakingVault.getAddress(), 1, 1000]);

    await expect(dashboard.connect(roles.tierChanger).changeTier(1n, 1000n))
      .to.emit(operatorGrid, "RoleMemberConfirmed")
      .withArgs(dashboard, ownerMemberIndex, expiryTimestamp, msgData);

    expiryTimestamp = (await getNextBlockTimestamp()) + (await operatorGrid.getConfirmExpiry());
    await expect(operatorGrid.connect(nodeOperator).changeTier(stakingVault, 1n, 1000n))
      .to.emit(operatorGrid, "RoleMemberConfirmed")
      .withArgs(nodeOperator, operatorMemberIndex, expiryTimestamp, msgData)
      .to.emit(operatorGrid, "TierChanged")
      .withArgs(stakingVault, 1);
  });

  describe("Locking", () => {
    it("Rejects to lock more than funded", async () => {
      const amount = ether("10");

      await dashboard.connect(roles.funder).fund({ value: amount });

      await expect(
        dashboard.connect(roles.locker).lock(VAULT_CONNECTION_DEPOSIT + amount + 1n),
      ).to.be.revertedWithCustomError(stakingVault, "NewLockedExceedsTotalValue");
    });

    it("Allows to lock ammount required to connect to hub", async () => {
      const amount = ether("1");
      await expect(dashboard.connect(roles.funder).fund({ value: amount }))
        .to.emit(stakingVault, "Funded")
        .withArgs(dashboard, amount);

      await expect(dashboard.connect(roles.locker).lock(amount))
        .to.emit(stakingVault, "LockedIncreased")
        .withArgs(amount);

      expect(await stakingVault.inOutDelta()).to.equal(VAULT_CONNECTION_DEPOSIT + amount);
      expect(await stakingVault.totalValue()).to.equal(VAULT_CONNECTION_DEPOSIT + amount);
    });
  });

  describe("Authorize / Deauthorize Lido VaultHub", () => {
    it("Can't deauthorize Lido VaultHub", async () => {
      await expect(
        dashboard.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub(),
      ).to.be.revertedWithCustomError(stakingVault, "VaultHubNotAuthorized");
    });

    it("Can authorize Lido VaultHub if it's deauthorized", async () => {
      await expect(dashboard.connect(roles.lidoVaultHubAuthorizer).authorizeLidoVaultHub())
        .to.emit(stakingVault, "VaultHubAuthorizedSet")
        .withArgs(true);

      expect(await stakingVault.vaultHubAuthorized()).to.equal(true);
    });
  });

  describe("Ossification", () => {
    it("Can ossify vault", async () => {
      await expect(dashboard.connect(roles.ossifier).ossifyStakingVault()).to.emit(
        stakingVault,
        "PinnedImplementationUpdated",
      );
      expect(await stakingVault.ossified()).to.equal(true);
    });

    it.skip("Can withdraw rewards after ossification", async () => {
      await dashboard.connect(roles.ossifier).ossifyStakingVault();
      const reward = ether("3");

      await stranger.sendTransaction({
        to: stakingVault.getAddress(),
        value: reward,
      });

      expect(await ethers.provider.getBalance(stakingVault.getAddress())).to.equal(VAULT_CONNECTION_DEPOSIT + reward);

      expect(await dashboard.withdrawableEther()).to.equal(VAULT_CONNECTION_DEPOSIT);
      await expect(dashboard.connect(roles.withdrawer).withdraw(stranger, reward)).to.emit(stakingVault, "Withdrawn");
      expect(await ethers.provider.getBalance(stakingVault.getAddress())).to.equal(0);
    });
    it("Can't ossify vault it's already ossified", async () => {
      await dashboard.connect(roles.ossifier).ossifyStakingVault();
      await expect(dashboard.connect(roles.ossifier).ossifyStakingVault()).to.be.revertedWithCustomError(
        stakingVault,
        "AlreadyOssified",
      );
    });
  });

  describe("Request validator exit", () => {
    it("Vault owner can request validator(s) exit", async () => {
      const keys = getPubkeys(2);
      await expect(dashboard.connect(roles.validatorExitRequester).requestValidatorExit(keys.stringified))
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(dashboard, keys.pubkeys[0], keys.pubkeys[0])
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(dashboard, keys.pubkeys[1], keys.pubkeys[1]);
    });
  });

  describe("Trigger validator withdrawal", () => {
    it("Can't perform trigger if withdrawal fee is insufficient", async () => {
      const keysAmount = 3;
      const value = await stakingVault.calculateValidatorWithdrawalFee(keysAmount - 1);
      const keys = getPubkeys(keysAmount);

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

    it("Can perform trigger if vault is not authorized", async () => {
      const keysAmount = 2;
      const keys = getPubkeys(keysAmount);
      const value = await stakingVault.calculateValidatorWithdrawalFee(keysAmount);
      const ownerAddress = await owner.getAddress();

      await expect(
        dashboard
          .connect(roles.validatorWithdrawalTriggerer)
          .triggerValidatorWithdrawal(keys.stringified, [ether("1"), ether("2")], ownerAddress, { value }),
      )
        .to.emit(stakingVault, "ValidatorWithdrawalTriggered")
        .withArgs(dashboard, keys.stringified, [ether("1"), ether("2")], ownerAddress, 0); // 0 refund bc fee = value
    });
  });

  describe("Reverts because not connected to VaultHub", () => {
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

      // suppose user somehow got 1 share and tries to burn it via the dashboard contract on disconnected vault
      const accountingSigner = await impersonate(await locator.accounting(), ether("1"));
      await lido.connect(accountingSigner).mintShares(roles.burner, 1n);

      await expect(dashboard.connect(roles.burner).burnStETH(1n)).to.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
    });
  });

  describe("Pausing/resuming deposits to beacon chain", () => {
    it("Allows pause/resume deposits to beacon chain", async () => {
      await expect(dashboard.connect(roles.depositPauser).pauseBeaconChainDeposits()).to.emit(
        stakingVault,
        "BeaconChainDepositsPaused",
      );
      await expect(dashboard.connect(roles.depositPauser).pauseBeaconChainDeposits()).to.be.revertedWithCustomError(
        stakingVault,
        "BeaconChainDepositsResumeExpected",
      );

      await expect(dashboard.connect(roles.depositResumer).resumeBeaconChainDeposits()).to.emit(
        stakingVault,
        "BeaconChainDepositsResumed",
      );
      await expect(dashboard.connect(roles.depositResumer).resumeBeaconChainDeposits()).to.be.revertedWithCustomError(
        stakingVault,
        "BeaconChainDepositsPauseExpected",
      );
    });

    it("Allows to deposit only if deposits are not paused", async () => {
      const { predepositGuarantee } = ctx.contracts;
      const withdrawalCredentials = await stakingVault.withdrawalCredentials();
      const validator = generateValidator(withdrawalCredentials);
      const predepositData = await generatePredepositData(
        predepositGuarantee,
        dashboard,
        roles,
        nodeOperator,
        validator,
      );

      await dashboard.connect(roles.depositPauser).pauseBeaconChainDeposits();

      await expect(
        predepositGuarantee
          .connect(nodeOperator)
          .predeposit(stakingVault, [predepositData.deposit], [predepositData.depositY]),
      ).to.be.revertedWithCustomError(stakingVault, "BeaconChainDepositsArePaused");

      await dashboard.connect(roles.depositResumer).resumeBeaconChainDeposits();

      await expect(
        predepositGuarantee
          .connect(nodeOperator)
          .predeposit(stakingVault, [predepositData.deposit], [predepositData.depositY]),
      ).to.emit(stakingVault, "DepositedToBeaconChain");
    });
  });

  context("Deposits", () => {
    it("Allows to set depositor and deposit validators to beacon chain", async () => {
      await dashboard.connect(roles.funder).fund({ value: ether("32") });

      await expect(dashboard.connect(roles.depositorSetter).setDepositor(depositor.address))
        .to.emit(stakingVault, "DepositorSet")
        .withArgs(depositor.address);

      const withdrawalCredentials = await stakingVault.withdrawalCredentials();
      const validator = generateValidator(withdrawalCredentials);

      const deposit = await generatePostDeposit(validator.container, ether("32"));

      await expect(stakingVault.connect(depositor).depositToBeaconChain([deposit])).to.emit(
        stakingVault,
        "DepositedToBeaconChain",
      );
    });

    it("Allows pre and depositing validators to beacon chain", async () => {
      const { predepositGuarantee } = ctx.contracts;

      const withdrawalCredentials = await stakingVault.withdrawalCredentials();
      const validator = generateValidator(withdrawalCredentials);

      const predepositData = await generatePredepositData(
        predepositGuarantee,
        dashboard,
        roles,
        nodeOperator,
        validator,
      );

      await expect(
        predepositGuarantee
          .connect(nodeOperator)
          .predeposit(stakingVault, [predepositData.deposit], [predepositData.depositY]),
      )
        .to.emit(stakingVault, "DepositedToBeaconChain")
        .withArgs(ctx.contracts.predepositGuarantee.address, 1, ether("1"));

      const { witnesses, postdeposit } = await getProofAndDepositData(
        predepositGuarantee,
        validator,
        withdrawalCredentials,
      );

      await expect(predepositGuarantee.connect(nodeOperator).proveAndDeposit(witnesses, [postdeposit], stakingVault))
        .to.emit(stakingVault, "DepositedToBeaconChain")
        .withArgs(ctx.contracts.predepositGuarantee.address, 1, ether("31"));
    });
  });

  // Both Owner and Node Operator Manager role actions

  it("Owner and Node Operator Manager can both vote for transferring ownership of the vault", async () => {
    const newOwner = certainAddress("new-owner");

    await expect(await dashboard.connect(nodeOperator).transferStakingVaultOwnership(newOwner)).to.emit(
      dashboard,
      "MemberConfirmed",
    );

    await expect(dashboard.connect(owner).transferStakingVaultOwnership(newOwner))
      .to.emit(stakingVault, "OwnershipTransferred")
      .withArgs(dashboard, newOwner);

    expect(await stakingVault.owner()).to.equal(newOwner);
  });
});
