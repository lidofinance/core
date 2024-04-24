import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracle,
  AccountingOracleTimeTravellable,
  HashConsensusTimeTravellable,
  LegacyOracle,
  MockLidoForAccountingOracle,
  MockStakingRouterForAccountingOracle,
  MockWithdrawalQueueForAccountingOracle,
} from "typechain-types";

import { hex, Snapshot, streccak } from "lib";

import {
  deployLocatorWithDummyAddressesImplementation,
  updateLocatorImplementation,
} from "../../../lib/locator-deploy";

// const { calcAccountingReportDataHash, getAccountingReportDataItems } = require('../../helpers/reportData')
import { CONSENSUS_VERSION, EPOCHS_PER_FRAME, GENESIS_TIME, SECONDS_PER_SLOT, SLOTS_PER_EPOCH } from "./baseOracle";
import { deployHashConsensus } from "./hashConsensus";

const V1_ORACLE_LAST_COMPLETED_EPOCH = 2 * EPOCHS_PER_FRAME;

const EXTRA_DATA_FORMAT_EMPTY = 0;
const EXTRA_DATA_FORMAT_LIST = 1;

const EXTRA_DATA_TYPE_STUCK_VALIDATORS = 1;
const EXTRA_DATA_TYPE_EXITED_VALIDATORS = 2;

function encodeExtraDataItem(
  itemIndex: number,
  itemType: number,
  moduleId: number,
  nodeOperatorIds: number[],
  keysCounts: number[],
) {
  const itemHeader = hex(itemIndex, 3) + hex(itemType, 2);
  const payloadHeader = hex(moduleId, 3) + hex(nodeOperatorIds.length, 8);
  const operatorIdsPayload = nodeOperatorIds.map((id) => hex(id, 8)).join("");
  const keysCountsPayload = keysCounts.map((count) => hex(count, 16)).join("");
  return "0x" + itemHeader + payloadHeader + operatorIdsPayload + keysCountsPayload;
}

export type KeyType = { moduleId: number; nodeOpIds: number[]; keysCounts: number[] };
export type ExtraDataType = { stuckKeys: KeyType[]; exitedKeys: KeyType[] };

export function encodeExtraDataItems(data: ExtraDataType) {
  const items: string[] = [];
  const encodeItem = (item: KeyType, type: number) =>
    encodeExtraDataItem(items.length, type, item.moduleId, item.nodeOpIds, item.keysCounts);
  data.stuckKeys.forEach((item: KeyType) => items.push(encodeItem(item, EXTRA_DATA_TYPE_STUCK_VALIDATORS)));
  data.exitedKeys.forEach((item: KeyType) => items.push(encodeItem(item, EXTRA_DATA_TYPE_EXITED_VALIDATORS)));
  return items;
}

export function packExtraDataList(extraDataItems: string[]) {
  return "0x" + extraDataItems.map((s) => s.substring(2)).join("");
}

export function calcExtraDataListHash(packedExtraDataList: string) {
  return streccak(packedExtraDataList);
}

async function deployMockLegacyOracle({
  epochsPerFrame = EPOCHS_PER_FRAME,
  slotsPerEpoch = SLOTS_PER_EPOCH,
  secondsPerSlot = SECONDS_PER_SLOT,
  genesisTime = GENESIS_TIME,
  lastCompletedEpochId = V1_ORACLE_LAST_COMPLETED_EPOCH,
} = {}) {
  const legacyOracle = await ethers.deployContract("MockLegacyOracle");
  await legacyOracle.setParams(epochsPerFrame, slotsPerEpoch, secondsPerSlot, genesisTime, lastCompletedEpochId);
  return legacyOracle;
}

async function deployMockLidoAndStakingRouter() {
  const stakingRouter = await ethers.deployContract("MockStakingRouterForAccountingOracle");
  const withdrawalQueue = await ethers.deployContract("MockWithdrawalQueueForAccountingOracle");
  const lido = await ethers.deployContract("MockLidoForAccountingOracle");
  return { lido, stakingRouter, withdrawalQueue };
}

