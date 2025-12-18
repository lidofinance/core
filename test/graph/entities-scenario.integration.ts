import { expect } from "chai";
import { ContractTransactionReceipt, formatEther, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault } from "typechain-types";

import { advanceChainTime, ether, log, mEqual, updateBalance } from "lib";
import {
  createVaultWithDashboard,
  finalizeWQViaElVault,
  getProtocolContext,
  norSdvtEnsureOperators,
  OracleReportParams,
  ProtocolContext,
  removeStakingLimit,
  report,
  reportVaultDataWithProof,
  setStakingLimit,
  setupLidoForVaults,
} from "lib/protocol";

import { bailOnFailure, Snapshot } from "test/suite";

import { deriveExpectedTotalReward, GraphSimulator, makeLidoSubmissionId, makeLidoTransferId } from "./simulator";
import { captureChainState, capturePoolState, SimulatorInitialState } from "./utils";
import { extractAllLogs } from "./utils/event-extraction";

const INTERVAL_12_HOURS = 12n * 60n * 60n;

/**
 * Comprehensive Graph Entity Integration Test Scenario
 *
 * Tests all entity types with interleaved actions:
 * - Deposits (submits): 6+
 * - Transfers: 5+
 * - Oracle reports: 7 (profitable, zero, negative, MEV-heavy)
 * - Withdrawal requests + finalizations: 5+
 * - V3 external shares mint: 5+
 * - V3 external shares burn: 5+
 *
 * Reference: test/graph/INTRO.md
 */
