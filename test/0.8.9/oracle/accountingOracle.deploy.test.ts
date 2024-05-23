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

import { CONSENSUS_VERSION, EPOCHS_PER_FRAME, GENESIS_TIME, SECONDS_PER_SLOT, SLOTS_PER_EPOCH } from "lib";

import {
  deployAccountingOracleSetup,
  deployAndConfigureAccountingOracle,
  deployMockLegacyOracle,
  initAccountingOracle,
  V1_ORACLE_LAST_COMPLETED_EPOCH,
} from "test/deploy";
import { Snapshot } from "test/suite";

describe("AccountingOracle.sol:deploy", () => {
  context("Deployment and initial configuration", () => {
    let admin: HardhatEthersSigner;
    let defaultOracle: AccountingOracle;

    before(async () => {
      [admin] = await ethers.getSigners();
      defaultOracle = (await deployAccountingOracleSetup(admin.address)).oracle;
    });
    const updateInitialEpoch = async (consensus: HashConsensusTimeTravellable) => {
      // pretend we're after the legacy oracle's last proc epoch but before the new oracle's initial epoch
      const voteExecTime = GENESIS_TIME + (V1_ORACLE_LAST_COMPLETED_EPOCH + 1n) * SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
      await consensus.setTime(voteExecTime);
      await consensus.updateInitialEpoch(V1_ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME);
    };

    it("init fails if the chain config is different from the one of the legacy oracle", async () => {
      let deployed = await deployAccountingOracleSetup(admin.address, {
        getLegacyOracle: () => deployMockLegacyOracle({ slotsPerEpoch: SLOTS_PER_EPOCH + 1n }),
      });
      await updateInitialEpoch(deployed.consensus);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed }))
        .to.be.revertedWithCustomError(deployed.oracle, "IncorrectOracleMigration")
        .withArgs(0);

      deployed = await deployAccountingOracleSetup(admin.address, {
        getLegacyOracle: () => deployMockLegacyOracle({ secondsPerSlot: SECONDS_PER_SLOT + 1n }),
      });
      await updateInitialEpoch(deployed.consensus);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed }))
        .to.be.revertedWithCustomError(deployed.oracle, "IncorrectOracleMigration")
        .withArgs(0);

      deployed = await deployAccountingOracleSetup(admin.address, {
        getLegacyOracle: () => deployMockLegacyOracle({ genesisTime: GENESIS_TIME + 1n }),
      });
      await updateInitialEpoch(deployed.consensus);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed }))
        .to.be.revertedWithCustomError(deployed.oracle, "IncorrectOracleMigration")
        .withArgs(0);
    });

    it("init fails if the frame size is different from the one of the legacy oracle", async () => {
      const deployed = await deployAccountingOracleSetup(admin.address, {
        getLegacyOracle: () => deployMockLegacyOracle({ epochsPerFrame: EPOCHS_PER_FRAME - 1n }),
      });
      await updateInitialEpoch(deployed.consensus);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed }))
        .to.be.revertedWithCustomError(deployed.oracle, "IncorrectOracleMigration")
        .withArgs(1);
    });

    it(`init fails if the initial epoch of the new oracle is not the next frame's first epoch`, async () => {
      const deployed = await deployAccountingOracleSetup(admin.address);

      const voteExecTime = GENESIS_TIME + (V1_ORACLE_LAST_COMPLETED_EPOCH + 1n) * SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
      await deployed.consensus.setTime(voteExecTime);

      let originalState = await Snapshot.take();
      await deployed.consensus.updateInitialEpoch(V1_ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME - 1n);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed }))
        .to.be.revertedWithCustomError(deployed.oracle, "IncorrectOracleMigration")
        .withArgs(2);
      await Snapshot.restore(originalState);

      originalState = await Snapshot.take();
      await deployed.consensus.updateInitialEpoch(V1_ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME + 1n);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed }))
        .to.be.revertedWithCustomError(deployed.oracle, "IncorrectOracleMigration")
        .withArgs(2);
      await Snapshot.restore(originalState);

      originalState = await Snapshot.take();
      await deployed.consensus.updateInitialEpoch(V1_ORACLE_LAST_COMPLETED_EPOCH + 2n * EPOCHS_PER_FRAME);
      await expect(initAccountingOracle({ admin: admin.address, ...deployed }))
        .to.be.revertedWithCustomError(deployed.oracle, "IncorrectOracleMigration")
        .withArgs(2);
      await Snapshot.restore(originalState);
    });

    it("reverts when slotsPerSecond is zero", async () => {
      await expect(deployAccountingOracleSetup(admin.address, { secondsPerSlot: 0n })).to.be.revertedWithCustomError(
        defaultOracle,
        "SecondsPerSlotCannotBeZero",
      );
    });

    it("deployment and init finishes successfully otherwise", async () => {
      const deployed = await deployAccountingOracleSetup(admin.address);

      const voteExecTime = GENESIS_TIME + (V1_ORACLE_LAST_COMPLETED_EPOCH + 1n) * SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
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
