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

    disconnectedVault = await vaultsContext.createMockStakignVault(user, user);
    connectedVault = await vaultsContext.createMockStakignVaultAndConnect(user, user);

    await vaultHub.connect(deployer).grantRole(await vaultHub.REDEMPTION_MASTER_ROLE(), redemptionMaster);
    await vaultHub.connect(deployer).grantRole(await vaultHub.PAUSE_ROLE(), user);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("updateRedemptionShares", () => {
    it("reverts when called by a non-REDEMPTION_MASTER_ROLE", async () => {
      await expect(
        vaultHub.connect(stranger).updateRedemptionShares(disconnectedVault, 1000n),
      ).to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount");
    });

    it("reverts if vault is not connected to the hub", async () => {
      await expect(vaultHub.connect(redemptionMaster).updateRedemptionShares(disconnectedVault, 1000n))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(disconnectedVault);
    });

    it("sets redemption shares to liability shares in case of overflow", async () => {
      const liabilityShares = 100n;
      const redemptionShares = 1000n;

      await connectedVault.connect(user).fund({ value: ether("1000") });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue: ether("1000") });
      await vaultHub.connect(user).mintShares(connectedVault, user, liabilityShares);

      await expect(vaultHub.connect(redemptionMaster).updateRedemptionShares(connectedVault, redemptionShares))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(connectedVault, liabilityShares)
        .and.not.to.emit(connectedVault, "Mock__BeaconChainDepositsPaused");
    });

    it("sets redemption shares fully if it is less than liability shares (and pauses deposits)", async () => {
      const liabilityShares = ether("2");

      await vaultsContext.reportVault({ vault: connectedVault, totalValue: ether("3") }); //
      await vaultHub.connect(user).mintShares(connectedVault, user, liabilityShares);

      await expect(vaultHub.connect(redemptionMaster).updateRedemptionShares(connectedVault, liabilityShares))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(connectedVault, liabilityShares)
        .to.emit(connectedVault, "Mock__BeaconChainDepositsPaused");
    });

    it("allows to reset redemption shares to 0", async () => {
      const liabilityShares = ether("2");

      await vaultsContext.reportVault({ vault: connectedVault, totalValue: ether("3") });
      await vaultHub.connect(user).mintShares(connectedVault, user, liabilityShares);

      await expect(vaultHub.connect(redemptionMaster).updateRedemptionShares(connectedVault, liabilityShares))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(connectedVault, liabilityShares)
        .and.to.emit(connectedVault, "Mock__BeaconChainDepositsPaused");

      await expect(vaultHub.connect(redemptionMaster).updateRedemptionShares(connectedVault, 0n))
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

    it("settles obligations and unpauses deposits if they are paused", async () => {
      const totalValue = ether("10");
      const redemptionShares = ether("1");
      await connectedVault.connect(user).fund({ value: totalValue });

      // Simulate that the vault has no balance on EL
      const vaultAddress = await connectedVault.getAddress();
      const vaultBalanceBefore = await ethers.provider.getBalance(vaultAddress);
      await setBalance(vaultAddress, 0);

      // Report the vault with some fees, mint shares and set redemption shares to simulate that the vault has obligations
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });
      await vaultHub.connect(user).mintShares(connectedVault, user, ether("2"));
      await vaultHub.connect(redemptionMaster).updateRedemptionShares(connectedVault, redemptionShares);

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
