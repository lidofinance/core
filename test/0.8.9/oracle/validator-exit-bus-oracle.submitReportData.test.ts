import { expect } from "chai";
import { ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  HashConsensus__Harness,
  OracleReportSanityChecker,
  StakingRouter__MockForValidatorsExitBus,
  TriggerableWithdrawalsBus__MockForVEB,
  ValidatorsExitBus__Harness,
} from "typechain-types";

import { VEBO_CONSENSUS_VERSION } from "lib";

import {
  calcVEBOReportDataHash,
  computeTimestampAtSlot,
  deployVEBO,
  encodeWithdrawalRequests,
  initVEBO,
  makeMockPubkey,
  MAX_REQUESTS_PER_REPORT,
  VEBOReportFields,
  WithdrawalRequest,
} from "test/deploy";
import { Snapshot } from "test/suite";

const HASH_1 = "0x1111111111111111111111111111111111111111111111111111111111111111";
const GWEI_PER_ETH = 10n ** 9n;

describe("ValidatorsExitBusOracle.sol:submitReportData", () => {
  let consensus: HashConsensus__Harness;
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;
  let oracleReportSanityChecker: OracleReportSanityChecker;
  let stakingRouter: StakingRouter__MockForValidatorsExitBus;
  let triggerableWithdrawalsBus: TriggerableWithdrawalsBus__MockForVEB;

  let oracleVersion: bigint;

  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;
  let member3: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const LAST_PROCESSING_REF_SLOT = 1;

  const triggerConsensusOnHash = async (hash: string) => {
    const { refSlot } = await consensus.getCurrentFrame();
    await consensus.connect(member1).submitReport(refSlot, hash, VEBO_CONSENSUS_VERSION);
    await consensus.connect(member3).submitReport(refSlot, hash, VEBO_CONSENSUS_VERSION);
    expect((await consensus.getConsensusState()).consensusReport).to.equal(hash);
  };

  // Builds a report from the requests and brings the committee to consensus on its hash
  const prepareReportAndSubmitHash = async (
    requests: WithdrawalRequest[] = [{ moduleId: 5, nodeOpId: 1, keyIndex: 1, amount: 0n }],
    options: { reportFields?: Partial<VEBOReportFields> } = {},
  ) => {
    const { refSlot } = await consensus.getCurrentFrame();
    const reportData: VEBOReportFields = {
      consensusVersion: VEBO_CONSENSUS_VERSION,
      refSlot,
      requestsCount: requests.length,
      data: encodeWithdrawalRequests(requests),
      ...options.reportFields,
    };

    const reportHash = calcVEBOReportDataHash(reportData);

    await triggerConsensusOnHash(reportHash);

    return { reportData, reportHash };
  };

  const deploy = async () => {
    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;
    oracleReportSanityChecker = deployed.oracleReportSanityChecker;
    stakingRouter = deployed.stakingRouter;
    triggerableWithdrawalsBus = deployed.triggerableWithdrawalsBus;

    await initVEBO({
      admin: admin.address,
      oracle,
      consensus,
      resumeAfterDeploy: true,
      lastProcessingRefSlot: LAST_PROCESSING_REF_SLOT,
    });

    oracleVersion = await oracle.getContractVersion();

    await consensus.addMember(member1, 1);
    await consensus.addMember(member2, 2);
    await consensus.addMember(member3, 2);
  };

  before(async () => {
    [admin, member1, member2, member3, stranger] = await ethers.getSigners();

    await deploy();
  });

  context("discarded report prevents data submit", () => {
    let reportData: VEBOReportFields;
    let reportHash: string;
    let originalState: string;

    before(async () => {
      originalState = await Snapshot.take();
    });

    after(async () => await Snapshot.restore(originalState));

    it("report is discarded", async () => {
      ({ reportData, reportHash } = await prepareReportAndSubmitHash());
      const { refSlot } = await consensus.getCurrentFrame();

      // change of mind
      const tx = await consensus.connect(member3).submitReport(refSlot, HASH_1, VEBO_CONSENSUS_VERSION);

      await expect(tx).to.emit(oracle, "ReportDiscarded").withArgs(refSlot, reportHash);
    });

    it("processing state reverts to pre-report state ", async () => {
      const state = await oracle.getProcessingState();
      expect(state.dataHash).to.equal(ZeroHash);
      expect(state.dataSubmitted).to.equal(false);
      expect(state.requestsCount).to.equal(0);
      expect(state.requestsSubmitted).to.equal(0);
    });

    it("reverts on trying to submit the discarded report", async () => {
      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
        .to.be.revertedWithCustomError(oracle, "UnexpectedDataHash")
        .withArgs(ZeroHash, reportHash);
    });
  });

  context("_handleConsensusReportData", () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();
      await consensus.advanceTimeToNextFrameStart();
    });

    afterEach(async () => await Snapshot.restore(originalState));

    context("enforces data length", () => {
      it("reverts if there is more data than expected", async () => {
        const { refSlot } = await consensus.getCurrentFrame();
        const requests = [{ moduleId: 5, nodeOpId: 3, keyIndex: 1, amount: 0n }];
        const { reportData } = await prepareReportAndSubmitHash(requests, {
          reportFields: { refSlot, data: encodeWithdrawalRequests(requests) + "aaaaaaaaaaaaaaaaaa" },
        });

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).to.be.revertedWithCustomError(
          oracle,
          "InvalidRequestsDataLength",
        );
      });

      it("reverts if there is less data than expected", async () => {
        const { refSlot } = await consensus.getCurrentFrame();
        const requests = [{ moduleId: 5, nodeOpId: 3, keyIndex: 1, amount: 0n }];
        const data = encodeWithdrawalRequests(requests);

        const { reportData } = await prepareReportAndSubmitHash(requests, {
          reportFields: {
            data: data.slice(0, data.length - 18),
            refSlot,
          },
        });

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).to.be.revertedWithCustomError(
          oracle,
          "InvalidRequestsDataLength",
        );
      });

      it("pass if there is exact amount of data", async () => {
        const { reportData } = await prepareReportAndSubmitHash([
          { moduleId: 5, nodeOpId: 3, keyIndex: 1, amount: 0n },
        ]);
        await oracle.connect(member1).submitReportData(reportData, oracleVersion);
      });
    });

    context("enforces max requests per report", () => {
      const makeFwrRequests = (count: number) =>
        Array.from({ length: count }, (_, i) => ({ moduleId: 1, nodeOpId: 1, keyIndex: i, amount: 0n }));

      it("MAX_REQUESTS_PER_REPORT is set from the constructor", async () => {
        expect(await oracle.MAX_REQUESTS_PER_REPORT()).to.equal(MAX_REQUESTS_PER_REPORT);
      });

      it("pass if requests count equals the limit", async () => {
        // the mock bus would run out of gas storing 400 intents from zero slots
        await triggerableWithdrawalsBus.setStoreIntents(false);

        const { reportData } = await prepareReportAndSubmitHash(makeFwrRequests(MAX_REQUESTS_PER_REPORT));
        await oracle.connect(member1).submitReportData(reportData, oracleVersion);

        expect(await triggerableWithdrawalsBus.receivedIntentsCount()).to.equal(MAX_REQUESTS_PER_REPORT);
      });

      it("reverts if requests count exceeds the limit", async () => {
        const { reportData } = await prepareReportAndSubmitHash(makeFwrRequests(MAX_REQUESTS_PER_REPORT + 1));
        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
          .to.be.revertedWithCustomError(oracle, "TooManyRequestsInReport")
          .withArgs(MAX_REQUESTS_PER_REPORT + 1, MAX_REQUESTS_PER_REPORT);
      });
    });

    context("validates partial withdrawals", () => {
      const MAX_PWR_AMOUNT_GWEI = 2016n * GWEI_PER_ETH;

      it("reverts if module does not allow partial withdrawals", async () => {
        const { reportData } = await prepareReportAndSubmitHash([
          { moduleId: 5, nodeOpId: 3, keyIndex: 1, amount: 32n * GWEI_PER_ETH },
        ]);

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
          .to.be.revertedWithCustomError(oracle, "PartialWithdrawalsNotAllowed")
          .withArgs(5);
      });

      it("pass if PWR amount equals MAX_PWR_AMOUNT", async () => {
        await stakingRouter.setStakingModulePartialWithdrawalsAllowed(5, true);
        const { reportData } = await prepareReportAndSubmitHash([
          { moduleId: 5, nodeOpId: 3, keyIndex: 1, amount: MAX_PWR_AMOUNT_GWEI },
        ]);

        await oracle.connect(member1).submitReportData(reportData, oracleVersion);
      });

      it("reverts if PWR amount exceeds MAX_PWR_AMOUNT", async () => {
        await stakingRouter.setStakingModulePartialWithdrawalsAllowed(5, true);
        const { reportData } = await prepareReportAndSubmitHash([
          { moduleId: 5, nodeOpId: 3, keyIndex: 1, amount: MAX_PWR_AMOUNT_GWEI + 1n },
        ]);

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
          .to.be.revertedWithCustomError(oracle, "WithdrawalAmountTooLarge")
          .withArgs(0, MAX_PWR_AMOUNT_GWEI + 1n);
      });
    });

    context("passes withdrawal intents to the bus", () => {
      // PWR first and module 5 again after module 1: no sorting, module cache is refreshed on every change
      const requests = [
        { moduleId: 5, nodeOpId: 3, keyIndex: 7, amount: 10n * GWEI_PER_ETH }, // PWR
        { moduleId: 1, nodeOpId: 1, keyIndex: 2, amount: 0n }, // FWR
        { moduleId: 5, nodeOpId: 2, keyIndex: 4, amount: 0n }, // FWR
      ];

      beforeEach(async () => {
        await stakingRouter.setStakingModulePartialWithdrawalsAllowed(5, true);
      });

      it("passes intents to the bus in report order", async () => {
        const { reportData } = await prepareReportAndSubmitHash(requests);
        await oracle.connect(member1).submitReportData(reportData, oracleVersion);

        const intents = await triggerableWithdrawalsBus.getWithdrawalIntents();
        expect(intents.length).to.equal(requests.length);
        intents.forEach((intent, i) => {
          const { nodeOpId, keyIndex, amount } = requests[i];
          expect(intent.amount).to.equal(amount);
          expect(intent.pubkey).to.equal(makeMockPubkey(nodeOpId, keyIndex));
        });
      });

      it("calls the bus once per report", async () => {
        const { reportData } = await prepareReportAndSubmitHash(requests);
        await oracle.connect(member1).submitReportData(reportData, oracleVersion);

        expect(await triggerableWithdrawalsBus.addWithdrawalIntentsCalls()).to.equal(1);
      });

      it("reverts the whole report if the bus reverts", async () => {
        await triggerableWithdrawalsBus.setRevertOnAdd(true);
        const stateBefore = await oracle.getDataProcessingState();
        const totalBefore = await oracle.getTotalRequestsProcessed();

        const { reportData } = await prepareReportAndSubmitHash(requests);
        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).to.be.revertedWith(
          "TWB mock: revert",
        );

        expect(await oracle.getDataProcessingState()).to.deep.equal(stateBefore);
        expect(await oracle.getTotalRequestsProcessed()).to.equal(totalBefore);
      });
    });

    context("invokes sanity check", () => {
      before(async () => {
        await oracleReportSanityChecker.grantRole(
          await oracleReportSanityChecker.MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE(),
          admin.address,
        );
      });

      it("reverts if request limit is reached", async () => {
        // Module 5 (not curated) = 2048 ETH per validator
        // Set limit to 1 validator worth
        const exitRequestsLimit = 2_048n; // 2048 ETH
        await oracleReportSanityChecker.connect(admin).setMaxBalanceExitRequestedPerReportInEth(exitRequestsLimit);
        const { reportData } = await prepareReportAndSubmitHash([
          { moduleId: 5, nodeOpId: 3, keyIndex: 1, amount: 0n },
          { moduleId: 5, nodeOpId: 3, keyIndex: 2, amount: 0n },
        ]);
        // 2 validators = 4096 ETH (actual balance that exceeds the limit)
        const actualBalance = 2_048n * 2n;
        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
          .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectSumOfExitBalancePerReport")
          .withArgs(actualBalance);
      });
      it("pass if requests amount equals to limit", async () => {
        // Module 5 (not curated) = 2048 ETH per validator
        // Set limit to exactly 1 validator worth
        const exitRequestsLimit = 2_048n; // 2048 ETH
        await oracleReportSanityChecker.connect(admin).setMaxBalanceExitRequestedPerReportInEth(exitRequestsLimit);
        const { reportData } = await prepareReportAndSubmitHash([
          { moduleId: 5, nodeOpId: 3, keyIndex: 1, amount: 0n },
        ]);
        await oracle.connect(member1).submitReportData(reportData, oracleVersion);
      });
    });

    context("validates data.requestsCount field with given data", () => {
      it("reverts if requestsCount does not match with encoded data size", async () => {
        const { reportData } = await prepareReportAndSubmitHash(
          [{ moduleId: 5, nodeOpId: 3, keyIndex: 1, amount: 0n }],
          {
            reportFields: { requestsCount: 2 },
          },
        );

        await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).to.be.revertedWithCustomError(
          oracle,
          "UnexpectedRequestsDataLength",
        );
      });
    });

    it("reverts if moduleId equals zero", async () => {
      const { reportData } = await prepareReportAndSubmitHash([{ moduleId: 0, nodeOpId: 3, keyIndex: 1, amount: 0n }]);

      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).to.be.revertedWithCustomError(
        oracle,
        "InvalidModuleId",
      );
    });

    it("emits WithdrawalRequested event for every request in report order", async () => {
      await stakingRouter.setStakingModulePartialWithdrawalsAllowed(5, true);

      const requests = [
        { moduleId: 4, nodeOpId: 2, keyIndex: 1, amount: 0n }, // FWR
        { moduleId: 5, nodeOpId: 3, keyIndex: 2, amount: 32n * GWEI_PER_ETH }, // PWR
      ];
      const { reportData } = await prepareReportAndSubmitHash(requests);
      const tx = await oracle.connect(member1).submitReportData(reportData, oracleVersion);
      const receipt = await tx.wait();

      const events = await oracle.queryFilter(oracle.filters.WithdrawalRequested(), receipt!.blockNumber);
      expect(events.length).to.equal(requests.length);
      events.forEach((event, i) => {
        const { moduleId, nodeOpId, keyIndex, amount } = requests[i];
        expect(event.args).to.deep.equal([moduleId, nodeOpId, makeMockPubkey(nodeOpId, keyIndex), amount]);
      });
    });

    it("updates processing state", async () => {
      const storageBefore = await oracle.getDataProcessingState();
      expect(storageBefore.refSlot).to.equal(0);
      expect(storageBefore.requestsCount).to.equal(0);

      expect(storageBefore.requestsProcessed).to.equal(0);

      const { refSlot } = await consensus.getCurrentFrame();
      const requests = [
        { moduleId: 4, nodeOpId: 3, keyIndex: 1, amount: 0n },
        { moduleId: 5, nodeOpId: 3, keyIndex: 2, amount: 0n },
      ];
      const { reportData } = await prepareReportAndSubmitHash(requests);
      await oracle.connect(member1).submitReportData(reportData, oracleVersion);

      const storageAfter = await oracle.getDataProcessingState();
      expect(storageAfter.refSlot).to.equal(refSlot);
      expect(storageAfter.requestsCount).to.equal(requests.length);
      expect(storageAfter.requestsProcessed).to.equal(requests.length);
    });

    it("updates total requests processed count", async () => {
      let currentCount = 0;
      const countStep0 = await oracle.getTotalRequestsProcessed();
      expect(countStep0).to.equal(currentCount);

      // Step 1 — process 1 item
      const requestsStep1 = [{ moduleId: 3, nodeOpId: 1, keyIndex: 1, amount: 0n }];
      const { reportData: reportStep1 } = await prepareReportAndSubmitHash(requestsStep1);
      await oracle.connect(member1).submitReportData(reportStep1, oracleVersion);
      const countStep1 = await oracle.getTotalRequestsProcessed();
      currentCount += requestsStep1.length;
      expect(countStep1).to.equal(currentCount);

      // Step 2 — process 2 items
      await consensus.advanceTimeToNextFrameStart();
      const requestsStep2 = [
        { moduleId: 4, nodeOpId: 2, keyIndex: 1, amount: 0n },
        { moduleId: 5, nodeOpId: 3, keyIndex: 2, amount: 0n },
      ];
      const { reportData: reportStep2 } = await prepareReportAndSubmitHash(requestsStep2);
      await oracle.connect(member1).submitReportData(reportStep2, oracleVersion);
      const countStep2 = await oracle.getTotalRequestsProcessed();
      currentCount += requestsStep2.length;
      expect(countStep2).to.equal(currentCount);

      // Step 3 — process no items
      await consensus.advanceTimeToNextFrameStart();
      const requestsStep3: WithdrawalRequest[] = [];
      const { reportData: reportStep3 } = await prepareReportAndSubmitHash(requestsStep3);
      await oracle.connect(member1).submitReportData(reportStep3, oracleVersion);

      const countStep3 = await oracle.getTotalRequestsProcessed();
      currentCount += requestsStep3.length;
      expect(countStep3).to.equal(currentCount);
    });
  });

  context(`only consensus member or SUBMIT_DATA_ROLE can submit report on unpaused contract`, () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();
      await consensus.advanceTimeToNextFrameStart();
    });

    afterEach(async () => await Snapshot.restore(originalState));

    it("reverts on stranger", async () => {
      const { reportData } = await prepareReportAndSubmitHash();
      await expect(oracle.connect(stranger).submitReportData(reportData, oracleVersion)).to.be.revertedWithCustomError(
        oracle,
        "SenderNotAllowed",
      );
    });

    it("SUBMIT_DATA_ROLE is allowed", async () => {
      await oracle.grantRole(await oracle.SUBMIT_DATA_ROLE(), stranger, { from: admin });
      await consensus.advanceTimeToNextFrameStart();
      const { reportData } = await prepareReportAndSubmitHash();
      await oracle.connect(stranger).submitReportData(reportData, oracleVersion);
    });

    it("consensus member is allowed", async () => {
      expect(await consensus.getIsMember(member1)).to.equal(true);
      await consensus.advanceTimeToNextFrameStart();
      const { reportData } = await prepareReportAndSubmitHash();
      await oracle.connect(member1).submitReportData(reportData, oracleVersion);
    });

    it("reverts on paused contract", async () => {
      await consensus.advanceTimeToNextFrameStart();
      const PAUSE_INFINITELY = await oracle.PAUSE_INFINITELY();
      await oracle.pauseFor(PAUSE_INFINITELY, { from: admin });
      const { reportData } = await prepareReportAndSubmitHash();
      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion)).to.be.revertedWithCustomError(
        oracle,
        "ResumedExpected",
      );
    });
  });

  context("invokes internal baseOracle checks", () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();
      await consensus.advanceTimeToNextFrameStart();
    });

    afterEach(async () => await Snapshot.restore(originalState));

    it(`reverts on contract version mismatch`, async () => {
      const { reportData } = await prepareReportAndSubmitHash();

      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion + 1n))
        .to.be.revertedWithCustomError(oracle, "UnexpectedContractVersion")
        .withArgs(oracleVersion, oracleVersion + 1n);
    });

    it("reverts on hash mismatch", async () => {
      const requests = [{ moduleId: 5, nodeOpId: 1, keyIndex: 1, amount: 0n }];
      const { reportHash: actualReportHash } = await prepareReportAndSubmitHash(requests);
      const newRequests = [{ moduleId: 5, nodeOpId: 1, keyIndex: 2, amount: 0n }];

      const { refSlot } = await consensus.getCurrentFrame();
      // change keyIndex
      const reportData = {
        consensusVersion: VEBO_CONSENSUS_VERSION,
        refSlot,
        requestsCount: requests.length,
        data: encodeWithdrawalRequests(newRequests),
      };

      const changedReportHash = calcVEBOReportDataHash(reportData);

      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
        .to.be.revertedWithCustomError(oracle, "UnexpectedDataHash")
        .withArgs(actualReportHash, changedReportHash);
    });

    it("reverts on processing deadline miss", async () => {
      const { reportData } = await prepareReportAndSubmitHash();
      const deadline = (await oracle.getConsensusReport()).processingDeadlineTime.toString(10);
      await consensus.advanceTimeToNextFrameStart();

      await expect(oracle.connect(member1).submitReportData(reportData, oracleVersion))
        .to.be.revertedWithCustomError(oracle, "ProcessingDeadlineMissed")
        .withArgs(deadline);
    });
  });

  context("getTotalRequestsProcessed reflects report history", () => {
    let originalState: string;

    before(async () => {
      originalState = await Snapshot.take();
      await consensus.advanceTimeToNextFrameStart();
    });

    after(async () => await Snapshot.restore(originalState));

    let requestCount = 0;

    it("should be zero at init", async () => {
      requestCount = 0;
      expect(await oracle.getTotalRequestsProcessed()).to.equal(requestCount);
    });

    it("should increase after report", async () => {
      const { reportData } = await prepareReportAndSubmitHash([{ moduleId: 5, nodeOpId: 3, keyIndex: 1, amount: 0n }]);
      await oracle.connect(member1).submitReportData(reportData, oracleVersion);
      requestCount += 1;
      expect(await oracle.getTotalRequestsProcessed()).to.equal(requestCount);
    });

    it("should double increase for two exits", async () => {
      await consensus.advanceTimeToNextFrameStart();
      const { reportData } = await prepareReportAndSubmitHash([
        { moduleId: 5, nodeOpId: 1, keyIndex: 1, amount: 0n },
        { moduleId: 5, nodeOpId: 3, keyIndex: 2, amount: 0n },
      ]);
      await oracle.connect(member1).submitReportData(reportData, oracleVersion);
      requestCount += 2;
      expect(await oracle.getTotalRequestsProcessed()).to.equal(requestCount);
    });

    it("should not change on empty report", async () => {
      await consensus.advanceTimeToNextFrameStart();
      const { reportData } = await prepareReportAndSubmitHash([]);
      await oracle.connect(member1).submitReportData(reportData, oracleVersion);
      expect(await oracle.getTotalRequestsProcessed()).to.equal(requestCount);
    });
  });

  context("getProcessingState reflects state change", () => {
    let originalState: string;
    before(async () => {
      originalState = await Snapshot.take();
      await consensus.advanceTimeToNextFrameStart();
    });
    after(async () => await Snapshot.restore(originalState));

    let report: VEBOReportFields;
    let hash: string;

    it("has correct defaults on init", async () => {
      const state = await oracle.getProcessingState();
      expect(Object.values(state)).to.deep.equal([
        (await consensus.getCurrentFrame()).refSlot,
        0,
        ZeroHash,
        false,
        0,
        0,
      ]);
    });

    it("consensus report submitted", async () => {
      ({ reportData: report, reportHash: hash } = await prepareReportAndSubmitHash([
        { moduleId: 5, nodeOpId: 1, keyIndex: 1, amount: 0n },
        { moduleId: 5, nodeOpId: 3, keyIndex: 2, amount: 0n },
      ]));
      const state = await oracle.getProcessingState();

      expect(Object.values(state)).to.deep.equal([
        (await consensus.getCurrentFrame()).refSlot,
        computeTimestampAtSlot((await consensus.getCurrentFrame()).reportProcessingDeadlineSlot),
        hash,
        false,
        0,
        0,
      ]);
    });

    it("report is processed", async () => {
      await oracle.connect(member1).submitReportData(report, oracleVersion);
      const state = await oracle.getProcessingState();
      expect(Object.values(state)).to.deep.equal([
        (await consensus.getCurrentFrame()).refSlot,
        computeTimestampAtSlot((await consensus.getCurrentFrame()).reportProcessingDeadlineSlot),
        hash,
        true,
        2,
        2,
      ]);
    });

    it("at next frame state resets", async () => {
      await consensus.advanceTimeToNextFrameStart();
      const state = await oracle.getProcessingState();
      expect(Object.values(state)).to.deep.equal([
        (await consensus.getCurrentFrame()).refSlot,
        0,
        ZeroHash,
        false,
        0,
        0,
      ]);
    });
  });

  context("allow oracle to submit empty data", () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();
      await consensus.advanceTimeToNextFrameStart();
    });

    afterEach(async () => await Snapshot.restore(originalState));

    it("submit report pass without withdrawal intents", async () => {
      const { refSlot } = await consensus.getCurrentFrame();
      const { reportData } = await prepareReportAndSubmitHash([]);
      const tx = await oracle.connect(member1).submitReportData(reportData, oracleVersion);

      await expect(tx).to.not.emit(oracle, "WithdrawalRequested");
      expect(await triggerableWithdrawalsBus.addWithdrawalIntentsCalls()).to.equal(0);

      const state = await oracle.getDataProcessingState();
      expect(state.refSlot).to.equal(refSlot);
      expect(state.requestsCount).to.equal(0);
      expect(state.requestsProcessed).to.equal(0);
    });
  });
});
