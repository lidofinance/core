import { expect } from "chai";
import { ContractTransactionReceipt, ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  HashConsensus__Harness,
  StakingModule__MockForKeyVerification,
  StakingRouter__MockForValidatorsExitBus,
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
  SECONDS_PER_FRAME,
  seedMockModuleSigningKeys,
  SLOTS_PER_FRAME,
  VEBOReportFields,
  WithdrawalRequest,
} from "test/deploy";
import { Snapshot } from "test/suite";

describe("ValidatorsExitBusOracle.sol:gas", () => {
  let consensus: HashConsensus__Harness;
  let oracle: ValidatorsExitBus__Harness;
  let stakingRouter: StakingRouter__MockForValidatorsExitBus;
  let admin: HardhatEthersSigner;
  let mockModules: {
    module1: StakingModule__MockForKeyVerification;
    module2: StakingModule__MockForKeyVerification;
    module3: StakingModule__MockForKeyVerification;
    module4: StakingModule__MockForKeyVerification;
    module5: StakingModule__MockForKeyVerification;
    module7: StakingModule__MockForKeyVerification;
  };

  let oracleVersion: bigint;

  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;
  let member3: HardhatEthersSigner;

  const NUM_MODULES = 5;
  const NODE_OPS_PER_MODULE = 100;

  let nextKeyIndex = 1;

  const triggerConsensusOnHash = async (hash: string) => {
    const { refSlot } = await consensus.getCurrentFrame();
    await consensus.connect(member1).submitReport(refSlot, hash, VEBO_CONSENSUS_VERSION);
    await consensus.connect(member3).submitReport(refSlot, hash, VEBO_CONSENSUS_VERSION);
    expect((await consensus.getConsensusState()).consensusReport).to.equal(hash);
  };

  const generateRequests = (totalRequests: number) => {
    const requestsPerModule = Math.max(1, Math.floor(totalRequests / NUM_MODULES));
    const requestsPerNodeOp = Math.max(1, Math.floor(requestsPerModule / NODE_OPS_PER_MODULE));

    const requests: WithdrawalRequest[] = [];

    for (let i = 0; i < totalRequests; ++i) {
      const moduleId = Math.floor(i / requestsPerModule);
      const nodeOpId = Math.floor((i - moduleId * requestsPerModule) / requestsPerNodeOp);
      const keyIndex = nextKeyIndex++;
      requests.push({ moduleId: moduleId + 1, nodeOpId, keyIndex, amount: 0n });
    }

    return { requests, requestsPerModule, requestsPerNodeOp };
  };

  const gasUsages: { totalRequests: number; requestsPerModule: number; requestsPerNodeOp: number; gasUsed: number }[] =
    [];

  before(async () => {
    [admin, member1, member2, member3] = await ethers.getSigners();

    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;
    stakingRouter = deployed.stakingRouter;
    mockModules = deployed.mockModules;

    // Measure the VEBO part only: the mock bus would spend most of the gas storing intents from zero slots
    await deployed.triggerableWithdrawalsBus.setStoreIntents(false);

    // Use legacy withdrawal credentials (32 ETH per validator) for all modules exercised in this suite
    for (let moduleId = 1; moduleId <= NUM_MODULES; moduleId++) {
      await stakingRouter.setStakingModuleWithdrawalCredentialsType(moduleId, 0x01);
    }

    await initVEBO({
      admin: admin.address,
      oracle,
      consensus,
      resumeAfterDeploy: true,
    });

    oracleVersion = await oracle.getContractVersion();

    await consensus.addMember(member1, 1);
    await consensus.addMember(member2, 2);
    await consensus.addMember(member3, 2);
  });

  after(async () => {
    gasUsages.forEach(({ totalRequests, requestsPerModule, requestsPerNodeOp, gasUsed }) =>
      console.log(
        `${totalRequests} requests (per module ${requestsPerModule}, ` +
          `per node op ${requestsPerNodeOp}): total gas ${gasUsed}, ` +
          `gas per request: ${Math.round(gasUsed / totalRequests)}`,
      ),
    );
  });

  for (const totalRequests of [10, 50, 100, MAX_REQUESTS_PER_REPORT]) {
    context(`Total requests: ${totalRequests}`, () => {
      let generated: { requests: WithdrawalRequest[]; requestsPerModule: number; requestsPerNodeOp: number };
      let reportFields: VEBOReportFields;
      let reportHash: string;
      let originalState: string;

      before(async () => (originalState = await Snapshot.take()));

      after(async () => await Snapshot.restore(originalState));

      it("initially, consensus report is not being processed", async () => {
        const { refSlot } = await consensus.getCurrentFrame();

        const report = await oracle.getConsensusReport();
        expect(refSlot).to.above(report.refSlot);

        const procState = await oracle.getProcessingState();
        expect(procState.dataHash, ZeroHash);
        expect(procState.dataSubmitted).to.equal(false);
      });

      it("committee reaches consensus on a report hash", async () => {
        const { refSlot } = await consensus.getCurrentFrame();

        generated = generateRequests(totalRequests);

        reportFields = {
          consensusVersion: VEBO_CONSENSUS_VERSION,
          refSlot: refSlot,
          requestsCount: generated.requests.length,
          data: encodeWithdrawalRequests(generated.requests),
        };
        // the module mocks read seeded keys from storage, as real modules do
        await seedMockModuleSigningKeys(
          mockModules,
          generated.requests.map(({ moduleId, nodeOpId, keyIndex }) => ({
            moduleId,
            nodeOpId: Number(nodeOpId),
            keyIndex: Number(keyIndex),
          })),
        );

        reportHash = calcVEBOReportDataHash(reportFields);

        await triggerConsensusOnHash(reportHash);
      });

      it("oracle gets the report hash", async () => {
        const report = await oracle.getConsensusReport();
        expect(report.hash).to.equal(reportHash);
        expect(report.refSlot).to.equal(reportFields.refSlot);
        expect(report.processingDeadlineTime).to.equal(computeTimestampAtSlot(report.refSlot + SLOTS_PER_FRAME));
        expect(report.processingStarted).to.equal(false);

        const procState = await oracle.getProcessingState();
        expect(procState.dataHash).to.equal(reportHash);
        expect(procState.dataSubmitted).to.equal(false);
        expect(procState.requestsCount).to.equal(0);
        expect(procState.requestsSubmitted).to.equal(0);
      });

      it("some time passes", async () => {
        await consensus.advanceTimeBy(SECONDS_PER_FRAME / 3n);
      });

      it(`a committee member submits the report data, withdrawal requests are emitted`, async () => {
        const tx = await oracle.connect(member1).submitReportData(reportFields, oracleVersion);
        const receipt = (await tx.wait()) as ContractTransactionReceipt;
        await expect(tx).to.emit(oracle, "ProcessingStarted").withArgs(reportFields.refSlot, reportHash);
        expect((await oracle.getConsensusReport()).processingStarted).to.equal(true);

        const first = generated.requests[0];
        const last = generated.requests[generated.requests.length - 1];

        await expect(tx)
          .to.emit(oracle, "WithdrawalRequested")
          .withArgs(first.moduleId, first.nodeOpId, makeMockPubkey(first.nodeOpId, first.keyIndex), first.amount);

        await expect(tx)
          .to.emit(oracle, "WithdrawalRequested")
          .withArgs(last.moduleId, last.nodeOpId, makeMockPubkey(last.nodeOpId, last.keyIndex), last.amount);

        const { gasUsed } = receipt;

        gasUsages.push({
          totalRequests,
          requestsPerModule: generated.requestsPerModule,
          requestsPerNodeOp: generated.requestsPerNodeOp,
          gasUsed: Number(gasUsed),
        });
      });

      it(`reports are marked as processed`, async () => {
        const procState = await oracle.getProcessingState();
        expect(procState.dataHash).to.equal(reportHash);
        expect(procState.dataSubmitted).to.equal(true);
        expect(procState.requestsCount).to.equal(generated.requests.length);
        expect(procState.requestsSubmitted).to.equal(generated.requests.length);
      });

      it("some time passes", async () => {
        const prevFrame = await consensus.getCurrentFrame();
        await consensus.advanceTimeBy(SECONDS_PER_FRAME - SECONDS_PER_FRAME / 3n);
        const newFrame = await consensus.getCurrentFrame();
        expect(newFrame.refSlot).to.above(prevFrame.refSlot);
      });
    });
  }
});
