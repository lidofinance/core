import { expect } from "chai";
import type { BigNumberish } from "ethers";
import { ethers } from "hardhat";

import { ether, ONE_GWEI } from "lib";
import {
  calcReportDataHash,
  depositValidatorsWithoutReport,
  getProtocolContext,
  getReportDataItems,
  ProtocolContext,
  reportWithoutClActivation,
  submitReportDataWithConsensusAndEmptyExtraData,
} from "lib/protocol";

import { bailOnFailure, Snapshot } from "test/suite";

const AMOUNT = ether("100");

function getExceptionalDecrease(totalCLBalance: bigint): bigint {
  // The configured soft decrease limit is zero and the hard limit is 5%.
  // A 1% decrease therefore requires, and can be rescued by, second opinion.
  return (totalCLBalance / 100n / ONE_GWEI) * ONE_GWEI;
}

describe("Integration: Second opinion", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalState: string;
  let setSecondOpinionHash: (refSlot: BigNumberish, reportHash: string) => Promise<unknown>;
  let reportedDecrease: bigint;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    const { lido, oracleReportSanityChecker } = ctx.contracts;

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

    const { clValidatorsBalanceAtLastReport, clPendingBalanceAtLastReport } = await lido.getBalanceStats();
    const totalCLBalance = clValidatorsBalanceAtLastReport + clPendingBalanceAtLastReport;
    expect(totalCLBalance).to.be.gt(0n, "Second-opinion integration requires a non-zero CL baseline");

    reportedDecrease = getExceptionalDecrease(totalCLBalance);
    expect(reportedDecrease).to.be.gt(0n);
  });

  beforeEach(bailOnFailure);
  beforeEach(async () => (originalState = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(originalState));
  after(async () => await Snapshot.restore(snapshot));

  const prepareExceptionalReport = async () => {
    const { data } = await reportWithoutClActivation(ctx, {
      effectiveClDiff: -reportedDecrease,
      reportElVault: false,
      dryRun: true,
    });
    return { data, hash: calcReportDataHash(getReportDataItems(data)) };
  };

  it("rejects an exceptional report without a second-opinion hash", async () => {
    const { oracleReportSanityChecker } = ctx.contracts;
    const { data } = await prepareExceptionalReport();

    await expect(submitReportDataWithConsensusAndEmptyExtraData(ctx, data)).to.be.revertedWithCustomError(
      oracleReportSanityChecker,
      "SecondOpinionReportNotReady",
    );
  });

  it("accepts an exceptional report with the exact consensus hash", async () => {
    const { accountingOracle } = ctx.contracts;
    const { data, hash } = await prepareExceptionalReport();

    await setSecondOpinionHash(data.refSlot, hash);

    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    await submitReportDataWithConsensusAndEmptyExtraData(ctx, data);
    expect(await accountingOracle.getLastProcessingRefSlot()).to.be.gt(lastProcessingRefSlotBefore);
  });

  it("rejects an exceptional report when the attested hash differs", async () => {
    const { oracleReportSanityChecker } = ctx.contracts;
    const { data } = await prepareExceptionalReport();
    const wrongHash = ethers.keccak256(ethers.toUtf8Bytes("different accounting report"));

    await setSecondOpinionHash(data.refSlot, wrongHash);

    await expect(submitReportDataWithConsensusAndEmptyExtraData(ctx, data)).to.be.revertedWithCustomError(
      oracleReportSanityChecker,
      "SecondOpinionReportHashMismatch",
    );
  });
});
