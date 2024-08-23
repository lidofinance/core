import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { ether, impersonate } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { report } from "lib/protocol/helpers";

import { Snapshot } from "test/suite";

describe("Negative rebase", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let ethHolder: HardhatEthersSigner;

  beforeEach(async () => {
    ctx = await getProtocolContext();

    [ethHolder] = await ethers.getSigners();
    await setBalance(ethHolder.address, ether("1000000"));
    const network = await ethers.provider.getNetwork();
    console.log("network", network.name);
    if (network.name == "sepolia" || network.name == "sepolia-fork") {
      const sepoliaDepositContractAddress = "0x7f02C3E3c98b133055B8B348B2Ac625669Ed295D";
      const bepoliaWhaleHolder = "0xf97e180c050e5Ab072211Ad2C213Eb5AEE4DF134";
      const BEPOLIA_TO_TRANSFER = 20;

      const bepoliaToken = await ethers.getContractAt("ISepoliaDepositContract", sepoliaDepositContractAddress);
      const bepiloaSigner = await ethers.getImpersonatedSigner(bepoliaWhaleHolder);

      const adapterAddr = await ctx.contracts.stakingRouter.DEPOSIT_CONTRACT();
      await bepoliaToken.connect(bepiloaSigner).transfer(adapterAddr, BEPOLIA_TO_TRANSFER);

      const beaconStat = await ctx.contracts.lido.getBeaconStat();
      if (beaconStat.beaconValidators == 0n) {
        const MAX_DEPOSIT = 96n;
        const CURATED_MODULE_ID = 1n;
        const ZERO_HASH = new Uint8Array(32).fill(0);

        const dsmSigner = await impersonate(ctx.contracts.depositSecurityModule.address, ether("100"));
        await ctx.contracts.lido.connect(dsmSigner).deposit(MAX_DEPOSIT, CURATED_MODULE_ID, ZERO_HASH);
      }
    }

    snapshot = await Snapshot.take();
  });

  afterEach(async () => await Snapshot.restore(snapshot));

  const exitedValidatorsCount = async () => {
    const ids = await ctx.contracts.stakingRouter.getStakingModuleIds();
    let exited = 0n;
    for (const id of ids) {
      const module = await ctx.contracts.stakingRouter.getStakingModule(id);
      exited += module["exitedValidatorsCount"];
    }
    return exited;
  };

  it("Should store correctly exited validators count", async () => {
    const { locator, oracleReportSanityChecker } = ctx.contracts;

    expect((await locator.oracleReportSanityChecker()) == oracleReportSanityChecker.address);

    await report(ctx, {
      clDiff: ether("96"),
      skipWithdrawals: true,
      clAppearedValidators: 3n,
    });

    const currentExited = await exitedValidatorsCount();
    const reportExitedValidators = currentExited + 2n;
    await report(ctx, {
      clDiff: ether("0"),
      skipWithdrawals: true,
      clAppearedValidators: 0n,
      stakingModuleIdsWithNewlyExitedValidators: [1n],
      numExitedValidatorsByStakingModule: [reportExitedValidators],
    });

    const count = await oracleReportSanityChecker.getReportDataCount();
    expect(count).to.be.greaterThanOrEqual(2);

    const lastReportData = await oracleReportSanityChecker.reportData(count - 1n);
    const beforeLastReportData = await oracleReportSanityChecker.reportData(count - 2n);

    expect(lastReportData.totalExitedValidators).to.be.equal(reportExitedValidators);
    expect(beforeLastReportData.totalExitedValidators).to.be.equal(currentExited);

    // for (let i = count - 1n; i >= 0; --i) {
    //   const reportData = await oracleReportSanityChecker.reportData(i);
    //   console.log("reportData", i, reportData);
    // }
  });

  it("Should store correctly many negative rebases", async () => {
    const { locator, oracleReportSanityChecker } = ctx.contracts;

    expect((await locator.oracleReportSanityChecker()) == oracleReportSanityChecker.address);

    await report(ctx, {
      clDiff: ether("96"),
      skipWithdrawals: true,
      clAppearedValidators: 3n,
    });

    const REPORTS_REPEATED = 56;
    const SINGLE_REPORT_DECREASE = -1000000000n;
    for (let i = 0; i < REPORTS_REPEATED; i++) {
      await report(ctx, {
        clDiff: SINGLE_REPORT_DECREASE * BigInt(i + 1),
        skipWithdrawals: true,
      });
    }
    const count = await oracleReportSanityChecker.getReportDataCount();
    expect(count).to.be.greaterThanOrEqual(REPORTS_REPEATED + 1);

    for (let i = count - 1n, j = REPORTS_REPEATED - 1; i >= 0 && j >= 0; --i, --j) {
      const reportData = await oracleReportSanityChecker.reportData(i);
      expect(reportData.negativeCLRebaseWei).to.be.equal(-1n * SINGLE_REPORT_DECREASE * BigInt(j + 1));
    }
    // for (let i = count - 1n; i >= 0; --i) {
    //   const reportData = await oracleReportSanityChecker.reportData(i);
    //   console.log("reportData", i, reportData);
    // }
  });
});