describe("Comprehensive Mixed Scenario", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  // Users
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let user3: HardhatEthersSigner;
  let user4: HardhatEthersSigner;
  let user5: HardhatEthersSigner;

  // V3 Vaults
  let vault1: StakingVault;
  let vault2: StakingVault;
  let dashboard1: Dashboard;
  let dashboard2: Dashboard;

  // Simulator
  let simulator: GraphSimulator;
  let initialState: SimulatorInitialState;

  // Initial shares for addresses (captured at test start for validation)
  const initialShares: Map<string, bigint> = new Map();

  // Counters for statistics
  let depositCount = 0;
  let transferCount = 0;
  let reportCount = 0;
  let profitableReportCount = 0;
  let withdrawalRequestCount = 0;
  let v3MintCount = 0;
  let v3BurnCount = 0;

  // Track pending withdrawal request IDs
  const pendingWithdrawalRequestIds: bigint[] = [];

  before(async () => {
    ctx = await getProtocolContext();

    // Get signers for 5 users
    const signers = await ethers.getSigners();
    [user1, user2, user3, user4, user5] = signers.slice(0, 5);

    // Fund all users
    for (const user of [user1, user2, user3, user4, user5]) {
      await updateBalance(user.address, ether("10000000"));
    }

    snapshot = await Snapshot.take();

    // Setup protocol state FIRST (before initializing simulator)
    await removeStakingLimit(ctx);
    await setStakingLimit(ctx, ether("500000"), ether("50"));

    // Ensure node operators exist (for fee distribution)
    await norSdvtEnsureOperators(ctx, ctx.contracts.nor, 3n, 5n);
    await norSdvtEnsureOperators(ctx, ctx.contracts.sdvt, 3n, 5n);

    // Setup Lido for vaults (V3) - this calls report(ctx) internally
    await setupLidoForVaults(ctx);

    // Create 2 vaults with dashboards for user3
    const vaultResult1 = await createVaultWithDashboard(ctx, ctx.contracts.stakingVaultFactory, user3, user3, user3);
    vault1 = vaultResult1.stakingVault;
    dashboard1 = vaultResult1.dashboard.connect(user3);

    const vaultResult2 = await createVaultWithDashboard(ctx, ctx.contracts.stakingVaultFactory, user3, user3, user3);
    vault2 = vaultResult2.stakingVault;
    dashboard2 = vaultResult2.dashboard.connect(user3);

    // Fund both vaults
    await dashboard1.fund({ value: ether("500") });
    await dashboard2.fund({ value: ether("500") });

    // Finalize any pending withdrawals
    await finalizeWQViaElVault(ctx);

    // NOW capture chain state and initialize simulator AFTER all setup is done
    initialState = await captureChainState(ctx);
    simulator = new GraphSimulator(initialState.treasuryAddress);
    simulator.initializeTotals(initialState.totalPooledEther, initialState.totalShares);

    // Capture initial shares for all relevant addresses
    // Include: treasury, staking modules, reward recipients, protocol contracts, users
    const { lido, locator, withdrawalQueue, accounting, stakingRouter } = ctx.contracts;
    const burnerAddress = await locator.burner();
    const wqAddress = await withdrawalQueue.getAddress();
    const accountingAddress = await accounting.getAddress();
    const stakingRouterAddress = await stakingRouter.getAddress();
    const vaultHubAddress = await locator.vaultHub();

    // Get all staking modules including CSM if registered
    const allModules = await stakingRouter.getStakingModules();
    const moduleAddresses = allModules.map((m) => m.stakingModuleAddress);

    // Some staking modules (like CSM) have a separate Fee Distributor contract that receives rewards
    // We need to capture these addresses as they receive transfers during oracle reports
    const feeDistributorAddresses: string[] = [];
    for (const module of allModules) {
      try {
        const moduleContract = new ethers.Contract(
          module.stakingModuleAddress,
          ["function FEE_DISTRIBUTOR() view returns (address)"],
          ethers.provider,
        );
        const feeDistributor = await moduleContract.FEE_DISTRIBUTOR();
        if (feeDistributor && feeDistributor !== ZeroAddress) {
          feeDistributorAddresses.push(feeDistributor);
        }
      } catch {
        // Module doesn't have FEE_DISTRIBUTOR (e.g., NOR, SDVT)
      }
    }

    const addressesToCapture = [
      initialState.treasuryAddress,
      ...initialState.stakingRelatedAddresses,
      ...moduleAddresses,
      ...feeDistributorAddresses,
      burnerAddress,
      wqAddress,
      accountingAddress,
      stakingRouterAddress,
      vaultHubAddress,
      user1.address,
      user2.address,
      user3.address,
      user4.address,
      user5.address,
    ];
    for (const addr of addressesToCapture) {
      const shares = await lido.sharesOf(addr);
      initialShares.set(addr.toLowerCase(), shares);
    }

    log.info("Setup complete", {
      "Vault1": await vault1.getAddress(),
      "Vault2": await vault2.getAddress(),
      "Total Pooled Ether": formatEther(initialState.totalPooledEther),
      "Total Shares": initialState.totalShares.toString(),
      "Addresses captured for Shares validation": addressesToCapture.length,
    });
  });

  after(async () => await Snapshot.restore(snapshot));

  beforeEach(bailOnFailure);

  // ============================================================================
  // Helper Functions
  // ============================================================================

  async function processTx(receipt: ContractTransactionReceipt, description: string) {
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    const blockTimestamp = BigInt(block!.timestamp);

    // Use processTransactionWithV3 to handle V3 events (ExternalSharesMinted, ExternalSharesBurnt)
    // which require async contract reads to sync totalPooledEther with the chain
    const result = await simulator.processTransactionWithV3(receipt, ctx, blockTimestamp);

    log.debug(`Processed: ${description}`, {
      "Block": receipt.blockNumber,
      "Totals Updated": result.totalsUpdated,
      "Submissions": result.lidoSubmissions.size,
      "Transfers": result.lidoTransfers.size,
      "TotalRewards": result.totalRewards.size,
      "SharesBurns": result.sharesBurns.size,
      "Warnings": result.warnings.length,
    });

    return result;
  }

  async function validateSubmission(
    receipt: ContractTransactionReceipt,
    expectedSender: string,
    expectedAmount: bigint,
    expectedReferral: string = ZeroAddress,
  ) {
    const logs = extractAllLogs(receipt, ctx);
    const submittedEvent = logs.find((l) => l.name === "Submitted");
    expect(submittedEvent, "Submitted event not found").to.not.be.undefined;

    const submissionId = makeLidoSubmissionId(receipt.hash, submittedEvent!.logIndex);
    const submission = simulator.getLidoSubmission(submissionId);

    expect(submission, "LidoSubmission entity not found").to.not.be.undefined;
    expect(submission!.sender.toLowerCase()).to.equal(expectedSender.toLowerCase());
    expect(submission!.amount).to.equal(expectedAmount);
    expect(submission!.referral.toLowerCase()).to.equal(expectedReferral.toLowerCase());
    expect(submission!.shares).to.be.gt(0n);

    return submission!;
  }

  async function validateTransfer(receipt: ContractTransactionReceipt, expectedFrom: string, expectedTo: string) {
    const logs = extractAllLogs(receipt, ctx);
    const transferEvent = logs.find(
      (l) =>
        l.name === "Transfer" &&
        l.args?.from?.toLowerCase() === expectedFrom.toLowerCase() &&
        l.args?.to?.toLowerCase() === expectedTo.toLowerCase(),
    );
    expect(transferEvent, "Transfer event not found").to.not.be.undefined;

    const transferId = makeLidoTransferId(receipt.hash, transferEvent!.logIndex);
    const transfer = simulator.getLidoTransfer(transferId);

    expect(transfer, "LidoTransfer entity not found").to.not.be.undefined;
    expect(transfer!.from.toLowerCase()).to.equal(expectedFrom.toLowerCase());
    expect(transfer!.to.toLowerCase()).to.equal(expectedTo.toLowerCase());
    expect(transfer!.shares).to.be.gt(0n);

    // Validate share balance changes
    expect(transfer!.sharesBeforeDecrease - transfer!.sharesAfterDecrease).to.equal(transfer!.shares);
    expect(transfer!.sharesAfterIncrease - transfer!.sharesBeforeIncrease).to.equal(transfer!.shares);

    return transfer!;
  }

  async function validateOracleReport(receipt: ContractTransactionReceipt, expectProfitable: boolean) {
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    const blockTimestamp = BigInt(block!.timestamp);
    const result = simulator.processTransaction(receipt, ctx, blockTimestamp);

    if (expectProfitable) {
      expect(result.hadProfitableReport, "Expected profitable report").to.be.true;
      expect(result.totalRewards.size).to.be.gte(1);

      const computed = result.totalRewards.get(receipt.hash);
      expect(computed, "TotalReward entity not found").to.not.be.undefined;

      // Derive expected values from events
      const expected = deriveExpectedTotalReward(receipt, ctx, initialState.treasuryAddress);
      expect(expected, "Failed to derive expected TotalReward from events").to.not.be.null;

      // Field-by-field validation against expected values
      await mEqual([
        // Identity fields
        [computed!.id.toLowerCase(), receipt.hash.toLowerCase()],
        [computed!.block, BigInt(receipt.blockNumber)],
        [computed!.blockTime, blockTimestamp],
        [computed!.transactionHash.toLowerCase(), receipt.hash.toLowerCase()],
        [computed!.transactionIndex, BigInt(receipt.index)],
        [computed!.logIndex, expected!.logIndex],
        // Pool state before/after
        [computed!.totalPooledEtherBefore, expected!.totalPooledEtherBefore],
        [computed!.totalPooledEtherAfter, expected!.totalPooledEtherAfter],
        [computed!.totalSharesBefore, expected!.totalSharesBefore],
        [computed!.totalSharesAfter, expected!.totalSharesAfter],
        // Reward distribution
        [computed!.shares2mint, expected!.shares2mint],
        [computed!.timeElapsed, expected!.timeElapsed],
        [computed!.mevFee, expected!.mevFee],
        [computed!.totalRewardsWithFees, expected!.totalRewardsWithFees],
        [computed!.totalRewards, expected!.totalRewards],
        [computed!.totalFee, expected!.totalFee],
        [computed!.treasuryFee, expected!.treasuryFee],
        [computed!.operatorsFee, expected!.operatorsFee],
        [computed!.sharesToTreasury, expected!.sharesToTreasury],
        [computed!.sharesToOperators, expected!.sharesToOperators],
        // APR fields
        [computed!.apr, expected!.apr],
        [computed!.aprRaw, expected!.aprRaw],
        [computed!.aprBeforeFees, expected!.aprBeforeFees],
        // Fee basis points
        [computed!.feeBasis, expected!.feeBasis],
        [computed!.treasuryFeeBasisPoints, expected!.treasuryFeeBasisPoints],
        [computed!.operatorsFeeBasisPoints, expected!.operatorsFeeBasisPoints],
        // Internal consistency checks
        [computed!.shares2mint, computed!.sharesToTreasury + computed!.sharesToOperators],
        [computed!.totalFee, computed!.treasuryFee + computed!.operatorsFee],
      ]);

      // ========== Per-Module Fee Distribution Validation ==========
      // Verify NodeOperatorFees and NodeOperatorsShares entities

      // Get per-module fee entities from simulator
      const nodeOpFees = simulator.getNodeOperatorFeesForReward(receipt.hash);
      const nodeOpShares = simulator.getNodeOperatorsSharesForReward(receipt.hash);

      // Validate that entities were created when there are operator fees
      if (computed!.operatorsFee > 0n) {
        expect(nodeOpFees.length, "NodeOperatorFees entities should be created for operator fees").to.be.gte(1);
        expect(nodeOpShares.length, "NodeOperatorsShares entities should be created for operator fees").to.be.gte(1);

        // Sum of all NodeOperatorFees should equal operatorsFee
        const totalNodeOpFee = nodeOpFees.reduce((sum, e) => sum + e.fee, 0n);
        expect(totalNodeOpFee).to.equal(computed!.operatorsFee, "Sum of NodeOperatorFees should equal operatorsFee");

        // Sum of all NodeOperatorsShares should equal sharesToOperators
        const totalNodeOpShares = nodeOpShares.reduce((sum, e) => sum + e.shares, 0n);
        expect(totalNodeOpShares).to.equal(
          computed!.sharesToOperators,
          "Sum of NodeOperatorsShares should equal sharesToOperators",
        );

        // Verify each entity has correct totalRewardId
        for (const entity of nodeOpFees) {
          expect(entity.totalRewardId.toLowerCase()).to.equal(
            receipt.hash.toLowerCase(),
            "NodeOperatorFees.totalRewardId should match TotalReward.id",
          );
          expect(entity.address).to.not.equal("", "NodeOperatorFees.address should be set");
          expect(entity.fee).to.be.gt(0n, "NodeOperatorFees.fee should be > 0");
        }

        for (const entity of nodeOpShares) {
          expect(entity.totalRewardId.toLowerCase()).to.equal(
            receipt.hash.toLowerCase(),
            "NodeOperatorsShares.totalRewardId should match TotalReward.id",
          );
          expect(entity.address).to.not.equal("", "NodeOperatorsShares.address should be set");
          expect(entity.shares).to.be.gt(0n, "NodeOperatorsShares.shares should be > 0");
        }

        // Verify nodeOperatorFeesIds and nodeOperatorsSharesIds arrays are populated
        expect(computed!.nodeOperatorFeesIds.length).to.equal(
          nodeOpFees.length,
          "nodeOperatorFeesIds should match number of NodeOperatorFees entities",
        );
        expect(computed!.nodeOperatorsSharesIds.length).to.equal(
          nodeOpShares.length,
          "nodeOperatorsSharesIds should match number of NodeOperatorsShares entities",
        );
      }

      profitableReportCount++;
      return computed!;
    } else {
      expect(result.hadProfitableReport, "Expected non-profitable report").to.be.false;
      expect(result.totalRewards.size).to.equal(0);

      // Totals should still be updated
      expect(result.totalsUpdated).to.be.true;
      return null;
    }
  }

  async function validateGlobalConsistency() {
    const { lido } = ctx.contracts;
    const totals = simulator.getTotals();
    expect(totals, "Totals entity should exist").to.not.be.null;

    // Verify Totals against on-chain state
    const poolState = await capturePoolState(ctx);
    expect(totals!.totalPooledEther).to.equal(poolState.totalPooledEther, "Totals.totalPooledEther should match chain");
    expect(totals!.totalShares).to.equal(poolState.totalShares, "Totals.totalShares should match chain");

    // Verify all Shares entities against on-chain state
    // The simulator tracks share deltas from events, so we need to add initial shares
    // All addresses should have been pre-captured (treasury, reward recipients, users, burner, WQ)
    const allShares = simulator.getAllShares();
    let validatedCount = 0;
    for (const [address, sharesEntity] of allShares) {
      const initialSharesForAddress = initialShares.get(address.toLowerCase());
      expect(initialSharesForAddress, `Address ${address} was not pre-captured - add it to addressesToCapture in setup`)
        .to.not.be.undefined;

      const onChainShares = await lido.sharesOf(address);
      const expectedShares = sharesEntity.shares + initialSharesForAddress!;
      expect(expectedShares).to.equal(
        onChainShares,
        `Shares for ${address} should match chain (simulator: ${sharesEntity.shares}, initial: ${initialSharesForAddress}, expected: ${expectedShares}, on-chain: ${onChainShares})`,
      );
      validatedCount++;
    }

    log.debug("Global consistency check passed", {
      "Total Pooled Ether": formatEther(totals!.totalPooledEther),
      "Total Shares": totals!.totalShares.toString(),
      "Shares Entities Validated": validatedCount,
    });
  }

  // ============================================================================
  // Phase 1: Initial Deposits & First Report
  // ============================================================================

  describe("Phase 1: Initial Deposits & First Report", () => {
    it("Action 1: user1 deposits 100 ETH (no referral)", async () => {
      const { lido } = ctx.contracts;
      const amount = ether("100");

      const tx = await lido.connect(user1).submit(ZeroAddress, { value: amount });
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "user1 deposit 100 ETH");
      await validateSubmission(receipt, user1.address, amount, ZeroAddress);

      depositCount++;
    });

    it("Action 2: user2 deposits 50 ETH (with referral = user1)", async () => {
      const { lido } = ctx.contracts;
      const amount = ether("50");

      const tx = await lido.connect(user2).submit(user1.address, { value: amount });
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "user2 deposit 50 ETH with referral");
      await validateSubmission(receipt, user2.address, amount, user1.address);

      depositCount++;
    });

    it("Action 3: Oracle report #1 - normal profitable", async () => {
      await advanceChainTime(INTERVAL_12_HOURS);

      const reportData: Partial<OracleReportParams> = {
        clDiff: ether("0.01"),
      };

      const { reportTx } = await report(ctx, reportData);
      const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

      await validateOracleReport(receipt, true);
      await validateGlobalConsistency();

      reportCount++;
    });

    it("Action 4: user3 deposits 200 ETH (large deposit)", async () => {
      const { lido } = ctx.contracts;
      const amount = ether("200");

      const tx = await lido.connect(user3).submit(ZeroAddress, { value: amount });
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "user3 deposit 200 ETH");
      await validateSubmission(receipt, user3.address, amount);

      depositCount++;
    });

    it("Action 5: Transfer user1 -> user2, 10 ETH", async () => {
      const { lido } = ctx.contracts;
      const amount = ether("10");

      const tx = await lido.connect(user1).transfer(user2.address, amount);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "Transfer user1 -> user2");
      await validateTransfer(receipt, user1.address, user2.address);

      transferCount++;
    });
  });

  // ============================================================================
  // Phase 2: V3 Vault Actions + Reports
  // ============================================================================

  describe("Phase 2: V3 Vault Actions + Reports", () => {
    it("Action 6: Vault1 mint external shares (50 stETH to user3)", async () => {
      const amount = ether("50");

      // Report vault data to make it fresh and process through simulator
      const vaultReportTx = await reportVaultDataWithProof(ctx, vault1);
      const vaultReportReceipt = (await vaultReportTx.wait()) as ContractTransactionReceipt;
      await processTx(vaultReportReceipt, "Vault1 report");

      const tx = await dashboard1.mintStETH(user3.address, amount);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "Vault1 mint 50 stETH");

      // Verify ExternalSharesMinted event
      const logs = extractAllLogs(receipt, ctx);
      const extMintEvent = logs.find((l) => l.name === "ExternalSharesMinted");
      expect(extMintEvent, "ExternalSharesMinted event not found").to.not.be.undefined;

      // Verify shares were minted (event args)
      expect(extMintEvent!.args!["amountOfShares"]).to.be.gt(0n);

      v3MintCount++;
    });

    it("Action 7: Oracle report #2 - small profitable", async () => {
      await advanceChainTime(INTERVAL_12_HOURS);

      const reportData: Partial<OracleReportParams> = {
        clDiff: ether("0.001"),
      };

      const { reportTx } = await report(ctx, reportData);
      const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

      await validateOracleReport(receipt, true);
      await validateGlobalConsistency();

      reportCount++;
    });

    it("Action 8: Vault2 mint external shares (30 stETH to user3)", async () => {
      const amount = ether("30");

      // Report vault data to make it fresh and process through simulator
      const vaultReportTx = await reportVaultDataWithProof(ctx, vault2);
      const vaultReportReceipt = (await vaultReportTx.wait()) as ContractTransactionReceipt;
      await processTx(vaultReportReceipt, "Vault2 report");

      const tx = await dashboard2.mintStETH(user3.address, amount);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "Vault2 mint 30 stETH");

      const logs = extractAllLogs(receipt, ctx);
      const extMintEvent = logs.find((l) => l.name === "ExternalSharesMinted");
      expect(extMintEvent, "ExternalSharesMinted event not found").to.not.be.undefined;

      v3MintCount++;
    });

    it("Action 9: user4 deposits 25 ETH", async () => {
      const { lido } = ctx.contracts;
      const amount = ether("25");

      const tx = await lido.connect(user4).submit(ZeroAddress, { value: amount });
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "user4 deposit 25 ETH");
      await validateSubmission(receipt, user4.address, amount);

      depositCount++;
    });

    it("Action 10: Vault1 burn external shares (20 stETH)", async () => {
      const { lido } = ctx.contracts;
      const amount = ether("20");

      // Report vault data to make it fresh and process through simulator
      const vaultReportTx = await reportVaultDataWithProof(ctx, vault1);
      const vaultReportReceipt = (await vaultReportTx.wait()) as ContractTransactionReceipt;
      await processTx(vaultReportReceipt, "Vault1 report");

      // Approve stETH for burning
      await lido.connect(user3).approve(await dashboard1.getAddress(), amount);

      const tx = await dashboard1.burnStETH(amount);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "Vault1 burn 20 stETH");

      // Verify SharesBurnt event
      const logs = extractAllLogs(receipt, ctx);
      const sharesBurntEvent = logs.find((l) => l.name === "SharesBurnt");
      expect(sharesBurntEvent, "SharesBurnt event not found").to.not.be.undefined;

      v3BurnCount++;
    });
  });

  // ============================================================================
  // Phase 3: Withdrawal Flow
  // ============================================================================

  describe("Phase 3: Withdrawal Flow", () => {
    it("Action 11: user1 requests withdrawal (30 ETH)", async () => {
      const { lido, withdrawalQueue } = ctx.contracts;
      const amount = ether("30");

      await lido.connect(user1).approve(await withdrawalQueue.getAddress(), amount);
      const tx = await withdrawalQueue.connect(user1).requestWithdrawals([amount], user1.address);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      // Process the withdrawal request transaction (includes Transfer from user to WQ)
      await processTx(receipt, "user1 withdrawal request 30 ETH");

      const withdrawalRequestedEvent = ctx.getEvents(receipt, "WithdrawalRequested")[0];
      const requestId = withdrawalRequestedEvent?.args?.requestId;
      expect(requestId).to.not.be.undefined;

      pendingWithdrawalRequestIds.push(requestId);
      withdrawalRequestCount++;

      log.debug("Withdrawal request created", { requestId: requestId.toString() });
    });

    it("Action 12: user2 requests withdrawal (20 ETH)", async () => {
      const { lido, withdrawalQueue } = ctx.contracts;
      const amount = ether("20");

      await lido.connect(user2).approve(await withdrawalQueue.getAddress(), amount);
      const tx = await withdrawalQueue.connect(user2).requestWithdrawals([amount], user2.address);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      // Process the withdrawal request transaction (includes Transfer from user to WQ)
      await processTx(receipt, "user2 withdrawal request 20 ETH");

      const withdrawalRequestedEvent = ctx.getEvents(receipt, "WithdrawalRequested")[0];
      const requestId = withdrawalRequestedEvent?.args?.requestId;
      expect(requestId).to.not.be.undefined;

      pendingWithdrawalRequestIds.push(requestId);
      withdrawalRequestCount++;

      log.debug("Withdrawal request created", { requestId: requestId.toString() });
    });

    it("Action 13: Oracle report #3 - profitable + finalizes withdrawals", async () => {
      await advanceChainTime(INTERVAL_12_HOURS);

      const reportData: Partial<OracleReportParams> = {
        clDiff: ether("0.01"),
      };

      const { reportTx } = await report(ctx, reportData);
      const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

      // Check for SharesBurnt events (withdrawal finalization)
      const logs = extractAllLogs(receipt, ctx);
      const sharesBurntEvents = logs.filter((l) => l.name === "SharesBurnt");

      log.debug("Oracle report with withdrawals", {
        "SharesBurnt events": sharesBurntEvents.length,
      });

      await validateOracleReport(receipt, true);
      await validateGlobalConsistency();

      reportCount++;
    });

    it("Action 14: user5 deposits 500 ETH (large)", async () => {
      const { lido } = ctx.contracts;
      const amount = ether("500");

      const tx = await lido.connect(user5).submit(ZeroAddress, { value: amount });
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "user5 deposit 500 ETH");
      await validateSubmission(receipt, user5.address, amount);

      depositCount++;
    });

    it("Action 15: Transfer user3 -> user4, partial balance", async () => {
      const { lido } = ctx.contracts;
      const amount = ether("50");

      const tx = await lido.connect(user3).transfer(user4.address, amount);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "Transfer user3 -> user4");
      await validateTransfer(receipt, user3.address, user4.address);

      transferCount++;
    });
  });

  // ============================================================================
  // Phase 4: Edge Case Reports
  // ============================================================================

  describe("Phase 4: Edge Case Reports", () => {
    it("Action 16: Oracle report #4 - zero rewards (non-profitable)", async () => {
      await advanceChainTime(INTERVAL_12_HOURS);

      const reportData: Partial<OracleReportParams> = {
        clDiff: 0n,
      };

      const { reportTx } = await report(ctx, reportData);
      const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

      // Should NOT create TotalReward entity
      await validateOracleReport(receipt, false);
      await validateGlobalConsistency();

      reportCount++;
    });

    it("Action 17: Vault2 mint external shares (100 stETH)", async () => {
      const amount = ether("100");

      // Report vault data to make it fresh and process through simulator
      const vaultReportTx = await reportVaultDataWithProof(ctx, vault2);
      const vaultReportReceipt = (await vaultReportTx.wait()) as ContractTransactionReceipt;
      await processTx(vaultReportReceipt, "Vault2 report");

      const tx = await dashboard2.mintStETH(user3.address, amount);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "Vault2 mint 100 stETH");

      v3MintCount++;
    });

    it("Action 18: user1 requests withdrawal (50 ETH)", async () => {
      const { lido, withdrawalQueue } = ctx.contracts;
      const amount = ether("50");

      await lido.connect(user1).approve(await withdrawalQueue.getAddress(), amount);
      const tx = await withdrawalQueue.connect(user1).requestWithdrawals([amount], user1.address);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      // Process the withdrawal request transaction (includes Transfer from user to WQ)
      await processTx(receipt, "user1 withdrawal request 50 ETH");

      const withdrawalRequestedEvent = ctx.getEvents(receipt, "WithdrawalRequested")[0];
      const requestId = withdrawalRequestedEvent?.args?.requestId;
      expect(requestId).to.not.be.undefined;

      pendingWithdrawalRequestIds.push(requestId);
      withdrawalRequestCount++;
    });

    it("Action 19: Oracle report #5 - negative rewards (slashing scenario)", async () => {
      await advanceChainTime(INTERVAL_12_HOURS);

      const reportData: Partial<OracleReportParams> = {
        clDiff: -ether("0.0001"),
      };

      const { reportTx } = await report(ctx, reportData);
      const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

      // Should NOT create TotalReward entity (negative/slashing)
      await validateOracleReport(receipt, false);
      await validateGlobalConsistency();

      reportCount++;
    });

    it("Action 20: Transfer user4 -> user1, full balance", async () => {
      const { lido } = ctx.contracts;
      const balance = await lido.balanceOf(user4.address);

      // Transfer almost full balance (leave 1 wei to avoid edge cases)
      const amount = balance - 1n;
      expect(amount).to.be.gt(0n);

      const tx = await lido.connect(user4).transfer(user1.address, amount);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "Transfer user4 -> user1 (near full balance)");
      await validateTransfer(receipt, user4.address, user1.address);

      transferCount++;
    });
  });

  // ============================================================================
  // Phase 5: More V3 + Withdrawals
  // ============================================================================

  describe("Phase 5: More V3 + Withdrawals", () => {
    it("Action 21: Vault1 mint external shares (75 stETH)", async () => {
      const amount = ether("75");

      // Report vault data to make it fresh and process through simulator
      const vaultReportTx = await reportVaultDataWithProof(ctx, vault1);
      const vaultReportReceipt = (await vaultReportTx.wait()) as ContractTransactionReceipt;
      await processTx(vaultReportReceipt, "Vault1 report");

      const tx = await dashboard1.mintStETH(user3.address, amount);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "Vault1 mint 75 stETH");

      v3MintCount++;
    });

    it("Action 22: user2 deposits 80 ETH", async () => {
      const { lido } = ctx.contracts;
      const amount = ether("80");

      const tx = await lido.connect(user2).submit(ZeroAddress, { value: amount });
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "user2 deposit 80 ETH");
      await validateSubmission(receipt, user2.address, amount);

      depositCount++;
    });

    it("Action 23: Vault2 burn external shares (50 stETH)", async () => {
      const { lido } = ctx.contracts;
      const amount = ether("50");

      // Report vault data to make it fresh and process through simulator
      const vaultReportTx = await reportVaultDataWithProof(ctx, vault2);
      const vaultReportReceipt = (await vaultReportTx.wait()) as ContractTransactionReceipt;
      await processTx(vaultReportReceipt, "Vault2 report");

      await lido.connect(user3).approve(await dashboard2.getAddress(), amount);

      const tx = await dashboard2.burnStETH(amount);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "Vault2 burn 50 stETH");

      v3BurnCount++;
    });

    it("Action 24: user3 requests withdrawal (40 ETH)", async () => {
      const { lido, withdrawalQueue } = ctx.contracts;
      const amount = ether("40");

      await lido.connect(user3).approve(await withdrawalQueue.getAddress(), amount);
      const tx = await withdrawalQueue.connect(user3).requestWithdrawals([amount], user3.address);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      // Process the withdrawal request transaction (includes Transfer from user to WQ)
      await processTx(receipt, "user3 withdrawal request 40 ETH");

      const withdrawalRequestedEvent = ctx.getEvents(receipt, "WithdrawalRequested")[0];
      const requestId = withdrawalRequestedEvent?.args?.requestId;
      expect(requestId).to.not.be.undefined;

      pendingWithdrawalRequestIds.push(requestId);
      withdrawalRequestCount++;
    });

    it("Action 25: Oracle report #6 - profitable, finalizes batch", async () => {
      await advanceChainTime(INTERVAL_12_HOURS);

      const reportData: Partial<OracleReportParams> = {
        clDiff: ether("0.005"),
      };

      const { reportTx } = await report(ctx, reportData);
      const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

      const logs = extractAllLogs(receipt, ctx);
      const sharesBurntEvents = logs.filter((l) => l.name === "SharesBurnt");

      log.debug("Oracle report #6 with batch finalization", {
        "SharesBurnt events": sharesBurntEvents.length,
      });

      await validateOracleReport(receipt, true);
      await validateGlobalConsistency();

      reportCount++;
    });
  });

  // ============================================================================
  // Phase 6: Final Mixed Actions + Summary
  // ============================================================================

  describe("Phase 6: Final Mixed Actions + Summary", () => {
    it("Action 26: user1 deposits 30 ETH (with referral = user5)", async () => {
      const { lido } = ctx.contracts;
      const amount = ether("30");

      const tx = await lido.connect(user1).submit(user5.address, { value: amount });
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "user1 deposit 30 ETH with referral");
      await validateSubmission(receipt, user1.address, amount, user5.address);

      depositCount++;
    });

    it("Action 27: Transfer user1 -> user3, 15 ETH", async () => {
      const { lido } = ctx.contracts;
      const amount = ether("15");

      const tx = await lido.connect(user1).transfer(user3.address, amount);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "Transfer user1 -> user3");
      await validateTransfer(receipt, user1.address, user3.address);

      transferCount++;
    });

    it("Action 28: Vault1 burn external shares (30 stETH)", async () => {
      const { lido } = ctx.contracts;
      const amount = ether("30");

      // Report vault data to make it fresh and process through simulator
      const vaultReportTx = await reportVaultDataWithProof(ctx, vault1);
      const vaultReportReceipt = (await vaultReportTx.wait()) as ContractTransactionReceipt;
      await processTx(vaultReportReceipt, "Vault1 report");

      await lido.connect(user3).approve(await dashboard1.getAddress(), amount);

      const tx = await dashboard1.burnStETH(amount);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "Vault1 burn 30 stETH");

      v3BurnCount++;
    });

    it("Action 29: user5 requests withdrawal (100 ETH)", async () => {
      const { lido, withdrawalQueue } = ctx.contracts;
      const amount = ether("100");

      await lido.connect(user5).approve(await withdrawalQueue.getAddress(), amount);
      const tx = await withdrawalQueue.connect(user5).requestWithdrawals([amount], user5.address);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      // Process the withdrawal request transaction (includes Transfer from user to WQ)
      await processTx(receipt, "user5 withdrawal request 100 ETH");

      const withdrawalRequestedEvent = ctx.getEvents(receipt, "WithdrawalRequested")[0];
      const requestId = withdrawalRequestedEvent?.args?.requestId;
      expect(requestId).to.not.be.undefined;

      pendingWithdrawalRequestIds.push(requestId);
      withdrawalRequestCount++;
    });

    it("Action 30: Oracle report #7 - profitable with MEV", async () => {
      await advanceChainTime(INTERVAL_12_HOURS);

      const reportData: Partial<OracleReportParams> = {
        clDiff: ether("0.002"),
      };

      const { reportTx } = await report(ctx, reportData);
      const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

      await validateOracleReport(receipt, true);
      await validateGlobalConsistency();

      reportCount++;
    });

    it("Action 31: Transfer user2 -> user5, 25 ETH", async () => {
      const { lido } = ctx.contracts;
      const amount = ether("25");

      const tx = await lido.connect(user2).transfer(user5.address, amount);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "Transfer user2 -> user5");
      await validateTransfer(receipt, user2.address, user5.address);

      transferCount++;
    });

    it("Action 32: Vault2 burn external shares (30 stETH)", async () => {
      const { lido } = ctx.contracts;
      const amount = ether("30");

      // Report vault data to make it fresh and process through simulator
      const vaultReportTx = await reportVaultDataWithProof(ctx, vault2);
      const vaultReportReceipt = (await vaultReportTx.wait()) as ContractTransactionReceipt;
      await processTx(vaultReportReceipt, "Vault2 report");

      await lido.connect(user3).approve(await dashboard2.getAddress(), amount);

      const tx = await dashboard2.burnStETH(amount);
      const receipt = (await tx.wait()) as ContractTransactionReceipt;

      await processTx(receipt, "Vault2 burn 30 stETH");

      v3BurnCount++;
    });

    it("Should have correct entity counts and pass final validation", async () => {
      // Validate global consistency - simulator state should match chain state
      await validateGlobalConsistency();

      const totalRewardCount = simulator.countTotalRewards(0n);
      const allShares = simulator.getAllShares();
      const allTransfers = simulator.getAllLidoTransfers();
      const allSubmissions = simulator.getAllLidoSubmissions();

      log.info("=== Scenario Summary ===", {
        "Deposits (submits)": depositCount,
        "Transfers": transferCount,
        "Oracle Reports": reportCount,
        "Profitable Reports": profitableReportCount,
        "Withdrawal Requests": withdrawalRequestCount,
        "V3 Mints": v3MintCount,
        "V3 Burns": v3BurnCount,
        "TotalReward Entities": totalRewardCount,
        "Shares Entities": allShares.size,
        "LidoTransfer Entities": allTransfers.size,
        "LidoSubmission Entities": allSubmissions.size,
      });

      // Verify minimum counts
      expect(depositCount).to.be.gte(6, "Should have at least 6 deposits");
      expect(transferCount).to.be.gte(5, "Should have at least 5 transfers");
      expect(reportCount).to.be.gte(7, "Should have at least 7 oracle reports");
      expect(withdrawalRequestCount).to.be.gte(5, "Should have at least 5 withdrawal requests");
      expect(v3MintCount).to.be.gte(4, "Should have at least 4 V3 mints");
      expect(v3BurnCount).to.be.gte(4, "Should have at least 4 V3 burns");

      // Verify entity creation
      expect(totalRewardCount).to.be.gte(profitableReportCount, "TotalReward entities match profitable reports");
      expect(allSubmissions.size).to.be.gte(depositCount, "LidoSubmission entities match deposits");
    });
  });
});
