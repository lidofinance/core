import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { ether } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
  VaultRoles,
} from "lib/protocol";

import { Snapshot } from "test/suite";

const TOTAL_BASIS_POINTS = 100_00n;

describe("Integration: Vault obligations", () => {
  let ctx: ProtocolContext;

  let vaultHub: VaultHub;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;
  let roles: VaultRoles;

  let stakingVaultAddress: string;
  let treasuryAddress: string;
  let vaultHubAddress: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let redemptionMaster: HardhatEthersSigner;
  let validatorExit: HardhatEthersSigner;
  let agentSigner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let originalSnapshot: string;
  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    ({ vaultHub } = ctx.contracts);

    [owner, nodeOperator, redemptionMaster, validatorExit, stranger] = await ethers.getSigners();

    // Owner can create a vault with operator as a node operator
    ({ stakingVault, dashboard, roles } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
      [],
    ));

    stakingVaultAddress = await stakingVault.getAddress();
    treasuryAddress = await ctx.contracts.locator.treasury();
    vaultHubAddress = await vaultHub.getAddress();

    agentSigner = await ctx.getSigner("agent");

    await vaultHub.connect(agentSigner).grantRole(await vaultHub.REDEMPTION_MASTER_ROLE(), redemptionMaster);
    await vaultHub.connect(agentSigner).grantRole(await vaultHub.VALIDATOR_EXIT_ROLE(), validatorExit);
  });

  after(async () => await Snapshot.restore(originalSnapshot));

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  async function addRedemptionsObligation(value: bigint) {
    const balanceBefore = await ethers.provider.getBalance(stakingVaultAddress);
    await setBalance(stakingVaultAddress, 0); // hack: deposit to beacon chain
    await vaultHub.connect(agentSigner).setVaultRedemptions(stakingVaultAddress, value);
    await setBalance(stakingVaultAddress, balanceBefore); // restore balance
  }

  context("Treasury fees obligations", () => {
    it("Will revert if accrued fees are less than the cumulative fees", async () => {
      const accruedTreasuryFees = ether("1.1");

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.treasuryFees).to.equal(0n);
      expect(obligationsBefore.totalSettledTreasuryFees).to.equal(0n);

      // Report the vault data with accrued treasury fees
      await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees });

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.treasuryFees).to.equal(ether("0.1"));
      expect(obligationsAfter.totalSettledTreasuryFees).to.equal(ether("1"));

      // Try to lower the fees
      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees: accruedTreasuryFees - 1n }))
        .to.be.revertedWithCustomError(vaultHub, "InvalidFees")
        .withArgs(stakingVaultAddress, accruedTreasuryFees - 1n, accruedTreasuryFees);
    });

    it("Updated on the vault report for vault with no balance", async () => {
      const accruedTreasuryFees = ether("1");

      await setBalance(stakingVaultAddress, 0); // dirty hack to make the vault balance 0

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.treasuryFees).to.equal(0n);
      expect(obligationsBefore.totalSettledTreasuryFees).to.equal(0n);

      // Report the vault data with accrued treasury fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees }))
        .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
        .withArgs(stakingVaultAddress, accruedTreasuryFees, 0n); // 0 settled

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.treasuryFees).to.equal(accruedTreasuryFees);
      expect(obligationsAfter.totalSettledTreasuryFees).to.equal(0n);
    });

    it("Settled on the vault report for vault with enough balance", async () => {
      const accruedTreasuryFees = ether("1");

      await dashboard.connect(roles.funder).fund({ value: ether("2") });

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.treasuryFees).to.equal(0n);
      expect(obligationsBefore.totalSettledTreasuryFees).to.equal(0n);

      // Report the vault data with accrued treasury fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees }))
        .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
        .withArgs(stakingVaultAddress, 0n, accruedTreasuryFees) // 0 unsettled
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, accruedTreasuryFees);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.treasuryFees).to.equal(0n);
      expect(obligationsAfter.totalSettledTreasuryFees).to.equal(accruedTreasuryFees);
    });

    it("Partially settled on the vault report for vault with some balance", async () => {
      // Make sure the vault has enough balance
      const accruedTreasuryFees = ether("1");
      const vaultBalance = ether("0.7");
      const unsettledTreasuryFees = accruedTreasuryFees - vaultBalance;

      await setBalance(stakingVaultAddress, vaultBalance);

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.treasuryFees).to.equal(0n);
      expect(obligationsBefore.totalSettledTreasuryFees).to.equal(0n);

      // Report the vault data with accrued treasury fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees }))
        .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
        .withArgs(stakingVaultAddress, unsettledTreasuryFees, vaultBalance) // unsettled, settled
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, vaultBalance); // settled withrdrawal to treasury

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.treasuryFees).to.equal(unsettledTreasuryFees);
      expect(obligationsAfter.totalSettledTreasuryFees).to.equal(vaultBalance);
    });

    it("Get updated on several consecutive reports", async () => {
      let accruedTreasuryFees = ether("1");
      const vaultBalance = ether("0.7");
      const unsettledTreasuryFees = accruedTreasuryFees - vaultBalance;

      await setBalance(stakingVaultAddress, vaultBalance);

      // 1st report with partial settlement
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees }))
        .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
        .withArgs(stakingVaultAddress, unsettledTreasuryFees, vaultBalance)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, vaultBalance);

      // 2nd report with no fees emit nothing because fees are not changed (reported value is cumulative)
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees })).not.to.emit(
        vaultHub,
        "TreasuryFeesObligationUpdated",
      );

      // Increase the fees
      accruedTreasuryFees += ether("0.5");

      // 3rd report with zero settlement
      const expectedUnsettled = accruedTreasuryFees - vaultBalance;
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees }))
        .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
        .withArgs(stakingVaultAddress, expectedUnsettled, 0n);

      // 4th report with full settlement
      const delta = ether("0.1");
      const feesToSettle = expectedUnsettled + delta;
      accruedTreasuryFees += delta;

      await dashboard.connect(roles.funder).fund({ value: ether("1") });

      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees }))
        .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
        .withArgs(stakingVaultAddress, 0n, feesToSettle)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, feesToSettle);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.treasuryFees).to.equal(0n);
      expect(obligationsAfter.totalSettledTreasuryFees).to.equal(feesToSettle + vaultBalance);
    });
  });

  context("Setting redemptions obligations", () => {
    let liabilityShares: bigint;
    let maxRedemptions: bigint;

    it("Adds nothing to the vault with no liabilities", async () => {
      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.redemptions).to.equal(0n);

      expect((await vaultHub.vaultRecord(stakingVaultAddress)).liabilityShares).to.equal(0n);

      await expect(vaultHub.connect(agentSigner).setVaultRedemptions(stakingVaultAddress, ether("1"))).not.to.emit(
        vaultHub,
        "RedemptionsObligationUpdated",
      );

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(0n);
    });

    // TODO: change test to
    // - capped on the liability
    // - partially settles
    // - fully settles
    // - pauses deposits if has > 1 ether of unsettled redemptions
    it.skip("Can be applied to the vault with liabilities", async () => {
      const { lido } = ctx.contracts;

      liabilityShares = 1000n;

      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await dashboard.connect(roles.minter).mintShares(roles.burner, liabilityShares);

      maxRedemptions = await lido.getPooledEthBySharesRoundUp(liabilityShares);

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.redemptions).to.equal(0n);

      // Over the max possible withdrawals
      await expect(vaultHub.connect(agentSigner).setVaultRedemptions(stakingVaultAddress, maxRedemptions + 1n))
        .to.emit(vaultHub, "RedemptionsObligationUpdated")
        .withArgs(stakingVaultAddress, 0, maxRedemptions);

      // Set the max possible withdrawals
      await expect(vaultHub.connect(agentSigner).setVaultRedemptions(stakingVaultAddress, maxRedemptions))
        .to.emit(vaultHub, "RedemptionsObligationUpdated")
        .withArgs(stakingVaultAddress, maxRedemptions, 0n);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(maxRedemptions);

      // Decrease the obligation
      const newValue = maxRedemptions / 10n;
      await expect(vaultHub.connect(agentSigner).setVaultRedemptions(stakingVaultAddress, newValue))
        .to.emit(vaultHub, "RedemptionsObligationUpdated")
        .withArgs(stakingVaultAddress, newValue, 0n);

      const obligationsAfterDecreased = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterDecreased.redemptions).to.equal(newValue);

      // Remove the obligation
      await expect(vaultHub.connect(agentSigner).setVaultRedemptions(stakingVaultAddress, 0))
        .to.emit(vaultHub, "RedemptionsObligationUpdated")
        .withArgs(stakingVaultAddress, 0, 0n);

      const obligationsAfterRemoved = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterRemoved.redemptions).to.equal(0n);
    });

    context("Must decrease on liability shares change", () => {
      beforeEach(async () => {
        liabilityShares = ether("1");
        maxRedemptions = await ctx.contracts.lido.getPooledEthBySharesRoundUp(liabilityShares);

        await dashboard.connect(roles.funder).fund({ value: ether("1") });
        await dashboard.connect(roles.minter).mintShares(roles.burner, liabilityShares);

        await addRedemptionsObligation(maxRedemptions);
      });

      it("On shares burned", async () => {
        const { lido } = ctx.contracts;

        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.redemptions).to.equal(maxRedemptions);

        expect(await lido.sharesOf(roles.burner)).to.equal(liabilityShares);
        await lido.connect(roles.burner).approve(dashboard, liabilityShares);

        const sharesToBurn = liabilityShares / 2n;
        const expectedRedemptions = maxRedemptions / 2n;

        await expect(dashboard.connect(roles.burner).burnShares(sharesToBurn))
          .to.emit(vaultHub, "RedemptionsObligationUpdated")
          .withArgs(stakingVaultAddress, expectedRedemptions, expectedRedemptions);

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptions).to.equal(expectedRedemptions);
      });

      it("On vault rebalanced", async () => {
        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.redemptions).to.equal(maxRedemptions);

        const sharesToRebalance = liabilityShares / 2n;
        const expectedRedemptions = maxRedemptions / 2n;

        await expect(dashboard.connect(roles.rebalancer).rebalanceVault(sharesToRebalance))
          .to.emit(vaultHub, "RedemptionsObligationUpdated")
          .withArgs(stakingVaultAddress, expectedRedemptions, expectedRedemptions);

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptions).to.equal(expectedRedemptions);
      });

      it("Should not increase on new minting", async () => {
        await dashboard.connect(roles.funder).fund({ value: ether("1") });
        await dashboard.connect(roles.minter).mintShares(roles.burner, ether("1"));

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptions).to.equal(maxRedemptions);
      });
    });

    context("Must be settled on report", () => {
      beforeEach(async () => {
        liabilityShares = ether("1");
        maxRedemptions = await ctx.contracts.lido.getPooledEthBySharesRoundUp(liabilityShares);

        await dashboard.connect(roles.funder).fund({ value: ether("1") });
        await dashboard.connect(roles.minter).mintShares(roles.burner, liabilityShares);

        await addRedemptionsObligation(maxRedemptions);
      });

      it("Should not change on report when vault has no balance", async () => {
        await setBalance(stakingVaultAddress, 0);

        await expect(reportVaultDataWithProof(ctx, stakingVault)).not.to.emit(vaultHub, "RedemptionsObligationUpdated");

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptions).to.equal(maxRedemptions);
      });

      it("Should partially settle on report when vault has some balance", async () => {
        const vaultBalance = ether("0.7");
        await setBalance(stakingVaultAddress, vaultBalance);

        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.redemptions).to.equal(maxRedemptions);

        await expect(reportVaultDataWithProof(ctx, stakingVault))
          .to.emit(vaultHub, "RedemptionsObligationUpdated")
          .withArgs(stakingVaultAddress, maxRedemptions - vaultBalance, vaultBalance)
          .not.to.emit(vaultHub, "VaultRebalanced");

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptions).to.equal(maxRedemptions - vaultBalance);
      });

      it("Should fully settle on report when vault has enough balance", async () => {
        await setBalance(stakingVaultAddress, ether("100"));

        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.redemptions).to.equal(maxRedemptions);

        await expect(reportVaultDataWithProof(ctx, stakingVault))
          .to.emit(vaultHub, "RedemptionsObligationUpdated")
          .withArgs(stakingVaultAddress, 0n, maxRedemptions)
          .not.to.emit(vaultHub, "VaultRebalanced");

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptions).to.equal(0n);
      });
    });
  });

  context("Report should settle obligations in correct order", () => {
    let liabilityShares: bigint;
    let maxRedemptions: bigint;

    beforeEach(async () => {
      liabilityShares = ether("1");
      maxRedemptions = await ctx.contracts.lido.getPooledEthBySharesRoundUp(liabilityShares);
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await dashboard.connect(roles.minter).mintShares(roles.burner, liabilityShares);

      await addRedemptionsObligation(maxRedemptions);
    });

    it("Withdrawals before the treasury fees", async () => {
      const vaultBalance = ether("0.7");
      await setBalance(stakingVaultAddress, vaultBalance);

      let accruedTreasuryFees = ether("1");

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.redemptions).to.equal(maxRedemptions);

      const unsettledWithdrawals = maxRedemptions - vaultBalance;

      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees }))
        .to.emit(vaultHub, "RedemptionsObligationUpdated")
        .withArgs(stakingVaultAddress, unsettledWithdrawals, vaultBalance)
        .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
        .withArgs(stakingVaultAddress, accruedTreasuryFees, 0n)
        .not.to.emit(vaultHub, "VaultRebalanced");

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(unsettledWithdrawals);
      expect(obligationsAfter.treasuryFees).to.equal(accruedTreasuryFees);
      expect(obligationsAfter.totalSettledTreasuryFees).to.equal(0n);

      // fund to the vault to settle some obligations
      const funded = ether("1");
      const feesIncreased = ether("0.1");
      await dashboard.connect(roles.funder).fund({ value: funded });

      // add some treasury fees
      accruedTreasuryFees += feesIncreased;

      const expectedSettledTreasuryFees1 = funded - unsettledWithdrawals;
      const expectedUnsettledTreasuryFees = accruedTreasuryFees - expectedSettledTreasuryFees1;

      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees }))
        .to.emit(vaultHub, "RedemptionsObligationUpdated")
        .withArgs(stakingVaultAddress, 0, unsettledWithdrawals)
        .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
        .withArgs(stakingVaultAddress, expectedUnsettledTreasuryFees, expectedSettledTreasuryFees1)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, expectedSettledTreasuryFees1)
        .not.to.emit(vaultHub, "VaultRebalanced");

      const obligationsAfterFunding = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterFunding.redemptions).to.equal(0n);
      expect(obligationsAfterFunding.treasuryFees).to.equal(expectedUnsettledTreasuryFees);
      expect(obligationsAfterFunding.totalSettledTreasuryFees).to.equal(expectedSettledTreasuryFees1);

      // fund to the vault to settle all the obligations
      await dashboard.connect(roles.funder).fund({ value: funded });

      accruedTreasuryFees += feesIncreased;
      const expectedSettledTreasuryFees2 = expectedUnsettledTreasuryFees + feesIncreased;
      const expectedTotalSettledTreasuryFees = expectedSettledTreasuryFees1 + expectedSettledTreasuryFees2;

      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees }))
        .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
        .withArgs(stakingVaultAddress, 0n, expectedSettledTreasuryFees2)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, expectedSettledTreasuryFees2)
        .not.to.emit(vaultHub, "RedemptionsObligationUpdated");

      const obligationsAfterReport = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterReport.redemptions).to.equal(0n);
      expect(obligationsAfterReport.treasuryFees).to.equal(0);
      expect(obligationsAfterReport.totalSettledTreasuryFees).to.equal(expectedTotalSettledTreasuryFees);
    });
  });

  context("Manual settlement via dashboard", () => {
    let liabilityShares: bigint;
    let maxRedemptions: bigint;
    let accruedTreasuryFees: bigint;
    let treasuryFees: bigint;

    beforeEach(async () => {
      liabilityShares = ether("1");
      accruedTreasuryFees = ether("2.1");

      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await dashboard.connect(roles.minter).mintShares(roles.burner.address, liabilityShares);

      await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees });
      ({ treasuryFees } = await vaultHub.vaultObligations(stakingVaultAddress));

      maxRedemptions = await ctx.contracts.lido.getPooledEthBySharesRoundUp(liabilityShares);
      await addRedemptionsObligation(maxRedemptions);
    });

    it("Reverts when vault balance is zero and no funding provided", async () => {
      expect(treasuryFees).to.equal(ether("0.1")); // 2 ether should be settled to the treasury

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.redemptions).to.equal(maxRedemptions);
      expect(obligationsBefore.treasuryFees).to.equal(treasuryFees);

      await setBalance(stakingVaultAddress, 0);

      await expect(vaultHub.settleVaultObligations(stakingVaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroBalance",
      );

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(maxRedemptions);
      expect(obligationsAfter.treasuryFees).to.equal(treasuryFees);
    });

    it("Partially settles obligations using existing balance", async () => {
      const funding = ether("0.5");

      await dashboard.connect(roles.funder).fund({ value: funding });

      await expect(vaultHub.settleVaultObligations(stakingVaultAddress))
        .to.emit(vaultHub, "RedemptionsObligationUpdated")
        .withArgs(stakingVaultAddress, maxRedemptions - funding, funding)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(vaultHubAddress, funding);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(maxRedemptions - funding);
      expect(obligationsAfter.treasuryFees).to.equal(treasuryFees);
    });

    it("Fully settles obligations when funded", async () => {
      const expectedSettledFees = maxRedemptions + treasuryFees;
      const extraFunding = expectedSettledFees + ether("1"); // 1 ether extra should stay in the vault

      await dashboard.connect(roles.funder).fund({ value: extraFunding });

      // here we use owner, because otherwise user has to have FUND_ROLE to be able to settle obligations
      await expect(vaultHub.settleVaultObligations(stakingVaultAddress))
        .to.emit(vaultHub, "RedemptionsObligationUpdated")
        .withArgs(stakingVaultAddress, 0n, maxRedemptions)
        .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
        .withArgs(stakingVaultAddress, 0n, treasuryFees)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(vaultHubAddress, maxRedemptions)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, treasuryFees);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(0n);

      const vaultBalanceAfter = await ethers.provider.getBalance(stakingVaultAddress);
      expect(vaultBalanceAfter).to.equal(ether("1"));
    });
  });

  context("Minting with unsettled treasury fees", () => {
    const accruedTreasuryFees = ether("0.1");

    beforeEach(async () => {
      await dashboard.connect(roles.funder).fund({ value: ether("1") });

      const balanceBefore = await ethers.provider.getBalance(stakingVaultAddress);
      await setBalance(stakingVaultAddress, 0);
      await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees });
      await setBalance(stakingVaultAddress, balanceBefore);
    });

    it("Should revert when trying to mint more than total value minus unsettled treasury fees", async () => {
      const totalValue = await vaultHub.totalValue(stakingVaultAddress);
      const reserveRatioBP = (await vaultHub.vaultConnection(stakingVaultAddress)).reserveRatioBP;
      const maxMintableRatioBP = TOTAL_BASIS_POINTS - reserveRatioBP;
      const maxLocked = totalValue - accruedTreasuryFees;
      const maxMintableEther = (maxLocked * maxMintableRatioBP) / TOTAL_BASIS_POINTS;

      await expect(
        dashboard.connect(roles.minter).mintShares(roles.burner, maxMintableEther + 1n),
      ).to.be.revertedWithCustomError(vaultHub, "InsufficientTotalValueToMint");

      await expect(dashboard.connect(roles.minter).mintShares(roles.burner, maxMintableEther))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVaultAddress, maxMintableEther, maxLocked);
    });

    it("Should not take withdrals obligation into account", async () => {
      const totalValue = await vaultHub.totalValue(stakingVaultAddress);
      const reserveRatioBP = (await vaultHub.vaultConnection(stakingVaultAddress)).reserveRatioBP;
      const maxMintableRatioBP = TOTAL_BASIS_POINTS - reserveRatioBP;
      const maxLocked = totalValue - accruedTreasuryFees;
      const maxMintableEther = (maxLocked * maxMintableRatioBP) / TOTAL_BASIS_POINTS;

      const mintEth = maxMintableEther / 2n;
      const mintShares = await ctx.contracts.lido.getPooledEthBySharesRoundUp(mintEth);

      // Add 1/2 of the mintable ether to the vault as withdrawals obligation, so if withdrawals obligation is taken into account,
      // the user will not be able to mint anything from this moment
      await dashboard.connect(roles.minter).mintShares(roles.burner, mintShares);

      await addRedemptionsObligation(mintEth);

      await expect(dashboard.connect(roles.minter).mintShares(roles.burner, mintShares))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVaultAddress, mintShares, maxLocked);
    });
  });

  context("Withdrawal takes unsettled obligations into account", () => {
    beforeEach(async () => {
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await dashboard.connect(roles.minter).mintShares(roles.burner, ether("1"));

      const obligation = ether("1");

      await addRedemptionsObligation(obligation);
    });

    it("Should work when trying to withdraw less than available balance", async () => {
      const unlockedValue = await vaultHub.unlocked(stakingVaultAddress);

      await expect(dashboard.connect(roles.withdrawer).withdraw(stranger, unlockedValue))
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(stranger, unlockedValue);
    });

    it("Should revert when trying to withdraw more than available balance", async () => {
      // simulate deposit to Beacon chain -1 ether
      await setBalance(stakingVaultAddress, ether("1"));
      const unlockedValue = await vaultHub.unlocked(stakingVaultAddress);

      await expect(dashboard.connect(roles.withdrawer).withdraw(stranger, unlockedValue))
        .to.be.revertedWithCustomError(vaultHub, "VaultInsufficientBalance")
        .withArgs(stakingVaultAddress, 0, unlockedValue);
    });

    // TODO: add test for node operator fees
  });

  context("Disconnect flow", () => {
    beforeEach(async () => {});

    it("Should revert when trying to disconnect with unsettled obligations", async () => {
      // 1 ether of the connection deposit will be settled to the treasury, so 0.1 ether will be left in obligations
      await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees: ether("1.1") });

      const obligations = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligations.treasuryFees).to.equal(ether("0.1"));
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(0n);

      await expect(dashboard.connect(roles.disconnecter).voluntaryDisconnect())
        .to.be.revertedWithCustomError(vaultHub, "VaultHasUnsettledObligations")
        .withArgs(stakingVaultAddress, ether("0.1"));
    });

    it("Should not allow to disconnect with no connection deposit on balance", async () => {
      // 1 ether of the connection deposit will be settled to the treasury
      await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees: ether("1") });

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.treasuryFees).to.equal(0n);
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(0n);

      await expect(dashboard.connect(roles.disconnecter).voluntaryDisconnect())
        .to.be.revertedWithCustomError(vaultHub, "VaultInsufficientBalance")
        .withArgs(stakingVaultAddress, 0, ether("1"));
    });

    it("Should allow to disconnect when all obligations are settled and balance is >= connection deposit", async () => {
      // 1 ether of the connection deposit will be settled to the treasury
      await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees: ether("1") });

      await dashboard.connect(roles.funder).fund({ value: ether("1") });

      await expect(dashboard.connect(roles.disconnecter).voluntaryDisconnect())
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(stakingVaultAddress);
    });

    it("Should take last fees from the post disconnect report", async () => {
      // 1 ether of the connection deposit will be settled to the treasury
      await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees: ether("1") });

      // adding 1 ether to cover the connection deposit
      await dashboard.connect(roles.funder).fund({ value: ether("1") });

      // successfully disconnect
      await expect(dashboard.connect(roles.disconnecter).voluntaryDisconnect())
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(stakingVaultAddress);

      // take the last fees from the post disconnect report (1.1 ether because fees are cumulative)
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees: ether("1.1") }))
        .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
        .withArgs(stakingVaultAddress, 0, ether("0.1"))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVaultAddress);

      // 0.9 ether should be left in the vault
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(ether("0.9"));
    });

    it("Should take max available fees if possible", async () => {
      // 1 ether of the connection deposit will be settled to the treasury
      await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees: ether("1") });

      // adding 1.1 ether to cover the connection deposit and add some more for fees
      await dashboard.connect(roles.funder).fund({ value: ether("1.1") });

      // successfully disconnect
      await expect(dashboard.connect(roles.disconnecter).voluntaryDisconnect())
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(stakingVaultAddress);

      // take the last fees from the post disconnect report (2.1 ether because fees are cumulative)
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees: ether("2.2") }))
        .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
        .withArgs(stakingVaultAddress, 0, ether("1.1")) // here max we can take is 1 ether
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVaultAddress);

      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(0n);
    });
  });
});
