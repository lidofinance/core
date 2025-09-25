import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { Lido, StakingVault__MockForVaultHub, VaultHub } from "typechain-types";

import { BigIntMath } from "lib";
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

    disconnectedVault = await vaultsContext.createMockStakingVault(user, user);
    vault = await vaultsContext.createMockStakingVaultAndConnect(user, user);

    vaultAddress = await vault.getAddress();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("forceRebalance", () => {
    it("reverts if vault is zero address", async () => {
      await expect(vaultHub.forceRebalance(ethers.ZeroAddress)).to.be.revertedWithCustomError(vaultHub, "ZeroAddress");
    });

    it("reverts if vault has no funds", async () => {
      await setBalance(vaultAddress, 0n);
      await vaultsContext.reportVault({ vault, totalValue: 0n });

      await expect(vaultHub.forceRebalance(vaultAddress))
        .to.be.revertedWithCustomError(vaultHub, "NoFundsForForceRebalance")
        .withArgs(vaultAddress);
    });

    it("reverts if vault has no total value", async () => {
      await vaultsContext.reportVault({ vault, totalValue: 0n });
      await expect(vaultHub.forceRebalance(vaultAddress))
        .to.be.revertedWithCustomError(vaultHub, "NoFundsForForceRebalance")
        .withArgs(vaultAddress);
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
        const expectedRebalanceShares = await vaultHub.healthShortfallShares(vaultAddress);
        const expectedRebalanceAmount = await lido.getPooledEthBySharesRoundUp(expectedRebalanceShares);
        const expectedSharesToBeBurned = await lido.getSharesByPooledEth(expectedRebalanceShares);

        await expect(vaultHub.forceRebalance(vaultAddress))
          .to.emit(vaultHub, "VaultRebalanced")
          .withArgs(vaultAddress, expectedSharesToBeBurned, expectedRebalanceShares)
          .to.emit(vault, "Mock__BeaconChainDepositsResumed");

        const balanceAfter = await ethers.provider.getBalance(vaultAddress);
        expect(balanceAfter).to.equal(balanceBefore - expectedRebalanceAmount);

        const sharesMintedAfter = await vaultHub.liabilityShares(vaultAddress);
        expect(sharesMintedAfter).to.equal(sharesMintedBefore - expectedSharesToBeBurned);

        expect(await vaultHub.isVaultHealthy(vaultAddress)).to.be.true;
      });

      it("rebalances with maximum available amount if shortfall exceeds balance", async () => {
        const sharesMintedBefore = await vaultHub.liabilityShares(vaultAddress);
        const shortfallShares = await vaultHub.healthShortfallShares(vaultAddress);

        const shortfall = await lido.getPooledEthBySharesRoundUp(shortfallShares);
        const expectedRebalanceAmount = shortfall / 2n;
        await setBalance(vaultAddress, expectedRebalanceAmount);

        const expectedSharesToBeBurned = await lido.getSharesByPooledEth(expectedRebalanceAmount);

        await expect(vaultHub.forceRebalance(vaultAddress))
          .to.emit(vaultHub, "VaultRebalanced")
          .withArgs(vaultAddress, expectedSharesToBeBurned, expectedRebalanceAmount)
          .not.to.emit(vault, "Mock__BeaconChainDepositsResumed");

        const balanceAfter = await ethers.provider.getBalance(vaultAddress);
        expect(balanceAfter).to.equal(0);

        const sharesMintedAfter = await vaultHub.liabilityShares(vaultAddress);
        expect(sharesMintedAfter).to.equal(sharesMintedBefore - expectedSharesToBeBurned);

        expect(await vaultHub.isVaultHealthy(vaultAddress)).to.be.false;
      });

      it("can be called by anyone", async () => {
        const balanceBefore = await ethers.provider.getBalance(vaultAddress);
        const shortfallShares = await vaultHub.healthShortfallShares(vaultAddress);

        const shortfall = await lido.getPooledEthBySharesRoundUp(shortfallShares);
        const expectedRebalanceAmount = shortfall < balanceBefore ? shortfall : balanceBefore;
        const expectedSharesToBeBurned = await lido.getSharesByPooledEth(expectedRebalanceAmount);

        await expect(vaultHub.connect(stranger).forceRebalance(vaultAddress))
          .to.emit(vaultHub, "VaultRebalanced")
          .withArgs(vaultAddress, expectedSharesToBeBurned, expectedRebalanceAmount);
      });

      it("takes into account redemption shares", async () => {
        const redemptionShares = await vaultHub.liabilityShares(vaultAddress);
        const balanceBefore = await ethers.provider.getBalance(vaultAddress);
        const shortfallShares = await vaultHub.healthShortfallShares(vaultAddress);

        await vaultHub.connect(user).setLiabilitySharesTarget(vaultAddress, 0n);

        const record = await vaultHub.vaultRecord(vaultAddress);
        expect(record.redemptionShares).to.equal(redemptionShares);

        const shortfall = await lido.getPooledEthBySharesRoundUp(shortfallShares);
        const expectedShortfallAmount = shortfall < balanceBefore ? shortfall : balanceBefore;
        const expectedShortfallShares = await lido.getSharesByPooledEth(expectedShortfallAmount);

        // redemptions may be greater than shortfall, so we need to take the max
        const expectedSharesToBeBurned = BigIntMath.max(expectedShortfallShares, redemptionShares);
        const expectedRebalanceAmount = await lido.getPooledEthBySharesRoundUp(expectedSharesToBeBurned);

        await expect(vaultHub.forceRebalance(vaultAddress))
          .to.emit(vaultHub, "VaultRebalanced")
          .withArgs(vaultAddress, expectedSharesToBeBurned, expectedRebalanceAmount);

        const sharesMintedAfter = await vaultHub.liabilityShares(vaultAddress);
        expect(sharesMintedAfter).to.equal(0n);

        const recordAfter = await vaultHub.vaultRecord(vaultAddress);
        expect(recordAfter.redemptionShares).to.equal(0n);
      });

      it("takes into account part of redemption shares if not enough balance", async () => {
        const redemptionShares = await vaultHub.liabilityShares(vaultAddress);
        const balanceBefore = await ethers.provider.getBalance(vaultAddress);
        const shortfallShares = await vaultHub.healthShortfallShares(vaultAddress);

        await vaultHub.connect(user).setLiabilitySharesTarget(vaultAddress, 0n);

        const record = await vaultHub.vaultRecord(vaultAddress);
        expect(record.redemptionShares).to.equal(redemptionShares);

        const shortfall = await lido.getPooledEthBySharesRoundUp(shortfallShares);
        const expectedShortfallAmount = shortfall < balanceBefore ? shortfall : balanceBefore;
        const expectedShortfallShares = await lido.getSharesByPooledEth(expectedShortfallAmount);
        const expectedRebalanceAmount = await lido.getPooledEthBySharesRoundUp(
          BigIntMath.max(expectedShortfallShares, redemptionShares),
        );

        const balance = expectedRebalanceAmount - expectedRebalanceAmount / 3n;
        const expectedSharesToBeBurned = await lido.getSharesByPooledEth(balance);

        await setBalance(vaultAddress, balance); // cheat to make balance lower than rebalanceShortfall
        await expect(vaultHub.forceRebalance(vaultAddress))
          .to.emit(vaultHub, "VaultRebalanced")
          .withArgs(vaultAddress, expectedSharesToBeBurned, balance);

        const sharesMintedAfter = await vaultHub.liabilityShares(vaultAddress);
        expect(sharesMintedAfter).to.equal(redemptionShares - expectedSharesToBeBurned);

        const recordAfter = await vaultHub.vaultRecord(vaultAddress);
        expect(recordAfter.redemptionShares).to.equal(redemptionShares - expectedSharesToBeBurned);
      });
    });

    context("healthy vault", () => {
      it("reverts if vault is healthy", async () => {
        await vaultsContext.reportVault({ vault, totalValue: ether("1") });

        const balanceBefore = await ethers.provider.getBalance(vaultAddress);

        await expect(vaultHub.forceRebalance(vaultAddress))
          .to.be.revertedWithCustomError(vaultHub, "NoReasonForForceRebalance")
          .withArgs(vaultAddress);

        const balanceAfter = await ethers.provider.getBalance(vaultAddress);
        expect(balanceAfter).to.equal(balanceBefore);
      });
    });
  });
});
