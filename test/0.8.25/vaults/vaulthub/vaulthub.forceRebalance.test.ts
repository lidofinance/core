import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { Lido, StakingVault__MockForVaultHub, VaultHub } from "typechain-types";

import { ether } from "lib/units";

import { deployVaults } from "test/deploy";
import { Snapshot } from "test/suite";

describe("VaultHub.sol:forceRebalance", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let vaultsContext: Awaited<ReturnType<typeof deployVaults>>;
  let vaultHub: VaultHub;
  let vault: StakingVault__MockForVaultHub;
  let disconnectedVault: StakingVault__MockForVaultHub;

  let lido: Lido;

  let vaultAddress: string;

  let originalState: string;

  before(async () => {
    [deployer, user, stranger] = await ethers.getSigners();

    vaultsContext = await deployVaults({ deployer, admin: user });
    vaultHub = vaultsContext.vaultHub;
    lido = vaultsContext.lido;

    disconnectedVault = await vaultsContext.createMockStakignVault(user, user);
    vault = await vaultsContext.createMockStakignVaultAndConnect(user, user);

    vaultAddress = await vault.getAddress();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("forceRebalance", () => {
    it("reverts if vault is zero address", async () => {
      await expect(vaultHub.forceRebalance(ethers.ZeroAddress)).to.be.revertedWithCustomError(vaultHub, "ZeroAddress");
    });

    it("reverts if vault report is stale", async () => {
      await expect(vaultHub.forceRebalance(vaultAddress))
        .to.be.revertedWithCustomError(vaultHub, "VaultReportStale")
        .withArgs(vaultAddress);
    });

    it("reverts if vault is not connected to the hub", async () => {
      await expect(vaultHub.forceRebalance(disconnectedVault.getAddress()))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(disconnectedVault.getAddress());
    });

    it("reverts if called for a disconnecting vault", async () => {
      await vaultsContext.reportVault({ vault, totalValue: ether("1") });
      await vaultHub.connect(user).disconnect(vaultAddress);

      await expect(vaultHub.forceRebalance(vaultAddress))
        .to.be.revertedWithCustomError(vaultHub, "VaultIsDisconnecting")
        .withArgs(vaultAddress);
    });

    it("reverts if called for a disconnected vault", async () => {
      await vaultsContext.reportVault({ vault, totalValue: ether("1") });
      await vaultHub.connect(user).disconnect(vaultAddress);

      await vaultsContext.reportVault({ vault, totalValue: ether("1") });

      await expect(vaultHub.forceRebalance(vaultAddress))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(vaultAddress);
    });

    context("unhealthy vault", () => {
      beforeEach(async () => {
        await vaultsContext.reportVault({
          vault,
          totalValue: ether("1"),
          inOutDelta: ether("1"),
        });

        await vaultHub.connect(user).fund(vaultAddress, { value: ether("1") });
        await vaultHub.connect(user).mintShares(vaultAddress, user, ether("0.9"));

        await vaultsContext.reportVault({
          vault,
          totalValue: ether("0.95"),
          inOutDelta: ether("2"),
          liabilityShares: ether("0.9"),
        });

        expect(await vaultHub.isVaultHealthy(vaultAddress)).to.be.false;
      });

      it("rebalances the vault with available balance", async () => {
        const sharesMintedBefore = await vaultHub.liabilityShares(vaultAddress);
        const balanceBefore = await ethers.provider.getBalance(vaultAddress);
        const expectedRebalanceAmount = await vaultHub.rebalanceShortfall(vaultAddress);
        const expectedSharesToBeBurned = await lido.getSharesByPooledEth(expectedRebalanceAmount);

        await expect(vaultHub.forceRebalance(vaultAddress))
          .to.emit(vaultHub, "VaultRebalanced")
          .withArgs(vaultAddress, expectedSharesToBeBurned, expectedRebalanceAmount)
          .to.emit(vault, "BeaconChainDepositsResumed");

        const balanceAfter = await ethers.provider.getBalance(vaultAddress);
        expect(balanceAfter).to.equal(balanceBefore - expectedRebalanceAmount);

        const sharesMintedAfter = await vaultHub.liabilityShares(vaultAddress);
        expect(sharesMintedAfter).to.equal(sharesMintedBefore - expectedSharesToBeBurned);

        expect(await vaultHub.isVaultHealthy(vaultAddress)).to.be.true;
      });

      it("rebalances with maximum available amount if shortfall exceeds balance", async () => {
        const sharesMintedBefore = await vaultHub.liabilityShares(vaultAddress);
        const shortfall = await vaultHub.rebalanceShortfall(vaultAddress);

        const expectedRebalanceAmount = shortfall / 2n;
        await setBalance(vaultAddress, expectedRebalanceAmount); // cheat to make balance lower than rebalanceShortfall

        const expectedSharesToBeBurned = await lido.getSharesByPooledEth(expectedRebalanceAmount);

        await expect(vaultHub.forceRebalance(vaultAddress))
          .to.emit(vaultHub, "VaultRebalanced")
          .withArgs(vaultAddress, expectedSharesToBeBurned, expectedRebalanceAmount)
          .not.to.emit(vault, "BeaconChainDepositsResumed");

        const balanceAfter = await ethers.provider.getBalance(vaultAddress);
        expect(balanceAfter).to.equal(0);

        const sharesMintedAfter = await vaultHub.liabilityShares(vaultAddress);
        expect(sharesMintedAfter).to.equal(sharesMintedBefore - expectedSharesToBeBurned);

        expect(await vaultHub.isVaultHealthy(vaultAddress)).to.be.false;
      });

      it("can be called by anyone", async () => {
        const balanceBefore = await ethers.provider.getBalance(vaultAddress);
        const shortfall = await vaultHub.rebalanceShortfall(vaultAddress);

        const expectedRebalanceAmount = shortfall < balanceBefore ? shortfall : balanceBefore;
        const expectedSharesToBeBurned = await lido.getSharesByPooledEth(expectedRebalanceAmount);

        await expect(vaultHub.connect(stranger).forceRebalance(vaultAddress))
          .to.emit(vaultHub, "VaultRebalanced")
          .withArgs(vaultAddress, expectedSharesToBeBurned, expectedRebalanceAmount);
      });
    });

    context("healthy vault", () => {
      it("reverts if vault is healthy", async () => {
        await vaultsContext.reportVault({ vault, totalValue: ether("1") });

        const balanceBefore = await ethers.provider.getBalance(vaultAddress);

        await expect(vaultHub.forceRebalance(vaultAddress))
          .to.be.revertedWithCustomError(vaultHub, "NothingToRebalance")
          .withArgs(vaultAddress);

        const balanceAfter = await ethers.provider.getBalance(vaultAddress);
        expect(balanceAfter).to.equal(balanceBefore);
      });
    });
  });
});
