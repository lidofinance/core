import { expect } from "chai";
import { AbiCoder, BigNumberish, BytesLike, keccak256 } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  CuratedModuleMock,
  CuratedModuleMock__factory,
  DepositContractMock,
  DepositContractMock__factory,
  HashConsensusTimeTravellable,
  HashConsensusTimeTravellable__factory,
  Lido,
  Lido__factory,
  LidoLocator,
  OracleReportSanityCheckerMock,
  OracleReportSanityCheckerMock__factory,
  Prover,
  Prover__factory,
  StakingRouter,
  StakingRouter__factory,
  TriggerableExitMock,
  TriggerableExitMock__factory,
  ValidatorsExitBusOracle,
  ValidatorsExitBusOracle__factory,
  WithdrawalVault,
  WithdrawalVault__factory,
} from "typechain-types";

import { de0x, dummyLocator, ether, proxify, Snapshot } from "lib";

type Report = ValidatorsExitBusOracle.ReportDataStruct;
type ReportAsArray = ReturnType<typeof getValidatorsExitBusReportDataItems>;

type Block = {
  number: number;
  timestamp: number;
  hash: string;
};
type ExitRequest = {
  moduleId: bigint;
  nodeOpId: bigint;
  valIndex: bigint;
  valPubkey: string;
};
type ExitRequests = ExitRequest[];

interface WithdrawalRequest {
  keys: BytesLike[];
  amounts: BigNumberish[];
  data: Report;
}

const pad = (hex: string, bytesLength: number, fill = "0") => {
  const absentZeroes = bytesLength * 2 + 2 - hex.length;
  if (absentZeroes > 0) hex = "0x" + fill.repeat(absentZeroes) + hex.substr(2);
  return hex;
};

const SLOTS_PER_EPOCH = 32;
const SECONDS_PER_SLOT = 12;
const GENESIS_TIME = 100;
const EPOCHS_PER_FRAME = 37;
const INITIAL_FAST_LANE_LENGTH_SLOTS = 0;
const INITIAL_EPOCH = 1;

const CONSENSUS_VERSION = 1;
const DATA_FORMAT_LIST = 1;

const PENALTY_DELAY = 2 * 24 * 60 * 60; // 2 days

function genPublicKeysArray(cnt = 1) {
  const pubkeys = [];
  const sigkeys = [];

  for (let i = 1; i <= cnt; i++) {
    pubkeys.push(pad("0x" + i.toString(16), 48));
    sigkeys.push(pad("0x" + i.toString(16), 96));
  }
  return { pubkeys, sigkeys };
}

function genPublicKeysCalldata(cnt = 1) {
  let pubkeys = "0x";
  let sigkeys = "0x";

  for (let i = 1; i <= cnt; i++) {
    pubkeys = pubkeys + de0x(pad("0x" + i.toString(16), 48));
    sigkeys = sigkeys + de0x(pad("0x" + i.toString(16), 96));
  }
  return { pubkeys, sigkeys };
}

async function bytes32() {
  return "0x".padEnd(66, "1234");
}

const createAmounts = (length: number) => {
  const arr = Array(length);
  return arr.fill(ether("32"));
};

const getDefaultReportFields = (overrides: object) =>
  ({
    consensusVersion: CONSENSUS_VERSION,
    dataFormat: DATA_FORMAT_LIST,
    // required override: refSlot
    // required override: requestsCount
    // required override: data
    ...overrides,
  }) as Report;

function calcValidatorsExitBusReportDataHash(reportItems: ReportAsArray): string {
  return keccak256(new AbiCoder().encode(["(uint256,uint256,uint256,uint256,bytes)"], [reportItems]));
}

function getValidatorsExitBusReportDataItems(r: Report) {
  return [r.consensusVersion, r.refSlot, r.requestsCount, r.dataFormat, r.data];
}
function hex(n: bigint, byteLen: number) {
  const s = n.toString(16);
  return byteLen === undefined ? s : s.padStart(byteLen * 2, "0");
}
function encodeExitRequestHex({ moduleId, nodeOpId, valIndex, valPubkey }: ExitRequest) {
  const pubkeyHex = de0x(valPubkey);
  return hex(moduleId, 3) + hex(nodeOpId, 5) + hex(valIndex, 8) + pubkeyHex;
}

