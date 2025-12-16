import { expect } from "chai";
import { ContractTransactionReceipt, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { advanceChainTime, ether, log, updateBalance } from "lib";
import {
  getProtocolContext,
  norSdvtEnsureOperators,
  OracleReportParams,
  ProtocolContext,
  removeStakingLimit,
  report,
  setStakingLimit,
} from "lib/protocol";

import { bailOnFailure, Snapshot } from "test/suite";

import {
  calcAPR_v2,
  calcAPR_v2Extended,
  E27_PRECISION_BASE,
  GraphSimulator,
  MAX_APR_SCALED,
  MIN_SHARE_RATE,
  SECONDS_PER_YEAR,
} from "./simulator";
import { captureChainState, capturePoolState, SimulatorInitialState } from "./utils";

/**
 * Graph Simulator Edge Case Tests
 *
 * These tests verify correct handling of edge cases:
 * - Zero rewards / non-profitable reports
 * - Division by zero scenarios
 * - Very small/large values for APR precision
 * - SharesBurnt handling during withdrawal finalization
 * - Totals state validation across multiple transactions
 *
 * Reference: test/graph/graph-tests-spec.md
 */
describe("Graph Simulator: Edge Cases", () => {
  /**
   * Unit tests for APR calculation edge cases
   * These don't require chain interaction
   */
  describe("APR Calculation Edge Cases", () => {
    describe("Zero Time Elapsed", () => {
      it("Should return 0 APR when timeElapsed is 0", () => {
        const apr = calcAPR_v2(
          ether("1000000"), // preTotalEther
          ether("1001000"), // postTotalEther (0.1% increase)
          ether("1000000"), // preTotalShares
          ether("1000000"), // postTotalShares
          0n, // timeElapsed = 0
        );

        expect(apr).to.equal(0);
      });

      it("Should return edge case info via extended function", () => {
        const result = calcAPR_v2Extended(ether("1000000"), ether("1001000"), ether("1000000"), ether("1000000"), 0n);

        expect(result.apr).to.equal(0);
        expect(result.edgeCase).to.equal("zero_time_elapsed");
      });
    });

    describe("Zero Shares", () => {
      it("Should return 0 APR when preTotalShares is 0", () => {
        const apr = calcAPR_v2(
          ether("1000000"),
          ether("1001000"),
          0n, // preTotalShares = 0
          ether("1000000"),
          86400n, // 1 day
        );

        expect(apr).to.equal(0);
      });

      it("Should return edge case info for zero pre shares", () => {
        const result = calcAPR_v2Extended(ether("1000000"), ether("1001000"), 0n, ether("1000000"), 86400n);

        expect(result.apr).to.equal(0);
        expect(result.edgeCase).to.equal("zero_pre_shares");
      });

      it("Should return 0 APR when postTotalShares is 0", () => {
        const apr = calcAPR_v2(
          ether("1000000"),
          ether("1001000"),
          ether("1000000"),
          0n, // postTotalShares = 0
          86400n,
        );

        expect(apr).to.equal(0);
      });

      it("Should return edge case info for zero post shares", () => {
        const result = calcAPR_v2Extended(ether("1000000"), ether("1001000"), ether("1000000"), 0n, 86400n);

        expect(result.apr).to.equal(0);
        expect(result.edgeCase).to.equal("zero_post_shares");
      });
    });

    describe("Zero Ether", () => {
      it("Should return 0 APR when preTotalEther is 0", () => {
        const apr = calcAPR_v2(
          0n, // preTotalEther = 0
          ether("1000"),
          ether("1000000"),
          ether("1000000"),
          86400n,
        );

        expect(apr).to.equal(0);
      });

      it("Should return edge case info for zero pre ether", () => {
        const result = calcAPR_v2Extended(0n, ether("1000"), ether("1000000"), ether("1000000"), 86400n);

        expect(result.apr).to.equal(0);
        expect(result.edgeCase).to.equal("zero_pre_ether");
      });
    });

    describe("Zero Rate Change", () => {
      it("Should return 0 APR when share rate is unchanged", () => {
        // Same ether and shares = same rate
        const apr = calcAPR_v2(
          ether("1000000"), // preTotalEther
          ether("1000000"), // postTotalEther (same)
          ether("1000000"), // preTotalShares
          ether("1000000"), // postTotalShares (same)
          86400n,
        );

        expect(apr).to.equal(0);
      });

      it("Should return 0 APR when rates are proportionally the same", () => {
        // Double both ether and shares = same rate
        const apr = calcAPR_v2(
          ether("1000000"),
          ether("2000000"), // 2x ether
          ether("500000"),
          ether("1000000"), // 2x shares (same rate)
          86400n,
        );

        expect(apr).to.equal(0);
      });

      it("Should return edge case info for zero rate change", () => {
        const result = calcAPR_v2Extended(
          ether("1000000"),
          ether("1000000"),
          ether("1000000"),
          ether("1000000"),
          86400n,
        );

        expect(result.apr).to.equal(0);
        expect(result.edgeCase).to.equal("zero_rate_change");
      });
    });

    describe("Very Small Values", () => {
      it("Should handle very small share amounts", () => {
        // 1 wei of ether and shares
        const apr = calcAPR_v2(
          1n, // 1 wei preTotalEther
          2n, // 2 wei postTotalEther
          1n, // 1 wei preTotalShares
          1n, // 1 wei postTotalShares
          SECONDS_PER_YEAR, // 1 year
        );

        // 100% increase over 1 year = 100% APR
        expect(apr).to.equal(100);
      });

      it("Should handle share rate at minimum threshold", () => {
        // Very small ether relative to shares
        const preShareRate = (1n * E27_PRECISION_BASE) / ether("1000000000");
        expect(preShareRate).to.be.lt(MIN_SHARE_RATE);

        const result = calcAPR_v2Extended(
          1n, // very small ether
          2n,
          ether("1000000000"), // huge shares
          ether("1000000000"),
          86400n,
        );

        expect(result.edgeCase).to.equal("share_rate_too_small");
      });
    });

    describe("Very Large Values", () => {
      it("Should cap extremely large APR to prevent overflow", () => {
        // Massive increase in short time
        const result = calcAPR_v2Extended(
          1n, // preTotalEther
          ether("1000000000000"), // postTotalEther (massive increase)
          1n, // preTotalShares
          1n, // postTotalShares
          1n, // 1 second
        );

        // Should be capped
        expect(result.apr).to.equal(Number(MAX_APR_SCALED) / 10000);
        expect(result.edgeCase).to.equal("apr_overflow_positive");
      });

      it("Should handle large but valid APR", () => {
        // 100% increase over 1 hour
        const apr = calcAPR_v2(
          ether("1000000"),
          ether("2000000"), // 100% increase
          ether("1000000"),
          ether("1000000"),
          3600n, // 1 hour
        );

        // APR should be approximately 100% * (365*24) = 876,000%
        expect(apr).to.be.gt(800000);
        expect(apr).to.be.lt(900000);
      });
    });

    describe("Negative Rate Change (Slashing)", () => {
      it("Should calculate negative APR for slashing scenario", () => {
        // Post ether less than pre ether (slashing)
        const apr = calcAPR_v2(
          ether("1000000"), // preTotalEther
          ether("990000"), // postTotalEther (1% decrease)
          ether("1000000"), // preTotalShares
          ether("1000000"), // postTotalShares
          SECONDS_PER_YEAR, // 1 year
        );

        // -1% over 1 year = -1% APR
        expect(apr).to.equal(-1);
      });

      it("Should handle extreme negative APR", () => {
        const result = calcAPR_v2Extended(
          ether("1000000000000"),
          1n, // Massive decrease
          1n,
          1n,
          1n,
        );

        expect(result.apr).to.equal(-Number(MAX_APR_SCALED) / 10000);
        expect(result.edgeCase).to.equal("apr_overflow_negative");
      });
    });

    describe("Normal APR Calculation Sanity Checks", () => {
      it("Should calculate approximately 5% APR for typical scenario", () => {
        // 5% annual yield
        const preTotalEther = ether("1000000");
        const postTotalEther = preTotalEther + (preTotalEther * 5n) / 100n; // 5% increase

        const apr = calcAPR_v2(
          preTotalEther,
          postTotalEther,
          ether("1000000"),
          ether("1000000"),
          SECONDS_PER_YEAR, // 1 year
        );

        // Should be approximately 5%
        expect(apr).to.be.approximately(5, 0.001);
      });

      it("Should correctly annualize from 1 day data", () => {
        // 0.01% daily = ~3.65% annually
        const preTotalEther = ether("1000000");
        const postTotalEther = preTotalEther + (preTotalEther * 1n) / 10000n; // 0.01% increase

        const apr = calcAPR_v2(
          preTotalEther,
          postTotalEther,
          ether("1000000"),
          ether("1000000"),
          86400n, // 1 day
        );

        // Should be approximately 365 * 0.01% = 3.65%
        expect(apr).to.be.approximately(3.65, 0.01);
      });
    });
  });

  /**
   * Integration tests for edge cases requiring chain interaction
   */
  describe("Scenario: Non-Profitable Oracle Report", () => {
    let ctx: ProtocolContext;
    let snapshot: string;
    let stEthHolder: HardhatEthersSigner;
    let simulator: GraphSimulator;
    let initialState: SimulatorInitialState;

    before(async () => {
      ctx = await getProtocolContext();
      [stEthHolder] = await ethers.getSigners();
      await updateBalance(stEthHolder.address, ether("100000000"));

      snapshot = await Snapshot.take();

      initialState = await captureChainState(ctx);
      simulator = new GraphSimulator(initialState.treasuryAddress);

      // Initialize simulator with current chain state
      simulator.initializeTotals(initialState.totalPooledEther, initialState.totalShares);

      // Setup protocol
      await removeStakingLimit(ctx);
      await setStakingLimit(ctx, ether("200000"), ether("20"));

      // Submit some ETH
      await ctx.contracts.lido.connect(stEthHolder).submit(ZeroAddress, { value: ether("1000") });
    });

    after(async () => await Snapshot.restore(snapshot));

    beforeEach(bailOnFailure);

    it("Should handle zero CL rewards (non-profitable report)", async () => {
      log("=== Zero Rewards Test ===");

      // Execute oracle report with zero CL diff (no rewards)
      const reportData: Partial<OracleReportParams> = {
        clDiff: 0n, // Zero rewards
      };

      log.info("Executing oracle report with zero CL diff");

      await advanceChainTime(12n * 60n * 60n);
      const { reportTx } = await report(ctx, reportData);
      const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const blockTimestamp = BigInt(block!.timestamp);

      // Process through simulator
      const result = simulator.processTransaction(receipt, ctx, blockTimestamp);

      log.info("Non-profitable report result", {
        "Had Profitable Report": result.hadProfitableReport,
        "TotalReward Entities": result.totalRewards.size,
        "Totals Updated": result.totalsUpdated,
        "Warnings": result.warnings.length,
      });

      // Verify: No TotalReward entity should be created
      expect(result.hadProfitableReport).to.be.false;
      expect(result.totalRewards.size).to.equal(0);

      // But Totals should still be updated
      expect(result.totalsUpdated).to.be.true;
      expect(result.totals).to.not.be.null;

      log("Zero rewards test PASSED");
    });

    it("Should handle negative CL diff (slashing scenario)", async () => {
      log("=== Negative Rewards (Slashing) Test ===");

      // Execute oracle report with negative CL diff
      const reportData: Partial<OracleReportParams> = {
        clDiff: -ether("0.001"), // Small loss due to slashing
      };

      log.info("Executing oracle report with negative CL diff");

      await advanceChainTime(12n * 60n * 60n);
      const { reportTx } = await report(ctx, reportData);
      const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;

      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const blockTimestamp = BigInt(block!.timestamp);

      // Process through simulator
      const result = simulator.processTransaction(receipt, ctx, blockTimestamp);

      log.info("Negative rewards result", {
        "Had Profitable Report": result.hadProfitableReport,
        "TotalReward Entities": result.totalRewards.size,
        "Totals Updated": result.totalsUpdated,
      });

      // Verify: No TotalReward entity (non-profitable)
      expect(result.hadProfitableReport).to.be.false;
      expect(result.totalRewards.size).to.equal(0);

      // Totals should still be updated
      expect(result.totalsUpdated).to.be.true;

      log("Negative rewards test PASSED");
    });
  });

  describe("Scenario: Totals State Validation", () => {
    let ctx: ProtocolContext;
    let snapshot: string;
    let stEthHolder: HardhatEthersSigner;
    let simulator: GraphSimulator;
    let initialState: SimulatorInitialState;
    let depositCount: bigint;

    before(async () => {
      ctx = await getProtocolContext();
      [stEthHolder] = await ethers.getSigners();
      await updateBalance(stEthHolder.address, ether("100000000"));

      snapshot = await Snapshot.take();

      initialState = await captureChainState(ctx);
      simulator = new GraphSimulator(initialState.treasuryAddress);

      // Initialize simulator with current chain state
      simulator.initializeTotals(initialState.totalPooledEther, initialState.totalShares);

      // Setup protocol
      await removeStakingLimit(ctx);
      await setStakingLimit(ctx, ether("200000"), ether("20"));

      // Ensure operators exist
      await norSdvtEnsureOperators(ctx, ctx.contracts.nor, 3n, 5n);

      // Submit ETH
      await ctx.contracts.lido.connect(stEthHolder).submit(ZeroAddress, { value: ether("1600") });

      // Make deposits
      const { impersonate, ether: etherFn } = await import("lib");
      const dsmSigner = await impersonate(ctx.contracts.depositSecurityModule.address, etherFn("100"));
      const depositTx = await ctx.contracts.lido.connect(dsmSigner).deposit(50n, 1n, new Uint8Array(32));
      const depositReceipt = (await depositTx.wait()) as ContractTransactionReceipt;
      const unbufferedEvent = ctx.getEvents(depositReceipt, "Unbuffered")[0];
      const unbufferedAmount = unbufferedEvent?.args[0] || 0n;
      depositCount = unbufferedAmount / ether("32");
    });

    after(async () => await Snapshot.restore(snapshot));

    beforeEach(bailOnFailure);

    it("Should validate Totals consistency across multiple reports", async () => {
      log("=== Multi-Transaction Totals Validation ===");

      // First report
      const clDiff1 = ether("32") * depositCount + ether("0.001");
      await advanceChainTime(12n * 60n * 60n);
      const { reportTx: reportTx1 } = await report(ctx, { clDiff: clDiff1, clAppearedValidators: depositCount });
      const receipt1 = (await reportTx1!.wait()) as ContractTransactionReceipt;
      const block1 = await ethers.provider.getBlock(receipt1.blockNumber);

      const result1 = simulator.processTransaction(receipt1, ctx, BigInt(block1!.timestamp));

      log.info("First report result", {
        "Totals Updated": result1.totalsUpdated,
        "Warnings": result1.warnings.length,
      });

      // Check for no state mismatch warnings (initialized correctly)
      const stateMismatchWarnings1 = result1.warnings.filter((w) => w.type === "totals_state_mismatch");
      expect(stateMismatchWarnings1.length).to.equal(0, "Should have no state mismatch on first report");

      // Get state after first report
      const stateAfter1 = await capturePoolState(ctx);
      const totalsAfter1 = simulator.getTotals();

      // Verify simulator Totals match on-chain state
      expect(totalsAfter1!.totalPooledEther).to.equal(
        stateAfter1.totalPooledEther,
        "Totals.totalPooledEther should match chain",
      );
      expect(totalsAfter1!.totalShares).to.equal(stateAfter1.totalShares, "Totals.totalShares should match chain");

      // Second report (simulator state should persist)
      const clDiff2 = ether("0.002");
      await advanceChainTime(12n * 60n * 60n);
      const { reportTx: reportTx2 } = await report(ctx, { clDiff: clDiff2 });
      const receipt2 = (await reportTx2!.wait()) as ContractTransactionReceipt;
      const block2 = await ethers.provider.getBlock(receipt2.blockNumber);

      const result2 = simulator.processTransaction(receipt2, ctx, BigInt(block2!.timestamp));

      log.info("Second report result", {
        "Totals Updated": result2.totalsUpdated,
        "Warnings": result2.warnings.length,
      });

      // Check for state consistency (should have no warnings since state was carried over)
      const stateMismatchWarnings2 = result2.warnings.filter((w) => w.type === "totals_state_mismatch");
      expect(stateMismatchWarnings2.length).to.equal(0, "Should have no state mismatch on second report");

      // Final verification
      const stateAfter2 = await capturePoolState(ctx);
      const totalsAfter2 = simulator.getTotals();

      expect(totalsAfter2!.totalPooledEther).to.equal(stateAfter2.totalPooledEther);
      expect(totalsAfter2!.totalShares).to.equal(stateAfter2.totalShares);

      log("Multi-transaction Totals validation PASSED");
    });

    it("Should detect Totals state mismatch when not initialized", async () => {
      log("=== Totals Mismatch Detection ===");

      // Create a fresh simulator WITHOUT initializing Totals
      const freshSimulator = new GraphSimulator(initialState.treasuryAddress);
      // Deliberately initialize with wrong values
      freshSimulator.initializeTotals(1n, 1n); // Wrong values

      // Execute a report
      const clDiff = ether("0.001");
      await advanceChainTime(12n * 60n * 60n);
      const { reportTx } = await report(ctx, { clDiff });
      const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const result = freshSimulator.processTransaction(receipt, ctx, BigInt(block!.timestamp));

      log.info("Mismatch detection result", {
        "Warnings Count": result.warnings.length,
        "Warnings": result.warnings.map((w) => w.type).join(", "),
      });

      // Should have state mismatch warnings
      const stateMismatchWarnings = result.warnings.filter((w) => w.type === "totals_state_mismatch");
      expect(stateMismatchWarnings.length).to.be.gt(0, "Should detect state mismatch");

      log("Totals mismatch detection PASSED");
    });
  });

  describe("shares2mint Validation", () => {
    let ctx: ProtocolContext;
    let snapshot: string;
    let stEthHolder: HardhatEthersSigner;
    let simulator: GraphSimulator;
    let initialState: SimulatorInitialState;
    let depositCount: bigint;

    before(async () => {
      ctx = await getProtocolContext();
      [stEthHolder] = await ethers.getSigners();
      await updateBalance(stEthHolder.address, ether("100000000"));

      snapshot = await Snapshot.take();

      initialState = await captureChainState(ctx);
      simulator = new GraphSimulator(initialState.treasuryAddress);
      simulator.initializeTotals(initialState.totalPooledEther, initialState.totalShares);

      // Setup
      await removeStakingLimit(ctx);
      await setStakingLimit(ctx, ether("200000"), ether("20"));
      await norSdvtEnsureOperators(ctx, ctx.contracts.nor, 3n, 5n);
      await ctx.contracts.lido.connect(stEthHolder).submit(ZeroAddress, { value: ether("1600") });

      // Deposits
      const { impersonate, ether: etherFn } = await import("lib");
      const dsmSigner = await impersonate(ctx.contracts.depositSecurityModule.address, etherFn("100"));
      const depositTx = await ctx.contracts.lido.connect(dsmSigner).deposit(50n, 1n, new Uint8Array(32));
      const depositReceipt = (await depositTx.wait()) as ContractTransactionReceipt;
      const unbufferedEvent = ctx.getEvents(depositReceipt, "Unbuffered")[0];
      depositCount = (unbufferedEvent?.args[0] || 0n) / ether("32");
    });

    after(async () => await Snapshot.restore(snapshot));

    beforeEach(bailOnFailure);

    it("Should validate shares2mint matches actual minted shares", async () => {
      log("=== shares2mint Validation Test ===");

      const clDiff = ether("32") * depositCount + ether("0.001");
      await advanceChainTime(12n * 60n * 60n);
      const { reportTx } = await report(ctx, { clDiff, clAppearedValidators: depositCount });
      const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const result = simulator.processTransaction(receipt, ctx, BigInt(block!.timestamp));

      // Check for shares2mint validation warnings
      const shares2mintWarnings = result.warnings.filter((w) => w.type === "shares2mint_mismatch");

      log.info("shares2mint validation result", {
        "Had Profitable Report": result.hadProfitableReport,
        "shares2mint Warnings": shares2mintWarnings.length,
      });

      // In a correctly functioning protocol, there should be no mismatch
      expect(shares2mintWarnings.length).to.equal(0, "shares2mint should match minted shares");

      if (result.hadProfitableReport) {
        const entity = result.totalRewards.values().next().value;
        if (entity) {
          // Verify the sanity check relationship
          const totalSharesMinted = entity.sharesToTreasury + entity.sharesToOperators;
          expect(entity.shares2mint).to.equal(totalSharesMinted, "shares2mint consistency check");

          log.info("shares2mint details", {
            "shares2mint (from event)": entity.shares2mint.toString(),
            "sharesToTreasury": entity.sharesToTreasury.toString(),
            "sharesToOperators": entity.sharesToOperators.toString(),
            "Sum": totalSharesMinted.toString(),
          });
        }
      }

      log("shares2mint validation PASSED");
    });
  });

  describe("Very Small Reward Precision", () => {
    let ctx: ProtocolContext;
    let snapshot: string;
    let stEthHolder: HardhatEthersSigner;
    let simulator: GraphSimulator;
    let initialState: SimulatorInitialState;

    before(async () => {
      ctx = await getProtocolContext();
      [stEthHolder] = await ethers.getSigners();
      await updateBalance(stEthHolder.address, ether("100000000"));

      snapshot = await Snapshot.take();

      initialState = await captureChainState(ctx);
      simulator = new GraphSimulator(initialState.treasuryAddress);
      simulator.initializeTotals(initialState.totalPooledEther, initialState.totalShares);

      await removeStakingLimit(ctx);
      await setStakingLimit(ctx, ether("200000"), ether("20"));
      await ctx.contracts.lido.connect(stEthHolder).submit(ZeroAddress, { value: ether("1000") });
    });

    after(async () => await Snapshot.restore(snapshot));

    beforeEach(bailOnFailure);

    it("Should handle very small rewards (1 wei)", async () => {
      log("=== Very Small Rewards Test ===");

      // Very small but positive reward
      const clDiff = 1n; // 1 wei

      await advanceChainTime(12n * 60n * 60n);
      const { reportTx } = await report(ctx, { clDiff });
      const receipt = (await reportTx!.wait()) as ContractTransactionReceipt;
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const result = simulator.processTransaction(receipt, ctx, BigInt(block!.timestamp));

      log.info("Very small rewards result", {
        "Had Profitable Report": result.hadProfitableReport,
        "TotalReward Entities": result.totalRewards.size,
      });

      // Even 1 wei should be considered profitable (postCL > preCL)
      expect(result.hadProfitableReport).to.be.true;

      if (result.hadProfitableReport) {
        const entity = result.totalRewards.values().next().value;
        if (entity) {
          log.info("Small reward entity details", {
            "Total Rewards With Fees": entity.totalRewardsWithFees.toString(),
            "APR": entity.apr.toString(),
          });

          // Total rewards should be very small
          expect(entity.totalRewardsWithFees).to.be.gt(0n);

          // APR calculation should still work (no division by zero)
          expect(Number.isFinite(entity.apr)).to.be.true;
        }
      }

      log("Very small rewards test PASSED");
    });
  });
});
