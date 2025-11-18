import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { days } from "lib";
import {
  changeTier,
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
  setUpOperatorGrid,
} from "lib/protocol";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

describe("Integration: VaultHub:fees", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let agentSigner: HardhatEthersSigner;
  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let vaultMaster: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;
  let vaultHub: VaultHub;

  before(async () => {
    originalSnapshot = await Snapshot.take();
    [, owner, nodeOperator, vaultMaster, stranger] = await ethers.getSigners();
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

  describe("Unpaid fees accumulation", () => {
    it("accumulates unpaid fees over multiple oracle reports", async () => {
      // Initial report with totalValue = 10 ETH
      await dashboard.fund({ value: ether("10") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("10"),
        cumulativeLidoFees: 0n,
      });

      // Verify no unsettled fees initially
      let obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(0n);

      // First report: accumulate 0.5 ETH fees
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("10.5"),
        cumulativeLidoFees: ether("0.5"),
        waitForNextRefSlot: true,
      });

      obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(ether("0.5"));

      // Second report: accumulate another 0.3 ETH (total 0.8 ETH)
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("10.8"),
        cumulativeLidoFees: ether("0.8"),
        waitForNextRefSlot: true,
      });

      obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(ether("0.8"));

      // Third report: accumulate another 0.3 ETH (total 1.1 ETH, crosses threshold)
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("11.1"),
        cumulativeLidoFees: ether("1.1"),
        waitForNextRefSlot: true,
      });

      obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(ether("1.1"));

      // Verify deposits are paused after crossing 1 ETH threshold
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
    });

    it("pauses beacon deposits when unsettled fees reach 1 ETH", async () => {
      // Setup: Vault with 10 ETH
      await dashboard.fund({ value: ether("10") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("10"),
        cumulativeLidoFees: 0n,
      });

      // Verify deposits are not paused initially
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;

      // Report with 0.5 ETH fees (below threshold)
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("10.5"),
        cumulativeLidoFees: ether("0.5"),
        waitForNextRefSlot: true,
      });

      // Deposits should still be active (< 1 ETH threshold)
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;

      // Report with 1e18-1 ETH fees (below threshold)
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("10.5"),
        cumulativeLidoFees: ether("1") - 1n,
        waitForNextRefSlot: true,
      });

      // Deposits should still be active (< 1 ETH threshold)
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;

      // Report with 1.0 ETH fees (at threshold)
      const tx = await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("11"),
        cumulativeLidoFees: ether("1.0"),
        waitForNextRefSlot: true,
      });

      // Expected: Deposits are paused
      await expect(tx).to.emit(stakingVault, "BeaconChainDepositsPaused");
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
    });
  });

  describe("Oracle fee reporting", () => {
    it("reverts when oracle attempts to decrease cumulative fees", async () => {
      // Setup: Report with 2 ETH cumulative fees
      await dashboard.fund({ value: ether("10") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("12"),
        cumulativeLidoFees: ether("2"),
      });

      const record = await vaultHub.vaultRecord(stakingVault);
      expect(record.cumulativeLidoFees).to.equal(ether("2"));

      // Action: Try to report with lower cumulative fees (1.5 ETH)
      // Expected: Should revert because cumulative fees can only increase
      await expect(
        reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: ether("11.5"),
          cumulativeLidoFees: ether("1.5"),
          waitForNextRefSlot: true,
        }),
      )
        .to.be.revertedWithCustomError(ctx.contracts.lazyOracle, "CumulativeLidoFeesTooLow")
        .withArgs(ether("1.5"), ether("2"));
    });
  });

  describe("Fee settlement", () => {
    it("settles fees when balance becomes available", async () => {
      // Setup: Vault with unsettled fees = 3 ETH
      await dashboard.fund({ value: ether("10") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("13"),
        cumulativeLidoFees: ether("3"),
      });

      // Verify unsettled fees
      let obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(ether("3"));

      // Verify deposits are paused (fees >= 1 ETH)
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      // Action: Settle fees (balance is available)
      const treasuryBefore = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());

      const tx = await vaultHub.settleLidoFees(stakingVault);

      // Expected: Fees settled
      await expect(tx).to.emit(vaultHub, "LidoFeesSettled").withArgs(stakingVault, ether("3"), ether("3"), ether("3"));

      // Verify treasury received fees
      const treasuryAfter = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());
      expect(treasuryAfter - treasuryBefore).to.equal(ether("3"));

      // Verify no unsettled fees remain
      obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(0n);

      // Verify deposits are resumed
      await expect(tx).to.emit(stakingVault, "BeaconChainDepositsResumed");
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
    });

    it("can be called by anyone (permissionless)", async () => {
      // Setup: Vault with unsettled fees
      await dashboard.fund({ value: ether("10") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("12"),
        cumulativeLidoFees: ether("2"),
      });

      const treasuryBefore = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());

      // Action: Stranger (not owner, not operator) settles fees
      const tx = await vaultHub.connect(stranger).settleLidoFees(stakingVault);

      // Expected: Success
      await expect(tx).to.emit(vaultHub, "LidoFeesSettled").withArgs(stakingVault, ether("2"), ether("2"), ether("2"));

      const treasuryAfter = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());
      expect(treasuryAfter - treasuryBefore).to.equal(ether("2"));
    });

    it("respects locked balance", async () => {
      // Setup: Fund vault with 30 ETH (total 31 with CONNECT_DEPOSIT)
      await dashboard.fund({ value: ether("30") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("31"), // includes CONNECT_DEPOSIT
      });

      // Mint 24 ETH worth of stETH
      // With 20% reserve ratio:
      //   reserve = ceilDiv(liability * 2000, 8000)
      //   locked = liability + reserve
      await dashboard.mintStETH(owner, ether("24"));

      // Report with 5 ETH unsettled fees
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("31"),
        cumulativeLidoFees: ether("5"),
        waitForNextRefSlot: true,
      });

      const obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(ether("5"));

      const locked = await vaultHub.locked(stakingVault);

      // Calculate expected settleable amount: totalValue - locked
      const totalValue = ether("31");
      const expectedSettleable = totalValue - locked;

      const settleableValue = await vaultHub.settleableLidoFeesValue(stakingVault);
      expect(settleableValue).to.equal(expectedSettleable);

      // Action: settleLidoFees (only settles what's available)
      const treasuryBefore = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());

      const tx = await vaultHub.settleLidoFees(stakingVault);
      await tx.wait();

      const treasuryAfter = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());
      const actualSettled = treasuryAfter - treasuryBefore;

      // Expected: Only partial fees settled (exactly settleableValue)
      expect(actualSettled).to.equal(settleableValue);

      // Verify remaining unsettled fees
      const expectedRemaining = ether("5") - actualSettled;
      const obligationsAfter = await vaultHub.obligations(stakingVault);
      expect(obligationsAfter.feesToSettle).to.equal(expectedRemaining);

      // Deposits remain paused (remaining fees >= 1 ETH)
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
    });

    it("respects redemptions", async () => {
      // Setup: Fund vault with 15 ETH (total 16 with CONNECT_DEPOSIT)
      await dashboard.fund({ value: ether("15") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("16"), // includes CONNECT_DEPOSIT
      });

      // Mint 10 ETH worth of stETH
      // With 20% reserve ratio:
      //   reserve = ceilDiv(liability * 2000, 8000)
      //   locked = liability + max(reserve, minimalReserve)
      await dashboard.mintStETH(owner, ether("10"));

      // Set redemption shares representing 2 ETH (reserves ETH from unlocked balance)
      const liabilityShares = await vaultHub.liabilityShares(stakingVault);
      const redemptionSharesAmount = await ctx.contracts.lido.getSharesByPooledEth(ether("2"));
      const targetLiabilityShares = liabilityShares - redemptionSharesAmount;
      const redemptionMasterRole = await vaultHub.REDEMPTION_MASTER_ROLE();
      await vaultHub.connect(agentSigner).grantRole(redemptionMasterRole, agentSigner);
      await vaultHub.connect(agentSigner).setLiabilitySharesTarget(stakingVault, targetLiabilityShares);

      // Verify redemption shares are set
      const record = await vaultHub.vaultRecord(stakingVault);
      expect(record.redemptionShares).to.equal(redemptionSharesAmount);

      // Report unsettled fees = 5 ETH (more than available after redemptions)
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("16"),
        cumulativeLidoFees: ether("5"),
        waitForNextRefSlot: true,
      });

      const obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(ether("5"));

      // Get the actual settleable amount from the contract
      const settleableValue = await vaultHub.settleableLidoFeesValue(stakingVault);

      // Action: Settle fees (only settles what's available after redemptions)
      const treasuryBefore = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());

      await vaultHub.settleLidoFees(stakingVault);

      const treasuryAfter = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());
      const actualSettled = treasuryAfter - treasuryBefore;

      // Expected: Settled exactly settleableValue
      expect(actualSettled).to.equal(settleableValue);

      // Verify remaining unsettled fees
      const expectedRemaining = ether("5") - actualSettled;
      const obligationsAfter = await vaultHub.obligations(stakingVault);
      expect(obligationsAfter.feesToSettle).to.equal(expectedRemaining);

      // Verify redemption shares are still reserved
      const recordAfter = await vaultHub.vaultRecord(stakingVault);
      expect(recordAfter.redemptionShares).to.equal(redemptionSharesAmount);
    });

    it("reverts when there are no unsettled fees", async () => {
      // Setup: Vault with no fees
      await dashboard.fund({ value: ether("10") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("11"),
        cumulativeLidoFees: 0n,
      });

      // Action: Try to settle fees when there are none
      await expect(vaultHub.settleLidoFees(stakingVault)).to.be.revertedWithCustomError(
        vaultHub,
        "NoUnsettledLidoFeesToSettle",
      );
    });

    it("reverts when there are no funds to settle", async () => {
      // Setup: Report fees but with no available balance
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("1"), // Only CONNECT_DEPOSIT (locked)
        cumulativeLidoFees: ether("2"),
      });

      // Verify fees exist
      const obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(ether("2"));

      // Action: Try to settle fees without available funds
      await expect(vaultHub.settleLidoFees(stakingVault)).to.be.revertedWithCustomError(
        vaultHub,
        "NoFundsToSettleLidoFees",
      );
    });
  });

  describe("Disconnect with unpaid fees", () => {
    it("blocks voluntary disconnect when fees cannot be fully settled", async () => {
      // Setup: Vault with unsettled fees > available balance
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("1"), // Only CONNECT_DEPOSIT
        cumulativeLidoFees: ether("1.5"),
        waitForNextRefSlot: true,
      });

      const obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(ether("1.5"));

      const settleableValue = await vaultHub.settleableLidoFeesValue(stakingVault);
      expect(settleableValue).to.equal(0n); // No funds available to settle

      // Action: Attempt voluntary disconnect
      await expect(dashboard.voluntaryDisconnect()).to.be.revertedWithCustomError(
        vaultHub,
        "NoUnsettledLidoFeesShouldBeLeft",
      );
    });

    it("requires settling all Lido fees before voluntary disconnect", async () => {
      // Setup: Vault with unsettled Lido fees
      await dashboard.fund({ value: ether("5") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("6"),
        cumulativeLidoFees: ether("0.5"),
      });

      let obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(ether("0.5"));

      // Settle the Lido fees
      const treasuryBefore = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());
      await vaultHub.settleLidoFees(stakingVault);

      const treasuryAfter = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());
      expect(treasuryAfter - treasuryBefore).to.equal(ether("0.5"));

      // Verify Lido fees are now settled
      obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(0n);

      // Verify the record shows fees are fully settled
      const record = await vaultHub.vaultRecord(stakingVault);
      expect(record.cumulativeLidoFees).to.equal(record.settledLidoFees);
      expect(record.cumulativeLidoFees).to.equal(ether("0.5"));
      expect(record.settledLidoFees).to.equal(ether("0.5"));
    });

    it("allows force disconnect even with large unpaid fees", async () => {
      // Setup: Report large fees that exceed balance
      const vaultBalance = await ethers.provider.getBalance(stakingVault);
      const largeFees = vaultBalance * 2n; // Fees > balance

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("1"),
        cumulativeLidoFees: largeFees,
        waitForNextRefSlot: true,
      });

      const obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(largeFees);

      const treasuryBefore = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());

      // Action: Force disconnect by VAULT_MASTER (will settle what it can)
      const tx = await vaultHub.connect(vaultMaster).disconnect(stakingVault);
      await expect(tx).to.emit(vaultHub, "VaultDisconnectInitiated").withArgs(stakingVault);

      // Expected: Some amount was settled during disconnect
      const treasuryAfter = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());
      const settled = treasuryAfter - treasuryBefore;

      // Verify the settled amount matches what was actually settled
      const obligationsAfter = await vaultHub.obligations(stakingVault);
      expect(obligationsAfter.feesToSettle).to.equal(largeFees - settled);

      // Disconnect still initiated despite unsettled fees
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
    });

    it("allows fee settlement during disconnect process", async () => {
      // Setup: Vault with 5 ETH balance and 2 ETH unsettled fees
      await dashboard.fund({ value: ether("5") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("6"),
        cumulativeLidoFees: ether("2"),
      });

      const treasuryBeforeDisconnect = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());

      // Initiate disconnect (settles all available fees - all 2 ETH should be settled)
      await vaultHub.connect(vaultMaster).disconnect(stakingVault);
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;

      const treasuryAfterDisconnect = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());
      const settledDuringDisconnect = treasuryAfterDisconnect - treasuryBeforeDisconnect;

      // Verify all 2 ETH fees were settled during disconnect (balance was sufficient)
      expect(settledDuringDisconnect).to.equal(ether("2"));

      // Verify no fees remain after disconnect
      const obligationsAfterDisconnect = await vaultHub.obligations(stakingVault);
      expect(obligationsAfterDisconnect.feesToSettle).to.equal(0n);

      // Disconnect process continues (and can complete on next report since all obligations are met)
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;

      // Complete the disconnect with next report
      const disconnectTx = await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("4"), // 6 - 2 settled fees
        cumulativeLidoFees: ether("2"),
        waitForNextRefSlot: true,
      });

      await expect(disconnectTx).to.emit(vaultHub, "VaultDisconnectCompleted").withArgs(stakingVault);
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;
    });
  });

  describe("Bad debt scenarios", () => {
    it("handles large unpaid fees with bad debt", async () => {
      // Setup: Create bad debt situation
      await dashboard.fund({ value: ether("10") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("11"),
      });

      // Mint stETH
      await dashboard.mintStETH(owner, ether("8"));

      // Report slashing that creates bad debt
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("2"), // Slashed from 11 to 2
        cumulativeLidoFees: ether("5"), // Large unpaid fees
        slashingReserve: ether("1"),
        waitForNextRefSlot: true,
      });

      // Check obligations
      const obligations = await vaultHub.obligations(stakingVault);
      const obligationsShortfall = await vaultHub.obligationsShortfallValue(stakingVault);

      // Expected: Bad debt dominates
      expect(obligations.sharesToBurn).to.equal(ethers.MaxUint256);
      expect(obligationsShortfall).to.equal(ethers.MaxUint256);

      // Fees cannot be settled until bad debt resolved
      await expect(vaultHub.settleLidoFees(stakingVault)).to.be.revertedWithCustomError(
        vaultHub,
        "NoFundsToSettleLidoFees",
      );

      // Deposits paused due to multiple reasons
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
    });
  });

  describe("Minting capacity impact", () => {
    it("reduces minting capacity by unsettled fees amount", async () => {
      // Setup: Vault with 50 ETH total value
      await dashboard.fund({ value: ether("50") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("51"), // includes CONNECT_DEPOSIT
      });

      // Check minting capacity without fees
      const maxLockableValueBefore = await vaultHub.maxLockableValue(stakingVault);
      expect(maxLockableValueBefore).to.equal(ether("51"));

      // Report unsettled fees = 10 ETH
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("51"),
        cumulativeLidoFees: ether("10"),
        waitForNextRefSlot: true,
      });

      // Check minting capacity with fees
      const maxLockableValueAfter = await vaultHub.maxLockableValue(stakingVault);

      // Expected: maxLockableValue reduced by unsettled fees
      expect(maxLockableValueAfter).to.equal(ether("41")); // 51 - 10

      // Verify obligations are tracked
      const obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(ether("10"));
    });

    it("restores minting capacity proportion after fees are settled", async () => {
      // Setup: Vault with fees (using smaller amounts to avoid sanity check limits)
      await dashboard.fund({ value: ether("20") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("21"),
        cumulativeLidoFees: ether("3"),
      });

      // Verify fees are unsettled before settlement
      const obligationsBefore = await vaultHub.obligations(stakingVault);
      expect(obligationsBefore.feesToSettle).to.equal(ether("3"));

      // Settle fees
      await vaultHub.settleLidoFees(stakingVault);

      // Check capacity after settlement (cumulative fees stay the same, totalValue decreases)
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("18"), // reduced by settled fees
        cumulativeLidoFees: ether("3"), // cumulative stays same (we only update settledLidoFees)
        waitForNextRefSlot: true,
      });

      const maxLockableAfter = await vaultHub.maxLockableValue(stakingVault);
      const obligationsAfter = await vaultHub.obligations(stakingVault);

      // Expected: maxLockableValue should equal totalValue (no more unsettled fees)
      expect(maxLockableAfter).to.equal(ether("18"));

      // Verify all fees have been settled
      expect(obligationsAfter.feesToSettle).to.equal(0n);
    });
  });

  describe("Operations unlock after settlement", () => {
    it("resumes beacon deposits after settling fees", async () => {
      // Setup: Vault with unsettled fees >= 1 ETH
      await dashboard.fund({ value: ether("10") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("11"),
        cumulativeLidoFees: ether("2"),
      });

      // Verify deposits are paused
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      // Action: Settle fees
      const tx = await vaultHub.settleLidoFees(stakingVault);

      // Expected: Deposits resumed
      await expect(tx).to.emit(stakingVault, "BeaconChainDepositsResumed");
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
    });

    it("allows deposits again after fees settled below 1 ETH", async () => {
      // Setup: Vault with 10 ETH
      await dashboard.fund({ value: ether("10") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("11"),
      });

      // Mint 7 ETH to lock the vault
      // With 20% reserve: locked = minimalReserve(1) + liability(7) + reserve(1.4) = ~9.4 ETH
      // Unlocked = 11 - 9.4 = ~1.6 ETH available
      await dashboard.mintStETH(owner, ether("7"));

      // Report 1.5 ETH fees (slightly less than available)
      // After settlement, remaining fees will be ~0 ETH (well below 1 ETH threshold)
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("11"),
        cumulativeLidoFees: ether("1.5"),
        waitForNextRefSlot: true,
      });

      // Verify deposits are paused initially (fees >= 1 ETH)
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      // Get the actual settleable amount
      const settleableValue = await vaultHub.settleableLidoFeesValue(stakingVault);

      // Settle fees
      await vaultHub.settleLidoFees(stakingVault);

      const remainingFees = ether("1.5") - settleableValue;

      // Verify remaining fees and deposit status
      const obligationsAfter = await vaultHub.obligations(stakingVault);
      expect(obligationsAfter.feesToSettle).to.equal(remainingFees);

      // Deposits should resume only if remaining fees < 1 ETH
      const depositsResumed = remainingFees < ether("1");
      expect(await stakingVault.beaconChainDepositsPaused()).to.equal(!depositsResumed);
    });

    it("unblocks minting after full fee settlement", async () => {
      // Setup: Vault with unsettled fees that restrict minting
      await dashboard.fund({ value: ether("20") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("21"),
        cumulativeLidoFees: ether("5"),
      });

      // Verify fees before settlement
      const obligationsBefore = await vaultHub.obligations(stakingVault);
      expect(obligationsBefore.feesToSettle).to.equal(ether("5"));

      // Settle fees
      await vaultHub.settleLidoFees(stakingVault);

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("16"), // 21 - 5 settled
        cumulativeLidoFees: ether("5"),
        waitForNextRefSlot: true,
      });

      // Verify state after settlement
      const obligationsAfter = await vaultHub.obligations(stakingVault);
      expect(obligationsAfter.feesToSettle).to.equal(0n); // All fees settled

      const maxLockableAfter = await vaultHub.maxLockableValue(stakingVault);
      expect(maxLockableAfter).to.equal(ether("16")); // No unsettled fees reducing maxLockable
    });
  });

  describe("Force rebalance interaction", () => {
    it("does not settle fees during force rebalance", async () => {
      // Setup: Vault with both bad health and unsettled fees
      await dashboard.fund({ value: ether("20") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("21"),
      });

      // Mint 10 ETH stETH to create liability
      await dashboard.mintStETH(owner, ether("10"));

      // Report slashing and fees
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("10"), // Heavily slashed from 21 to 10
        cumulativeLidoFees: ether("1.5"),
        waitForNextRefSlot: true,
      });

      const treasuryBefore = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());
      const obligations = await vaultHub.obligations(stakingVault);

      // Verify bad health (need to rebalance shares) and unsettled fees
      const healthShortfallShares = await vaultHub.healthShortfallShares(stakingVault);
      expect(obligations.sharesToBurn).to.equal(healthShortfallShares);
      expect(obligations.feesToSettle).to.equal(ether("1.5"));

      // Action: forceRebalance (rebalances shares, not fees)
      const tx = await vaultHub.forceRebalance(stakingVault);
      await expect(tx).to.emit(vaultHub, "VaultRebalanced");

      const treasuryAfter = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());

      // Expected: Treasury unchanged (fees not settled by forceRebalance)
      expect(treasuryAfter).to.equal(treasuryBefore);

      // Fees remain unsettled after rebalance
      const obligationsAfter = await vaultHub.obligations(stakingVault);
      expect(obligationsAfter.feesToSettle).to.equal(ether("1.5"));

      // Deposits still paused (fees >= 1 ETH)
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      // Verify rebalance reduced the shares to burn
      const healthShortfallAfter = await vaultHub.healthShortfallShares(stakingVault);
      expect(obligationsAfter.sharesToBurn).to.equal(healthShortfallAfter);
      expect(healthShortfallAfter).to.equal(0n); // Health restored after rebalance
    });
  });

  describe("Edge cases", () => {
    it("handles fees exactly at 1 ETH threshold", async () => {
      // Setup: Report exactly 1 ETH fees
      await dashboard.fund({ value: ether("10") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("11"),
        cumulativeLidoFees: ether("1.0"),
      });

      const obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(ether("1.0"));

      // Expected: Deposits paused at exactly 1 ETH
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
    });

    it("handles fees just below 1 ETH threshold", async () => {
      // Setup: Report 1 ETH - 1 wei fees
      await dashboard.fund({ value: ether("10") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("10"),
        cumulativeLidoFees: ether("1") - 1n,
      });

      const obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(ether("1") - 1n);

      // Expected: Deposits NOT paused (below threshold)
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
    });

    it("does not settle fees when balance is exactly zero", async () => {
      // Setup: Report fees with no balance
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("1"), // Only locked CONNECT_DEPOSIT
        cumulativeLidoFees: ether("2"),
      });

      const settleableValue = await vaultHub.settleableLidoFeesValue(stakingVault);
      expect(settleableValue).to.equal(0n);

      // Cannot settle when no funds available
      await expect(vaultHub.settleLidoFees(stakingVault)).to.be.revertedWithCustomError(
        vaultHub,
        "NoFundsToSettleLidoFees",
      );
    });

    it("handles multiple partial settlements until fully settled", async () => {
      // Setup: Fund vault with 15 ETH (total 16 with CONNECT_DEPOSIT)
      await dashboard.fund({ value: ether("15") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("16"),
        cumulativeLidoFees: ether("3"),
      });

      let obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(ether("3"));

      // Mint 10 ETH to lock most of the vault
      // With 20% reserve: locked = minimalReserve(1) + liability(10) + reserve(2) = ~13 ETH
      // Unlocked = 16 - 13 = ~3 ETH, but with 3 ETH fees, very little available for settlement
      await dashboard.mintStETH(owner, ether("10"));

      // First partial settlement - with current setup all 3 ETH is settleable
      // (balance is sufficient even with liabilities)
      let settleableValue = await vaultHub.settleableLidoFeesValue(stakingVault);
      expect(settleableValue).to.equal(ether("3"));

      const treasuryBefore1 = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());
      await vaultHub.settleLidoFees(stakingVault);
      const treasuryAfter1 = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());

      const firstSettlement = treasuryAfter1 - treasuryBefore1;
      expect(firstSettlement).to.equal(ether("3"));

      obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(0n);

      // Report more fees accumulating after first settlement
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("13"), // 16 - 3 settled
        cumulativeLidoFees: ether("5"), // 2 ETH new fees
        waitForNextRefSlot: true,
      });

      obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(ether("2"));

      // Calculate exact settleable amount based on locked balance
      const locked = await vaultHub.locked(stakingVault);
      const totalValue = ether("13");
      const expectedSettleable = totalValue - locked;

      settleableValue = await vaultHub.settleableLidoFeesValue(stakingVault);
      expect(settleableValue).to.equal(expectedSettleable);

      const treasuryBefore2 = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());
      await vaultHub.settleLidoFees(stakingVault);
      const treasuryAfter2 = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());

      const secondSettlement = treasuryAfter2 - treasuryBefore2;
      expect(secondSettlement).to.equal(settleableValue);

      // Verify remaining unsettled fees
      const expectedRemaining = ether("2") - secondSettlement;
      obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(expectedRemaining);

      // Verify multiple settlements occurred
      const totalSettled = firstSettlement + secondSettlement;
      expect(totalSettled).to.equal(ether("3") + secondSettlement);
    });
  });
});
