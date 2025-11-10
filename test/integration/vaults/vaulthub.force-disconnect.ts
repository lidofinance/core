import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { BigIntMath, days, DISCONNECT_NOT_INITIATED, impersonate } from "lib";
import {
  changeTier,
  createVaultsReportTree,
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
  setUpOperatorGrid,
  waitNextAvailableReportTime,
} from "lib/protocol";
import { getCurrentBlockTimestamp } from "lib/time";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

describe("Integration: VaultHub:force-disconnect", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let agentSigner: HardhatEthersSigner;
  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let vaultMaster: HardhatEthersSigner;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;
  let vaultHub: VaultHub;

  before(async () => {
    originalSnapshot = await Snapshot.take();
    [, owner, nodeOperator, vaultMaster] = await ethers.getSigners();
    ctx = await getProtocolContext();
    agentSigner = await ctx.getSigner("agent");
    await setupLidoForVaults(ctx);
    await setUpOperatorGrid(ctx, [nodeOperator]);

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);
    vaultHub = ctx.contracts.vaultHub;

    await changeTier(ctx, dashboard, owner, nodeOperator);
    await vaultHub.connect(agentSigner).grantRole(await vaultHub.VAULT_MASTER_ROLE(), vaultMaster);

    // loosen sanity checks to bypass fee increase rate limit
    await ctx.contracts.lazyOracle.connect(agentSigner).updateSanityParams(days(30n), 1000n, 1000000000000000000n);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  for (const feePercent of [50n, 100n, 150n]) {
    it(`disconnects when fee is ${feePercent}% of the vault balance`, async () => {
      const vaultBalance = await ethers.provider.getBalance(stakingVault);
      const feesToSettle = (vaultBalance * feePercent) / 100n;

      // Setup: Connected vault with liabilityShares = 0, fresh report
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("1"),
        cumulativeLidoFees: feesToSettle, // Assign unsettled fees to the vault
      });

      // Verify initial state
      expect(await vaultHub.liabilityShares(stakingVault)).to.equal(0n);
      expect(await vaultHub.isReportFresh(stakingVault)).to.be.true;
      const unsettledFees = await vaultHub.obligations(stakingVault);
      expect(unsettledFees.feesToSettle).to.be.equal(feesToSettle);

      const treasuryBalanceBefore = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());

      // VAULT_MASTER_ROLE calls disconnect(vault)
      const tx = await vaultHub.connect(vaultMaster).disconnect(stakingVault);
      await expect(tx).to.emit(vaultHub, "VaultDisconnectInitiated").withArgs(stakingVault);

      // Verify disconnectInitiatedTs = block.timestamp
      const receipt = await tx.wait();
      const blockTimestamp = (await ethers.provider.getBlock(receipt!.blockNumber))?.timestamp || 0n;
      const connection = await vaultHub.vaultConnection(stakingVault);
      expect(connection.disconnectInitiatedTs).to.equal(BigInt(blockTimestamp));

      // Verify fees are settled to the treasury
      const settleAmount = BigIntMath.min(vaultBalance, feesToSettle);
      const treasuryAfter = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());
      expect(treasuryAfter).to.be.equal(treasuryBalanceBefore + settleAmount);
      expect(await ethers.provider.getBalance(await stakingVault.getAddress())).to.be.equal(
        vaultBalance - settleAmount,
      );

      // Verify vault is pending disconnect
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;

      await expect(
        reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1"), cumulativeLidoFees: feesToSettle }),
      )
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVault);

      // Expected: vault is disconnected
      expect((await ctx.contracts.operatorGrid.vaultTierInfo(stakingVault)).tierId).to.be.equal(0n);
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.false;
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;
      expect(await vaultHub.locked(stakingVault)).to.be.equal(0n);
    });
  }

  it("aborts disconnect when slashing reserve is reported", async () => {
    // Refresh report
    await reportVaultDataWithProof(ctx, stakingVault, {
      totalValue: ether("1"),
      liabilityShares: 0n,
    });

    // Initiate disconnect
    await vaultHub.connect(vaultMaster).disconnect(stakingVault);
    expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
    const connectionBefore = await vaultHub.vaultConnection(stakingVault);
    const disconnectTs = connectionBefore.disconnectInitiatedTs;
    expect(disconnectTs).to.be.greaterThan(0n);

    // Action: Oracle reports with slashing reserve
    const slashingReserve = ether("0.5");
    const tx = await reportVaultDataWithProof(ctx, stakingVault, {
      totalValue: ether("1"),
      liabilityShares: 0n,
      slashingReserve,
    });

    // Expected: Disconnect aborted
    await expect(tx).to.emit(vaultHub, "VaultDisconnectAborted").withArgs(stakingVault, slashingReserve);

    // Verify disconnect was cancelled
    const connectionAfter = await vaultHub.vaultConnection(stakingVault);
    expect(connectionAfter.disconnectInitiatedTs).to.equal(DISCONNECT_NOT_INITIATED);
    expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.false;

    // Verify vault remains connected
    expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
    expect((await ctx.contracts.operatorGrid.vaultTierInfo(stakingVault)).tierId).to.be.greaterThan(0n);
  });

  it("aborts disconnect when bad debt is socialized to the vault", async () => {
    const acceptingVault = stakingVault;

    const vault = await createVaultWithDashboard(ctx, ctx.contracts.stakingVaultFactory, owner, nodeOperator);
    const badDebtVault = vault.stakingVault;
    const badDebtDashboard = vault.dashboard.connect(owner);
    await changeTier(ctx, badDebtDashboard, owner, nodeOperator);

    // Grant BAD_DEBT_MASTER_ROLE
    await vaultHub.connect(agentSigner).grantRole(await vaultHub.BAD_DEBT_MASTER_ROLE(), agentSigner);

    // Create bad debt
    await badDebtDashboard.fund({ value: ether("10") });
    await reportVaultDataWithProof(ctx, badDebtVault, {
      totalValue: ether("11"),
      liabilityShares: 0n,
    });
    await badDebtDashboard.mintStETH(owner, ether("5"));
    await reportVaultDataWithProof(ctx, badDebtVault, {
      totalValue: ether("1"), // Slashed from 11 to 1
      slashingReserve: ether("10"),
      waitForNextRefSlot: true,
    });

    // Verify bad debt
    const badDebtVaultLiabilityShares = await vaultHub.liabilityShares(badDebtVault);
    const badDebtVaultTotalValue = await vaultHub.totalValue(badDebtVault);
    const badDebtVaultLiabilityValue =
      await ctx.contracts.lido.getPooledEthBySharesRoundUp(badDebtVaultLiabilityShares);
    expect(badDebtVaultLiabilityValue).to.be.greaterThan(badDebtVaultTotalValue);

    // Fund accepting vault to have capacity to accept bad debt
    await dashboard.fund({ value: ether("10") });

    // Report both vaults together in the same Merkle tree
    const { lazyOracle, hashConsensus, locator } = ctx.contracts;

    await waitNextAvailableReportTime(ctx);

    const [acceptingVaultRecord, badDebtVaultRecord] = await Promise.all([
      vaultHub.vaultRecord(acceptingVault),
      vaultHub.vaultRecord(badDebtVault),
    ]);

    const acceptingVaultReport = {
      vault: await acceptingVault.getAddress(),
      totalValue: ether("11"),
      cumulativeLidoFees: 0n,
      liabilityShares: 0n,
      maxLiabilityShares: acceptingVaultRecord.maxLiabilityShares,
      slashingReserve: 0n,
    };

    const badDebtVaultReport = {
      vault: await badDebtVault.getAddress(),
      totalValue: ether("1"),
      cumulativeLidoFees: badDebtVaultRecord.cumulativeLidoFees,
      liabilityShares: badDebtVaultRecord.liabilityShares,
      maxLiabilityShares: badDebtVaultRecord.maxLiabilityShares,
      slashingReserve: ether("10"),
    };

    const reportTree = createVaultsReportTree([acceptingVaultReport, badDebtVaultReport]);
    const reportTimestamp = await getCurrentBlockTimestamp();
    const reportRefSlot = (await hashConsensus.getCurrentFrame()).refSlot;

    const accountingSigner = await impersonate(await locator.accountingOracle(), ether("100"));
    await lazyOracle.connect(accountingSigner).updateReportData(reportTimestamp, reportRefSlot, reportTree.root, "");

    // Report Accepting Vault
    await lazyOracle.updateVaultData(
      acceptingVaultReport.vault,
      acceptingVaultReport.totalValue,
      acceptingVaultReport.cumulativeLidoFees,
      acceptingVaultReport.liabilityShares,
      acceptingVaultReport.maxLiabilityShares,
      acceptingVaultReport.slashingReserve,
      reportTree.getProof(0),
    );

    // Report Bad Debt Vault
    await lazyOracle.updateVaultData(
      badDebtVaultReport.vault,
      badDebtVaultReport.totalValue,
      badDebtVaultReport.cumulativeLidoFees,
      badDebtVaultReport.liabilityShares,
      badDebtVaultReport.maxLiabilityShares,
      badDebtVaultReport.slashingReserve,
      reportTree.getProof(1),
    );

    // Initiate disconnect on accepting vault
    await vaultHub.connect(vaultMaster).disconnect(acceptingVault);

    // Calculate and socialize bad debt
    const badDebtShares =
      badDebtVaultLiabilityShares - (await ctx.contracts.lido.getSharesByPooledEth(badDebtVaultTotalValue));
    await vaultHub.connect(agentSigner).socializeBadDebt(badDebtVault, acceptingVault, badDebtShares);

    // Verify accepting vault now has liability
    const tx = await reportVaultDataWithProof(ctx, acceptingVault, {
      totalValue: ether("11"),
      waitForNextRefSlot: true,
      liabilityShares: badDebtShares,
    });
    expect(await vaultHub.liabilityShares(acceptingVault)).to.be.equal(badDebtShares);

    // Verify disconnect aborted
    await expect(tx).to.emit(vaultHub, "VaultDisconnectAborted");
    expect(await vaultHub.isPendingDisconnect(acceptingVault)).to.be.false;
    const connection = await vaultHub.vaultConnection(acceptingVault);
    expect(connection.disconnectInitiatedTs).to.equal(DISCONNECT_NOT_INITIATED);
    expect(await vaultHub.isVaultConnected(acceptingVault)).to.be.true;
  });

  it("prevents minting after disconnect is initiated", async () => {
    // Setup: Fund vault and initiate disconnect
    await dashboard.fund({ value: ether("10") });
    await reportVaultDataWithProof(ctx, stakingVault, {
      totalValue: ether("11"),
    });
    await vaultHub.connect(vaultMaster).disconnect(stakingVault);
    expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
    await expect(dashboard.mintStETH(owner, ether("1"))).to.be.revertedWithCustomError(
      vaultHub,
      "VaultIsDisconnecting",
    );
  });

  it("settles all fees when doing voluntary disconnect", async () => {
    // Setup: Create unsettled fees
    const unsettledFees = ether("0.5");
    await reportVaultDataWithProof(ctx, stakingVault, {
      totalValue: ether("1"),
      cumulativeLidoFees: unsettledFees,
    });

    // Ensure vault has enough balance to settle fees
    await dashboard.fund({ value: ether("1") });

    const vaultBalance = await ethers.provider.getBalance(stakingVault);
    expect(vaultBalance).to.be.greaterThanOrEqual(unsettledFees);

    const treasuryBalanceBefore = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());

    // Action: Voluntary disconnect
    const tx = await dashboard.voluntaryDisconnect();
    await expect(tx).to.emit(vaultHub, "VaultDisconnectInitiated").withArgs(stakingVault);

    // Expected: All fees settled
    const treasuryBalanceAfter = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());
    expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(unsettledFees);

    // Verify no unsettled fees remain
    const obligations = await vaultHub.obligations(stakingVault);
    expect(obligations.feesToSettle).to.equal(0n);

    // Verify disconnect was initiated
    expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;

    // Disconnect with report
    const reportTx = await reportVaultDataWithProof(ctx, stakingVault, { cumulativeLidoFees: unsettledFees });
    await expect(reportTx).to.emit(vaultHub, "VaultDisconnectCompleted").withArgs(stakingVault);
    expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.false;
    expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;
    expect(await vaultHub.locked(stakingVault)).to.be.equal(0n);
    expect((await ctx.contracts.operatorGrid.vaultTierInfo(stakingVault)).tierId).to.be.equal(0n);
  });

  it("reverts voluntary disconnect when fees cannot be fully settled", async () => {
    // Report fees that exceed the remaining balance
    // Vault now has only 1 ETH (CONNECT_DEPOSIT) but needs 1.5 ETH for fees
    await reportVaultDataWithProof(ctx, stakingVault, {
      totalValue: ether("1"),
      cumulativeLidoFees: ether("1.5"),
      waitForNextRefSlot: true,
    });

    // Verify: balance (1 ETH) < unsettled fees (1.5 ETH)
    const availableBalance = await stakingVault.availableBalance();
    const unsettledFees = ether("1.5");
    expect(availableBalance).to.be.lessThan(unsettledFees);

    // Action: Attempt voluntary disconnect
    // Expected: Should revert because fees cannot be fully settled
    await expect(dashboard.voluntaryDisconnect()).to.be.revertedWithCustomError(
      vaultHub,
      "NoUnsettledLidoFeesShouldBeLeft",
    );
  });
});
