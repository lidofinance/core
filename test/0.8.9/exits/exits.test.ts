import { expect } from "chai";
import { AbiCoder, keccak256 } from "ethers";
import { ethers } from "hardhat";

import {
  CuratedModuleMock,
  CuratedModuleMock__factory,
  DepositContractMock,
  DepositContractMock__factory,
  HashConsensusTimeTravellable__factory,
  Lido,
  Lido__factory,
  OracleReportSanityCheckerMock,
  OracleReportSanityCheckerMock__factory,
  Prover,
  Prover__factory,
  StakingRouterMockForTE,
  StakingRouterMockForTE__factory,
  TriggerableExitMock,
  TriggerableExitMock__factory,
  ValidatorsExitBusOracle,
  ValidatorsExitBusOracleMock__factory,
  WithdrawalVault,
  WithdrawalVault__factory,
} from "typechain-types";

import { ether, Snapshot } from "lib";
import { de0x, dummyLocator } from "lib/dummy";

const pad = (hex, bytesLength, fill = "0") => {
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

const getDefaultReportFields = (overrides) => ({
  consensusVersion: CONSENSUS_VERSION,
  dataFormat: DATA_FORMAT_LIST,
  // required override: refSlot
  // required override: requestsCount
  // required override: data
  ...overrides,
});

function calcValidatorsExitBusReportDataHash(reportItems) {
  return keccak256(new AbiCoder().encode(["(uint256,uint256,uint256,uint256,bytes)"], [reportItems]));
}

function getValidatorsExitBusReportDataItems(r) {
  return [r.consensusVersion, r.refSlot, r.requestsCount, r.dataFormat, r.data];
}
function hex(n, byteLen = undefined) {
  const s = n.toString(16);
  return byteLen === undefined ? s : s.padStart(byteLen * 2, "0");
}
function encodeExitRequestHex({ moduleId, nodeOpId, valIndex, valPubkey }) {
  const pubkeyHex = de0x(valPubkey);
  return hex(moduleId, 3) + hex(nodeOpId, 5) + hex(valIndex, 8) + pubkeyHex;
}

function encodeExitRequestsDataList(requests) {
  return "0x" + requests.map(encodeExitRequestHex).join("");
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
  let consensus: HashConsensus;
  let sanityChecker: OracleReportSanityCheckerMock;
  let triggerableExitMock: TriggerableExitMock;
  let prover: Prover;
  let curatedModule: CuratedModuleMock;
  let depositContract: DepositContractMock;
  let stakingRouter: StakingRouterMockForTE;

  let curatedModuleId: bigint;
  const operator1Id: bigint = 0;

  // let oracleVersion: bigint;

  async function getLatestBlock(): Promise<Block> {
    const block = await provider.getBlock("latest");
    if (!block) throw new Error("Failed to retrieve latest block");
    return block as Block;
  }

  async function triggerConsensusOnHash(hash) {
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
    const treasury = await lido.getAddress();

    //triggerable exits mock
    const triggerableExitMockFactory = new TriggerableExitMock__factory(deployer);
    triggerableExitMock = await triggerableExitMockFactory.deploy();

    //withdrawal vault
    const withdrawalVaultFactory = new WithdrawalVault__factory(deployer);
    withdrawalVault = await withdrawalVaultFactory.deploy(
      await lido.getAddress(),
      treasury,
      await triggerableExitMock.getAddress(),
    );

    //staking router
    const depositContractFactory = new DepositContractMock__factory(deployer);
    depositContract = await depositContractFactory.deploy();

    const stakingRouterFactory = new StakingRouterMockForTE__factory(deployer);
    stakingRouter = await stakingRouterFactory.deploy(depositContract);
    await stakingRouter.initialize(deployer, lido, await bytes32());

    //sanity checker
    const sanityCheckerFactory = new OracleReportSanityCheckerMock__factory(deployer);
    sanityChecker = await sanityCheckerFactory.deploy();

    //locator
    locator = await dummyLocator({
      withdrawalVault: await withdrawalVault.getAddress(),
      oracleReportSanityChecker: await sanityChecker.getAddress(),
      stakingRouter: await stakingRouter.getAddress(),
    });

    //module
    const type = keccak256("0x01"); //0x01
    const curatedModuleFactory = new CuratedModuleMock__factory(deployer);
    curatedModule = await curatedModuleFactory.deploy();
    await curatedModule.initialize(locator, type, PENALTY_DELAY);

    //oracle
    const validatorsExitBusOracleFactory = new ValidatorsExitBusOracleMock__factory(deployer);
    oracle = await validatorsExitBusOracleFactory.deploy(SECONDS_PER_SLOT, GENESIS_TIME, locator);

    //prover
    const proverFactory = new Prover__factory(deployer);
    prover = await proverFactory.deploy(locator, oracle);

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
    await oracle.grantRole(await oracle.SUBMIT_PRIORITY_DATA_ROLE(), prover);
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
      const moduleId = 5;
      const moduleId2 = 1;
      const nodeOpId = 1;
      const nodeOpId2 = 1;
      const valIndex = 10;
      const valIndex2 = 11;
      const valPubkey = pad("0x010203", 48);
      const valPubkey2 = pad("0x010204", 48);

      const block = await getLatestBlock();
      await consensus.setTime(block.timestamp);

      const { refSlot } = await consensus.getCurrentFrame();

      const exitRequests = [
        { moduleId: moduleId2, nodeOpId: nodeOpId2, valIndex: valIndex2, valPubkey: valPubkey2 },
        { moduleId, nodeOpId, valIndex, valPubkey },
      ];

      const reportFields = getDefaultReportFields({
        refSlot,
        requestsCount: exitRequests.length,
        data: encodeExitRequestsDataList(exitRequests),
      });

      const reportItems = getValidatorsExitBusReportDataItems(reportFields);
      const reportHash = calcValidatorsExitBusReportDataHash(reportItems);

      await triggerConsensusOnHash(reportHash);

      //oracle report
      const tx2 = await oracle.submitReportData(reportFields, 1);
      await expect(tx2).to.be.emit(oracle, "ValidatorExitRequest");

      const valPubkeyUnknown = pad("0x010101", 48);

      await expect(oracle.forcedExitPubkey(valPubkeyUnknown, reportItems)).to.be.revertedWithCustomError(
        oracle,
        "ErrorInvalidPubkeyInReport",
      );
    });

    it("forced exit with oracle report works", async () => {
      const moduleId = 5;
      const moduleId2 = 1;
      const nodeOpId = 1;
      const nodeOpId2 = 1;
      const valIndex = 10;
      const valIndex2 = 11;
      const valPubkey = pad("0x010203", 48);
      const valPubkey2 = pad("0x010204", 48);

      const block = await getLatestBlock();
      await consensus.setTime(block.timestamp);

      const { refSlot } = await consensus.getCurrentFrame();

      const exitRequests = [
        { moduleId: moduleId2, nodeOpId: nodeOpId2, valIndex: valIndex2, valPubkey: valPubkey2 },
        { moduleId, nodeOpId, valIndex, valPubkey },
      ];

      const reportFields = getDefaultReportFields({
        refSlot,
        requestsCount: exitRequests.length,
        data: encodeExitRequestsDataList(exitRequests),
      });

      const reportItems = getValidatorsExitBusReportDataItems(reportFields);
      const reportHash = calcValidatorsExitBusReportDataHash(reportItems);

      await triggerConsensusOnHash(reportHash);

      //oracle report
      const tx2 = await oracle.submitReportData(reportFields, 1);
      await expect(tx2).to.be.emit(oracle, "ValidatorExitRequest");

      //maximum to exit - 600val
      const tx = await oracle.connect(stranger).forcedExitPubkey(valPubkey, reportItems, { value: ether("1.0") });
      await expect(tx).to.be.emit(oracle, "ValidatorForcedExitRequest");
      await expect(tx).to.be.emit(triggerableExitMock, "TriggerableExit");
    });

    it("governance vote without oracle.submitReportData works", async () => {
      const moduleId = 5;
      const moduleId2 = 1;
      const nodeOpId = 1;
      const nodeOpId2 = 1;
      const valIndex = 10;
      const valIndex2 = 11;
      const valPubkey = pad("0x010203", 48);
      const valPubkey2 = pad("0x010204", 48);

      const refSlot = 0; //await consensus.getCurrentFrame()
      const exitRequests = [
        { moduleId: moduleId2, nodeOpId: nodeOpId2, valIndex: valIndex2, valPubkey: valPubkey2 },
        { moduleId, nodeOpId, valIndex, valPubkey },
      ];

      const reportFields = getDefaultReportFields({
        refSlot: +refSlot,
        requestsCount: exitRequests.length,
        data: encodeExitRequestsDataList(exitRequests),
      });

      const reportItems = getValidatorsExitBusReportDataItems(reportFields);
      const reportHash = calcValidatorsExitBusReportDataHash(reportItems);

      //priority
      await oracle.connect(voting).submitPriorityReportData(reportHash, exitRequests.length);

      const tx = await oracle.connect(stranger).forcedExitPubkey(valPubkey, reportItems, { value: ether("1.0") });
      await expect(tx).to.be.emit(oracle, "ValidatorForcedExitRequest");
      await expect(tx).to.be.emit(triggerableExitMock, "TriggerableExit");
    });

    it("exit multiple keys", async () => {
      const { pubkeys: keys } = genPublicKeysArray(5);

      const refSlot = 0; //await consensus.getCurrentFrame()
      const exitRequests = [
        { moduleId: 1, nodeOpId: 1, valIndex: 0, valPubkey: keys[0] },
        { moduleId: 2, nodeOpId: 2, valIndex: 0, valPubkey: keys[1] },
        { moduleId: 3, nodeOpId: 3, valIndex: 0, valPubkey: keys[2] },
        { moduleId: 4, nodeOpId: 4, valIndex: 0, valPubkey: keys[3] },
        { moduleId: 5, nodeOpId: 5, valIndex: 0, valPubkey: keys[4] },
      ];

      const reportFields = getDefaultReportFields({
        refSlot: +refSlot,
        requestsCount: exitRequests.length,
        data: encodeExitRequestsDataList(exitRequests),
      });

      const reportItems = getValidatorsExitBusReportDataItems(reportFields);
      const reportHash = calcValidatorsExitBusReportDataHash(reportItems);

      //priority
      await oracle.connect(voting).submitPriorityReportData(reportHash, exitRequests.length);

      //check invalid request count
      const { pubkeys: keysInvalidRequestCount } = genPublicKeysArray(6);
      await expect(
        oracle.connect(stranger).forcedExitPubkeys(keysInvalidRequestCount, reportItems),
      ).to.be.revertedWithCustomError(oracle, "ErrorInvalidKeysRequestsCount");

      //check invalid request count
      const { pubkeys: validRequestLessInTheReport } = genPublicKeysArray(3);
      await expect(
        oracle.connect(stranger).forcedExitPubkeys(validRequestLessInTheReport, reportItems),
      ).not.to.be.revertedWithCustomError(oracle, "ErrorInvalidKeysRequestsCount");

      //check invalid request count
      const invalidKeyInRequest = [...keys];
      invalidKeyInRequest[2] = pad("0x010203", 48);
      await expect(
        oracle.connect(stranger).forcedExitPubkeys(invalidKeyInRequest, reportItems, { value: ether("1.0") }),
      ).to.be.revertedWithCustomError(oracle, "ErrorInvalidPubkeyInReport");

      //works
      await oracle.connect(stranger).forcedExitPubkeys(keys, reportItems, { value: ether("1.0") });
    });

    it("module request exit", async () => {
      const keysAmount = 5;
      const keys1 = genPublicKeysCalldata(keysAmount);

      await curatedModule.addSigningKeys(operator1Id, keysAmount, keys1.pubkeys, keys1.sigkeys);
      await curatedModule.setNodeOperatorStakingLimit(operator1Id, keysAmount - 2);

      const { pubkeys: keys } = genPublicKeysArray(keysAmount);

      const valPubkeyUnknown = pad("0x010101", 48);

      const requestIndex = 1;
      const requestKey = keys[requestIndex];

      //first attempt - no deposits
      await expect(
        prover.reportKeyToExit(curatedModuleId, operator1Id, requestIndex, requestKey, await bytes32()),
      ).to.be.revertedWithCustomError(prover, "ErrorKeyIsNotAvailiableToExit");

      //set keys are deposited
      await curatedModule.testing_markAllKeysDeposited(operator1Id);

      //calculate report
      const refSlot = 0; //await consensus.getCurrentFrame()
      const exitRequests = [
        { moduleId: 1, nodeOpId: 1, valIndex: 0, valPubkey: keys[0] },
        { moduleId: 2, nodeOpId: 2, valIndex: 0, valPubkey: keys[1] },
        { moduleId: 3, nodeOpId: 3, valIndex: 0, valPubkey: keys[2] },
        { moduleId: 4, nodeOpId: 4, valIndex: 0, valPubkey: keys[3] },
        { moduleId: 5, nodeOpId: 5, valIndex: 0, valPubkey: keys[4] },
      ];
      const reportFields = getDefaultReportFields({
        refSlot: +refSlot,
        requestsCount: exitRequests.length,
        data: encodeExitRequestsDataList(exitRequests),
      });

      const reportItems = getValidatorsExitBusReportDataItems(reportFields);
      const reportHash = calcValidatorsExitBusReportDataHash(reportItems);

      await prover.reportKeyToExit(curatedModuleId, operator1Id, requestIndex, requestKey, reportHash);

      //invalid key requested
      await expect(
        oracle.connect(stranger).forcedExitPubkey(valPubkeyUnknown, reportItems),
      ).not.to.be.revertedWithCustomError(oracle, "ErrorInvalidKeysRequestsCount");

      //unvetted key requested
      await expect(oracle.connect(stranger).forcedExitPubkey(keys[4], reportItems)).not.to.be.revertedWithCustomError(
        oracle,
        "ErrorInvalidKeysRequestsCount",
      );

      //requested key exit
      const tx = await oracle.connect(stranger).forcedExitPubkey(requestKey, reportItems, { value: ether("1.0") });
      await expect(tx).to.be.emit(oracle, "ValidatorForcedExitRequest");
      await expect(tx).to.be.emit(triggerableExitMock, "TriggerableExit");
    });
  });
});
