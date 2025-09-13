import { expect } from "chai";
import { ethers } from "hardhat";
import { describe } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { StakingVault__MockForVaultHub, VaultHub } from "typechain-types";

import { ether } from "lib/units";

import { deployVaults } from "test/deploy";
import { Snapshot } from "test/suite";

describe("VaultHub.sol:redemptions", () => {
  let vaultsContext: Awaited<ReturnType<typeof deployVaults>>;
  let vaultHub: VaultHub;
  let disconnectedVault: StakingVault__MockForVaultHub;
  let connectedVault: StakingVault__MockForVaultHub;

  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let redemptionMaster: HardhatEthersSigner;

  let originalState: string;

  before(async () => {
    [deployer, user, stranger, redemptionMaster] = await ethers.getSigners();

    vaultsContext = await deployVaults({ deployer, admin: user });
    vaultHub = vaultsContext.vaultHub;

    disconnectedVault = await vaultsContext.createMockStakingVault(user, user);
    connectedVault = await vaultsContext.createMockStakingVaultAndConnect(user, user);

    await vaultHub.connect(deployer).grantRole(await vaultHub.REDEMPTION_MASTER_ROLE(), redemptionMaster);
    await vaultHub.connect(deployer).grantRole(await vaultHub.PAUSE_ROLE(), user);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("setLiabilitySharesTarget", () => {
    it("reverts when called by a non-REDEMPTION_MASTER_ROLE", async () => {
      await expect(
        vaultHub.connect(stranger).setLiabilitySharesTarget(disconnectedVault, 1000n),
      ).to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount");
    });

    it("reverts if vault is not connected to the hub", async () => {
      await expect(vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(disconnectedVault, 1000n))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(disconnectedVault);
    });

    it("sets redemption shares to all liability shares if target is 0", async () => {
      const liabilityShares = 100n;

      await connectedVault.connect(user).fund({ value: ether("1000") });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue: ether("1000") });
      await vaultHub.connect(user).mintShares(connectedVault, user, liabilityShares);

      await expect(vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(connectedVault, 0n))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(connectedVault, liabilityShares)
        .and.to.emit(connectedVault, "Mock__BeaconChainDepositsPaused");
    });

    it("allows to set redemption shares fully up to liability shares", async () => {
      const liabilityShares = ether("2");

      await vaultsContext.reportVault({ vault: connectedVault, totalValue: ether("3") });
      await vaultHub.connect(user).mintShares(connectedVault, user, liabilityShares);

      await expect(vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(connectedVault, 0n))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(connectedVault, liabilityShares)
        .to.emit(connectedVault, "Mock__BeaconChainDepositsPaused");
    });

    it("pauses deposits if redemption shares are set to >= MIN_BEACON_DEPOSIT (1 ether)", async () => {
      const liabilityShares = ether("2");
      const redemptionShares = ether("1");

      await vaultsContext.reportVault({ vault: connectedVault, totalValue: ether("3") });
      await vaultHub.connect(user).mintShares(connectedVault, user, liabilityShares);

      await expect(
        vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(connectedVault, liabilityShares - redemptionShares),
      )
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(connectedVault, redemptionShares)
        .to.emit(connectedVault, "Mock__BeaconChainDepositsPaused");
    });

    it("does pause deposits if redemption shares are set to > 0", async () => {
      const liabilityShares = ether("2");
      const redemptionShares = 1n;

      await vaultsContext.reportVault({ vault: connectedVault, totalValue: ether("3") });
      await vaultHub.connect(user).mintShares(connectedVault, user, liabilityShares);

      await expect(
        vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(connectedVault, liabilityShares - redemptionShares),
      )
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(connectedVault, redemptionShares)
        .and.to.emit(connectedVault, "Mock__BeaconChainDepositsPaused");
    });

    // https://github.com/lidofinance/core/issues/1297
    it("allows to reset redemption shares to 0 passing target more than liability shares", async () => {
      const liabilityShares = ether("2");

      await vaultsContext.reportVault({ vault: connectedVault, totalValue: ether("3") });
      await vaultHub.connect(user).mintShares(connectedVault, user, liabilityShares);

      await expect(vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(connectedVault, 0n))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(connectedVault, liabilityShares)
        .and.to.emit(connectedVault, "Mock__BeaconChainDepositsPaused");

      await expect(vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(connectedVault, liabilityShares + 1n))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(connectedVault, 0n)
        .and.to.emit(connectedVault, "Mock__BeaconChainDepositsResumed");

      const record = await vaultHub.vaultRecord(connectedVault);
      expect(await connectedVault.beaconChainDepositsPaused()).to.be.false;
      expect(record.redemptionShares).to.equal(0n);
    });
  });

  context("forceRebalance", () => {
    it("reverts if vault is not connected to the hub", async () => {
      await disconnectedVault.connect(user).fund({ value: ether("1") });
      await expect(vaultHub.forceRebalance(disconnectedVault))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(disconnectedVault);
    });

    it("reverts if report is stale", async () => {
      await expect(vaultHub.forceRebalance(connectedVault))
        .to.be.revertedWithCustomError(vaultHub, "VaultReportStale")
        .withArgs(connectedVault);
    });

    it("settles obligations and unpauses deposits if they are paused", async () => {
      const totalValue = ether("10");
      const liabilityShares = ether("2");
      const redemptionShares = ether("1");
      await connectedVault.connect(user).fund({ value: totalValue });

      // Simulate that the vault has no balance on EL
      const vaultAddress = await connectedVault.getAddress();
      const vaultBalanceBefore = await ethers.provider.getBalance(vaultAddress);
      await setBalance(vaultAddress, 0);

      // Report the vault with some fees, mint shares and set redemption shares to simulate that the vault has obligations
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });
      await vaultHub.connect(user).mintShares(connectedVault, user, ether("2"));
      await vaultHub
        .connect(redemptionMaster)
        .setLiabilitySharesTarget(connectedVault, liabilityShares - redemptionShares);

      // Check that the deposits are paused and the vault has obligations
      expect(await connectedVault.beaconChainDepositsPaused()).to.be.true;

      const record = await vaultHub.vaultRecord(connectedVault);
      expect(record.redemptionShares).to.equal(redemptionShares);

      // Return the balance to the vault
      await setBalance(vaultAddress, vaultBalanceBefore);

      // Settle the obligations and check that the deposits are unpaused
      await expect(vaultHub.forceRebalance(connectedVault))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(connectedVault, 0n)
        .to.emit(vaultHub, "VaultRebalanced")
        .withArgs(connectedVault, redemptionShares, redemptionShares); // 1 share => 1 wei in unit tests

      expect(await connectedVault.beaconChainDepositsPaused()).to.be.false;
    });
  });
});
