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

import { Snapshot, Tracing } from "test/suite";

describe("Integration: Vault obligations", () => {
  let ctx: ProtocolContext;

  let vaultHub: VaultHub;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;
  let roles: VaultRoles;

  let stakingVaultAddress: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let agentSigner: HardhatEthersSigner;

  let originalSnapshot: string;
  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    ({ vaultHub } = ctx.contracts);

    [owner, nodeOperator] = await ethers.getSigners();

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
    agentSigner = await ctx.getSigner("agent");
  });

  after(async () => await Snapshot.restore(originalSnapshot));

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  context("Treasury fees obligations", () => {
    it("Updated on the vault report for vault with no balance", async () => {
      const accruedTreasuryFees = ether("1");

      await setBalance(stakingVaultAddress, 0); // dirty hack to make the vault balance 0

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.unsettledTreasuryFees).to.equal(0n);
      expect(obligationsBefore.settledTreasuryFees).to.equal(0n);

      // Report the vault data with accrued treasury fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees }))
        .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
        .withArgs(stakingVaultAddress, accruedTreasuryFees, 0n); // 0 settled

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledTreasuryFees).to.equal(accruedTreasuryFees);
      expect(obligationsAfter.settledTreasuryFees).to.equal(0n);
    });

    it("Settled on the vault report for vault with enough balance", async () => {
      const accruedTreasuryFees = ether("1");

      await dashboard.connect(roles.funder).fund({ value: ether("2") });

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.unsettledTreasuryFees).to.equal(0n);
      expect(obligationsBefore.settledTreasuryFees).to.equal(0n);

      // Report the vault data with accrued treasury fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees }))
        .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
        .withArgs(stakingVaultAddress, 0n, accruedTreasuryFees) // 0 unsettled
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(await ctx.contracts.locator.treasury(), accruedTreasuryFees);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledTreasuryFees).to.equal(0n);
      expect(obligationsAfter.settledTreasuryFees).to.equal(accruedTreasuryFees);
    });

    it("Partially settled on the vault report for vault with some balance", async () => {
      // Make sure the vault has enough balance
      const accruedTreasuryFees = ether("1");
      const vaultBalance = ether("0.7");
      const unsettledTreasuryFees = accruedTreasuryFees - vaultBalance;

      await setBalance(stakingVaultAddress, vaultBalance);

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.unsettledTreasuryFees).to.equal(0n);
      expect(obligationsBefore.settledTreasuryFees).to.equal(0n);

      // Report the vault data with accrued treasury fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees }))
        .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
        .withArgs(stakingVaultAddress, unsettledTreasuryFees, vaultBalance) // unsettled, settled
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(await ctx.contracts.locator.treasury(), vaultBalance); // settled withrdrawal to treasury

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledTreasuryFees).to.equal(unsettledTreasuryFees);
      expect(obligationsAfter.settledTreasuryFees).to.equal(vaultBalance);
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
        .withArgs(await ctx.contracts.locator.treasury(), vaultBalance);

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
        .withArgs(await ctx.contracts.locator.treasury(), feesToSettle);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledTreasuryFees).to.equal(0n);
      expect(obligationsAfter.settledTreasuryFees).to.equal(feesToSettle + vaultBalance);
    });
  });

  context("Core withdrawals obligations", () => {
    let liabilityShares: bigint;
    let maxPossibleWithdrawals: bigint;

    it("Can't be applied to the vault with no liabilities", async () => {
      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.unsettledWithdrawals).to.equal(0n);

      expect((await vaultHub.vaultRecord(stakingVaultAddress)).liabilityShares).to.equal(0n);

      await expect(vaultHub.connect(agentSigner).setUnsettledWithdrawals(stakingVaultAddress, ether("1")))
        .to.be.revertedWithCustomError(vaultHub, "WithdrawalsObligationValueTooHigh")
        .withArgs(stakingVaultAddress, ether("1"), 0n);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledWithdrawals).to.equal(0n);
    });

    it("Can be applied to the vault with liabilities", async () => {
      const { lido } = ctx.contracts;

      liabilityShares = 1000n;

      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await dashboard.connect(roles.minter).mintShares(roles.burner.address, liabilityShares);

      maxPossibleWithdrawals = await lido.getPooledEthBySharesRoundUp(liabilityShares);

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.unsettledWithdrawals).to.equal(0n);

      // Over the max possible withdrawals
      await expect(
        vaultHub.connect(agentSigner).setUnsettledWithdrawals(stakingVaultAddress, maxPossibleWithdrawals + 1n),
      )
        .to.be.revertedWithCustomError(vaultHub, "WithdrawalsObligationValueTooHigh")
        .withArgs(stakingVaultAddress, maxPossibleWithdrawals + 1n, maxPossibleWithdrawals);

      // Set the max possible withdrawals
      await expect(vaultHub.connect(agentSigner).setUnsettledWithdrawals(stakingVaultAddress, maxPossibleWithdrawals))
        .to.emit(vaultHub, "WithdrawalsObligationUpdated")
        .withArgs(stakingVaultAddress, maxPossibleWithdrawals, 0n);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledWithdrawals).to.equal(maxPossibleWithdrawals);

      // Decrease the obligation
      const newValue = maxPossibleWithdrawals / 10n;
      await expect(vaultHub.connect(agentSigner).setUnsettledWithdrawals(stakingVaultAddress, newValue))
        .to.emit(vaultHub, "WithdrawalsObligationUpdated")
        .withArgs(stakingVaultAddress, newValue, 0n);

      const obligationsAfterDecreased = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterDecreased.unsettledWithdrawals).to.equal(newValue);

      // Remove the obligation
      await expect(vaultHub.connect(agentSigner).setUnsettledWithdrawals(stakingVaultAddress, 0))
        .to.emit(vaultHub, "WithdrawalsObligationUpdated")
        .withArgs(stakingVaultAddress, 0, 0n);

      const obligationsAfterRemoved = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterRemoved.unsettledWithdrawals).to.equal(0n);
    });

    context("Must decrease on liability shares change", () => {
      beforeEach(async () => {
        liabilityShares = ether("1");

        await dashboard.connect(roles.funder).fund({ value: ether("1") });
        await dashboard.connect(roles.minter).mintShares(roles.burner.address, liabilityShares);

        maxPossibleWithdrawals = await ctx.contracts.lido.getPooledEthBySharesRoundUp(liabilityShares);
        await vaultHub.connect(agentSigner).setUnsettledWithdrawals(stakingVaultAddress, maxPossibleWithdrawals);
      });

      it("On shares burned", async () => {
        const { lido } = ctx.contracts;

        expect(await lido.sharesOf(roles.burner)).to.equal(liabilityShares);
        await lido.connect(roles.burner).approve(dashboard, liabilityShares);

        await expect(dashboard.connect(roles.burner).burnShares(liabilityShares / 2n))
          .to.emit(vaultHub, "WithdrawalsObligationUpdated")
          .withArgs(stakingVaultAddress, maxPossibleWithdrawals / 2n, 0n);

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.unsettledWithdrawals).to.equal(maxPossibleWithdrawals / 2n);
      });

      it("On vault rebalanced", async () => {
        await expect(dashboard.connect(roles.rebalancer).rebalanceVault(liabilityShares / 2n))
          .to.emit(vaultHub, "WithdrawalsObligationUpdated")
          .withArgs(stakingVaultAddress, maxPossibleWithdrawals / 2n, 0n);

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.unsettledWithdrawals).to.equal(maxPossibleWithdrawals / 2n);
      });
    });

    context("Must be settled on report", () => {
      beforeEach(async () => {
        liabilityShares = ether("1");

        await dashboard.connect(roles.funder).fund({ value: ether("1") });
        await dashboard.connect(roles.minter).mintShares(roles.burner.address, liabilityShares);

        maxPossibleWithdrawals = await ctx.contracts.lido.getPooledEthBySharesRoundUp(liabilityShares);
        await vaultHub.connect(agentSigner).setUnsettledWithdrawals(stakingVaultAddress, maxPossibleWithdrawals);
        Tracing.disable();
      });

      it("Should not change on report when vault has no balance", async () => {
        await setBalance(stakingVaultAddress, 0);

        await expect(reportVaultDataWithProof(ctx, stakingVault)).not.to.emit(vaultHub, "WithdrawalsObligationUpdated");

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.unsettledWithdrawals).to.equal(maxPossibleWithdrawals);
      });

      it("Should partially settle on report when vault has some balance", async () => {
        const vaultBalance = ether("0.7");
        await setBalance(stakingVaultAddress, vaultBalance);

        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.unsettledWithdrawals).to.equal(maxPossibleWithdrawals);

        await expect(reportVaultDataWithProof(ctx, stakingVault))
          .to.emit(vaultHub, "WithdrawalsObligationUpdated")
          .withArgs(stakingVaultAddress, maxPossibleWithdrawals - vaultBalance, vaultBalance)
          .not.to.emit(vaultHub, "VaultRebalanced");

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.unsettledWithdrawals).to.equal(maxPossibleWithdrawals - vaultBalance);
      });

      it("Should fully settle on report when vault has enough balance", async () => {
        await setBalance(stakingVaultAddress, ether("100"));

        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.unsettledWithdrawals).to.equal(maxPossibleWithdrawals);

        await expect(reportVaultDataWithProof(ctx, stakingVault))
          .to.emit(vaultHub, "WithdrawalsObligationUpdated")
          .withArgs(stakingVaultAddress, 0n, maxPossibleWithdrawals)
          .not.to.emit(vaultHub, "VaultRebalanced");

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.unsettledWithdrawals).to.equal(0n);
      });
    });

    context("In correct order", () => {
      beforeEach(async () => {
        liabilityShares = ether("1");

        await dashboard.connect(roles.funder).fund({ value: ether("1") });
        await dashboard.connect(roles.minter).mintShares(roles.burner.address, liabilityShares);

        maxPossibleWithdrawals = await ctx.contracts.lido.getPooledEthBySharesRoundUp(liabilityShares);
        await vaultHub.connect(agentSigner).setUnsettledWithdrawals(stakingVaultAddress, maxPossibleWithdrawals);
      });

      it("Should settle before the treasury fees", async () => {
        const vaultBalance = ether("0.7");
        await setBalance(stakingVaultAddress, vaultBalance);

        let accruedTreasuryFees = ether("1");

        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.unsettledWithdrawals).to.equal(maxPossibleWithdrawals);

        const unsettledWithdrawals = maxPossibleWithdrawals - vaultBalance;

        await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees }))
          .to.emit(vaultHub, "WithdrawalsObligationUpdated")
          .withArgs(stakingVaultAddress, unsettledWithdrawals, vaultBalance)
          .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
          .withArgs(stakingVaultAddress, accruedTreasuryFees, 0n)
          .not.to.emit(vaultHub, "VaultRebalanced");

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.unsettledWithdrawals).to.equal(unsettledWithdrawals);
        expect(obligationsAfter.unsettledTreasuryFees).to.equal(accruedTreasuryFees);
        expect(obligationsAfter.settledTreasuryFees).to.equal(0n);

        // fund to the vault to settle some obligations
        const funded = ether("1");
        const feesIncreased = ether("0.1");
        await dashboard.connect(roles.funder).fund({ value: funded });

        // add some treasury fees
        accruedTreasuryFees += feesIncreased;

        const expectedSettledTreasuryFees1 = funded - unsettledWithdrawals;
        const expectedUnsettledTreasuryFees = accruedTreasuryFees - expectedSettledTreasuryFees1;

        await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees }))
          .to.emit(vaultHub, "WithdrawalsObligationUpdated")
          .withArgs(stakingVaultAddress, 0, unsettledWithdrawals)
          .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
          .withArgs(stakingVaultAddress, expectedUnsettledTreasuryFees, expectedSettledTreasuryFees1)
          .to.emit(stakingVault, "EtherWithdrawn")
          .withArgs(await ctx.contracts.locator.treasury(), expectedSettledTreasuryFees1)
          .not.to.emit(vaultHub, "VaultRebalanced");

        const obligationsAfterFunding = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfterFunding.unsettledWithdrawals).to.equal(0n);
        expect(obligationsAfterFunding.unsettledTreasuryFees).to.equal(expectedUnsettledTreasuryFees);
        expect(obligationsAfterFunding.settledTreasuryFees).to.equal(expectedSettledTreasuryFees1);

        // fund to the vault to settle all the obligations
        await dashboard.connect(roles.funder).fund({ value: funded });

        accruedTreasuryFees += feesIncreased;
        const expectedSettledTreasuryFees2 = expectedUnsettledTreasuryFees + feesIncreased;
        const expectedTotalSettledTreasuryFees = expectedSettledTreasuryFees1 + expectedSettledTreasuryFees2;

        await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedTreasuryFees }))
          .to.emit(vaultHub, "TreasuryFeesObligationUpdated")
          .withArgs(stakingVaultAddress, 0n, expectedSettledTreasuryFees2)
          .to.emit(stakingVault, "EtherWithdrawn")
          .withArgs(await ctx.contracts.locator.treasury(), expectedSettledTreasuryFees2)
          .not.to.emit(vaultHub, "WithdrawalsObligationUpdated");

        const obligationsAfterReport = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfterReport.unsettledWithdrawals).to.equal(0n);
        expect(obligationsAfterReport.unsettledTreasuryFees).to.equal(0);
        expect(obligationsAfterReport.settledTreasuryFees).to.equal(expectedTotalSettledTreasuryFees);
      });
    });
  });
});