async function deployAccountingOracleSetup(
  admin: string,
  {
    initialEpoch = null as number | null,
    epochsPerFrame = EPOCHS_PER_FRAME,
    slotsPerEpoch = SLOTS_PER_EPOCH,
    secondsPerSlot = SECONDS_PER_SLOT,
    genesisTime = GENESIS_TIME,
    getLidoAndStakingRouter = deployMockLidoAndStakingRouter,
    getLegacyOracle = deployMockLegacyOracle,
    lidoLocatorAddr = null as string | null,
    legacyOracleAddr = null as string | null,
    lidoAddr = null as string | null,
  } = {},
) {
  const locatorAddr = await (await deployLocatorWithDummyAddressesImplementation(admin)).getAddress();
  const { lido, stakingRouter, withdrawalQueue } = await getLidoAndStakingRouter();
  const oracleReportSanityChecker = await deployOracleReportSanityCheckerForAccounting(locatorAddr, admin);

  const legacyOracle = await getLegacyOracle();

  if (initialEpoch == null) {
    initialEpoch = Number((await legacyOracle.getLastCompletedEpochId()) + BigInt(epochsPerFrame));
  }

  const oracle = await ethers.deployContract("AccountingOracleTimeTravellable", [
    lidoLocatorAddr || locatorAddr,
    lidoAddr || (await lido.getAddress()),
    legacyOracleAddr || (await legacyOracle.getAddress()),
    secondsPerSlot,
    genesisTime,
  ]);

  const { consensus } = await deployHashConsensus(admin, {
    reportProcessor: oracle,
    epochsPerFrame,
    slotsPerEpoch,
    secondsPerSlot,
    genesisTime,
    initialEpoch,
  });
  await updateLocatorImplementation(locatorAddr, admin, {
    lido: lidoAddr || (await lido.getAddress()),
    stakingRouter: await stakingRouter.getAddress(),
    withdrawalQueue: await withdrawalQueue.getAddress(),
    oracleReportSanityChecker: await oracleReportSanityChecker.getAddress(),
    accountingOracle: await oracle.getAddress(),
  });

  // pretend we're at the first slot of the initial frame's epoch
  await consensus.setTime(genesisTime + initialEpoch * slotsPerEpoch * secondsPerSlot);

  return {
    lido,
    stakingRouter,
    withdrawalQueue,
    locatorAddr,
    legacyOracle,
    oracle,
    consensus,
    oracleReportSanityChecker,
  };
}

interface AccountingOracleConfig {
  admin: string;
  oracle: AccountingOracle;
  consensus: HashConsensusTimeTravellable;
  dataSubmitter?: string;
  consensusVersion?: number;
  shouldMigrateLegacyOracle?: boolean;
  lastProcessingRefSlot?: number;
}

async function initAccountingOracle({
  admin,
  oracle,
  consensus,
  dataSubmitter = undefined,
  consensusVersion = CONSENSUS_VERSION,
  shouldMigrateLegacyOracle = true,
  lastProcessingRefSlot = 0,
}: AccountingOracleConfig) {
  let initTx;
  if (shouldMigrateLegacyOracle)
    initTx = await oracle.initialize(admin, await consensus.getAddress(), consensusVersion);
  else
    initTx = await oracle.initializeWithoutMigration(
      admin,
      await consensus.getAddress(),
      consensusVersion,
      lastProcessingRefSlot,
    );

  await oracle.grantRole(await oracle.MANAGE_CONSENSUS_CONTRACT_ROLE(), admin);
  await oracle.grantRole(await oracle.MANAGE_CONSENSUS_VERSION_ROLE(), admin);

  if (dataSubmitter) {
    await oracle.grantRole(await oracle.SUBMIT_DATA_ROLE(), dataSubmitter);
  }

  expect(await oracle.EXTRA_DATA_FORMAT_EMPTY()).to.be.equal(EXTRA_DATA_FORMAT_EMPTY);
  expect(await oracle.EXTRA_DATA_FORMAT_LIST()).to.be.equal(EXTRA_DATA_FORMAT_LIST);
  expect(await oracle.EXTRA_DATA_TYPE_STUCK_VALIDATORS()).to.be.equal(EXTRA_DATA_TYPE_STUCK_VALIDATORS);
  expect(await oracle.EXTRA_DATA_TYPE_EXITED_VALIDATORS()).to.be.equal(EXTRA_DATA_TYPE_EXITED_VALIDATORS);

  return initTx;
}

