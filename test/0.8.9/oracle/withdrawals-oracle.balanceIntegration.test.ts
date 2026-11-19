import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__Harness, OracleReportSanityChecker, WithdrawalsOracle__Harness } from "typechain-types";

import { WITHDRAWALS_ORACLE_CONSENSUS_VERSION } from "lib";

import {
  calcWithdrawalsOracleReportDataHash,
  deployWithdrawalsOracle,
  encodeWithdrawalRequests,
  initWithdrawalsOracle,
  WithdrawalRequest,
  WithdrawalsOracleReportFields,
} from "test/deploy";
import { Snapshot } from "test/suite";

const LEGACY_MODULE_ID = 1; // Module with 0x01 withdrawal credentials (32 ETH)
const MAXEB_MODULE_ID_1 = 3; // Module with 0x02 withdrawal credentials (2048 ETH)
const MAXEB_MODULE_ID_2 = 5; // Another module with 0x02 withdrawal credentials

// FWR weights from OracleReportSanityChecker set by the fixture
const LEGACY_MODULE_MAX_BALANCE_ETH = 32n; // 32 ETH
const MAXEB_MODULE_MAX_BALANCE_ETH = 2048n; // 2048 ETH

const GWEI_PER_ETH = 10n ** 9n;

describe("WithdrawalsOracle.sol:balanceIntegration", () => {
  let consensus: HashConsensus__Harness;
  let oracle: WithdrawalsOracle__Harness;
  let oracleReportSanityChecker: OracleReportSanityChecker;
  let admin: HardhatEthersSigner;
  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;
  let member3: HardhatEthersSigner;

  let oracleVersion: bigint;

  const fwr = (moduleId: number, nodeOpId: number, keyIndex: number) => ({ moduleId, nodeOpId, keyIndex, amount: 0n });
  const pwr = (moduleId: number, nodeOpId: number, keyIndex: number, amount: bigint) => ({
    moduleId,
    nodeOpId,
    keyIndex,
    amount,
  });

  const triggerConsensusOnHash = async (hash: string) => {
    const { refSlot } = await consensus.getCurrentFrame();
    await consensus.connect(member1).submitReport(refSlot, hash, WITHDRAWALS_ORACLE_CONSENSUS_VERSION);
    await consensus.connect(member3).submitReport(refSlot, hash, WITHDRAWALS_ORACLE_CONSENSUS_VERSION);
    expect((await consensus.getConsensusState()).consensusReport).to.equal(hash);
  };

  // Builds a report from the requests and brings the committee to consensus on its hash
  const prepareReportAndSubmitHash = async (requests: WithdrawalRequest[]): Promise<WithdrawalsOracleReportFields> => {
    const { refSlot } = await consensus.getCurrentFrame();
    const reportData = {
      consensusVersion: WITHDRAWALS_ORACLE_CONSENSUS_VERSION,
      refSlot,
      requestsCount: requests.length,
      data: encodeWithdrawalRequests(requests),
    };

    await triggerConsensusOnHash(calcWithdrawalsOracleReportDataHash(reportData));

    return reportData;
  };

  const setLimit = async (limitEth: bigint) => {
    await oracleReportSanityChecker.connect(admin).setMaxBalanceExitRequestedPerReportInEth(limitEth);
  };

  before(async () => {
    [admin, member1, member2, member3] = await ethers.getSigners();

    const deployed = await deployWithdrawalsOracle(admin.address);
    consensus = deployed.consensus;
    oracle = deployed.oracle;
    oracleReportSanityChecker = deployed.oracleReportSanityChecker;

    // 0x02 modules accept partial withdrawals
    await deployed.stakingRouter.setStakingModulePartialWithdrawalsAllowed(MAXEB_MODULE_ID_1, true);
    await deployed.stakingRouter.setStakingModulePartialWithdrawalsAllowed(MAXEB_MODULE_ID_2, true);

    await initWithdrawalsOracle({
      admin: admin.address,
      oracle,
      consensus,
      resumeAfterDeploy: true,
    });

    await consensus.addMember(member1, 1);
    await consensus.addMember(member2, 2);
    await consensus.addMember(member3, 2);

    oracleVersion = await oracle.getContractVersion();
  });

  describe("Balance calculation integration with sanity checker", () => {
    let originalState: string;

    before(async () => {
      // Grant the role to admin for setting limits
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(await oracleReportSanityChecker.MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE(), admin.address);
    });

    beforeEach(async () => {
      originalState = await Snapshot.take();
    });

    afterEach(async () => {
      await Snapshot.restore(originalState);
    });

    context("FWR", () => {
      it("should pass sanity check for legacy validators", async () => {
        // Set limit to allow 10 legacy validators (320 ETH)
        await setLimit(LEGACY_MODULE_MAX_BALANCE_ETH * 10n);

        const reportData = await prepareReportAndSubmitHash([
          fwr(LEGACY_MODULE_ID, 1, 1),
          fwr(LEGACY_MODULE_ID, 1, 2),
          fwr(LEGACY_MODULE_ID, 1, 3),
        ]);

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).not.to.be.reverted;
      });

      it("should pass sanity check for MaxEB validators at the limit", async () => {
        // Set limit to allow exactly 2 MaxEB validators (4096 ETH)
        await setLimit(MAXEB_MODULE_MAX_BALANCE_ETH * 2n);

        const reportData = await prepareReportAndSubmitHash([
          fwr(MAXEB_MODULE_ID_1, 1, 10),
          fwr(MAXEB_MODULE_ID_2, 2, 20),
        ]);

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).not.to.be.reverted;
      });

      const mixedRequests = [
        fwr(LEGACY_MODULE_ID, 1, 1),
        fwr(LEGACY_MODULE_ID, 1, 2),
        fwr(LEGACY_MODULE_ID, 1, 3),
        fwr(LEGACY_MODULE_ID, 1, 4),
        fwr(LEGACY_MODULE_ID, 1, 5),
        fwr(MAXEB_MODULE_ID_1, 2, 20),
      ];
      // 5 legacy (160 ETH) + 1 MaxEB (2048 ETH) = 2208 ETH
      const mixedTotal = LEGACY_MODULE_MAX_BALANCE_ETH * 5n + MAXEB_MODULE_MAX_BALANCE_ETH;

      it("should pass sanity check for mixed validators at the limit", async () => {
        await setLimit(mixedTotal);

        const reportData = await prepareReportAndSubmitHash(mixedRequests);

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).not.to.be.reverted;
      });

      it("should revert if mixed validators exceed the limit", async () => {
        await setLimit(mixedTotal - 1n);

        const reportData = await prepareReportAndSubmitHash(mixedRequests);

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
          .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectSumOfExitBalancePerReport")
          .withArgs(mixedTotal);
      });
    });

    context("PWR", () => {
      it("should weigh a PWR at its amount, not at the module weight", async () => {
        await setLimit(100n);

        const reportData = await prepareReportAndSubmitHash([pwr(MAXEB_MODULE_ID_1, 1, 10, 100n * GWEI_PER_ETH)]);

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).not.to.be.reverted;
      });

      it("should revert if rounding the PWR amount up exceeds the limit", async () => {
        await setLimit(100n);

        const reportData = await prepareReportAndSubmitHash([pwr(MAXEB_MODULE_ID_1, 1, 10, 100n * GWEI_PER_ETH + 1n)]);

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
          .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectSumOfExitBalancePerReport")
          .withArgs(101n);
      });

      it("should pass a mixed PWR and FWR report at the limit", async () => {
        await setLimit(100n);

        // 32 ETH FWR + 68 ETH PWR = 100 ETH
        const reportData = await prepareReportAndSubmitHash([
          fwr(LEGACY_MODULE_ID, 1, 1),
          pwr(MAXEB_MODULE_ID_1, 1, 10, 68n * GWEI_PER_ETH),
        ]);

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).not.to.be.reverted;
      });

      it("should revert a mixed PWR and FWR report over the limit", async () => {
        await setLimit(100n);

        // 32 ETH FWR + 68 ETH and 1 gwei PWR = 101 ETH after rounding up
        const reportData = await prepareReportAndSubmitHash([
          fwr(LEGACY_MODULE_ID, 1, 1),
          pwr(MAXEB_MODULE_ID_1, 1, 10, 68n * GWEI_PER_ETH + 1n),
        ]);

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
          .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectSumOfExitBalancePerReport")
          .withArgs(101n);
      });
    });
  });
});
