import { expect } from "chai";
import { ethers } from "hardhat";
import { describe } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { StakingVault__MockForVaultHub, VaultHub } from "typechain-types";

import { ether } from "lib/units";

import { deployVaults } from "test/deploy";
import { Snapshot } from "test/suite";

describe("VaultHub.sol:obligations", () => {
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
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("setVaultRedemptionShares", () => {
    before(async () => {
      await vaultHub.connect(deployer).grantRole(await vaultHub.REDEMPTION_MASTER_ROLE(), redemptionMaster);
    });

    it("reverts when called by a non-REDEMPTION_MASTER_ROLE", async () => {
      await expect(
        vaultHub.connect(stranger).setVaultRedemptionShares(disconnectedVault, 1000n),
      ).to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount");
    });

    it("reverts if vault is not connected to the hub", async () => {
      await expect(vaultHub.connect(redemptionMaster).setVaultRedemptionShares(disconnectedVault, 1000n))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(disconnectedVault);
    });

    it("reverts if redemption shares are not set (either because they are 0 or because they are already set)", async () => {
      await expect(vaultHub.connect(redemptionMaster).setVaultRedemptionShares(connectedVault, 1000n))
        .to.be.revertedWithCustomError(vaultHub, "RedemptionSharesNotSet")
        .withArgs(connectedVault, 1000n, 0n);
    });

    it("sets redemption shares to liability shares in case of overflow", async () => {
      const liabilityShares = 100n;
      const redemptionShares = 1000n;
      await connectedVault.connect(user).fund({ value: ether("1000") });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue: ether("1000") });
      await vaultHub.connect(user).mintShares(connectedVault, user, liabilityShares);

      await expect(vaultHub.connect(redemptionMaster).setVaultRedemptionShares(connectedVault, redemptionShares))
        .to.emit(vaultHub, "RedemptionSharesUpdated")
        .withArgs(connectedVault, liabilityShares)
        .and.not.to.emit(connectedVault, "BeaconChainDepositsPaused");
    });

    it("sets redemption shares fully if it is less than liability shares", async () => {
      const liabilityShares = ether("2");
      const redemptionShares = ether("1");

      await connectedVault.connect(user).fund({ value: ether("1000") });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue: ether("1000") });
      await vaultHub.connect(user).mintShares(connectedVault, user, liabilityShares);

      await expect(vaultHub.connect(redemptionMaster).setVaultRedemptionShares(connectedVault, redemptionShares))
        .to.emit(vaultHub, "RedemptionSharesUpdated")
        .withArgs(connectedVault, redemptionShares)
        .and.to.emit(connectedVault, "BeaconChainDepositsPaused");
    });
  });
});
