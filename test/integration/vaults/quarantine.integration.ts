import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, LazyOracle, StakingVault, VaultHub } from "typechain-types";

import { advanceChainTime, ether } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
  waitNextAvailableReportTime,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: Quarantine", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let dashboard: Dashboard;
  let stakingVault: StakingVault;
  let vaultHub: VaultHub;
  let lazyOracle: LazyOracle;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  // Constants
  const INITIAL_VAULT_VALUE = ether("1");
  const LARGE_UNSAFE_VALUE = ether("1000");

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    ({ vaultHub, lazyOracle } = ctx.contracts);

    [owner, nodeOperator, stranger] = await ethers.getSigners();

    // Owner can create a vault with an operator as a node operator
    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  async function expectQuarantineActive(expectedAmount: bigint, startTimestamp: bigint, remainder = 0n) {
    const quarantine = await lazyOracle.vaultQuarantine(stakingVault);
    const quarantinePeriod = await lazyOracle.quarantinePeriod();
    expect(quarantine.isActive).to.equal(true);
    expect(quarantine.pendingTotalValueIncrease).to.equal(expectedAmount);
    expect(quarantine.startTimestamp).to.equal(startTimestamp);
    expect(quarantine.endTimestamp).to.equal(startTimestamp + quarantinePeriod);
    expect(quarantine.totalValueRemainder).to.equal(remainder);
    expect(await lazyOracle.quarantineValue(stakingVault)).to.equal(expectedAmount + remainder);
  }

  async function expectQuarantineCleared() {
    const quarantine = await lazyOracle.vaultQuarantine(stakingVault);
    expect(quarantine.isActive).to.equal(false);
    expect(quarantine.pendingTotalValueIncrease).to.equal(0);
    expect(quarantine.startTimestamp).to.equal(0);
    expect(quarantine.totalValueRemainder).to.equal(0n);
    expect(await lazyOracle.quarantineValue(stakingVault)).to.equal(0n);
  }

  async function reportTotalValue(reportedTotalValue: bigint, waitForNextRefSlot = false): Promise<bigint> {
    await reportVaultDataWithProof(ctx, stakingVault, { totalValue: reportedTotalValue, waitForNextRefSlot });
    expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
    const [timestamp] = await lazyOracle.latestReportData();
    return timestamp;
  }

  async function expireQuarantine() {
    const quarantinePeriod = await lazyOracle.quarantinePeriod();
    await advanceChainTime(quarantinePeriod + 60n * 60n);
  }

  beforeEach(async () => {
    expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true, "Report is fresh after setup");
    expect(await vaultHub.isVaultHealthy(stakingVault)).to.equal(true, "Vault is healthy after setup");

    await waitNextAvailableReportTime(ctx);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE);
  });

  it("Should not allow huge CL/EL rewards totalValue increase without quarantine", async () => {
    const reportedValue = INITIAL_VAULT_VALUE + LARGE_UNSAFE_VALUE;
    const startTimestamp = await reportTotalValue(reportedValue);
    // Value remains at initial because the increase is quarantined
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE);
    await expectQuarantineActive(LARGE_UNSAFE_VALUE, startTimestamp);
  });

  it("Quarantine happy path (with rewards)", async () => {
    const reportedValue = INITIAL_VAULT_VALUE + LARGE_UNSAFE_VALUE;
    const rewardsValue = (INITIAL_VAULT_VALUE * (await lazyOracle.maxRewardRatioBP())) / 10000n;

    // Start quarantine
    const startTimestamp = await reportTotalValue(reportedValue);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE);
    await expectQuarantineActive(LARGE_UNSAFE_VALUE, startTimestamp);

    // Middle of quarantine - value still locked
    const quarantinePeriod = await lazyOracle.quarantinePeriod();
    await advanceChainTime(quarantinePeriod / 2n);
    await reportTotalValue(reportedValue + rewardsValue);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE);
    await expectQuarantineActive(LARGE_UNSAFE_VALUE, startTimestamp, rewardsValue);

    // End of quarantine - value released
    await advanceChainTime(quarantinePeriod / 2n + 60n * 60n);
    await reportTotalValue(reportedValue + rewardsValue);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(reportedValue + rewardsValue);
    await expectQuarantineCleared();
  });

  it("Quarantine happy path (with slashing)", async () => {
    const reportedValue = INITIAL_VAULT_VALUE + LARGE_UNSAFE_VALUE;
    const slashingValue = ether("0.1");

    // Start quarantine
    const startTimestamp = await reportTotalValue(reportedValue);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE);
    await expectQuarantineActive(LARGE_UNSAFE_VALUE, startTimestamp);

    // Middle of quarantine - value still locked
    const quarantinePeriod = await lazyOracle.quarantinePeriod();
    await advanceChainTime(quarantinePeriod / 2n);
    await reportTotalValue(reportedValue - slashingValue);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE);
    await expectQuarantineActive(LARGE_UNSAFE_VALUE, startTimestamp);

    // End of quarantine - value released
    await advanceChainTime(quarantinePeriod / 2n + 60n * 60n);
    await reportTotalValue(reportedValue - slashingValue);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(reportedValue - slashingValue);
    await expectQuarantineCleared();
  });

  it("Funding in quarantine period - before expiration", async () => {
    const reportedValue = INITIAL_VAULT_VALUE + LARGE_UNSAFE_VALUE;
    const depositAmount = INITIAL_VAULT_VALUE;

    // Start quarantine
    const startTimestamp = await reportTotalValue(reportedValue);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE);
    await expectQuarantineActive(LARGE_UNSAFE_VALUE, startTimestamp);

    // Safe deposit during quarantine (immediately reflected)
    const quarantinePeriod = await lazyOracle.quarantinePeriod();
    await advanceChainTime(quarantinePeriod / 2n);
    await dashboard.fund({ value: depositAmount });
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE + depositAmount);
    await expectQuarantineActive(LARGE_UNSAFE_VALUE, startTimestamp);

    // End quarantine - both deposit and quarantined value are now active
    await advanceChainTime(quarantinePeriod / 2n + 60n * 60n);
    await waitNextAvailableReportTime(ctx);
    await reportTotalValue(INITIAL_VAULT_VALUE + depositAmount + LARGE_UNSAFE_VALUE);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE + depositAmount + LARGE_UNSAFE_VALUE);
    await expectQuarantineCleared();
  });

  it("Funding in quarantine period - after expiration", async () => {
    const reportedValue = INITIAL_VAULT_VALUE + LARGE_UNSAFE_VALUE;
    const depositAmount = INITIAL_VAULT_VALUE;

    // Start quarantine
    const startTimestamp = await reportTotalValue(reportedValue);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE);
    await expectQuarantineActive(LARGE_UNSAFE_VALUE, startTimestamp);

    // Quarantine expires, then safe deposit
    await expireQuarantine();
    await waitNextAvailableReportTime(ctx);
    await dashboard.fund({ value: depositAmount });
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE + depositAmount);

    // Report includes quarantined value and new deposit
    await reportTotalValue(reportedValue);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE + depositAmount + LARGE_UNSAFE_VALUE);
    await expectQuarantineCleared();
  });

  it("Withdrawal in quarantine period - before last refslot", async () => {
    const reportedValue = INITIAL_VAULT_VALUE + LARGE_UNSAFE_VALUE;
    const depositAmount = ether("1");
    const withdrawalAmount = ether("0.3");

    // Start quarantine
    const startTimestamp = await reportTotalValue(reportedValue);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE);
    await expectQuarantineActive(LARGE_UNSAFE_VALUE, startTimestamp);

    // Deposit and withdraw during quarantine
    const accruedFee = await dashboard.accruedFee(); // we need to pay fees from quarantined amount to
    await dashboard.fund({ value: depositAmount + accruedFee });
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE + depositAmount + accruedFee);

    await dashboard.withdraw(stranger, withdrawalAmount);
    const expectedValueAfterWithdrawal = INITIAL_VAULT_VALUE + depositAmount + accruedFee - withdrawalAmount;
    expect(await vaultHub.totalValue(stakingVault)).to.equal(expectedValueAfterWithdrawal);

    // End quarantine - quarantined value added to current total
    await expireQuarantine();
    await reportTotalValue(expectedValueAfterWithdrawal + LARGE_UNSAFE_VALUE, true);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(expectedValueAfterWithdrawal + LARGE_UNSAFE_VALUE);
    await expectQuarantineCleared();
  });

  it("Withdrawal in quarantine period - after last refslot", async () => {
    const reportedValue = INITIAL_VAULT_VALUE + LARGE_UNSAFE_VALUE;
    const depositAmount = INITIAL_VAULT_VALUE;
    const withdrawalAmount = ether("0.3");

    // Start quarantine
    const startTimestamp = await reportTotalValue(reportedValue);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE);
    await expectQuarantineActive(LARGE_UNSAFE_VALUE, startTimestamp);

    // Deposit during quarantine, then advance to near expiry
    const quarantinePeriod = await lazyOracle.quarantinePeriod();
    await advanceChainTime(quarantinePeriod / 2n);
    const accruedFee = await dashboard.accruedFee();
    await dashboard.fund({ value: depositAmount + accruedFee });
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE + depositAmount + accruedFee);

    // Report while quarantine is still active but near expiry
    await advanceChainTime(quarantinePeriod / 2n - 60n * 60n);
    await reportTotalValue(INITIAL_VAULT_VALUE + depositAmount + LARGE_UNSAFE_VALUE + accruedFee, true);

    // Wait for next refslot
    await waitNextAvailableReportTime(ctx);

    // Withdraw after quarantine expired and refslot advanced
    await dashboard.withdraw(stranger, withdrawalAmount);
    const expectedValueAfterWithdrawal = INITIAL_VAULT_VALUE + depositAmount + accruedFee - withdrawalAmount;
    expect(await vaultHub.totalValue(stakingVault)).to.equal(expectedValueAfterWithdrawal);

    // Final report includes quarantined value
    await reportTotalValue(INITIAL_VAULT_VALUE + depositAmount + LARGE_UNSAFE_VALUE + accruedFee);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(expectedValueAfterWithdrawal + LARGE_UNSAFE_VALUE);
    await expectQuarantineCleared();
  });

  it("Sequential quarantine with unsafe fund (without rewards)", async () => {
    // First quarantine: report huge value increase
    const reportedValue = INITIAL_VAULT_VALUE + LARGE_UNSAFE_VALUE;
    const startTimestamp = await reportTotalValue(reportedValue);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE);
    await expectQuarantineActive(LARGE_UNSAFE_VALUE, startTimestamp);

    // Report even larger value during first quarantine
    const quarantinePeriod = await lazyOracle.quarantinePeriod();
    await advanceChainTime(quarantinePeriod / 2n);
    await reportTotalValue(reportedValue + LARGE_UNSAFE_VALUE);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE);
    await expectQuarantineActive(LARGE_UNSAFE_VALUE, startTimestamp, LARGE_UNSAFE_VALUE);

    // First quarantine expires, second one starts
    await advanceChainTime(quarantinePeriod / 2n + 60n * 60n);
    const secondStartTimestamp = await reportTotalValue(reportedValue + LARGE_UNSAFE_VALUE);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(reportedValue);
    await expectQuarantineActive(LARGE_UNSAFE_VALUE, secondStartTimestamp);

    // Second quarantine expires
    await expireQuarantine();
    await reportTotalValue(reportedValue + LARGE_UNSAFE_VALUE);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(reportedValue + LARGE_UNSAFE_VALUE);
    await expectQuarantineCleared();
  });

  it("Sequential quarantine with EL/CL rewards", async () => {
    // First quarantine: report huge value increase
    const reportedValue = INITIAL_VAULT_VALUE + LARGE_UNSAFE_VALUE;
    const startTimestamp = await reportTotalValue(reportedValue);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE);
    await expectQuarantineActive(LARGE_UNSAFE_VALUE, startTimestamp);

    // Report additional rewards during first quarantine
    const rewardsValue = (INITIAL_VAULT_VALUE * (await lazyOracle.maxRewardRatioBP())) / 10000n;
    const quarantinePeriod = await lazyOracle.quarantinePeriod();
    await advanceChainTime(quarantinePeriod / 2n);
    await reportTotalValue(reportedValue + rewardsValue);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(INITIAL_VAULT_VALUE);
    await expectQuarantineActive(LARGE_UNSAFE_VALUE, startTimestamp, rewardsValue);

    // First quarantine expires, report triggers second quarantine
    await advanceChainTime(quarantinePeriod / 2n + 60n * 60n);
    const secondStartTimestamp = await reportTotalValue(reportedValue + LARGE_UNSAFE_VALUE + rewardsValue);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(reportedValue);
    await expectQuarantineActive(LARGE_UNSAFE_VALUE + rewardsValue, secondStartTimestamp);

    // Second quarantine expires
    await expireQuarantine();
    await reportTotalValue(reportedValue + LARGE_UNSAFE_VALUE + rewardsValue);
    expect(await vaultHub.totalValue(stakingVault)).to.equal(reportedValue + LARGE_UNSAFE_VALUE + rewardsValue);
    await expectQuarantineCleared();
  });
});
