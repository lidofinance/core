import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { AccountingOracleMock, LidoLocatorMock, OracleReportSanityChecker } from "typechain-types";

// pnpm hardhat test --grep "OracleReportSanityChecker"

describe("OracleReportSanityChecker.sol", (...accounts) => {
  let locator: LidoLocatorMock;
  let checker: OracleReportSanityChecker;
  let accountingOracle: AccountingOracleMock;
  let deployer: HardhatEthersSigner;
  // let genesisTime: bigint;

  const managersRoster = {
    allLimitsManagers: accounts.slice(0, 2),
    churnValidatorsPerDayLimitManagers: accounts.slice(2, 4),
    oneOffCLBalanceDecreaseLimitManagers: accounts.slice(4, 6),
    annualBalanceIncreaseLimitManagers: accounts.slice(6, 8),
    shareRateDeviationLimitManagers: accounts.slice(8, 10),
    maxValidatorExitRequestsPerReportManagers: accounts.slice(10, 12),
    maxAccountingExtraDataListItemsCountManagers: accounts.slice(12, 14),
    maxNodeOperatorsPerExtraDataItemCountManagers: accounts.slice(14, 16),
    requestTimestampMarginManagers: accounts.slice(16, 18),
    maxPositiveTokenRebaseManagers: accounts.slice(18, 20),
  };
  const defaultLimitsList = {
    churnValidatorsPerDayLimit: 55,
    oneOffCLBalanceDecreaseBPLimit: 5_00, // 5%
    annualBalanceIncreaseBPLimit: 10_00, // 10%
    simulatedShareRateDeviationBPLimit: 2_50, // 2.5%
    maxValidatorExitRequestsPerReport: 2000,
    maxAccountingExtraDataListItemsCount: 15,
    maxNodeOperatorsPerExtraDataItemCount: 16,
    requestTimestampMargin: 128,
    maxPositiveTokenRebase: 5_000_000, // 0.05%
  };

  const log = console.log;
  // const log = () => {}

  beforeEach(async () => {
    [deployer] = await ethers.getSigners();

    accountingOracle = await ethers.deployContract("AccountingOracleMock", [deployer.address, 12, 1606824023]);
    // genesisTime = await accountingOracle.GENESIS_TIME();
    const sanityChecker = deployer.address;
    const burner = await ethers.deployContract("BurnerStub", []);

    locator = await ethers.deployContract("LidoLocatorMock", [
      {
        lido: deployer.address,
        depositSecurityModule: deployer.address,
        elRewardsVault: deployer.address,
        accountingOracle: await accountingOracle.getAddress(),
        legacyOracle: deployer.address,
        oracleReportSanityChecker: sanityChecker,
        burner: await burner.getAddress(),
        validatorsExitBusOracle: deployer.address,
        stakingRouter: deployer.address,
        treasury: deployer.address,
        withdrawalQueue: deployer.address,
        withdrawalVault: deployer.address,
        postTokenRebaseReceiver: deployer.address,
        oracleDaemonConfig: deployer.address,
      },
    ]);

    checker = await ethers.deployContract("OracleReportSanityChecker", [
      await locator.getAddress(),
      deployer.address,
      Object.values(defaultLimitsList),
      Object.values(managersRoster),
    ]);
  });

  context("OracleReportSanityChecker is functional", () => {
    it(`base parameters are correct`, async () => {
      const locateChecker = await locator.oracleReportSanityChecker();
      expect(locateChecker).to.equal(deployer.address);

      const locateLocator = await checker.getLidoLocator();
      expect(locateLocator).to.equal(await locator.getAddress());

      const secondsPerSlot = await accountingOracle.SECONDS_PER_SLOT();
      const genesisTime = await accountingOracle.GENESIS_TIME();
      log("secondsPerSlot", secondsPerSlot);
      log("genesisTime", genesisTime);
    });

    // it(`zk oracle can be changed or removed`, async () => {
    //   const timestamp = 100 * 12 + Number(genesisTime);
    //   expect(await checker.getNegativeRebaseOracle()).to.be.equal(await multiprover.getAddress());

    //   await expect(
    //     checker.checkAccountingOracleReport(timestamp, 96, 95, 0, 0, 0, 10, 10),
    //   ).to.be.revertedWithCustomError(multiprover, "NoConsensus");

    //   await checker.setNegativeRebaseOracle(ZeroAddress);
    //   expect(await checker.getNegativeRebaseOracle()).to.be.equal(ZeroAddress);

    //   await expect(checker.checkAccountingOracleReport(timestamp, 96, 95, 0, 0, 0, 10, 10)).not.to.be.reverted;
    // });
  });

  context("OracleReportSanityChecker rebase slots logic", () => {
    async function newChecker() {
      const checker = await ethers.deployContract("OracleReportSanityCheckerWrapper", [
        await locator.getAddress(),
        deployer.address,
        Object.values(defaultLimitsList),
        Object.values(managersRoster),
      ]);

      return checker;
    }
    const SLOTS_PER_DAY = 7200;

    it(`works for happy path`, async () => {
      const checker = await newChecker();
      const timestamp = await time.latest();

      const result = await checker.sumRebaseValuesNotOlderThan(timestamp - 18 * SLOTS_PER_DAY);
      expect(result).to.equal(0);

      await checker.addRebaseValue(100, timestamp - 1 * SLOTS_PER_DAY);
      await checker.addRebaseValue(150, timestamp - 2 * SLOTS_PER_DAY);

      const result2 = await checker.sumRebaseValuesNotOlderThan(timestamp - 18 * SLOTS_PER_DAY);
      expect(result2).to.equal(250);
    });

    it(`works for happy path`, async () => {
      const checker = await newChecker();
      const timestamp = await time.latest();

      await checker.addRebaseValue(700, timestamp - 19 * SLOTS_PER_DAY);
      await checker.addRebaseValue(13, timestamp - 18 * SLOTS_PER_DAY);
      await checker.addRebaseValue(10, timestamp - 17 * SLOTS_PER_DAY);
      await checker.addRebaseValue(5, timestamp - 5 * SLOTS_PER_DAY);
      await checker.addRebaseValue(150, timestamp - 2 * SLOTS_PER_DAY);
      await checker.addRebaseValue(100, timestamp - 1 * SLOTS_PER_DAY);

      const result = await checker.sumRebaseValuesNotOlderThan(timestamp - 18 * SLOTS_PER_DAY);
      expect(result).to.equal(100 + 150 + 5 + 10 + 13);
      log("result", result);
    });
  });

  // context("OracleReportSanityChecker checks against zkOracles", () => {
  //   it(`works for happy path, NoConsensus and ClBalanceMismatch`, async () => {
  //     const timestamp = 100 * 12 + Number(genesisTime);

  //     // Expect to pass through
  //     await checker.checkAccountingOracleReport(timestamp, 96, 96, 0, 0, 0, 10, 10);

  //     await expect(
  //       checker.checkAccountingOracleReport(timestamp, 96, 95, 0, 0, 0, 10, 10),
  //     ).to.be.revertedWithCustomError(multiprover, "NoConsensus");

  //     const zkOracle = await ethers.deployContract("ZkOracleMock");
  //     const role = await multiprover.MANAGE_MEMBERS_AND_QUORUM_ROLE();
  //     await multiprover.grantRole(role, deployer);

  //     await zkOracle.addReport(100, { success: true, clBalanceGwei: 95, numValidators: 10, exitedValidators: 3 });
  //     await multiprover.addMember(await zkOracle.getAddress(), 1);

  //     await expect(checker.checkAccountingOracleReport(timestamp, 96, 94, 0, 0, 0, 10, 10))
  //       .to.be.revertedWithCustomError(checker, "ClBalanceMismatch")
  //       .withArgs(94, 95);
  //   });

  // });
});