async function deployOracleReportSanityCheckerForAccounting(lidoLocator: string, admin: string) {
  const churnValidatorsPerDayLimit = 100;
  const limitsList = [churnValidatorsPerDayLimit, 0, 0, 0, 32 * 12, 15, 16, 0, 0];
  const managersRoster = [[admin], [admin], [admin], [admin], [admin], [admin], [admin], [admin], [admin], [admin]];

  const oracleReportSanityChecker = await ethers.deployContract("OracleReportSanityChecker", [
    lidoLocator,
    admin,
    limitsList,
    managersRoster,
  ]);
  return oracleReportSanityChecker;
}

interface AccountingOracleSetup {
  admin: string;
  consensus: HashConsensusTimeTravellable;
  oracle: AccountingOracle;
  legacyOracle: LegacyOracle;
  dataSubmitter?: string;
  consensusVersion?: number;
}

async function configureAccountingOracleSetup({
  admin,
  consensus,
  oracle,
  legacyOracle,
  dataSubmitter = undefined,
  consensusVersion = CONSENSUS_VERSION,
}: AccountingOracleSetup) {
  // this is done as a part of the protocol upgrade voting execution

  const frameConfig = await consensus.getFrameConfig();
  // TODO: Double check it
  await consensus.setTimeInEpochs(await legacyOracle.getLastCompletedEpochId());

  const initialEpoch = (await legacyOracle.getLastCompletedEpochId()) + frameConfig.epochsPerFrame;

  const updateInitialEpochIx = await consensus.updateInitialEpoch(initialEpoch);
  const initTx = await initAccountingOracle({ admin, oracle, consensus, dataSubmitter, consensusVersion });

  return { updateInitialEpochIx, initTx };
}

async function deployAndConfigureAccountingOracle(admin: string) {
  /// this is done (far) before the protocol upgrade voting initiation:
  ///   1. deploy HashConsensus
  ///   2. deploy AccountingOracle impl
  const deployed = await deployAccountingOracleSetup(admin);

  // pretend we're after the legacy oracle's last proc epoch but before the new oracle's initial epoch
  expect(EPOCHS_PER_FRAME).to.be.greaterThan(1);
  const voteExecTime = GENESIS_TIME + (V1_ORACLE_LAST_COMPLETED_EPOCH + 1) * SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
  await deployed.consensus.setTime(voteExecTime);

  /// this is done as a part of the protocol upgrade voting execution:
  ///   1. calculate HashConsensus initial epoch as the last finalized legacy epoch + frame size
  ///   2. set HashConsensus initial epoch
  ///   3. deploy AccountingOracle proxy (skipped in these tests as they're not testing the proxy setup)
  ///   4. initialize AccountingOracle
  const finalizeResult = await configureAccountingOracleSetup({ admin, ...deployed });

  // pretend we're at the first slot of the new oracle's initial epoch
  const initialEpoch = V1_ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME;
  await deployed.consensus.setTime(GENESIS_TIME + initialEpoch * SLOTS_PER_EPOCH * SECONDS_PER_SLOT);

  return { ...deployed, ...finalizeResult };
}

export async function getInitialFrameStartTime(consensus: HashConsensusTimeTravellable) {
  const chainConfig = await consensus.getChainConfig();
  const frameConfig = await consensus.getFrameConfig();
  return (
    BigInt(frameConfig.initialEpoch) * chainConfig.slotsPerEpoch * chainConfig.secondsPerSlot +
    BigInt(chainConfig.genesisTime)
  );
}