function encodeExitRequestsDataList(requests: ExitRequests) {
  return "0x" + requests.map(encodeExitRequestHex).join("");
}

async function prepareOracleReport({
  exitRequests,
  ...restFields
}: {
  exitRequests: ExitRequest[];
} & Partial<Report>) {
  const fields = getDefaultReportFields({
    ...restFields,
    requestsCount: exitRequests.length,
    data: encodeExitRequestsDataList(exitRequests),
  }) as Report;

  const items = getValidatorsExitBusReportDataItems(fields);
  const hash = calcValidatorsExitBusReportDataHash(items);

  return { fields, items, hash };
}

describe("Triggerable exits test", () => {
  let deployer: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let voting: HardhatEthersSigner;
  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;
  let member3: HardhatEthersSigner;
  let operator1: HardhatEthersSigner;

  let provider: typeof ethers.provider;

  let lido: Lido;
  let withdrawalVault: WithdrawalVault;
  let oracle: ValidatorsExitBusOracle;
  let locator: LidoLocator;
  let consensus: HashConsensusTimeTravellable;
  let sanityChecker: OracleReportSanityCheckerMock;
  let triggerableExitMock: TriggerableExitMock;
  let prover: Prover;
  let curatedModule: CuratedModuleMock;
  let depositContract: DepositContractMock;
  let stakingRouter: StakingRouter;

  let curatedModuleId: bigint;
  const operator1Id = 0n;
  let withdrawalRequest: WithdrawalRequest;

  async function getLatestBlock(): Promise<Block> {
    const block = await provider.getBlock("latest");
    if (!block) throw new Error("Failed to retrieve latest block");
    return block as Block;
  }

  async function triggerConsensusOnHash(hash: string) {
    const { refSlot } = await consensus.getCurrentFrame();
    await consensus.connect(member1).submitReport(refSlot, hash, CONSENSUS_VERSION);
    await consensus.connect(member3).submitReport(refSlot, hash, CONSENSUS_VERSION);

    const state = await consensus.getConsensusState();
    expect(state.consensusReport).to.be.equal(hash);
  }

  before(async () => {
    ({ provider } = ethers);
    [deployer, stranger, voting, member1, member2, member3, operator1] = await ethers.getSigners();

    const lidoFactory = new Lido__factory(deployer);
    lido = await lidoFactory.deploy();

    //triggerable exits mock
    const triggerableExitMockFactory = new TriggerableExitMock__factory(deployer);
    triggerableExitMock = await triggerableExitMockFactory.deploy();

    //staking router
    const depositContractFactory = new DepositContractMock__factory(deployer);
    depositContract = await depositContractFactory.deploy();

    const stakingRouterFactory = new StakingRouter__factory(deployer);
    const stakingRouterImpl = await stakingRouterFactory.deploy(depositContract);
    [stakingRouter] = await proxify({ impl: stakingRouterImpl, admin: deployer });
    await stakingRouter.initialize(deployer, lido, await bytes32());

    //sanity checker
    const sanityCheckerFactory = new OracleReportSanityCheckerMock__factory(deployer);
    sanityChecker = await sanityCheckerFactory.deploy();

    //locator
    locator = await dummyLocator({
      oracleReportSanityChecker: await sanityChecker.getAddress(),
      stakingRouter: await stakingRouter.getAddress(),
    });

    //module
    const type = keccak256("0x01"); //0x01
    const curatedModuleFactory = new CuratedModuleMock__factory(deployer);
    curatedModule = await curatedModuleFactory.deploy();
    await curatedModule.initialize(locator, type, PENALTY_DELAY);

    //oracle
    const validatorsExitBusOracleFactory = new ValidatorsExitBusOracle__factory(deployer);
    const oracleImpl = await validatorsExitBusOracleFactory.deploy(SECONDS_PER_SLOT, GENESIS_TIME, locator);
    [oracle] = await proxify({ impl: oracleImpl, admin: deployer });

    //withdrawal vault
    const treasury = lido;
    const withdrawalVaultFactory = new WithdrawalVault__factory(deployer);
    const withdrawalVaultImpl = await withdrawalVaultFactory.deploy(lido, treasury, oracle, triggerableExitMock);
    [withdrawalVault] = await proxify({ impl: withdrawalVaultImpl, admin: deployer });
    //initialize WC Vault
    await withdrawalVault.initialize();

    //mock update locator
    // @ts-expect-error : dummyLocator() should return LidoLocator__MutableMock instead of LidoLocator
    await locator.mock__updateValidatorsExitBusOracle(oracle);
    // @ts-expect-error : dummyLocator() should return LidoLocator__MutableMock instead of LidoLocator
    await locator.mock__updateWithdrawalVault(withdrawalVault);

    //consensus contract
    const consensusFactory = new HashConsensusTimeTravellable__factory(deployer);
    consensus = await consensusFactory.deploy(
      SLOTS_PER_EPOCH,
      SECONDS_PER_SLOT,
      GENESIS_TIME,
      EPOCHS_PER_FRAME,
      INITIAL_FAST_LANE_LENGTH_SLOTS,
      deployer,
      await oracle.getAddress(),
    );
    await consensus.updateInitialEpoch(INITIAL_EPOCH);
    await consensus.setTime(GENESIS_TIME + INITIAL_EPOCH * SLOTS_PER_EPOCH * SECONDS_PER_SLOT);

    await consensus.grantRole(await consensus.MANAGE_MEMBERS_AND_QUORUM_ROLE(), deployer);
    await consensus.grantRole(await consensus.DISABLE_CONSENSUS_ROLE(), deployer);
    await consensus.grantRole(await consensus.MANAGE_FRAME_CONFIG_ROLE(), deployer);
    await consensus.grantRole(await consensus.MANAGE_FAST_LANE_CONFIG_ROLE(), deployer);
    await consensus.grantRole(await consensus.MANAGE_REPORT_PROCESSOR_ROLE(), deployer);

    const lastProcessingRefSlot = 0;
    await oracle.initialize(deployer, await consensus.getAddress(), CONSENSUS_VERSION, lastProcessingRefSlot);

    await oracle.grantRole(await oracle.SUBMIT_PRIORITY_DATA_ROLE(), voting);
    await oracle.grantRole(await oracle.SUBMIT_DATA_ROLE(), deployer);
    await oracle.grantRole(await oracle.PAUSE_ROLE(), deployer);
    await oracle.grantRole(await oracle.RESUME_ROLE(), deployer);

    //add consensus members
    await consensus.addMember(member1, 1);
    await consensus.addMember(member2, 2);
    await consensus.addMember(member3, 2);

    //resume after deploy
    await oracle.resume();

    //prover
    // await prover.grantRole(await oracle.ONLY_MODULE(), voting);

    //add module
    await stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), deployer);
    await stakingRouter.grantRole(await stakingRouter.UNSAFE_SET_EXITED_VALIDATORS_ROLE(), deployer);

    await stakingRouter.addStakingModule(
      "Curated",
      await curatedModule.getAddress(),
      10_000, // 100 % _targetShare
      1_000, // 10 % _moduleFee
      5_000, // 50 % _treasuryFee
    );
    curatedModuleId = (await stakingRouter.getStakingModuleIds())[0];

    await curatedModule.addNodeOperator("1", operator1);

    //prover
    const proverFactory = new Prover__factory(deployer);
    prover = await proverFactory.deploy(locator, oracle, curatedModuleId);
    await oracle.grantRole(await oracle.SUBMIT_PRIORITY_DATA_ROLE(), prover);
  });

  context("stage1", () => {
    let originalState: string;

    beforeEach(async () => {
      originalState = await Snapshot.take();
    });
    afterEach(async () => {
      await Snapshot.restore(originalState);
    });

    it("reverts if oracle report does not have valPubkeyUnknown", async () => {
      const moduleId = 5n;
      const moduleId2 = 1n;
      const nodeOpId = 1n;
      const nodeOpId2 = 1n;
      const valIndex = 10n;
      const valIndex2 = 11n;
      const valPubkey = pad("0x010203", 48);
      const valPubkey2 = pad("0x010204", 48);

      const block = await getLatestBlock();
      await consensus.setTime(block.timestamp);

      const { refSlot } = await consensus.getCurrentFrame();

      const exitRequests = [
        { moduleId: moduleId2, nodeOpId: nodeOpId2, valIndex: valIndex2, valPubkey: valPubkey2 },
        { moduleId, nodeOpId, valIndex, valPubkey },
      ];

      const report = await prepareOracleReport({ refSlot, exitRequests });

      await triggerConsensusOnHash(report.hash);

      //oracle report
      const tx2 = await oracle.submitReportData(report.fields, 1);
      await expect(tx2).to.be.emit(oracle, "ValidatorExitRequest");

      const valPubkeyUnknown = pad("0x010101", 48);

      withdrawalRequest = {
        keys: [valPubkeyUnknown],
        amounts: [ether("32")],
        data: report.fields,
      };

      await expect(
        oracle.forcedExitPubkeys(withdrawalRequest.keys, withdrawalRequest.amounts, withdrawalRequest.data),
      ).to.be.revertedWithCustomError(oracle, "ErrorInvalidPubkeyInReport");
    });

    it("forced exit with oracle report works", async () => {
      const moduleId = 5n;
      const moduleId2 = 1n;
      const nodeOpId = 1n;
      const nodeOpId2 = 1n;
      const valIndex = 10n;
      const valIndex2 = 11n;
      const valPubkey = pad("0x010203", 48);
      const valPubkey2 = pad("0x010204", 48);

      const block = await getLatestBlock();
      await consensus.setTime(block.timestamp);

      const { refSlot } = await consensus.getCurrentFrame();

      const exitRequests = [
        { moduleId: moduleId2, nodeOpId: nodeOpId2, valIndex: valIndex2, valPubkey: valPubkey2 },
        { moduleId, nodeOpId, valIndex, valPubkey },
      ];

      const report = await prepareOracleReport({ refSlot, exitRequests });
      await triggerConsensusOnHash(report.hash);

      //oracle report
      const tx2 = await oracle.submitReportData(report.fields, 1);
      await expect(tx2).to.be.emit(oracle, "ValidatorExitRequest");

      withdrawalRequest = {
        keys: [valPubkey],
        amounts: [ether("32")],
        data: report.fields,
      };

      //maximum to exit - 600val
      const tx = await oracle
        .connect(stranger)
        .forcedExitPubkeys(withdrawalRequest.keys, withdrawalRequest.amounts, withdrawalRequest.data, {
          value: ether("1.0"),
        });
      await expect(tx).to.be.emit(oracle, "ValidatorExitRequest");
      await expect(tx).to.be.emit(triggerableExitMock, "WithdrawalRequest");
    });

    it("governance vote without oracle.submitReportData works", async () => {
      const moduleId = 5n;
      const moduleId2 = 1n;
      const nodeOpId = 1n;
      const nodeOpId2 = 1n;
      const valIndex = 10n;
      const valIndex2 = 11n;
      const valPubkey = pad("0x010203", 48);
      const valPubkey2 = pad("0x010204", 48);

      const refSlot = 0; //await consensus.getCurrentFrame()
      const exitRequests = [
        { moduleId: moduleId2, nodeOpId: nodeOpId2, valIndex: valIndex2, valPubkey: valPubkey2 },
        { moduleId, nodeOpId, valIndex, valPubkey },
      ];

      const report = await prepareOracleReport({ refSlot, exitRequests });

      //priority
      await oracle.connect(voting).submitPriorityReportData(report.hash, report.fields.requestsCount);

      withdrawalRequest = {
        keys: [valPubkey],
        amounts: [ether("32")],
        data: report.fields,
      };

      const tx = await oracle
        .connect(stranger)
        .forcedExitPubkeys(withdrawalRequest.keys, withdrawalRequest.amounts, withdrawalRequest.data, {
          value: ether("1.0"),
        });
      await expect(tx).to.be.emit(oracle, "ValidatorExitRequest");
      await expect(tx).to.be.emit(triggerableExitMock, "WithdrawalRequest");
    });

    it("exit multiple keys", async () => {
      const { pubkeys: keys } = genPublicKeysArray(5);

      const refSlot = 0; //await consensus.getCurrentFrame()
      const exitRequests = [
        { moduleId: 1n, nodeOpId: 1n, valIndex: 0n, valPubkey: keys[0] },
        { moduleId: 2n, nodeOpId: 2n, valIndex: 0n, valPubkey: keys[1] },
        { moduleId: 3n, nodeOpId: 3n, valIndex: 0n, valPubkey: keys[2] },
        { moduleId: 4n, nodeOpId: 4n, valIndex: 0n, valPubkey: keys[3] },
        { moduleId: 5n, nodeOpId: 5n, valIndex: 0n, valPubkey: keys[4] },
      ];

      const report = await prepareOracleReport({ refSlot, exitRequests });

      //priority
      await oracle.connect(voting).submitPriorityReportData(report.hash, exitRequests.length);

      //check invalid request count
      const { pubkeys: keysInvalidRequestCount } = genPublicKeysArray(6);
      withdrawalRequest = {
        keys: keysInvalidRequestCount,
        amounts: createAmounts(keysInvalidRequestCount.length),
        data: report.fields,
      };

      await expect(
        oracle
          .connect(stranger)
          .forcedExitPubkeys(withdrawalRequest.keys, withdrawalRequest.amounts, withdrawalRequest.data, {
            value: ether("1.0"),
          }),
      ).to.be.revertedWithCustomError(oracle, "ErrorInvalidKeysRequestsCount");

      //check valid request count (not reverted)
      const { pubkeys: validRequestLessInTheReport } = genPublicKeysArray(3);
      withdrawalRequest = {
        keys: validRequestLessInTheReport,
        amounts: createAmounts(validRequestLessInTheReport.length),
        data: report.fields,
      };
      await expect(
        oracle
          .connect(stranger)
          .forcedExitPubkeys(withdrawalRequest.keys, withdrawalRequest.amounts, withdrawalRequest.data, {
            value: ether("1.1"),
          }),
      ).not.to.be.revertedWithCustomError(oracle, "ErrorInvalidKeysRequestsCount");

      //check invalid request count
      const invalidKeyInRequest = [...keys];
      invalidKeyInRequest[2] = pad("0x010203", 48);
      withdrawalRequest = {
        keys: invalidKeyInRequest,
        amounts: createAmounts(invalidKeyInRequest.length),
        data: report.fields,
      };
      await expect(
        oracle
          .connect(stranger)
          .forcedExitPubkeys(withdrawalRequest.keys, withdrawalRequest.amounts, withdrawalRequest.data, {
            value: ether("1.2"),
          }),
      ).to.be.revertedWithCustomError(oracle, "ErrorInvalidPubkeyInReport");

      //works
      withdrawalRequest = {
        keys,
        amounts: createAmounts(keys.length),
        data: report.fields,
      };
      withdrawalRequest;
      await oracle
        .connect(stranger)
        .forcedExitPubkeys(withdrawalRequest.keys, withdrawalRequest.amounts, withdrawalRequest.data, {
          value: ether("1.0"),
        });
    });

    it("reverts module request exit - if unvetted/undeposited keys in report", async () => {
      const keysAmount = 5;
      const keysOperator1 = genPublicKeysCalldata(keysAmount);

      await curatedModule.addSigningKeys(operator1Id, keysAmount, keysOperator1.pubkeys, keysOperator1.sigkeys);
      await curatedModule.setNodeOperatorStakingLimit(operator1Id, keysAmount - 2);

      const { pubkeys: keys } = genPublicKeysArray(keysAmount);

      const requestIndex = 1;
      const requestKey = keys[requestIndex];

      //first attempt - no deposits
      await expect(
        prover.reportKeysToExit(operator1Id, [requestIndex], [requestKey], await bytes32()),
      ).to.be.revertedWithCustomError(prover, "ErrorKeyIsNotAvailiableToExit");

      //set keys are deposited
      await curatedModule.testing_markAllKeysDeposited(operator1Id);

      //calculate report
      const refSlot = 0; //await consensus.getCurrentFrame()
      const exitRequests = [
        { moduleId: curatedModuleId, nodeOpId: operator1Id, valIndex: 0n, valPubkey: keys[0] },
        { moduleId: curatedModuleId, nodeOpId: operator1Id, valIndex: 1n, valPubkey: keys[1] },
        { moduleId: curatedModuleId, nodeOpId: operator1Id, valIndex: 2n, valPubkey: keys[2] },
        { moduleId: curatedModuleId, nodeOpId: operator1Id, valIndex: 3n, valPubkey: keys[3] },
        { moduleId: curatedModuleId, nodeOpId: operator1Id, valIndex: 4n, valPubkey: keys[4] },
      ];

      const report = await prepareOracleReport({ refSlot, exitRequests });

      const reportIndexes = exitRequests.map((req) => req.valIndex);
      const reportKeys = exitRequests.map((req) => req.valPubkey);

      //keys [0,1,2] - deposited
      //keys [3,4] - not
      await expect(
        prover.reportKeysToExit(operator1Id, reportIndexes, reportKeys, report.hash),
      ).to.be.revertedWithCustomError(prover, "ErrorKeyIsNotAvailiableToExit");
    });

    it("module request exit", async () => {
      const keysAmount = 5;
      const keysOperator1 = genPublicKeysCalldata(keysAmount);

      await curatedModule.addSigningKeys(operator1Id, keysAmount, keysOperator1.pubkeys, keysOperator1.sigkeys);
      await curatedModule.setNodeOperatorStakingLimit(operator1Id, keysAmount - 2);

      //set keys are deposited
      await curatedModule.testing_markAllKeysDeposited(operator1Id);

      const { pubkeys: keys } = genPublicKeysArray(keysAmount);

      //calculate report
      const refSlot = 0; //await consensus.getCurrentFrame()
      const exitRequests = [
        { moduleId: curatedModuleId, nodeOpId: operator1Id, valIndex: 0n, valPubkey: keys[0] },
        { moduleId: curatedModuleId, nodeOpId: operator1Id, valIndex: 1n, valPubkey: keys[1] },
        { moduleId: curatedModuleId, nodeOpId: operator1Id, valIndex: 2n, valPubkey: keys[2] },
      ];

      const report = await prepareOracleReport({ refSlot, exitRequests });

      const reportIndexes = exitRequests.map((req) => req.valIndex);
      const reportKeys = exitRequests.map((req) => req.valPubkey);

      await prover.reportKeysToExit(operator1Id, reportIndexes, reportKeys, report.hash);

      // invalid key requested
      const valPubkeyUnknown = pad("0x010101", 48);
      withdrawalRequest = {
        keys: [valPubkeyUnknown],
        amounts: createAmounts(1),
        data: report.fields,
      };
      await expect(
        oracle
          .connect(stranger)
          .forcedExitPubkeys(withdrawalRequest.keys, withdrawalRequest.amounts, withdrawalRequest.data),
      ).to.be.revertedWithCustomError(oracle, "ErrorInvalidPubkeyInReport");

      //unvetted key requested
      const unvettedKey = keys[4];
      withdrawalRequest = {
        keys: [unvettedKey],
        amounts: createAmounts(1),
        data: report.fields,
      };
      await expect(
        oracle
          .connect(stranger)
          .forcedExitPubkeys(withdrawalRequest.keys, withdrawalRequest.amounts, withdrawalRequest.data),
      ).to.be.revertedWithCustomError(oracle, "ErrorInvalidPubkeyInReport");

      // //requested key exit
      withdrawalRequest = {
        keys: [keys[0], keys[1]],
        amounts: createAmounts(2),
        data: report.fields,
      };
      const tx = await oracle
        .connect(stranger)
        .forcedExitPubkeys(withdrawalRequest.keys, withdrawalRequest.amounts, withdrawalRequest.data, {
          value: ether("1.0"),
        });
      await expect(tx).to.be.emit(oracle, "ValidatorExitRequest");
      await expect(tx).to.be.emit(triggerableExitMock, "WithdrawalRequest");
    });

    it("increased exitFee", async function () {
      const { pubkeys: keys } = genPublicKeysArray(5);

      const refSlot = 0; //await consensus.getCurrentFrame()

      const keysCount = 17;
      const exitRequests = [...Array(keysCount).keys()].map(() => ({
        moduleId: 1n,
        nodeOpId: 1n,
        valIndex: 0n,
        valPubkey: keys[0],
      }));

      const report = await prepareOracleReport({ refSlot, exitRequests });

      //priority
      await oracle.connect(voting).submitPriorityReportData(report.hash, report.fields.requestsCount);

      const keys1 = [...Array(keysCount).keys()].map(() => keys[0]);

      expect(await triggerableExitMock.getFee()).to.be.equal(1n);

      //works
      // const gasEstimate1 = await oracle
      //   .connect(stranger)
      //   .forcedExitPubkeys.estimateGas(keys1, reportItems, { value: ether("1.0") });

      //calculate exitFee
      const exitFee1 = await triggerableExitMock.getFee();
      const keysFee1 = ether((exitFee1 * BigInt(keys1.length)).toString());

      withdrawalRequest = {
        keys: keys1,
        amounts: createAmounts(keys1.length),
        data: report.fields,
      };

      await oracle
        .connect(stranger)
        .forcedExitPubkeys(withdrawalRequest.keys, withdrawalRequest.amounts, withdrawalRequest.data, {
          value: keysFee1,
        });

      await triggerableExitMock.blockProcessing();
      //after block processing block the fee would be increased

      const exitFee2 = await triggerableExitMock.getFee();
      expect(exitFee2).to.be.equal(2n);

      const keysFee2 = ether((exitFee2 * BigInt(keys1.length)).toString());

      // const gasEstimate2 = await oracle
      //   .connect(stranger)
      //   .forcedExitPubkeys.estimateGas(keys1, reportItems, { value: ether("1.0") });
      await oracle
        .connect(stranger)
        .forcedExitPubkeys(withdrawalRequest.keys, withdrawalRequest.amounts, withdrawalRequest.data, {
          value: keysFee2,
        });
    });

    it("test queue size", async function () {
      const { pubkeys: keys } = genPublicKeysArray(5);

      const refSlot = 0; //await consensus.getCurrentFrame()

      const keysCount = 7;
      const exitRequests = [...Array(keysCount).keys()].map(() => ({
        moduleId: 1n,
        nodeOpId: 1n,
        valIndex: 0n,
        valPubkey: keys[0],
      }));

      const report = await prepareOracleReport({ refSlot, exitRequests });

      //priority
      await oracle.connect(voting).submitPriorityReportData(report.hash, report.fields.requestsCount);

      const keys1 = [...Array(keysCount).keys()].map(() => keys[0]);

      expect(await triggerableExitMock.getFee()).to.be.equal(1n);

      //works
      // const gasEstimate1 = await oracle
      //   .connect(stranger)
      //   .forcedExitPubkeys.estimateGas(keys1, reportItems, { value: ether("1.0") });

      //calculate exitFee
      const exitFee1 = await triggerableExitMock.getFee();
      const keysFee1 = ether((exitFee1 * BigInt(keys1.length)).toString());
      withdrawalRequest = {
        keys: keys1,
        amounts: createAmounts(keys1.length),
        data: report.fields,
      };

      await oracle
        .connect(stranger)
        .forcedExitPubkeys(withdrawalRequest.keys, withdrawalRequest.amounts, withdrawalRequest.data, {
          value: keysFee1,
        });

      const queueCountBefore = await triggerableExitMock.getQueueCount();
      expect(queueCountBefore).to.be.equal(keysCount);

      //block processing
      await triggerableExitMock.blockProcessing();

      const queueCountAfter = await triggerableExitMock.getQueueCount();
      expect(queueCountAfter).to.be.equal(0);
    });
  });
});
