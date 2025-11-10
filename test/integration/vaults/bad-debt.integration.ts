import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault } from "typechain-types";

import { advanceChainTime, days, getCurrentBlockTimestamp, MAX_UINT256, SECONDS_PER_SLOT } from "lib";
import {
  changeTier,
  createVaultWithDashboard,
  DEFAULT_TIER_PARAMS,
  getProtocolContext,
  getReportTimeElapsed,
  ProtocolContext,
  report,
  reportVaultDataWithProof,
  reportVaultsDataWithProof,
  setupLidoForVaults,
  setUpOperatorGrid,
  waitNextAvailableReportTime,
} from "lib/protocol";
import { simulateReport } from "lib/protocol/helpers/accounting";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

describe("Integration: Vault with bad debt", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let otherOwner: HardhatEthersSigner;
  let daoAgent: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;

  before(async () => {
    ctx = await getProtocolContext();
    const { lido, stakingVaultFactory, vaultHub } = ctx.contracts;
    originalSnapshot = await Snapshot.take();

    [, owner, nodeOperator, otherOwner, daoAgent] = await ethers.getSigners();
    await setupLidoForVaults(ctx);

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);

    // Going to bad debt
    await dashboard.fund({ value: ether("10") }); // TV = 11 ETH
    await dashboard.mintShares(owner, await dashboard.remainingMintingCapacityShares(0n));

    // Slash 10 ETH
    await reportVaultDataWithProof(ctx, stakingVault, {
      totalValue: ether("1"),
      slashingReserve: ether("1"),
      waitForNextRefSlot: true,
    });

    expect(await dashboard.totalValue()).to.be.lessThan(
      await lido.getPooledEthBySharesRoundUp(await dashboard.liabilityShares()),
    );

    // Indicates bad debt
    expect(await vaultHub.healthShortfallShares(stakingVault)).to.be.equal(MAX_UINT256);

    // Grant a role to the DAO agent
    await vaultHub.connect(await ctx.getSigner("agent")).grantRole(await vaultHub.BAD_DEBT_MASTER_ROLE(), daoAgent);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Bad Debt Detection", () => {
    it("Detect bad debt condition", async () => {
      const { vaultHub, lido } = ctx.contracts;

      // Verify bad debt exists
      const totalValue = await dashboard.totalValue();
      const liabilityShares = await dashboard.liabilityShares();
      const liabilityValue = await lido.getPooledEthBySharesRoundUp(liabilityShares);

      expect(totalValue).to.be.lessThan(liabilityValue, "Total value should be less than liability value");

      // Check isVaultHealthy
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.equal(false, "Vault should be unhealthy");

      // Check healthShortfallShares
      expect(await vaultHub.healthShortfallShares(stakingVault)).to.be.equal(
        MAX_UINT256,
        "healthShortfallShares should be MAX_UINT256",
      );

      // Check obligationsShortfallValue
      expect(await vaultHub.obligationsShortfallValue(stakingVault)).to.be.equal(
        MAX_UINT256,
        "obligationsShortfallValue should be MAX_UINT256",
      );
    });

    it("Bad debt prevents normal operations (mint, withdraw, or disconnect)", async () => {
      const { vaultHub } = ctx.contracts;

      // Verify vault is unhealthy
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.equal(false);

      // Try to mint - should fail with ExceedsMintingCapacity (no lockable value available)
      await expect(dashboard.mintShares(owner, 1000n)).to.be.revertedWithCustomError(
        dashboard,
        "ExceedsMintingCapacity",
      );

      // Try to withdraw - should fail with ExceedsWithdrawable (withdrawable is 0)
      await expect(dashboard.withdraw(owner, ether("0.1"))).to.be.revertedWithCustomError(
        dashboard,
        "ExceedsWithdrawable",
      );

      // Try to disconnect - should fail with NoLiabilitySharesShouldBeLeft
      await expect(dashboard.voluntaryDisconnect()).to.be.revertedWithCustomError(
        vaultHub,
        "NoLiabilitySharesShouldBeLeft",
      );
    });
  });

  describe("Cover Bad Debt", () => {
    it("Owner covers bad debt with direct deposit", async () => {
      const { vaultHub, lido } = ctx.contracts;

      // Calculate bad debt amount
      const liabilityShares = await dashboard.liabilityShares();
      const totalValue = await dashboard.totalValue();
      const liabilityValue = await lido.getPooledEthBySharesRoundUp(liabilityShares);

      // Verify vault is unhealthy before recovery
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.equal(false);

      // Owner deposits to cover bad debt
      // Use 2x the liability value to ensure we're above health threshold
      const depositAmount = liabilityValue * 2n - totalValue;
      await dashboard.fund({ value: depositAmount });

      // Bring fresh report
      await reportVaultDataWithProof(ctx, stakingVault);

      // Verify vault is now healthy
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.equal(true, "Vault should be healthy after deposit");

      // Verify healthShortfallShares is no longer MAX_UINT256
      const healthShortfall = await vaultHub.healthShortfallShares(stakingVault);
      expect(healthShortfall).to.not.equal(MAX_UINT256, "healthShortfallShares should not be MAX_UINT256");

      // Mint should work - use actual minting capacity
      const mintingCapacity = await dashboard.remainingMintingCapacityShares(0n);
      expect(mintingCapacity).to.be.greaterThan(0n, "Should have minting capacity");
      const sharesToMint = mintingCapacity / 10n; // Mint 10% of capacity
      await expect(dashboard.mintShares(owner, sharesToMint)).to.emit(vaultHub, "MintedSharesOnVault");

      // Withdraw should work
      const withdrawableValue = await vaultHub.withdrawableValue(stakingVault);
      expect(withdrawableValue).to.be.greaterThan(ether("0.1"), "Should have withdrawable value");
      await expect(dashboard.withdraw(owner, ether("0.1"))).to.emit(stakingVault, "EtherWithdrawn");
    });

    it("Recovery via CL rewards", async () => {
      const { vaultHub, lazyOracle } = ctx.contracts;

      const totalValue = await dashboard.totalValue();

      // Verify vault is unhealthy before recovery
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.equal(false);

      // Increase totalValue by 100% each time - simulate CL rewards accumulation
      const agentSigner = await ctx.getSigner("agent");
      await lazyOracle.connect(agentSigner).updateSanityParams(days(30n), 10500n, ether("0.01"));

      let newTotalValue = totalValue;
      for (let i = 0; i < 5; i++) {
        newTotalValue = newTotalValue * 2n;
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: newTotalValue,
          waitForNextRefSlot: true,
        });
      }

      // Verify vault is now healthy
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.equal(true, "Vault should be healthy after CL rewards");

      // Verify healthShortfallShares is no longer MAX_UINT256
      const healthShortfall = await vaultHub.healthShortfallShares(stakingVault);
      expect(healthShortfall).to.not.equal(MAX_UINT256, "healthShortfallShares should not be MAX_UINT256");
    });
  });

  describe("Socialization", () => {
    let acceptorStakingVault: StakingVault;
    let acceptorDashboard: Dashboard;

    beforeEach(async () => {
      const { stakingVaultFactory } = ctx.contracts;
      // create vault acceptor
      ({ stakingVault: acceptorStakingVault, dashboard: acceptorDashboard } = await createVaultWithDashboard(
        ctx,
        stakingVaultFactory,
        otherOwner,
        nodeOperator,
        nodeOperator,
      ));
    });

    it("Vault's debt can be socialized", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("10") });
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtSocialized")
        .withArgs(stakingVault, acceptorStakingVault, badDebtShares);

      expect(await dashboard.liabilityShares()).to.be.lessThanOrEqual(
        await lido.getSharesByPooledEth(await dashboard.totalValue()),
        "No more bad debt in vault",
      );

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.equal(false);

      expect(await acceptorDashboard.liabilityShares()).to.be.equal(badDebtShares);
      expect(await vaultHub.isVaultHealthy(acceptorStakingVault)).to.be.equal(true);
    });

    it("Socialization bypasses jail restrictions", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("10") });
      const { vaultHub, lido, operatorGrid } = ctx.contracts;
      const agentSigner = await ctx.getSigner("agent");

      // Put acceptor vault in jail to test bypass functionality
      await operatorGrid.connect(agentSigner).setVaultJailStatus(acceptorStakingVault, true);
      expect(await operatorGrid.isVaultInJail(acceptorStakingVault)).to.be.true;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      // Socialization should succeed even though acceptor vault is in jail
      // because socializeBadDebt uses _overrideLimits: true
      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtSocialized")
        .withArgs(stakingVault, acceptorStakingVault, badDebtShares);

      // Verify bad debt was transferred despite jail restriction
      expect(await acceptorDashboard.liabilityShares()).to.equal(badDebtShares);
      expect(await operatorGrid.isVaultInJail(acceptorStakingVault)).to.be.true; // Still in jail
    });

    it("Socialization doesn't lead to bad debt in acceptor", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("1") });
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      await expect(
        vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares),
      ).to.emit(vaultHub, "BadDebtSocialized");

      expect(await dashboard.liabilityShares()).to.be.greaterThan(
        await lido.getSharesByPooledEth(await dashboard.totalValue()),
        "Still some bad debt left",
      );

      expect(
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue())),
      ).to.be.lessThan(badDebtShares, "bad debt should decrease");

      expect(await vaultHub.isVaultHealthy(acceptorStakingVault)).to.be.equal(false);
      expect(await acceptorDashboard.liabilityShares()).to.be.lessThanOrEqual(
        await lido.getSharesByPooledEth(await acceptorDashboard.totalValue()),
        "No bad debt in acceptor vault",
      );
    });

    it("Socialization lead to bad debt beacon chain deposits pause", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("2") });
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      expect(await acceptorStakingVault.beaconChainDepositsPaused()).to.be.false;

      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtSocialized")
        .and.to.emit(acceptorStakingVault, "BeaconChainDepositsPaused");

      expect(await acceptorStakingVault.beaconChainDepositsPaused()).to.be.true;
    });

    it("OperatorGrid shareLimits can't prevent socialization", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("10") });
      const { vaultHub, lido } = ctx.contracts;

      await setUpOperatorGrid(
        ctx,
        [nodeOperator],
        [{ noShareLimit: await acceptorDashboard.liabilityShares(), tiers: [DEFAULT_TIER_PARAMS] }],
      );
      await changeTier(ctx, acceptorDashboard, otherOwner, nodeOperator);

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtSocialized")
        .withArgs(stakingVault, acceptorStakingVault, badDebtShares);
    });

    it("Socialization requires fresh reports", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("10") });
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      // Advance time to make report stale
      await advanceChainTime(await vaultHub.REPORT_FRESHNESS_DELTA());

      // Try to socialize with stale report - should fail
      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares))
        .to.be.revertedWithCustomError(vaultHub, "VaultReportStale")
        .withArgs(stakingVault);
    });

    it("Socialization only between same node operator", async () => {
      const { stakingVaultFactory, vaultHub, lido } = ctx.contracts;
      const [, , , , , differentOperator] = await ethers.getSigners();

      // Create acceptor vault with different node operator
      const { stakingVault: differentOpVault, dashboard: differentOpDashboard } = await createVaultWithDashboard(
        ctx,
        stakingVaultFactory,
        otherOwner,
        differentOperator,
        differentOperator,
      );

      await differentOpDashboard.connect(otherOwner).fund({ value: ether("10") });

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      // Try to socialize between different operators - should fail
      await expect(
        vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, differentOpVault, badDebtShares),
      ).to.be.revertedWithCustomError(vaultHub, "BadDebtSocializationNotAllowed");

      // Verify socialization works with same operator
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("10") });
      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtSocialized")
        .withArgs(stakingVault, acceptorStakingVault, badDebtShares);
    });

    it("Multi-vault bad debt socialization scenario", async () => {
      const { stakingVaultFactory, vaultHub, lido } = ctx.contracts;

      // Create vault B and C (acceptors, same operator)
      const { stakingVault: vaultB, dashboard: dashboardB } = await createVaultWithDashboard(
        ctx,
        stakingVaultFactory,
        otherOwner,
        nodeOperator,
        nodeOperator,
      );

      const { stakingVault: vaultC, dashboard: dashboardC } = await createVaultWithDashboard(
        ctx,
        stakingVaultFactory,
        otherOwner,
        nodeOperator,
        nodeOperator,
      );

      // Fund acceptor vaults with limited capacity
      const donorLiabilitySharesBefore = await dashboard.liabilityShares();
      await dashboardB.connect(otherOwner).fund({ value: donorLiabilitySharesBefore / 4n });
      await dashboardC.connect(otherOwner).fund({ value: donorLiabilitySharesBefore });

      const totalBadDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      const vaultBLiabilitySharesBefore = await dashboardB.liabilityShares();
      const vaultCLiabilitySharesBefore = await dashboardC.liabilityShares();

      // Calculate capacity for each acceptor (approximately half of total value in shares)
      const vaultBCapacity = await lido.getSharesByPooledEth(await dashboardB.totalValue());
      const vaultCCapacity = await lido.getSharesByPooledEth(await dashboardC.totalValue());

      // First socialization: transfer to vault B
      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, vaultB, totalBadDebtShares)).to.emit(
        vaultHub,
        "BadDebtSocialized",
      );

      const donorLiabilitySharesAfterFirst = await dashboard.liabilityShares();
      const vaultBLiabilitySharesAfterFirst = await dashboardB.liabilityShares();

      // Verify first transfer
      expect(donorLiabilitySharesAfterFirst).to.be.lessThan(donorLiabilitySharesBefore);
      expect(vaultBLiabilitySharesAfterFirst).to.be.greaterThan(vaultBLiabilitySharesBefore);
      expect(vaultBLiabilitySharesAfterFirst).to.be.lessThanOrEqual(vaultBCapacity, "Vault B shouldn't has bad debt");

      // Second socialization: transfer remaining to vault C
      const remainingBadDebt =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, vaultC, remainingBadDebt)).to.emit(
        vaultHub,
        "BadDebtSocialized",
      );

      const donorLiabilitySharesAfterSecond = await dashboard.liabilityShares();
      const vaultCLiabilitySharesAfterSecond = await dashboardC.liabilityShares();

      // Verify second transfer
      expect(donorLiabilitySharesAfterSecond).to.be.lessThan(donorLiabilitySharesAfterFirst);
      expect(vaultCLiabilitySharesAfterSecond).to.be.greaterThan(vaultCLiabilitySharesBefore);
      expect(vaultCLiabilitySharesAfterSecond).to.be.lessThanOrEqual(vaultCCapacity, "Vault C shouldn't has bad debt");

      // Verify vault A is fully recovered from bad debt
      const finalBadDebt =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      expect(finalBadDebt).to.equal(0n, "Donor vault should be fully recovered");

      // Verify all liability shares are properly tracked
      const totalLiabilityAfter =
        (await dashboard.liabilityShares()) +
        (await dashboardB.liabilityShares()) +
        (await dashboardC.liabilityShares());

      const totalLiabilityBefore =
        donorLiabilitySharesBefore + vaultBLiabilitySharesBefore + vaultCLiabilitySharesBefore;

      expect(totalLiabilityAfter).to.equal(totalLiabilityBefore, "Total liability shares should be conserved");
    });
  });

  describe("Internalization", () => {
    it("Full bad debt internalization", async () => {
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      const liabilitySharesBefore = await dashboard.liabilityShares();

      await expect(vaultHub.connect(daoAgent).internalizeBadDebt(stakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtWrittenOffToBeInternalized")
        .withArgs(stakingVault, badDebtShares);

      expect(await dashboard.liabilityShares()).to.be.equal(
        liabilitySharesBefore - badDebtShares,
        "Liability shares reduced by internalized amount",
      );

      expect(await dashboard.liabilityShares()).to.be.lessThanOrEqual(
        await lido.getSharesByPooledEth(await dashboard.totalValue()),
        "No bad debt in vault",
      );

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.equal(false, "Vault still unhealthy");

      await waitNextAvailableReportTime(ctx);
      expect(await vaultHub.badDebtToInternalize()).to.be.equal(badDebtShares);

      const { reportTx } = await report(ctx, { waitNextReportTime: false });
      await expect(reportTx)
        .to.emit(lido, "ExternalBadDebtInternalized")
        .withArgs(badDebtShares)
        .to.emit(lido, "ExternalSharesBurnt")
        .withArgs(badDebtShares);

      expect(await vaultHub.badDebtToInternalize()).to.be.equal(0n);
    });

    it("Partial bad debt internalization", async () => {
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      const partialAmount = badDebtShares / 2n;
      const liabilitySharesBefore = await dashboard.liabilityShares();

      await expect(vaultHub.connect(daoAgent).internalizeBadDebt(stakingVault, partialAmount))
        .to.emit(vaultHub, "BadDebtWrittenOffToBeInternalized")
        .withArgs(stakingVault, partialAmount);

      expect(await dashboard.liabilityShares()).to.be.equal(
        liabilitySharesBefore - partialAmount,
        "Liability shares reduced by partial amount",
      );

      const remainingBadDebt =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));
      expect(remainingBadDebt).to.be.greaterThan(0n, "Still has bad debt");

      await waitNextAvailableReportTime(ctx);
      expect(await vaultHub.badDebtToInternalize()).to.be.equal(partialAmount);

      const { reportTx } = await report(ctx, { waitNextReportTime: false });
      await expect(reportTx)
        .to.emit(lido, "ExternalBadDebtInternalized")
        .withArgs(partialAmount)
        .to.emit(lido, "ExternalSharesBurnt")
        .withArgs(partialAmount);

      expect(await vaultHub.badDebtToInternalize()).to.be.equal(0n);
    });

    it("Internalized debt settled on AccountingOracle report", async () => {
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      // First internalize the bad debt
      await vaultHub.connect(daoAgent).internalizeBadDebt(stakingVault, badDebtShares);

      await waitNextAvailableReportTime(ctx);
      expect(await vaultHub.badDebtToInternalize()).to.be.equal(badDebtShares, "Bad debt accumulated");

      const totalSharesBefore = await lido.getTotalShares();
      const externalSharesBefore = await lido.getExternalShares();

      // Trigger oracle report
      const { reportTx } = await report(ctx, { waitNextReportTime: false });

      await expect(reportTx)
        .to.emit(lido, "ExternalBadDebtInternalized")
        .withArgs(badDebtShares)
        .to.emit(lido, "ExternalSharesBurnt")
        .withArgs(badDebtShares);

      // Get the exact amount of fees minted from TokenRebased event
      const receipt = await reportTx!.wait();
      const rebasedEvent = ctx.getEvents(receipt!, "TokenRebased")[0];
      const sharesMintedAsFees = rebasedEvent.args.sharesMintedAsFees;

      expect(await vaultHub.badDebtToInternalize()).to.be.equal(0n, "Bad debt reset to 0");
      expect(await lido.getExternalShares()).to.be.equal(
        externalSharesBefore - badDebtShares,
        "External shares decreased",
      );
      // Total shares increase only by minted fees (bad debt is transferred from external to internal, not creating new shares)
      expect(await lido.getTotalShares()).to.be.equal(
        totalSharesBefore + sharesMintedAsFees,
        "Total shares increased exactly by minted fees",
      );
    });

    it("BadDebtToInternalize lags to next refSlot", async () => {
      const { vaultHub, lido, hashConsensus } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      const currentRefSlot = (await hashConsensus.getCurrentFrame()).refSlot;

      // Internalize bad debt in current refSlot
      await vaultHub.connect(daoAgent).internalizeBadDebt(stakingVault, badDebtShares);

      // Immediately check badDebtToInternalize - should return 0 because increase applies to next refSlot
      expect(await vaultHub.badDebtToInternalizeForLastRefSlot()).to.be.equal(0n, "Returns 0 for current refSlot");

      // Wait for next refSlot
      await waitNextAvailableReportTime(ctx);

      const newRefSlot = (await hashConsensus.getCurrentFrame()).refSlot;
      expect(newRefSlot).to.be.greaterThan(currentRefSlot, "Advanced to next refSlot");

      // Now badDebtToInternalize should show the internalized amount
      expect(await vaultHub.badDebtToInternalizeForLastRefSlot()).to.be.equal(
        badDebtShares,
        "Returns internalized amount",
      );
    });

    it("Multiple internalizations accumulate", async () => {
      const { vaultHub, lido, stakingVaultFactory } = ctx.contracts;

      // Create a second vault with bad debt
      const [, , , , , otherOwner2] = await ethers.getSigners();
      const { stakingVault: vault2, dashboard: dashboard2 } = await createVaultWithDashboard(
        ctx,
        stakingVaultFactory,
        otherOwner2,
        nodeOperator,
        nodeOperator,
      );

      // Setup bad debt for vault2
      await dashboard2.connect(otherOwner2).fund({ value: ether("10") });
      await dashboard2
        .connect(otherOwner2)
        .mintShares(otherOwner2, await dashboard2.remainingMintingCapacityShares(0n));

      // Bring fresh reports for both vaults
      await reportVaultsDataWithProof(ctx, [stakingVault, vault2], {
        totalValue: [ether("1"), ether("1")],
        slashingReserve: [ether("1"), ether("1")],
        waitForNextRefSlot: true,
      });

      const badDebtShares1 =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));
      const badDebtShares2 =
        (await dashboard2.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard2.totalValue()));

      const amountA = badDebtShares1 / 2n;
      const amountB = badDebtShares2 / 3n;

      // Internalize from both vaults
      await vaultHub.connect(daoAgent).internalizeBadDebt(stakingVault, amountA);
      await vaultHub.connect(daoAgent).internalizeBadDebt(vault2, amountB);

      // Wait for next refSlot
      await waitNextAvailableReportTime(ctx);

      // Check accumulated amount
      expect(await vaultHub.badDebtToInternalize()).to.be.equal(amountA + amountB, "Amounts accumulated");

      const { reportTx } = await report(ctx, { waitNextReportTime: false });
      await expect(reportTx)
        .to.emit(lido, "ExternalBadDebtInternalized")
        .withArgs(amountA + amountB)
        .to.emit(lido, "ExternalSharesBurnt")
        .withArgs(amountA + amountB);

      expect(await vaultHub.badDebtToInternalize()).to.be.equal(0n);
    });

    it("Internalization requires fresh report", async () => {
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      // Advance time to make report stale
      await advanceChainTime(await vaultHub.REPORT_FRESHNESS_DELTA());

      // Try to internalize with stale report - should fail
      await expect(vaultHub.connect(daoAgent).internalizeBadDebt(stakingVault, badDebtShares))
        .to.be.revertedWithCustomError(vaultHub, "VaultReportStale")
        .withArgs(stakingVault);
    });

    it("Internalization is reflected in the next report(both simulation and real report)", async () => {
      const { vaultHub, lido, hashConsensus } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      await vaultHub.connect(daoAgent).internalizeBadDebt(stakingVault, badDebtShares);

      const { reportProcessingDeadlineSlot: nextRefSlot } = await hashConsensus.getCurrentFrame();
      const { time, nextFrameStart } = await getReportTimeElapsed(ctx);

      await advanceChainTime(nextFrameStart - time); // Advance to the next frame start exactly
      expect(await getCurrentBlockTimestamp()).to.be.equal(nextFrameStart, "We landed exactly in the refSlotBlock");
      expect(await vaultHub.badDebtToInternalizeForLastRefSlot()).to.be.equal(0, "Bad debt to internalize is still 0");
      expect(await vaultHub.badDebtToInternalize()).to.be.equal(badDebtShares, "Bad debt to internalize is the same");

      // simulate the report at the refSlot (like the Oracle would do)
      const { beaconValidators, beaconBalance } = await lido.getBeaconStat();
      const simulationAtRefSlot = await simulateReport(ctx, {
        refSlot: nextRefSlot,
        beaconValidators,
        clBalance: beaconBalance,
        withdrawalVaultBalance: 0n,
        elRewardsVaultBalance: 0n,
      });

      await advanceChainTime(SECONDS_PER_SLOT);
      expect(await vaultHub.badDebtToInternalize()).to.be.equal(badDebtShares);

      // simulate the report after refSlot (like it happens during the report processing)
      expect(
        await simulateReport(ctx, {
          refSlot: (await hashConsensus.getCurrentFrame()).refSlot,
          beaconValidators,
          clBalance: beaconBalance,
          withdrawalVaultBalance: 0n,
          elRewardsVaultBalance: 0n,
        }),
      ).to.be.deep.equal(simulationAtRefSlot, "Simulation after refSlot should work the same");
    });
  });
});
