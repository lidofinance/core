import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { ether } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { report } from "lib/protocol/helpers";

import { Snapshot } from "test/suite";

describe("Negative rebase", () => {
  let ctx: ProtocolContext;
  let beforeSnapshot: string;
  let beforeEachSnapshot: string;
  let ethHolder: HardhatEthersSigner;

  before(async () => {
    beforeSnapshot = await Snapshot.take();
    ctx = await getProtocolContext();

    [ethHolder] = await ethers.getSigners();
    await setBalance(ethHolder.address, ether("1000000"));
    const network = await ethers.provider.getNetwork();

    // In case of sepolia network, transfer some BEPOLIA tokens to the adapter contract
    if (network.name == "sepolia" || network.name == "sepolia-fork") {
      const sepoliaDepositContractAddress = "0x7f02C3E3c98b133055B8B348B2Ac625669Ed295D";
      const bepoliaWhaleHolder = "0xf97e180c050e5Ab072211Ad2C213Eb5AEE4DF134";
      const BEPOLIA_TO_TRANSFER = 20;

      const bepoliaToken = await ethers.getContractAt("ISepoliaDepositContract", sepoliaDepositContractAddress);
      const bepiloaSigner = await ethers.getImpersonatedSigner(bepoliaWhaleHolder);

      const adapterAddr = await ctx.contracts.stakingRouter.DEPOSIT_CONTRACT();
      await bepoliaToken.connect(bepiloaSigner).transfer(adapterAddr, BEPOLIA_TO_TRANSFER);
    }
  });

  after(async () => await Snapshot.restore(beforeSnapshot));

  beforeEach(async () => (beforeEachSnapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(beforeEachSnapshot));

  const exitedValidatorsCount = async () => {
    const ids = await ctx.contracts.stakingRouter.getStakingModuleIds();
    const exited = new Map<bigint, bigint>();
    for (const id of ids) {
      const module = await ctx.contracts.stakingRouter.getStakingModule(id);
      exited.set(id, module["exitedValidatorsCount"]);
    }
    return exited;
  };

  it("Should store correctly exited validators count", async () => {
    const { locator, oracleReportSanityChecker } = ctx.contracts;

    expect((await locator.oracleReportSanityChecker()) == oracleReportSanityChecker.address);

    const currentExited = await exitedValidatorsCount();
    const reportExitedValidators = currentExited.get(1n) ?? 0n;
    await report(ctx, {
      clDiff: ether("0"),
      skipWithdrawals: true,
      clAppearedValidators: 0n,
      stakingModuleIdsWithNewlyExitedValidators: [1n],
      numExitedValidatorsByStakingModule: [reportExitedValidators + 2n],
    });

    const count = await oracleReportSanityChecker.getReportDataCount();
    expect(count).to.be.greaterThanOrEqual(2);

    const lastReportData = await oracleReportSanityChecker.reportData(count - 1n);
    const beforeLastReportData = await oracleReportSanityChecker.reportData(count - 2n);

    const lastExitedTotal = Array.from(currentExited.values()).reduce((acc, val) => acc + val, 0n);

    expect(lastReportData.totalExitedValidators).to.be.equal(lastExitedTotal + 2n);
    expect(beforeLastReportData.totalExitedValidators).to.be.equal(lastExitedTotal);
  });

  it("Should store correctly many negative rebases", async () => {
    const { locator, oracleReportSanityChecker } = ctx.contracts;

    expect((await locator.oracleReportSanityChecker()) == oracleReportSanityChecker.address);

    const REPORTS_REPEATED = 56;
    const SINGLE_REPORT_DECREASE = -1000000000n;
    for (let i = 0; i < REPORTS_REPEATED; i++) {
      await report(ctx, {
        clDiff: SINGLE_REPORT_DECREASE * BigInt(i + 1),
        skipWithdrawals: true,
        reportWithdrawalsVault: false,
        reportElVault: false,
      });
    }
    const count = await oracleReportSanityChecker.getReportDataCount();
    expect(count).to.be.greaterThanOrEqual(REPORTS_REPEATED + 1);

    for (let i = count - 1n, j = REPORTS_REPEATED - 1; i >= 0 && j >= 0; --i, --j) {
      const reportData = await oracleReportSanityChecker.reportData(i);
      expect(reportData.negativeCLRebaseWei).to.be.equal(-1n * SINGLE_REPORT_DECREASE * BigInt(j + 1));
    }
  });
});