describe("AccountingOracle.sol", () => {
  context("Deployment and initial configuration", () => {
    let admin: HardhatEthersSigner;
    let defaultOracle: AccountingOracle;

    before(async () => {
      [admin] = await ethers.getSigners();
      defaultOracle = (await deployAccountingOracleSetup(admin.address)).oracle;
    });
    const updateInitialEpoch = async (consensus: HashConsensusTimeTravellable) => {
      // pretend we're after the legacy oracle's last proc epoch but before the new oracle's initial epoch
      const voteExecTime = GENESIS_TIME + (V1_ORACLE_LAST_COMPLETED_EPOCH + 1) * SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
      await consensus.setTime(voteExecTime);
      await consensus.updateInitialEpoch(V1_ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME);
    };

    it("init fails if the chain config is different from the one of the legacy oracle", async () => {
      let deployed = await deployAccountingOracleSetup(admin.address, {
        getLegacyOracle: () => deployMockLegacyOracle({ slotsPerEpoch: SLOTS_PER_EPOCH + 1 }),
      });
      await updateInitialEpoch(deployed.consensus);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed }))
        .to.be.revertedWithCustomError(deployed.oracle, "IncorrectOracleMigration")
        .withArgs(0);

      deployed = await deployAccountingOracleSetup(admin.address, {
        getLegacyOracle: () => deployMockLegacyOracle({ secondsPerSlot: SECONDS_PER_SLOT + 1 }),
      });
      await updateInitialEpoch(deployed.consensus);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed }))
        .to.be.revertedWithCustomError(deployed.oracle, "IncorrectOracleMigration")
        .withArgs(0);

      deployed = await deployAccountingOracleSetup(admin.address, {
        getLegacyOracle: () => deployMockLegacyOracle({ genesisTime: GENESIS_TIME + 1 }),
      });
      await updateInitialEpoch(deployed.consensus);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed }))
        .to.be.revertedWithCustomError(deployed.oracle, "IncorrectOracleMigration")
        .withArgs(0);
    });

    it("init fails if the frame size is different from the one of the legacy oracle", async () => {
      const deployed = await deployAccountingOracleSetup(admin.address, {
        getLegacyOracle: () => deployMockLegacyOracle({ epochsPerFrame: EPOCHS_PER_FRAME - 1 }),
      });
      await updateInitialEpoch(deployed.consensus);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed }))
        .to.be.revertedWithCustomError(deployed.oracle, "IncorrectOracleMigration")
        .withArgs(1);
    });

    it(`init fails if the initial epoch of the new oracle is not the next frame's first epoch`, async () => {
      const deployed = await deployAccountingOracleSetup(admin.address);

      const voteExecTime = GENESIS_TIME + (V1_ORACLE_LAST_COMPLETED_EPOCH + 1) * SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
      await deployed.consensus.setTime(voteExecTime);

      let originalState = await Snapshot.take();
      await deployed.consensus.updateInitialEpoch(V1_ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME - 1);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed }))
        .to.be.revertedWithCustomError(deployed.oracle, "IncorrectOracleMigration")
        .withArgs(2);
      await Snapshot.restore(originalState);

      originalState = await Snapshot.take();
      await deployed.consensus.updateInitialEpoch(V1_ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME + 1);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed }))
        .to.be.revertedWithCustomError(deployed.oracle, "IncorrectOracleMigration")
        .withArgs(2);
      await Snapshot.restore(originalState);

      originalState = await Snapshot.take();
      await deployed.consensus.updateInitialEpoch(V1_ORACLE_LAST_COMPLETED_EPOCH + 2 * EPOCHS_PER_FRAME);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed }))
        .to.be.revertedWithCustomError(deployed.oracle, "IncorrectOracleMigration")
        .withArgs(2);
      await Snapshot.restore(originalState);
    });

    it("reverts when slotsPerSecond is zero", async () => {
      await expect(deployAccountingOracleSetup(admin.address, { secondsPerSlot: 0 })).to.be.revertedWithCustomError(
        defaultOracle,
        "SecondsPerSlotCannotBeZero",
      );
    });

    it("deployment and init finishes successfully otherwise", async () => {
      const deployed = await deployAccountingOracleSetup(admin.address);

      const voteExecTime = GENESIS_TIME + (V1_ORACLE_LAST_COMPLETED_EPOCH + 1) * SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
      await deployed.consensus.setTime(voteExecTime);
      await deployed.consensus.updateInitialEpoch(V1_ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME);

      await initAccountingOracle({ admin: admin.address, ...deployed });

      const refSlot = await deployed.oracle.getLastProcessingRefSlot();
      const epoch = await deployed.legacyOracle.getLastCompletedEpochId();
      expect(refSlot).to.be.equal(epoch * BigInt(SLOTS_PER_EPOCH));
    });

    describe("deployment and init finishes successfully (default setup)", async () => {
      let consensus: HashConsensusTimeTravellable;
      let oracle: AccountingOracleTimeTravellable;
      let mockLido: MockLidoForAccountingOracle;
      let mockStakingRouter: MockStakingRouterForAccountingOracle;
      let mockWithdrawalQueue: MockWithdrawalQueueForAccountingOracle;
      let legacyOracle: LegacyOracle;

      before(async () => {
        const deployed = await deployAndConfigureAccountingOracle(admin.address);
        consensus = deployed.consensus;
        oracle = deployed.oracle;
        mockLido = deployed.lido;
        mockStakingRouter = deployed.stakingRouter;
        mockWithdrawalQueue = deployed.withdrawalQueue;
        legacyOracle = deployed.legacyOracle;
      });

      it("mock setup is correct", async () => {
        // check the mock time-travellable setup
        const time1 = await consensus.getTime();
        expect(await oracle.getTime()).to.be.equal(time1);

        await consensus.advanceTimeBy(SECONDS_PER_SLOT);

        const time2 = await consensus.getTime();
        expect(time2).to.be.equal(time1 + BigInt(SECONDS_PER_SLOT));
        expect(await oracle.getTime()).to.be.equal(time2);

        const handleOracleReportCallData = await mockLido.getLastCall_handleOracleReport();
        expect(handleOracleReportCallData.callCount).to.be.equal(0);

        const updateExitedKeysByModuleCallData = await mockStakingRouter.lastCall_updateExitedKeysByModule();
        expect(updateExitedKeysByModuleCallData.callCount).to.be.equal(0);

        expect(await mockStakingRouter.totalCalls_reportExitedKeysByNodeOperator()).to.be.equal(0);
        expect(await mockStakingRouter.totalCalls_reportStuckKeysByNodeOperator()).to.be.equal(0);

        const onOracleReportLastCall = await mockWithdrawalQueue.lastCall__onOracleReport();
        expect(onOracleReportLastCall.callCount).to.be.equal(0);
      });

      it("the initial reference slot is greater than the last one of the legacy oracle", async () => {
        const legacyRefSlot = (await legacyOracle.getLastCompletedEpochId()) * BigInt(SLOTS_PER_EPOCH);
        expect((await consensus.getCurrentFrame()).refSlot).to.be.greaterThan(legacyRefSlot);
      });

      it("initial configuration is correct", async () => {
        expect(await oracle.getConsensusContract()).to.be.equal(await consensus.getAddress());
        expect(await oracle.getConsensusVersion()).to.be.equal(CONSENSUS_VERSION);
        expect(await oracle.LIDO()).to.be.equal(await mockLido.getAddress());
        expect(await oracle.SECONDS_PER_SLOT()).to.be.equal(SECONDS_PER_SLOT);
      });

      it("constructor reverts if lido locator address is zero", async () => {
        await expect(
          deployAccountingOracleSetup(admin.address, { lidoLocatorAddr: ZeroAddress }),
        ).to.be.revertedWithCustomError(defaultOracle, "LidoLocatorCannotBeZero");
      });

      it("constructor reverts if legacy oracle address is zero", async () => {
        await expect(
          deployAccountingOracleSetup(admin.address, { legacyOracleAddr: ZeroAddress }),
        ).to.be.revertedWithCustomError(defaultOracle, "LegacyOracleCannotBeZero");
      });

      it("constructor reverts if lido address is zero", async () => {
        await expect(
          deployAccountingOracleSetup(admin.address, { lidoAddr: ZeroAddress }),
        ).to.be.revertedWithCustomError(defaultOracle, "LidoCannotBeZero");
      });

      it("initialize reverts if admin address is zero", async () => {
        const deployed = await deployAccountingOracleSetup(admin.address);
        await updateInitialEpoch(deployed.consensus);
        await expect(
          deployed.oracle.initialize(ZeroAddress, await deployed.consensus.getAddress(), CONSENSUS_VERSION),
        ).to.be.revertedWithCustomError(defaultOracle, "AdminCannotBeZero");
      });

      it("initializeWithoutMigration reverts if admin address is zero", async () => {
        const deployed = await deployAccountingOracleSetup(admin.address);
        await updateInitialEpoch(deployed.consensus);

        await expect(
          deployed.oracle.initializeWithoutMigration(
            ZeroAddress,
            await deployed.consensus.getAddress(),
            CONSENSUS_VERSION,
            0,
          ),
        ).to.be.revertedWithCustomError(defaultOracle, "AdminCannotBeZero");
      });

      it("initializeWithoutMigration succeeds otherwise", async () => {
        const deployed = await deployAccountingOracleSetup(admin.address);
        await updateInitialEpoch(deployed.consensus);

        await deployed.oracle.initializeWithoutMigration(
          admin,
          await deployed.consensus.getAddress(),
          CONSENSUS_VERSION,
          0,
        );
      });
    });
  });
});
