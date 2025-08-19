import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { Dashboard, Lido, StakingVault, VaultHub } from "typechain-types";

import { ether } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: Vault redemptions and fees obligations", () => {
  let ctx: ProtocolContext;
  let originalSnapshot: string;
  let snapshot: string;

  let lido: Lido;
  let vaultHub: VaultHub;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;

  let stakingVaultAddress: string;
  let treasuryAddress: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let redemptionMaster: HardhatEthersSigner;
  let validatorExit: HardhatEthersSigner;
  let agentSigner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    ({ vaultHub, lido } = ctx.contracts);

    [owner, nodeOperator, redemptionMaster, validatorExit, stranger] = await ethers.getSigners();

    // Owner can create a vault with operator as a node operator
    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
      [],
    ));

    stakingVaultAddress = await stakingVault.getAddress();
    treasuryAddress = await ctx.contracts.locator.treasury();

    agentSigner = await ctx.getSigner("agent");

    await vaultHub.connect(agentSigner).grantRole(await vaultHub.REDEMPTION_MASTER_ROLE(), redemptionMaster);
    await vaultHub.connect(agentSigner).grantRole(await vaultHub.VALIDATOR_EXIT_ROLE(), validatorExit);

    await reportVaultDataWithProof(ctx, stakingVault);
  });

  after(async () => await Snapshot.restore(originalSnapshot));
  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));

  context("Redemptions", () => {
    it("Does not accrue when vault has no liabilities", async () => {
      const recordBefore = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordBefore.redemptionShares).to.equal(0n);
      expect(recordBefore.liabilityShares).to.equal(0n);

      const redemptionShares = ether("1");

      await expect(vaultHub.connect(agentSigner).updateRedemptionShares(stakingVaultAddress, redemptionShares))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(stakingVaultAddress, 0);

      const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfter.redemptionShares).to.equal(0n);
      expect(recordAfter.liabilityShares).to.equal(0n);
    });

    it("Accrues on the vault with liabilities", async () => {
      await dashboard.fund({ value: ether("1") });
      await dashboard.mintShares(stranger, 2n);

      const recordBefore = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordBefore.redemptionShares).to.equal(0n);
      expect(recordBefore.liabilityShares).to.equal(2n);

      // Over the max possible withdrawals (3 shares => 2 shares because of the liabilities)
      await expect(vaultHub.connect(agentSigner).updateRedemptionShares(stakingVaultAddress, 3n))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(stakingVaultAddress, 2n);

      const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfter.redemptionShares).to.equal(2n);
      expect(recordAfter.liabilityShares).to.equal(2n);

      // Decrease the obligation
      await expect(vaultHub.connect(agentSigner).updateRedemptionShares(stakingVaultAddress, 1n))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(stakingVaultAddress, 1n);

      const recordAfterDecreased = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfterDecreased.redemptionShares).to.equal(1n);
      expect(recordAfterDecreased.liabilityShares).to.equal(2n);

      // Remove the obligation
      await expect(vaultHub.connect(agentSigner).updateRedemptionShares(stakingVaultAddress, 0))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(stakingVaultAddress, 0n);

      const recordAfterRemoved = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfterRemoved.redemptionShares).to.equal(0n);
      expect(recordAfterRemoved.liabilityShares).to.equal(2n);
    });

    it("Pauses beacon chain deposits when redemptions >= 1 ether", async () => {
      let redemptionShares = (await lido.getSharesByPooledEth(ether("1"))) + 1n;

      const redemptionValue = await lido.getPooledEthBySharesRoundUp(redemptionShares);
      if (redemptionValue < ether("1")) redemptionShares += 1n;

      await dashboard.fund({ value: redemptionValue });
      await dashboard.mintShares(stranger, redemptionShares);

      const recordBefore = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordBefore.redemptionShares).to.equal(0n);
      expect(recordBefore.liabilityShares).to.equal(redemptionShares);

      await setBalance(await stakingVault.getAddress(), 0n); // simulate all balance on CL

      await expect(vaultHub.connect(agentSigner).updateRedemptionShares(stakingVaultAddress, redemptionShares))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(stakingVaultAddress, redemptionShares)
        .to.emit(stakingVault, "BeaconChainDepositsPaused");

      const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfter.redemptionShares).to.equal(redemptionShares);
      expect(recordAfter.liabilityShares).to.equal(redemptionShares);
    });

    it("Not pauses beacon chain deposits when redemptions > 1 ether and vault has enough balance", async () => {
      let redemptionShares = (await lido.getSharesByPooledEth(ether("1"))) + 1n;

      const redemptionValue = await lido.getPooledEthBySharesRoundUp(redemptionShares);
      if (redemptionValue < ether("1")) redemptionShares += 1n;

      await dashboard.fund({ value: redemptionValue });
      await dashboard.mintShares(stranger, redemptionShares);

      const recordBefore = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordBefore.redemptionShares).to.equal(0n);
      expect(recordBefore.liabilityShares).to.equal(redemptionShares);

      await expect(vaultHub.connect(agentSigner).updateRedemptionShares(stakingVaultAddress, redemptionShares))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(stakingVaultAddress, redemptionShares)
        .and.not.to.emit(stakingVault, "BeaconChainDepositsPaused");

      const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfter.redemptionShares).to.equal(redemptionShares);
      expect(recordAfter.liabilityShares).to.equal(redemptionShares);
    });

    context("Decreases on liability shares change", () => {
      let redemptionShares: bigint;

      beforeEach(async () => {
        redemptionShares = ether("1");

        await dashboard.fund({ value: ether("2") });
        await dashboard.mintShares(owner, redemptionShares);

        await vaultHub.connect(agentSigner).updateRedemptionShares(stakingVaultAddress, redemptionShares);
      });

      it("On shares burned", async () => {
        const recordBefore = await vaultHub.vaultRecord(stakingVaultAddress);
        expect(recordBefore.redemptionShares).to.equal(redemptionShares);

        expect(await lido.sharesOf(owner)).to.equal(redemptionShares);
        await lido.connect(owner).approve(dashboard, redemptionShares);

        const parts = 2n;
        const sharesToBurn = redemptionShares / parts;
        const expectedRedemptions = redemptionShares / parts;

        await expect(dashboard.burnShares(sharesToBurn))
          .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
          .withArgs(stakingVaultAddress, expectedRedemptions);

        const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
        expect(recordAfter.redemptionShares).to.equal(expectedRedemptions);
      });

      it("On vault rebalanced", async () => {
        const recordBefore = await vaultHub.vaultRecord(stakingVaultAddress);
        expect(recordBefore.redemptionShares).to.equal(redemptionShares);

        const rebalanceShares = redemptionShares / 2n;
        await expect(dashboard.rebalanceVaultWithShares(rebalanceShares))
          .to.emit(vaultHub, "VaultRebalanced")
          .withArgs(stakingVaultAddress, rebalanceShares, await lido.getPooledEthBySharesRoundUp(rebalanceShares))
          .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
          .withArgs(stakingVaultAddress, rebalanceShares);

        const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
        expect(recordAfter.redemptionShares).to.equal(rebalanceShares);
      });

      it("On force rebalance", async () => {
        const recordBefore = await vaultHub.vaultRecord(stakingVaultAddress);
        expect(recordBefore.redemptionShares).to.equal(redemptionShares);

        await expect(vaultHub.forceRebalance(stakingVaultAddress))
          .to.emit(vaultHub, "VaultRebalanced")
          .withArgs(stakingVaultAddress, redemptionShares, await lido.getPooledEthBySharesRoundUp(redemptionShares))
          .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
          .withArgs(stakingVaultAddress, 0n);

        const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
        expect(recordAfter.redemptionShares).to.equal(0n);
      });

      it("Does not increase on new minting", async () => {
        await dashboard.fund({ value: ether("2") });
        await dashboard.mintShares(stranger, ether("1"));

        const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
        expect(recordAfter.redemptionShares).to.equal(redemptionShares);
      });
    });

    context("Settlement", () => {
      let redemptionShares: bigint;

      beforeEach(async () => {
        redemptionShares = ether("1");

        await dashboard.fund({ value: ether("2") });
        await dashboard.mintShares(stranger, redemptionShares);
        await vaultHub.connect(agentSigner).updateRedemptionShares(stakingVaultAddress, redemptionShares);
      });

      it("Allows to partially settle redemptions with force rebalance", async () => {
        const vaultBalance = ether("0.7");
        await setBalance(stakingVaultAddress, vaultBalance);

        const sharesToRebalance = await lido.getSharesByPooledEth(vaultBalance);

        const recordBefore = await vaultHub.vaultRecord(stakingVaultAddress);
        expect(recordBefore.redemptionShares).to.equal(redemptionShares);

        const expectedRedemptions = redemptionShares - sharesToRebalance;

        await expect(vaultHub.forceRebalance(stakingVaultAddress))
          .to.emit(vaultHub, "VaultRebalanced")
          .withArgs(stakingVaultAddress, sharesToRebalance, await lido.getPooledEthBySharesRoundUp(sharesToRebalance))
          .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
          .withArgs(stakingVaultAddress, expectedRedemptions);

        const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
        expect(recordAfter.redemptionShares).to.equal(expectedRedemptions);
      });

      it("Allows to fully settle redemptions with force rebalance", async () => {
        const recordBefore = await vaultHub.vaultRecord(stakingVaultAddress);
        expect(recordBefore.redemptionShares).to.equal(redemptionShares);

        await expect(vaultHub.forceRebalance(stakingVaultAddress))
          .to.emit(vaultHub, "VaultRebalanced")
          .withArgs(stakingVaultAddress, redemptionShares, await lido.getPooledEthBySharesRoundUp(redemptionShares))
          .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
          .withArgs(stakingVaultAddress, 0n);

        const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
        expect(recordAfter.redemptionShares).to.equal(0n);
      });
    });
  });

  context("Lido Fees", () => {
    it("Reverts if accrued fees are less than the cumulative fees", async () => {
      const accruedLidoFees = ether("1.1");

      const recordBefore = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordBefore.accruedLidoFees).to.equal(0n);
      expect(recordBefore.settledLidoFees).to.equal(0n);

      // Report the vault data with accrued lido fees
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });

      const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfter.accruedLidoFees).to.equal(accruedLidoFees);
      expect(recordAfter.settledLidoFees).to.equal(0n);

      // Try to lower the fees in the report
      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: accruedLidoFees - 1n }))
        .to.be.revertedWithCustomError(vaultHub, "InvalidLidoFees")
        .withArgs(stakingVaultAddress, accruedLidoFees - 1n, accruedLidoFees);
    });

    it("Updates on the vault report for vault with no balance", async () => {
      const accruedLidoFees = ether("1");

      await setBalance(stakingVaultAddress, 0); // dirty hack to make the vault balance 0

      const recordBefore = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordBefore.accruedLidoFees).to.equal(0n);
      expect(recordBefore.settledLidoFees).to.equal(0n);

      // Report the vault data with accrued Lido fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, accruedLidoFees, 0n);

      const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfter.accruedLidoFees).to.equal(accruedLidoFees);
      expect(recordAfter.settledLidoFees).to.equal(0n);
    });

    it("Withdraws fees to the treasury when the vault has enough balance", async () => {
      const accruedLidoFees = ether("1");

      await dashboard.fund({ value: ether("2") });

      const recordBefore = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordBefore.accruedLidoFees).to.equal(0n);
      expect(recordBefore.settledLidoFees).to.equal(0n);

      // Report the vault data with accrued Lido fees
      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, accruedLidoFees, 0n)
        .and.not.to.emit(stakingVault, "BeaconChainDepositsPaused");

      // Pay the fees to the treasury
      await expect(vaultHub.transferLidoFeesToTreasury(stakingVaultAddress))
        .to.emit(vaultHub, "LidoFeesSettled")
        .withArgs(stakingVaultAddress, accruedLidoFees, accruedLidoFees, accruedLidoFees)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, accruedLidoFees)
        .and.not.to.emit(stakingVault, "BeaconChainDepositsResumed");

      const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfter.accruedLidoFees).to.equal(accruedLidoFees);
      expect(recordAfter.settledLidoFees).to.equal(accruedLidoFees);
    });

    it("Withdraws fees partially to the treasury when the vault has not enough balance", async () => {
      // Make sure the vault has enough balance
      const accruedLidoFees = ether("1");
      const funding = ether("0.5");

      await dashboard.fund({ value: funding });

      const recordBefore = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordBefore.accruedLidoFees).to.equal(0n);
      expect(recordBefore.settledLidoFees).to.equal(0n);

      // Report the vault data with accrued Lido fees
      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, accruedLidoFees, 0n)
        .and.not.to.emit(stakingVault, "BeaconChainDepositsPaused");

      // Pay the fees to the treasury
      await expect(vaultHub.transferLidoFeesToTreasury(stakingVaultAddress))
        .to.emit(vaultHub, "LidoFeesSettled")
        .withArgs(stakingVaultAddress, funding, accruedLidoFees, funding)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, funding)
        .and.not.to.emit(stakingVault, "BeaconChainDepositsResumed");

      const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfter.accruedLidoFees).to.equal(accruedLidoFees);
      expect(recordAfter.settledLidoFees).to.equal(funding);
    });

    it("Withdraws fees in several consecutive payments", async () => {
      let accruedLidoFees = ether("1");
      const initialFunding = ether("0.5");

      await dashboard.fund({ value: initialFunding });

      // Report the vault data with accrued Lido fees
      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, accruedLidoFees, 0n)
        .and.not.to.emit(stakingVault, "BeaconChainDepositsPaused");

      // Pay the fees to the treasury partially
      await expect(vaultHub.transferLidoFeesToTreasury(stakingVaultAddress))
        .to.emit(vaultHub, "LidoFeesSettled")
        .withArgs(stakingVaultAddress, initialFunding, accruedLidoFees, initialFunding)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, initialFunding)
        .and.not.to.emit(stakingVault, "BeaconChainDepositsResumed");

      // 2nd report with no fees emit nothing because fees are not changed (reported value is cumulative)
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees })).not.to.emit(
        vaultHub,
        "LidoFeesUpdated",
      );

      // Increase the fees
      const delta = ether("0.1");
      accruedLidoFees += delta;

      // 3rd report with some fees updated
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, accruedLidoFees, initialFunding);

      const fundingToSettle = accruedLidoFees - initialFunding;
      await dashboard.fund({ value: fundingToSettle });

      // Pay the fees to the treasury
      await expect(vaultHub.transferLidoFeesToTreasury(stakingVaultAddress))
        .to.emit(vaultHub, "LidoFeesSettled")
        .withArgs(stakingVaultAddress, fundingToSettle, accruedLidoFees, accruedLidoFees)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, fundingToSettle);

      const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfter.accruedLidoFees).to.equal(accruedLidoFees);
      expect(recordAfter.settledLidoFees).to.equal(accruedLidoFees);
    });

    context("Settlement", () => {
      let redemptionShares: bigint;
      let accruedLidoFees: bigint;

      beforeEach(async () => {
        redemptionShares = ether("1");
        accruedLidoFees = ether("2.1");

        await dashboard.fund({ value: ether("2") });
        await dashboard.mintShares(stranger, redemptionShares);

        await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });
        ({ accruedLidoFees } = await vaultHub.vaultRecord(stakingVaultAddress));
      });

      it("Reduces the unsettled fees when redemptions are set", async () => {
        await vaultHub.connect(agentSigner).updateRedemptionShares(stakingVaultAddress, redemptionShares);

        const redemptionValue = await lido.getPooledEthBySharesRoundUp(redemptionShares);

        const totalValue = await vaultHub.totalValue(stakingVaultAddress);
        const locked = await vaultHub.locked(stakingVaultAddress);
        const free = totalValue - locked; // some free balance on the vault
        const obligations = redemptionValue + accruedLidoFees; // total obligations for the vault

        // some overlapping with the redemption value to make visible that redemptions will be reserved
        const overlapping = ether("0.25");
        await dashboard.fund({ value: obligations - free - overlapping });

        const feesToSettle = accruedLidoFees - overlapping;
        await expect(vaultHub.transferLidoFeesToTreasury(stakingVaultAddress))
          .to.emit(vaultHub, "LidoFeesSettled")
          .withArgs(stakingVaultAddress, feesToSettle, accruedLidoFees, feesToSettle);

        const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
        expect(recordAfter.redemptionShares).to.equal(redemptionShares);
        expect(recordAfter.accruedLidoFees).to.equal(accruedLidoFees);
        expect(recordAfter.settledLidoFees).to.equal(feesToSettle);
      });

      it("Does not make the vault unhealthy", async () => {
        const feesToSettle = await vaultHub.transferableLidoFeesValue(stakingVaultAddress);

        // make sure the vault has enough balance to pay all the fees
        const vaultBalance = await ethers.provider.getBalance(stakingVaultAddress);
        expect(vaultBalance).to.be.greaterThan(accruedLidoFees);

        expect(await vaultHub.isVaultHealthy(stakingVaultAddress)).to.be.true;

        await expect(vaultHub.transferLidoFeesToTreasury(stakingVaultAddress))
          .to.emit(vaultHub, "LidoFeesSettled")
          .withArgs(stakingVaultAddress, feesToSettle, accruedLidoFees, feesToSettle);

        expect(await vaultHub.isVaultHealthy(stakingVaultAddress)).to.be.true;

        const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
        expect(recordAfter.accruedLidoFees).to.equal(accruedLidoFees);
        expect(recordAfter.settledLidoFees).to.equal(feesToSettle);
      });
    });
  });

  context("Minting", () => {
    const accruedLidoFees = ether("0.1");

    beforeEach(async () => {
      await dashboard.fund({ value: ether("1") });

      const balanceBefore = await ethers.provider.getBalance(stakingVaultAddress);
      await setBalance(stakingVaultAddress, 0);
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });
      await setBalance(stakingVaultAddress, balanceBefore);
    });

    it("Reverts when trying to mint more than total value minus unsettled Lido fees", async () => {
      const mintableShares = await dashboard.totalMintingCapacityShares();

      await expect(dashboard.mintShares(stranger, mintableShares + 1n)).to.be.revertedWithCustomError(
        dashboard,
        "ExceedsMintingCapacity",
      );

      await expect(dashboard.mintShares(stranger, mintableShares)).to.emit(vaultHub, "MintedSharesOnVault");

      expect(await vaultHub.liabilityShares(stakingVaultAddress)).to.equal(mintableShares);
    });

    it("Does not take redemptions obligation into account", async () => {
      const mintableShares = await dashboard.totalMintingCapacityShares();
      const sharesToMint = mintableShares / 2n;

      // Add 1/2 of the mintable ether to the vault as withdrawals obligation, so if withdrawals obligation is taken into account,
      // the user will not be able to mint anything from this moment
      await dashboard.mintShares(stranger, sharesToMint);
      await vaultHub.connect(agentSigner).updateRedemptionShares(stakingVaultAddress, sharesToMint);

      await await expect(dashboard.mintShares(stranger, sharesToMint)).to.emit(vaultHub, "MintedSharesOnVault");
    });
  });

  context("Withdrawals", () => {
    let redemptionShares: bigint;

    beforeEach(async () => {
      redemptionShares = ether("1");
      const value = await lido.getPooledEthBySharesRoundUp(redemptionShares);

      await dashboard.fund({ value });
      await dashboard.mintShares(stranger, redemptionShares);

      await vaultHub.connect(agentSigner).updateRedemptionShares(stakingVaultAddress, redemptionShares);
    });

    it("Reverts when trying to withdraw more than available balance", async () => {
      // simulate deposit to Beacon chain -1 ether
      const withdrawableValue = await vaultHub.withdrawableValue(stakingVaultAddress);
      expect(withdrawableValue).to.equal(0n);

      await expect(dashboard.withdraw(stranger, withdrawableValue + 1n))
        .to.be.revertedWithCustomError(dashboard, "ExceedsWithdrawable")
        .withArgs(withdrawableValue + 1n, withdrawableValue);
    });

    it("Works when trying to withdraw all the withdrawable balance", async () => {
      const totalValue = await vaultHub.totalValue(stakingVaultAddress);
      const locked = await vaultHub.locked(stakingVaultAddress);
      expect(totalValue).to.equal(locked);

      let withdrawableValue = await vaultHub.withdrawableValue(stakingVaultAddress);
      expect(withdrawableValue).to.equal(0n);

      const overfunding = ether("0.1");
      const redemptionsCoverage = await lido.getPooledEthBySharesRoundUp(redemptionShares);
      await dashboard.fund({ value: redemptionsCoverage + overfunding });
      expect(await vaultHub.withdrawableValue(stakingVaultAddress)).to.equal(overfunding);

      await expect(dashboard.withdraw(stranger, overfunding))
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(stranger, overfunding);

      withdrawableValue = await vaultHub.withdrawableValue(stakingVaultAddress);
      expect(withdrawableValue).to.equal(0n);

      await expect(dashboard.rebalanceVaultWithShares(redemptionShares))
        .to.emit(vaultHub, "VaultRebalanced")
        .withArgs(stakingVaultAddress, redemptionShares, await lido.getPooledEthBySharesRoundUp(redemptionShares))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(stakingVaultAddress, 0n);

      expect(await vaultHub.liabilityShares(stakingVaultAddress)).to.equal(0n);

      // report the vault data to unlock the locked value
      await reportVaultDataWithProof(ctx, stakingVault);

      expect(await vaultHub.locked(stakingVaultAddress)).to.equal(ether("1")); // connection deposit
      expect(await vaultHub.totalValue(stakingVaultAddress)).to.equal(ether("1") + redemptionsCoverage);
    });
  });

  // TODO: Need to fix the disconnect flow first
  context.skip("Disconnect flow", () => {
    it("Reverts when trying to disconnect with unsettled obligations", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1.1") });

      const obligations = await vaultHub.vaultRecord(stakingVaultAddress);

      // 1 ether of the connection deposit will be settled to the treasury
      expect(obligations.accruedLidoFees).to.equal(ether("1.1"));
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(ether("1"));

      // will revert because of the unsettled obligations event trying to settle using the connection deposit
      await expect(dashboard.voluntaryDisconnect())
        .to.be.revertedWithCustomError(vaultHub, "UnsettledObligationsExceedsAllowance")
        .withArgs(stakingVaultAddress, ether("1"), 0);

      expect(obligations.accruedLidoFees).to.equal(ether("1.1"));
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(ether("1"));
    });

    it("Allows to disconnect when all obligations are settled", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1.1") });
      await dashboard.fund({ value: ether("0.1") });

      await expect(dashboard.voluntaryDisconnect())
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, ether("1.1"), 0n, 0n, ether("1.1"))
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(stakingVaultAddress);
    });

    it("Allows to fund after disconnect initiated", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1.1") });
      await dashboard.fund({ value: ether("0.1") }); // cover all the fees

      await expect(dashboard.voluntaryDisconnect())
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(stakingVaultAddress);

      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(0n);
      expect(await vaultHub.totalValue(stakingVaultAddress)).to.equal(0n);

      await dashboard.fund({ value: ether("0.1") });

      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(ether("0.1"));
      expect(await vaultHub.totalValue(stakingVaultAddress)).to.equal(ether("0.1"));
    });

    it("Reverts disconnect process when balance is not enough to cover the exit fees", async () => {
      expect(await vaultHub.totalValue(stakingVaultAddress)).to.equal(ether("1"));
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1") });

      const totalValue = await vaultHub.totalValue(stakingVaultAddress);
      await dashboard.voluntaryDisconnect();

      // take the last fees from the post disconnect report (1.1 ether because fees are cumulative)
      await expect(reportVaultDataWithProof(ctx, stakingVault, { totalValue, accruedLidoFees: ether("1.1") }))
        .to.be.revertedWithCustomError(vaultHub, "UnsettledObligationsExceedsAllowance")
        .withArgs(stakingVaultAddress, ether("0.1"), 0);
    });

    it("Should take last fees from the post disconnect report with direct transfer", async () => {
      // 1 ether of the connection deposit will be settled to the treasury
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1") });

      const totalValueOnRefSlot = await vaultHub.totalValue(stakingVaultAddress);

      // successfully disconnect
      await dashboard.voluntaryDisconnect();

      // adding 1 ether to cover the exit fees
      await owner.sendTransaction({ to: stakingVaultAddress, value: ether("1") });

      // take the last fees from the post disconnect report (1.1 ether because fees are cumulative)
      await expect(
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: totalValueOnRefSlot,
          accruedLidoFees: ether("1.1"),
        }),
      )
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, ether("0.1"), 0n, 0n, ether("1.1"))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVaultAddress);

      // 0.9 ether should be left in the vault
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(ether("0.9"));
    });

    it("Should take last fees from the post disconnect report with fund", async () => {
      // 1 ether of the connection deposit will be settled to the treasury
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1") });

      const totalValueOnRefSlot = await vaultHub.totalValue(stakingVaultAddress);

      // successfully disconnect
      await dashboard.voluntaryDisconnect();

      // adding 1 ether to cover the exit fees
      await dashboard.fund({ value: ether("1") });

      // take the last fees from the post disconnect report (1.1 ether because fees are cumulative)
      await expect(
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: totalValueOnRefSlot,
          accruedLidoFees: ether("1.1"),
        }),
      )
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, ether("0.1"), 0n, 0n, ether("1.1"))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVaultAddress);

      // 0.9 ether should be left in the vault
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(ether("0.9"));
    });
  });
});
