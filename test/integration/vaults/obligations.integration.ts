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

      if ((await lido.getPooledEthBySharesRoundUp(redemptionShares)) < ether("1")) {
        redemptionShares += 1n;
      }

      await dashboard.fund({ value: ether("2") });
      await dashboard.mintShares(stranger, redemptionShares);

      const recordBefore = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordBefore.redemptionShares).to.equal(0n);
      expect(recordBefore.liabilityShares).to.equal(redemptionShares);

      await expect(vaultHub.connect(agentSigner).updateRedemptionShares(stakingVaultAddress, redemptionShares))
        .to.emit(vaultHub, "VaultRedemptionSharesUpdated")
        .withArgs(stakingVaultAddress, redemptionShares)
        .to.emit(stakingVault, "BeaconChainDepositsPaused");

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
      expect(recordBefore.unsettledLidoFees).to.equal(0n);
      expect(recordBefore.settledLidoFees).to.equal(0n);

      // Report the vault data with accrued lido fees
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });

      const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfter.unsettledLidoFees).to.equal(accruedLidoFees);
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
      expect(recordBefore.unsettledLidoFees).to.equal(0n);
      expect(recordBefore.settledLidoFees).to.equal(0n);

      // Report the vault data with accrued Lido fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, accruedLidoFees, 0n);

      const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfter.unsettledLidoFees).to.equal(accruedLidoFees);
      expect(recordAfter.settledLidoFees).to.equal(0n);
    });

    it("Withdraws fees to the treasury when the vault has enough balance", async () => {
      const accruedLidoFees = ether("1");

      await dashboard.fund({ value: ether("2") });

      const recordBefore = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordBefore.unsettledLidoFees).to.equal(0n);
      expect(recordBefore.settledLidoFees).to.equal(0n);

      // Report the vault data with accrued Lido fees
      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, accruedLidoFees, 0n)
        .to.emit(stakingVault, "BeaconChainDepositsPaused");

      // Pay the fees to the treasury
      await expect(vaultHub.payLidoFees(stakingVaultAddress))
        .to.emit(vaultHub, "LidoFeesSettled")
        .withArgs(stakingVaultAddress, accruedLidoFees, 0n, accruedLidoFees)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, accruedLidoFees)
        .to.emit(stakingVault, "BeaconChainDepositsResumed");

      const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfter.unsettledLidoFees).to.equal(0n);
      expect(recordAfter.settledLidoFees).to.equal(accruedLidoFees);
    });

    it("Withdraws fees partially to the treasury when the vault has not enough balance", async () => {
      // Make sure the vault has enough balance
      const accruedLidoFees = ether("1");
      const funding = ether("0.5");

      await dashboard.fund({ value: funding });

      const recordBefore = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordBefore.unsettledLidoFees).to.equal(0n);
      expect(recordBefore.settledLidoFees).to.equal(0n);

      const unsettledLidoFees = accruedLidoFees - funding;

      // Report the vault data with accrued Lido fees
      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, accruedLidoFees, 0n)
        .to.emit(stakingVault, "BeaconChainDepositsPaused");

      // Pay the fees to the treasury
      await expect(vaultHub.payLidoFees(stakingVaultAddress))
        .to.emit(vaultHub, "LidoFeesSettled")
        .withArgs(stakingVaultAddress, funding, unsettledLidoFees, funding)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, funding)
        .to.emit(stakingVault, "BeaconChainDepositsResumed");

      const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfter.unsettledLidoFees).to.equal(unsettledLidoFees);
      expect(recordAfter.settledLidoFees).to.equal(funding);
    });

    it("Withdraws fees in several consecutive payments", async () => {
      let accruedLidoFees = ether("1");
      const initialFunding = ether("0.5");
      const unsettledLidoFees = accruedLidoFees - initialFunding;

      await dashboard.fund({ value: initialFunding });

      // Report the vault data with accrued Lido fees
      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, accruedLidoFees, 0n)
        .to.emit(stakingVault, "BeaconChainDepositsPaused");

      // Pay the fees to the treasury partially
      await expect(vaultHub.payLidoFees(stakingVaultAddress))
        .to.emit(vaultHub, "LidoFeesSettled")
        .withArgs(stakingVaultAddress, initialFunding, unsettledLidoFees, initialFunding)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, initialFunding)
        .to.emit(stakingVault, "BeaconChainDepositsResumed");

      // 2nd report with no fees emit nothing because fees are not changed (reported value is cumulative)
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees })).not.to.emit(
        vaultHub,
        "LidoFeesUpdated",
      );

      // Increase the fees
      const delta = ether("0.1");
      const expectedUnsettled = accruedLidoFees - initialFunding;
      const feesToSettle = expectedUnsettled + delta;
      accruedLidoFees += delta;

      // 3rd report with some fees updated
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, feesToSettle, initialFunding);

      await dashboard.fund({ value: feesToSettle });

      // Pay the fees to the treasury
      await expect(vaultHub.payLidoFees(stakingVaultAddress))
        .to.emit(vaultHub, "LidoFeesSettled")
        .withArgs(stakingVaultAddress, feesToSettle, 0n, accruedLidoFees)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, feesToSettle);

      const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfter.unsettledLidoFees).to.equal(0n);
      expect(recordAfter.settledLidoFees).to.equal(accruedLidoFees);
    });
  });

  context("Settlement", () => {
    let redemptionShares: bigint;
    let accruedLidoFees: bigint;
    let unsettledLidoFees: bigint;
    let settledLidoFees: bigint;

    beforeEach(async () => {
      redemptionShares = ether("1");
      accruedLidoFees = ether("2.1");

      await dashboard.fund({ value: ether("2") });
      await dashboard.mintShares(stranger, redemptionShares);

      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });
      ({ unsettledLidoFees, settledLidoFees } = await vaultHub.vaultRecord(stakingVaultAddress));

      await vaultHub.connect(agentSigner).updateRedemptionShares(stakingVaultAddress, redemptionShares);
    });

    it("");

    it("Reverts when trying to pay fees before redemptions are settled", async () => {
      await expect(vaultHub.payLidoFees(stakingVaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "UnsettledRedemptions",
      );

      const recordAfter = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(recordAfter.redemptionShares).to.equal(redemptionShares);
      expect(recordAfter.unsettledLidoFees).to.equal(unsettledLidoFees);
      expect(recordAfter.settledLidoFees).to.equal(settledLidoFees);
    });

    it("Fully settles obligations", async () => {
      const funding = accruedLidoFees + (await lido.getPooledEthBySharesRoundUp(redemptionShares));
      await dashboard.fund({ value: funding });

      await expect(vaultHub.settleVaultObligations(stakingVaultAddress))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, redemptionShares, unsettledLidoFees, 0n, 0n, accruedLidoFees);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptionShares).to.equal(0n);
      expect(obligationsAfter.unsettledLidoFees).to.equal(0n);
      expect(obligationsAfter.settledLidoFees).to.equal(accruedLidoFees);
    });

    it("Settles obligations in correct order", async () => {});

    it("Does not make the vault unhealthy", async () => {
      const vaultBalance = ether("1.5");

      await dashboard.fund({ value: vaultBalance });
      await dashboard.mintShares(stranger, await dashboard.remainingMintingCapacityShares(0));

      const feesToSettle = 100n;
      await dashboard.fund({ value: feesToSettle }); // add some ether to make sure some fees are settled

      await expect(reportVaultDataWithProof(ctx, stakingVault, { totalValue: vaultBalance, accruedLidoFees })).to.emit(
        vaultHub,
        "VaultObligationsSettled",
      );

      expect(await vaultHub.isVaultHealthy(stakingVaultAddress)).to.be.true;
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
      await vaultHub.connect(agentSigner).setVaultRedemptionShares(stakingVaultAddress, sharesToMint);

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

      await vaultHub.connect(agentSigner).setVaultRedemptionShares(stakingVaultAddress, redemptionShares);
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
      const funding = await lido.getPooledEthBySharesRoundUp(redemptionShares);
      await dashboard.fund({ value: funding });

      let withdrawableValue = await vaultHub.withdrawableValue(stakingVaultAddress);
      expect(withdrawableValue).to.equal(0n);

      const withdrawable = ether("1");
      await dashboard.fund({ value: withdrawable });
      expect(await vaultHub.withdrawableValue(stakingVaultAddress)).to.equal(withdrawable);

      await expect(dashboard.withdraw(stranger, withdrawable))
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(stranger, withdrawable);

      withdrawableValue = await vaultHub.withdrawableValue(stakingVaultAddress);
      expect(withdrawableValue).to.equal(0n);
    });
  });

  // TODO: Need to fix the disconnect flow first
  context.skip("Disconnect flow", () => {
    it("Reverts when trying to disconnect with unsettled obligations", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1.1") });

      const obligations = await vaultHub.vaultObligations(stakingVaultAddress);

      // 1 ether of the connection deposit will be settled to the treasury
      expect(obligations.unsettledLidoFees).to.equal(ether("1.1"));
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(ether("1"));

      // will revert because of the unsettled obligations event trying to settle using the connection deposit
      await expect(dashboard.voluntaryDisconnect())
        .to.be.revertedWithCustomError(vaultHub, "UnsettledObligationsExceedsAllowance")
        .withArgs(stakingVaultAddress, ether("1"), 0);

      expect(obligations.unsettledLidoFees).to.equal(ether("1.1"));
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

  context("Beacon chain deposits", () => {
    it("Pauses deposits when unsettled fees are >= 1 ether", async () => {
      const accruedLidoFees = ether("1");

      await setBalance(stakingVaultAddress, 0); // dirty hack to make the vault balance 0

      // Report the vault data with accrued treasury fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, accruedLidoFees, 0n)
        .to.emit(stakingVault, "BeaconChainDepositsPaused"); // paused because >= 1 ether of unsettled fees

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(accruedLidoFees);
      expect(obligationsAfter.settledLidoFees).to.equal(0n);
    });

    it("Resumes deposits when unsettled fees are < 1 ether", async () => {
      const accruedLidoFees = ether("1");

      await setBalance(stakingVaultAddress, 0); // dirty hack to make the vault balance 0
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });
      expect(await stakingVault.beaconChainDepositsPaused()).to.equal(true);

      await dashboard.fund({ value: ether("2") });

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.unsettledLidoFees).to.equal(accruedLidoFees);
      expect(obligationsBefore.settledLidoFees).to.equal(0n);

      // Report the vault data with accrued treasury fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, accruedLidoFees, 0n, 0n, accruedLidoFees) // 0 unsettled
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, accruedLidoFees)
        .to.emit(stakingVault, "BeaconChainDepositsResumed");

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(0n);
      expect(obligationsAfter.settledLidoFees).to.equal(accruedLidoFees);
    });
  });
});
