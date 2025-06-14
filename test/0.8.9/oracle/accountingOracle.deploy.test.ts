import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Accounting__MockForAccountingOracle,
  AccountingOracle,
  AccountingOracle__Harness,
  HashConsensus__Harness,
  StakingRouter__MockForAccountingOracle,
  WithdrawalQueue__MockForAccountingOracle,
} from "typechain-types";

import { AO_CONSENSUS_VERSION, EPOCHS_PER_FRAME, GENESIS_TIME, SECONDS_PER_SLOT, SLOTS_PER_EPOCH } from "lib";

import {
  deployAccountingOracleSetup,
  deployAndConfigureAccountingOracle,
  initAccountingOracle,
  ORACLE_LAST_COMPLETED_EPOCH,
} from "test/deploy";

describe("AccountingOracle.sol:deploy", () => {
  context("Deployment and initial configuration", () => {
    let admin: HardhatEthersSigner;
    let defaultOracle: AccountingOracle;

    before(async () => {
      [admin] = await ethers.getSigners();
      defaultOracle = (await deployAccountingOracleSetup(admin.address)).oracle;
    });

    const updateInitialEpoch = async (consensus: HashConsensus__Harness) => {
      // pretend we're after the legacy oracle's last proc epoch but before the new oracle's initial epoch
      const voteExecTime = GENESIS_TIME + (ORACLE_LAST_COMPLETED_EPOCH + 1n) * SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
      await consensus.setTime(voteExecTime);
      await consensus.updateInitialEpoch(ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME);
    };

    it("reverts when slotsPerSecond is zero", async () => {
      await expect(deployAccountingOracleSetup(admin.address, { secondsPerSlot: 0n })).to.be.revertedWithCustomError(
        defaultOracle,
        "SecondsPerSlotCannotBeZero",
      );
    });

    it("deployment and init finishes successfully otherwise", async () => {
      const deployed = await deployAccountingOracleSetup(admin.address);

      const voteExecTime = GENESIS_TIME + (ORACLE_LAST_COMPLETED_EPOCH + 1n) * SLOTS_PER_EPOCH * SECONDS_PER_SLOT;
      await deployed.consensus.setTime(voteExecTime);
      await deployed.consensus.updateInitialEpoch(ORACLE_LAST_COMPLETED_EPOCH + EPOCHS_PER_FRAME);

      await initAccountingOracle({ admin: admin.address, ...deployed });

      const refSlot = await deployed.oracle.getLastProcessingRefSlot();
      expect(refSlot).to.equal(0n);
    });

    context("deployment and init finishes successfully (default setup)", async () => {
      let consensus: HashConsensus__Harness;
      let oracle: AccountingOracle__Harness;
      let mockAccounting: Accounting__MockForAccountingOracle;
      let mockStakingRouter: StakingRouter__MockForAccountingOracle;
      let mockWithdrawalQueue: WithdrawalQueue__MockForAccountingOracle;
      let locatorAddr: string;

      before(async () => {
        const deployed = await deployAndConfigureAccountingOracle(admin.address);
        consensus = deployed.consensus;
        oracle = deployed.oracle;
        mockAccounting = deployed.accounting;
        mockStakingRouter = deployed.stakingRouter;
        mockWithdrawalQueue = deployed.withdrawalQueue;
        locatorAddr = deployed.locatorAddr;
      });

      it("mock setup is correct", async () => {
        // check the mock time-travellable setup
        const time1 = await consensus.getTime();
        expect(await oracle.getTime()).to.equal(time1);

        await consensus.advanceTimeBy(SECONDS_PER_SLOT);

        const time2 = await consensus.getTime();
        expect(time2).to.equal(time1 + BigInt(SECONDS_PER_SLOT));
        expect(await oracle.getTime()).to.equal(time2);

        const handleOracleReportCallData = await mockAccounting.lastCall__handleOracleReport();
        expect(handleOracleReportCallData.callCount).to.equal(0);

        const updateExitedKeysByModuleCallData = await mockStakingRouter.lastCall_updateExitedKeysByModule();
        expect(updateExitedKeysByModuleCallData.callCount).to.equal(0);

        expect(await mockStakingRouter.totalCalls_reportExitedKeysByNodeOperator()).to.equal(0);

        const onOracleReportLastCall = await mockWithdrawalQueue.lastCall__onOracleReport();
        expect(onOracleReportLastCall.callCount).to.equal(0);
      });

      it("initial configuration is correct", async () => {
        expect(await oracle.getConsensusContract()).to.equal(await consensus.getAddress());
        expect(await oracle.getConsensusVersion()).to.equal(AO_CONSENSUS_VERSION);
        expect(await oracle.LOCATOR()).to.equal(locatorAddr);
        expect(await oracle.SECONDS_PER_SLOT()).to.equal(SECONDS_PER_SLOT);
      });

      it("constructor reverts if lido locator address is zero", async () => {
        await expect(
          deployAccountingOracleSetup(admin.address, { lidoLocatorAddr: ZeroAddress }),
        ).to.be.revertedWithCustomError(defaultOracle, "LidoLocatorCannotBeZero");
      });

      it("initialize reverts if admin address is zero", async () => {
        const deployed = await deployAccountingOracleSetup(admin.address);
        await updateInitialEpoch(deployed.consensus);
        await expect(
          deployed.oracle.initialize(ZeroAddress, await deployed.consensus.getAddress(), AO_CONSENSUS_VERSION, 0n),
        ).to.be.revertedWithCustomError(defaultOracle, "AdminCannotBeZero");
      });

      it("initialize reverts if admin address is zero", async () => {
        const deployed = await deployAccountingOracleSetup(admin.address);
        await updateInitialEpoch(deployed.consensus);

        await expect(
          deployed.oracle.initialize(ZeroAddress, await deployed.consensus.getAddress(), AO_CONSENSUS_VERSION, 0),
        ).to.be.revertedWithCustomError(defaultOracle, "AdminCannotBeZero");
      });

      it("initialize succeeds otherwise", async () => {
        const deployed = await deployAccountingOracleSetup(admin.address);
        await updateInitialEpoch(deployed.consensus);

        await deployed.oracle.initialize(admin, await deployed.consensus.getAddress(), AO_CONSENSUS_VERSION, 0);
      });
    });
  });
});
