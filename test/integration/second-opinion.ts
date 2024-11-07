import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { SecondOpinionOracle__Mock } from "typechain-types";

import { ether, impersonate, log, ONE_GWEI } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { finalizeWithdrawalQueue, norEnsureOperators, report, sdvtEnsureOperators } from "lib/protocol/helpers";

import { bailOnFailure, Snapshot } from "test/suite";

const AMOUNT = ether("100");
const MAX_DEPOSIT = 150n;
const CURATED_MODULE_ID = 1n;
const INITIAL_REPORTED_BALANCE = ether("32") * 3n; // 32 ETH * 3 validators

const ZERO_HASH = new Uint8Array(32).fill(0);

// Diff amount is 10% of total supply
function getDiffAmount(totalSupply: bigint): bigint {
  return (totalSupply / 10n / ONE_GWEI) * ONE_GWEI;
}

describe("Second opinion", () => {
  let ctx: ProtocolContext;

  let ethHolder: HardhatEthersSigner;
  let stEthHolder: HardhatEthersSigner;

  let snapshot: string;
  let originalState: string;

  let secondOpinion: SecondOpinionOracle__Mock;
  let totalSupply: bigint;

  before(async () => {
    ctx = await getProtocolContext();

    [stEthHolder, ethHolder] = await ethers.getSigners();

    snapshot = await Snapshot.take();

    const { lido, depositSecurityModule, oracleReportSanityChecker } = ctx.contracts;

    await finalizeWithdrawalQueue(ctx, stEthHolder, ethHolder);

    await norEnsureOperators(ctx, 3n, 5n);
    await sdvtEnsureOperators(ctx, 3n, 5n);

    const { chainId } = await ethers.provider.getNetwork();
    // Sepolia-specific initialization
    if (chainId === 11155111n) {
      // Sepolia deposit contract address https://sepolia.etherscan.io/token/0x7f02c3e3c98b133055b8b348b2ac625669ed295d
      const sepoliaDepositContractAddress = "0x7f02C3E3c98b133055B8B348B2Ac625669Ed295D";
      const bepoliaWhaleHolder = "0xf97e180c050e5Ab072211Ad2C213Eb5AEE4DF134";
      const BEPOLIA_TO_TRANSFER = 20;

      const bepoliaToken = await ethers.getContractAt("ISepoliaDepositContract", sepoliaDepositContractAddress);
      const bepiloaSigner = await ethers.getImpersonatedSigner(bepoliaWhaleHolder);

      const adapterAddr = await ctx.contracts.stakingRouter.DEPOSIT_CONTRACT();
      await bepoliaToken.connect(bepiloaSigner).transfer(adapterAddr, BEPOLIA_TO_TRANSFER);
    }
    const dsmSigner = await impersonate(depositSecurityModule.address, AMOUNT);
    await lido.connect(dsmSigner).deposit(MAX_DEPOSIT, CURATED_MODULE_ID, ZERO_HASH);

    secondOpinion = await ethers.deployContract("SecondOpinionOracle__Mock", []);
    const soAddress = await secondOpinion.getAddress();

    const agentSigner = await ctx.getSigner("agent", AMOUNT);
    await oracleReportSanityChecker
      .connect(agentSigner)
      .grantRole(await oracleReportSanityChecker.SECOND_OPINION_MANAGER_ROLE(), agentSigner.address);

    let { beaconBalance } = await lido.getBeaconStat();
    // Report initial balances if TVL is zero
    if (beaconBalance === 0n) {
      await report(ctx, {
        clDiff: INITIAL_REPORTED_BALANCE,
        clAppearedValidators: 3n,
        excludeVaultsBalances: true,
      });
      beaconBalance = (await lido.getBeaconStat()).beaconBalance;
    }
    totalSupply = beaconBalance;

    await oracleReportSanityChecker.connect(agentSigner).setSecondOpinionOracleAndCLBalanceUpperMargin(soAddress, 74n);
  });

  beforeEach(bailOnFailure);

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot)); // Rollback to the initial state pre deployment

  it("Should fail report without second opinion ready", async () => {
    const { oracleReportSanityChecker } = ctx.contracts;

    const reportedDiff = getDiffAmount(totalSupply);

    await expect(report(ctx, { clDiff: -reportedDiff, excludeVaultsBalances: true })).to.be.revertedWithCustomError(
      oracleReportSanityChecker,
      "NegativeRebaseFailedSecondOpinionReportIsNotReady",
    );
  });

  it("Should correctly report negative rebase with second opinion", async () => {
    const { hashConsensus, accountingOracle } = ctx.contracts;

    const reportedDiff = getDiffAmount(totalSupply);

    // Provide a second opinion
    const curFrame = await hashConsensus.getCurrentFrame();
    const expectedBalance = (totalSupply - reportedDiff) / ONE_GWEI;
    await secondOpinion.addPlainReport(curFrame.reportProcessingDeadlineSlot, expectedBalance, 0n);

    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    await report(ctx, { clDiff: -reportedDiff, excludeVaultsBalances: true });
    const lastProcessingRefSlotAfter = await accountingOracle.getLastProcessingRefSlot();
    expect(lastProcessingRefSlotBefore).to.be.lessThan(
      lastProcessingRefSlotAfter,
      "LastProcessingRefSlot should be updated",
    );
  });

  it("Should fail report with smaller second opinion cl balance", async () => {
    const { hashConsensus, oracleReportSanityChecker } = ctx.contracts;

    const reportedDiff = getDiffAmount(totalSupply);

    const curFrame = await hashConsensus.getCurrentFrame();
    const expectedBalance = (totalSupply - reportedDiff) / ONE_GWEI - 1n;
    await secondOpinion.addPlainReport(curFrame.reportProcessingDeadlineSlot, expectedBalance, 0n);

    await expect(report(ctx, { clDiff: -reportedDiff, excludeVaultsBalances: true })).to.be.revertedWithCustomError(
      oracleReportSanityChecker,
      "NegativeRebaseFailedCLBalanceMismatch",
    );
  });

  it("Should tolerate report with slightly bigger second opinion cl balance", async () => {
    const { hashConsensus, accountingOracle } = ctx.contracts;

    const reportedDiff = getDiffAmount(totalSupply);

    const curFrame = await hashConsensus.getCurrentFrame();
    const expectedBalance = (totalSupply - reportedDiff) / ONE_GWEI;
    // Less than 0.5% diff in balances
    const correction = (expectedBalance * 4n) / 1000n;
    await secondOpinion.addPlainReport(curFrame.reportProcessingDeadlineSlot, expectedBalance + correction, 0n);
    log.debug("Reporting parameters", {
      totalSupply,
      reportedDiff,
      expectedBalance,
      correction,
      reportedBalance: totalSupply - reportedDiff,
    });

    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    await report(ctx, { clDiff: -reportedDiff, excludeVaultsBalances: true });
    const lastProcessingRefSlotAfter = await accountingOracle.getLastProcessingRefSlot();
    expect(lastProcessingRefSlotBefore).to.be.lessThan(
      lastProcessingRefSlotAfter,
      "LastProcessingRefSlot should be updated",
    );
  });

  it("Should fail report with significantly bigger second opinion cl balance", async () => {
    const { hashConsensus, oracleReportSanityChecker } = ctx.contracts;

    const reportedDiff = getDiffAmount(totalSupply);

    const curFrame = await hashConsensus.getCurrentFrame();
    const expectedBalance = (totalSupply - reportedDiff) / ONE_GWEI;
    // More than 0.5% diff in balances
    const correction = (expectedBalance * 9n) / 1000n;
    await secondOpinion.addPlainReport(curFrame.reportProcessingDeadlineSlot, expectedBalance + correction, 0n);
    log.debug("Reporting parameters", {
      totalSupply,
      reportedDiff,
      expectedBalance,
      correction,
      "expected + correction": expectedBalance + correction,
    });

    await expect(report(ctx, { clDiff: -reportedDiff, excludeVaultsBalances: true })).to.be.revertedWithCustomError(
      oracleReportSanityChecker,
      "NegativeRebaseFailedCLBalanceMismatch",
    );
  });
});
