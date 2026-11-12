import { expect } from "chai";
import type { BigNumberish } from "ethers";
import { ethers } from "hardhat";

import { advanceChainTime, days, ether, ONE_GWEI, TOTAL_BASIS_POINTS } from "lib";
import {
  calcReportDataHash,
  depositValidatorsWithoutReport,
  getProtocolContext,
  getReportDataItems,
  ProtocolContext,
  reportWithoutClActivation,
  setWithdrawalVaultBalance,
  submitReportDataWithConsensusAndEmptyExtraData,
  updateOracleReportLimits,
  waitNextAvailableReportTime,
} from "lib/protocol";

import { bailOnFailure, Snapshot } from "test/suite";

const AMOUNT = ether("100");

// Pin the decrease limits, so the expected boundaries do not depend on the network config.
// Any decrease is above the zero soft limit and needs a second opinion.
const SOFT_DECREASE_BP = 0n;
const DAILY_HARD_DECREASE_BP = 25n;
const HARD_DECREASE_CEILING_BP = 500n;

const ONE_DAY = days(1n);

/** Mirrors `OracleReportSanityChecker._calculateCLRebaseDecreaseHardLimit`. */
function hardDecreaseLimit(principal: bigint, timeElapsed: bigint): bigint {
  const elapsed = timeElapsed > ONE_DAY ? timeElapsed : ONE_DAY;
  const limitForElapsedTime = (principal * DAILY_HARD_DECREASE_BP * elapsed) / (TOTAL_BASIS_POINTS * ONE_DAY);
  const limitPerReport = (principal * HARD_DECREASE_CEILING_BP) / TOTAL_BASIS_POINTS;
  return limitForElapsedTime < limitPerReport ? limitForElapsedTime : limitPerReport;
}

const floorToGwei = (amount: bigint) => (amount / ONE_GWEI) * ONE_GWEI;

