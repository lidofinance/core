import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracleMock,
  LidoLocatorMock,
  Multiprover,
  OracleReportSanityChecker,
  StakingRouterMockForZkSanityCheck,
} from "typechain-types";

// pnpm hardhat test --grep "OracleReportSanityChecker"

describe("OracleReportSanityChecker.sol", (...accounts) => {
  let locator: LidoLocatorMock;
  let checker: OracleReportSanityChecker;
  let accountingOracle: AccountingOracleMock;
  let stakingRouter: StakingRouterMockForZkSanityCheck;
  let deployer: HardhatEthersSigner;
  let multiprover: Multiprover;

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

    multiprover = await ethers.deployContract("Multiprover", [deployer.address]);

    accountingOracle = await ethers.deployContract("AccountingOracleMock", [deployer.address, 12, 1606824023]);
    stakingRouter = await ethers.deployContract("StakingRouterMockForZkSanityCheck");
    const sanityChecker = deployer.address;

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
        zkMultiprover: await multiprover.getAddress(),
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

    it(`staking router mock is functional`, async () => {
      await stakingRouter.addStakingModule(1, {
        totalExitedValidators: 10,
        totalDepositedValidators: 20,
        depositableValidatorsCount: 0,
      });
      expect(await stakingRouter.getStakingModuleIds()).to.deep.equal([1]);
      expect(await stakingRouter.getStakingModuleSummary(1)).to.deep.equal([10, 20, 0]);

      await stakingRouter.addStakingModule(2, {
        totalExitedValidators: 1,
        totalDepositedValidators: 2,
        depositableValidatorsCount: 0,
      });
      expect(await stakingRouter.getStakingModuleIds()).to.deep.equal([1, 2]);
      expect(await stakingRouter.getStakingModuleSummary(2)).to.deep.equal([1, 2, 0]);

      await stakingRouter.removeStakingModule(1);
      expect(await stakingRouter.getStakingModuleIds()).to.deep.equal([2]);
      expect(await stakingRouter.getStakingModuleSummary(1)).to.deep.equal([0, 0, 0]);
    });
  });

  context("OracleReportSanityChecker checks against zkOracles", () => {
    it(`base parameters are correct`, async () => {
      const timestamp = 100 * 12 + 1606824023;

      await expect(checker.checkAccountingReportZKP(96, 10, timestamp)).to.be.revertedWithCustomError(
        multiprover,
        "NoConsensus",
      );

      const zkOracle = await ethers.deployContract("ZkOracleMock");
      const role = await multiprover.MANAGE_MEMBERS_AND_QUORUM_ROLE();
      await multiprover.grantRole(role, deployer);

      await zkOracle.addReport(100, { success: true, clBalanceGwei: 95, numValidators: 10, exitedValidators: 3 });
      await multiprover.addMember(await zkOracle.getAddress(), 1);

      await expect(checker.checkAccountingReportZKP(96, 10, timestamp))
        .to.be.revertedWithCustomError(checker, "ClBalanceMismatch")
        .withArgs(96, 95);
    });
  });
});
