import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { AccountingOracleMock, LidoLocatorMock, OracleReportSanityChecker } from "typechain-types";

// pnpm hardhat test --grep "OracleReportSanityChecker"

describe("OracleReportSanityChecker.sol", (...accounts) => {
  let locator: LidoLocatorMock;
  let checker: OracleReportSanityChecker;
  let accountingOracle: AccountingOracleMock;
  let deployer: HardhatEthersSigner;

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
    const sanityChecker = deployer.address;
    const stakingRouter = deployer.address;

    locator = await ethers.deployContract("LidoLocatorMock", [
      {
        lido: deployer.address,
        depositSecurityModule: deployer.address,
        elRewardsVault: deployer.address,
        accountingOracle: await accountingOracle.getAddress(),
        legacyOracle: deployer.address,
        oracleReportSanityChecker: sanityChecker,
        burner: deployer.address,
        validatorsExitBusOracle: deployer.address,
        stakingRouter: stakingRouter,
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
  });
});