describe("Integration: Second opinion", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalState: string;
  let setSecondOpinionHash: (refSlot: BigNumberish, reportHash: string) => Promise<unknown>;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    const { oracleReportSanityChecker } = ctx.contracts;

    const { chainId } = await ethers.provider.getNetwork();
    // Sepolia-specific initialization
    if (chainId === 11155111n) {
      // Sepolia deposit contract address https://sepolia.etherscan.io/token/0x7f02c3e3c98b133055b8b348b2ac625669ed295d
      const sepoliaDepositContractAddress = "0x7f02C3E3c98B133055B8B348B2Ac625669Ed295D";
      const bepoliaWhaleHolder = "0xf97e180c050e5Ab072211Ad2C213Eb5AEE4DF134";
      const BEPOLIA_TO_TRANSFER = 20;

      const bepoliaToken = await ethers.getContractAt("ISepoliaDepositContract", sepoliaDepositContractAddress);
      const bepiloaSigner = await ethers.getImpersonatedSigner(bepoliaWhaleHolder);

      const adapterAddr = await ctx.contracts.stakingRouter.DEPOSIT_CONTRACT();
      await bepoliaToken.connect(bepiloaSigner).transfer(adapterAddr, BEPOLIA_TO_TRANSFER);
    }

    // On Hoodi after SRv3 allocation, a raw router deposit into NOR can return `ZeroDeposits()`
    // unless the test first prepares Lido buffered ETH and module deposit limits.
    await depositValidatorsWithoutReport(ctx, 1n);

    const agentSigner = await ctx.getSigner("agent", AMOUNT);
    if (ctx.isScratch) {
      const secondOpinionAddress = await oracleReportSanityChecker.secondOpinionOracle();
      expect(secondOpinionAddress).not.to.equal(ethers.ZeroAddress);

      const secondOpinion = await ethers.getContractAt("SecondOpinionOracle", secondOpinionAddress);
      expect(await secondOpinion.hasRole(await secondOpinion.DEFAULT_ADMIN_ROLE(), agentSigner.address)).to.equal(true);
      expect(await secondOpinion.hasRole(await secondOpinion.SUBMIT_REPORT_HASH_ROLE(), agentSigner.address)).to.equal(
        true,
      );
      setSecondOpinionHash = (refSlot, reportHash) =>
        secondOpinion.connect(agentSigner).setReportHash(refSlot, reportHash);
    } else {
      const secondOpinion = await ethers.deployContract("SecondOpinionOracle__Mock", []);
      await oracleReportSanityChecker
        .connect(agentSigner)
        .grantRole(await oracleReportSanityChecker.SECOND_OPINION_MANAGER_ROLE(), agentSigner.address);
      await oracleReportSanityChecker.connect(agentSigner).setSecondOpinionOracle(await secondOpinion.getAddress());
      setSecondOpinionHash = (refSlot, reportHash) => secondOpinion.setReportHash(refSlot, reportHash);
    }

    await updateOracleReportLimits(ctx, {
      clRebaseDecreaseSoftBPLimit: SOFT_DECREASE_BP,
      dailyCLRebaseDecreaseHardBPLimit: DAILY_HARD_DECREASE_BP,
      clRebaseDecreaseHardBPLimit: HARD_DECREASE_CEILING_BP,
    });
    // Exact amount boundaries need the whole CL accounting balance in gwei.
    await setWithdrawalVaultBalance(ctx, 0n);
  });

  beforeEach(bailOnFailure);
  beforeEach(async () => (originalState = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(originalState));
  after(async () => await Snapshot.restore(snapshot));

  /**
   * Moves to the next report frame, optionally after missed reports, and returns the values the
   * checker will see for that report: the time since the last processed report and the principal.
   */
  const waitReportFrame = async (missedTime = 0n) => {
    const { accountingOracle, hashConsensus, lido } = ctx.contracts;

    if (missedTime > 0n) await advanceChainTime(missedTime);
    const { reportRefSlot } = await waitNextAvailableReportTime(ctx);

    // AccountingOracle passes `(refSlot - lastProcessingRefSlot) * SECONDS_PER_SLOT` to the checker.
    const { secondsPerSlot } = await hashConsensus.getChainConfig();
    const timeElapsed = (reportRefSlot - (await accountingOracle.getLastProcessingRefSlot())) * secondsPerSlot;

    const { clValidatorsBalanceAtLastReport, clPendingBalanceAtLastReport, depositedForCurrentReport } =
      await lido.getBalanceStats();
    const principal = clValidatorsBalanceAtLastReport + clPendingBalanceAtLastReport + depositedForCurrentReport;
    expect(principal).to.be.gt(0n, "Second-opinion integration requires a non-zero CL baseline");

    return { timeElapsed, principal, hardLimit: hardDecreaseLimit(principal, timeElapsed) };
  };

  const prepareDecreaseReport = async (decrease: bigint) => {
    const { data } = await reportWithoutClActivation(ctx, {
      effectiveClDiff: -decrease,
      waitNextReportTime: false,
      skipWithdrawals: true,
      reportElVault: false,
      dryRun: true,
    });
    return { data, hash: calcReportDataHash(getReportDataItems(data)) };
  };

  const getCLBalance = async () => {
    const { clValidatorsBalanceAtLastReport, clPendingBalanceAtLastReport } =
      await ctx.contracts.lido.getBalanceStats();
    return clValidatorsBalanceAtLastReport + clPendingBalanceAtLastReport;
  };

  context("Second-opinion hash", () => {
    it("rejects a decrease above the soft limit without a second-opinion hash", async () => {
      const { oracleReportSanityChecker } = ctx.contracts;
      const { hardLimit } = await waitReportFrame();
      const { data } = await prepareDecreaseReport(floorToGwei(hardLimit));

      await expect(submitReportDataWithConsensusAndEmptyExtraData(ctx, data)).to.be.revertedWithCustomError(
        oracleReportSanityChecker,
        "SecondOpinionReportNotReady",
      );
    });

    it("rejects a decrease when the attested hash differs", async () => {
      const { oracleReportSanityChecker } = ctx.contracts;
      const { hardLimit } = await waitReportFrame();
      const { data } = await prepareDecreaseReport(floorToGwei(hardLimit));
      const wrongHash = ethers.keccak256(ethers.toUtf8Bytes("different accounting report"));

      await setSecondOpinionHash(data.refSlot, wrongHash);

      await expect(submitReportDataWithConsensusAndEmptyExtraData(ctx, data)).to.be.revertedWithCustomError(
        oracleReportSanityChecker,
        "SecondOpinionReportHashMismatch",
      );
    });
  });

  const dailyHardLimit = (principal: bigint) => (principal * DAILY_HARD_DECREASE_BP) / TOTAL_BASIS_POINTS;
  const hardLimitCeiling = (principal: bigint) => (principal * HARD_DECREASE_CEILING_BP) / TOTAL_BASIS_POINTS;

  // The hard limit grows by the daily limit for each day since the last processed report,
  // counts less than a day as one day, and stops at the per-report ceiling.
  const scenarios = [
    {
      name: "one frame after the previous report",
      missedTime: 0n,
      expectHardLimit: (principal: bigint, hardLimit: bigint) => {
        expect(hardLimit).to.be.gte(dailyHardLimit(principal));
        expect(hardLimit).to.be.lt(hardLimitCeiling(principal));
      },
    },
    {
      name: "after three days of missed reports",
      missedTime: days(3n),
      expectHardLimit: (principal: bigint, hardLimit: bigint) => {
        expect(hardLimit).to.be.gte(3n * dailyHardLimit(principal));
        expect(hardLimit).to.be.lt(hardLimitCeiling(principal));
      },
    },
    {
      name: "after thirty days of missed reports",
      missedTime: days(30n),
      expectHardLimit: (principal: bigint, hardLimit: bigint) => {
        expect(hardLimit).to.equal(hardLimitCeiling(principal));
      },
    },
  ];

  for (const { name, missedTime, expectHardLimit } of scenarios) {
    context(`Hard decrease limit ${name}`, () => {
      it("accepts a decrease at the hard limit with the exact second-opinion hash", async () => {
        const { accountingOracle } = ctx.contracts;
        const { timeElapsed, principal, hardLimit } = await waitReportFrame(missedTime);
        expect(timeElapsed).to.be.gte(missedTime);
        expectHardLimit(principal, hardLimit);

        const decrease = floorToGwei(hardLimit);
        const { data, hash } = await prepareDecreaseReport(decrease);
        await setSecondOpinionHash(data.refSlot, hash);

        await submitReportDataWithConsensusAndEmptyExtraData(ctx, data);

        expect(await accountingOracle.getLastProcessingRefSlot()).to.equal(data.refSlot);
        expect(await getCLBalance()).to.equal(principal - decrease);
      });

      it("rejects a decrease above the hard limit even with the exact second-opinion hash", async () => {
        const { oracleReportSanityChecker } = ctx.contracts;
        const { hardLimit } = await waitReportFrame(missedTime);

        const decrease = floorToGwei(hardLimit) + ONE_GWEI;
        const { data, hash } = await prepareDecreaseReport(decrease);
        await setSecondOpinionHash(data.refSlot, hash);

        await expect(submitReportDataWithConsensusAndEmptyExtraData(ctx, data))
          .to.be.revertedWithCustomError(oracleReportSanityChecker, "CLRebaseDecreaseAboveHardLimit")
          .withArgs(decrease, hardLimit);
      });
    });
  }
});
