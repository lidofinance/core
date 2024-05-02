import { expect } from "chai";
import { parseUnits, ZeroAddress } from "ethers";
import { artifacts, ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import {
  AccountingOracleMock,
  LidoLocatorMock,
  OracleReportSanityChecker,
  StakingRouterMockForValidatorsCount,
} from "typechain-types";

import { ether } from "lib";

// pnpm hardhat test --grep "OracleReportSanityChecker"

describe("OracleReportSanityChecker.sol", () => {
  let locator: LidoLocatorMock;
  let checker: OracleReportSanityChecker;
  let accountingOracle: AccountingOracleMock;
  let stakingRouter: StakingRouterMockForValidatorsCount;
  let deployer: HardhatEthersSigner;
  let genesisTime: bigint;
  const SLOTS_PER_DAY = 7200;

  const defaultLimitsList = {
    churnValidatorsPerDayLimit: 55,
    clBalanceDecreaseBPLimit: 3_20, // 3.2%
    clBalanceDecreaseHoursSpan: 18 * 24, // 18 days
    clBalanceOraclesErrorUpperBPLimit: 74, // 0.74%
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

  const gweis = (x: number) => parseUnits(x.toString(), "gwei");

  const genAccessControlError = (caller: string, role: string): string => {
    return `AccessControl: account ${caller.toLowerCase()} is missing role ${role}`;
  };

  beforeEach(async () => {
    [deployer] = await ethers.getSigners();

    accountingOracle = await ethers.deployContract("AccountingOracleMock", [deployer.address, 12, 1606824023]);
    genesisTime = await accountingOracle.GENESIS_TIME();
    const sanityChecker = deployer.address;
    const burner = await ethers.deployContract("BurnerStub", []);
    stakingRouter = await ethers.deployContract("StakingRouterMockForValidatorsCount");

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
        stakingRouter: await stakingRouter.getAddress(),
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
      expect(secondsPerSlot).to.equal(12);
      log("genesisTime", genesisTime);
    });

    it("has compact packed limits representation", async () => {
      const artifact = await artifacts.readArtifact("OracleReportSanityCheckerWrapper");

      const functionABI = artifact.abi.find(
        (entry) => entry.type === "function" && entry.name === "exposePackedLimits",
      );

      const sizeOfCalc = (x: string) => {
        switch (x) {
          case "uint256":
            return 256;
          case "uint64":
            return 64;
          case "uint48":
            return 48;
          case "uint16":
            return 16;
          default:
            expect.fail(`Unknown type ${x}`);
        }
      };

      const structSizeInBits = functionABI.outputs[0].components
        .map((x: { type: string }) => x.type)
        .reduce((acc: number, x: string) => acc + sizeOfCalc(x), 0);
      expect(structSizeInBits).to.lessThanOrEqual(256);
    });

    it(`second opinion can be changed or removed`, async () => {
      expect(await checker.secondOpinionOracle()).to.be.equal(ZeroAddress);

      const clOraclesRole = await checker.SECOND_OPINION_MANAGER_ROLE();
      await checker.grantRole(clOraclesRole, deployer.address);

      await checker.setSecondOpinionOracleAndCLBalanceUpperMargin(deployer.address, 74);
      expect(await checker.secondOpinionOracle()).to.be.equal(deployer.address);

      const allLimitsRole = await checker.ALL_LIMITS_MANAGER_ROLE();
      await checker.grantRole(allLimitsRole, deployer.address);

      await checker.setOracleReportLimits(defaultLimitsList, ZeroAddress);
      expect(await checker.secondOpinionOracle()).to.be.equal(ZeroAddress);
    });
  });

  context("OracleReportSanityChecker rebase report data", () => {
    async function newChecker() {
      const checker = await ethers.deployContract("OracleReportSanityCheckerWrapper", [
        await locator.getAddress(),
        deployer.address,
        Object.values(defaultLimitsList),
      ]);
      return checker;
    }

    it(`sums negative rebases for a few days`, async () => {
      const checker = await newChecker();
      const timestamp = await time.latest();
      expect(await checker.sumNegativeRebasesNotOlderThan(timestamp - 18 * SLOTS_PER_DAY)).to.equal(0);
      await checker.addReportData(timestamp - 1 * SLOTS_PER_DAY, 10, 100);
      await checker.addReportData(timestamp - 2 * SLOTS_PER_DAY, 10, 150);
      expect(await checker.sumNegativeRebasesNotOlderThan(timestamp - 18 * SLOTS_PER_DAY)).to.equal(250);
    });

    it(`sums negative rebases for 18 days`, async () => {
      const checker = await newChecker();
      const timestamp = await time.latest();
      await checker.addReportData(timestamp - 19 * SLOTS_PER_DAY, 0, 700);
      await checker.addReportData(timestamp - 18 * SLOTS_PER_DAY, 0, 13);
      await checker.addReportData(timestamp - 17 * SLOTS_PER_DAY, 0, 10);
      await checker.addReportData(timestamp - 5 * SLOTS_PER_DAY, 0, 5);
      await checker.addReportData(timestamp - 2 * SLOTS_PER_DAY, 0, 150);
      await checker.addReportData(timestamp - 1 * SLOTS_PER_DAY, 0, 100);
      expect(await checker.sumNegativeRebasesNotOlderThan(timestamp - 18 * SLOTS_PER_DAY)).to.equal(
        100 + 150 + 5 + 10 + 13,
      );
    });

    it(`exited validators count`, async () => {
      const checker = await newChecker();
      const timestamp = await time.latest();
      await checker.addReportData(timestamp - 19 * SLOTS_PER_DAY, 10, 100);
      await checker.addReportData(timestamp - 18 * SLOTS_PER_DAY, 11, 100);
      await checker.addReportData(timestamp - 17 * SLOTS_PER_DAY, 12, 100);
      await checker.addReportData(timestamp - 5 * SLOTS_PER_DAY, 13, 100);
      await checker.addReportData(timestamp - 2 * SLOTS_PER_DAY, 14, 100);
      await checker.addReportData(timestamp - 1 * SLOTS_PER_DAY, 15, 100);
      expect(await checker.exitedValidatorsAtTimestamp(timestamp - 19 * SLOTS_PER_DAY)).to.equal(10);
      expect(await checker.exitedValidatorsAtTimestamp(timestamp - 18 * SLOTS_PER_DAY)).to.equal(11);
      expect(await checker.exitedValidatorsAtTimestamp(timestamp - 1 * SLOTS_PER_DAY)).to.equal(15);
      // Out of range: day -20
      expect(await checker.exitedValidatorsAtTimestamp(timestamp - 20 * SLOTS_PER_DAY)).to.equal(0);
    });
  });

  context("OracleReportSanityChecker additional balance decrease check", () => {
    it(`works for IncorrectCLBalanceDecreaseForSpan`, async () => {
      await expect(checker.checkAccountingOracleReport(0, ether("320"), ether("300"), 0, 0, 0, 10, 10))
        .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecreaseForSpan")
        .withArgs(20n * ether("1"), 10n * ether("1") + 10n * ether("0.101"), 18 * 24);
    });

    it(`works as accamulation for IncorrectCLBalanceDecreaseForSpan`, async () => {
      const refSlot = Math.floor(((await time.latest()) - Number(genesisTime)) / 12);
      const prevRefSlot = refSlot - SLOTS_PER_DAY;

      await accountingOracle.setLastProcessingRefSlot(prevRefSlot);
      await checker.checkAccountingOracleReport(0, ether("320"), ether("310"), 0, 0, 0, 10, 10);

      await accountingOracle.setLastProcessingRefSlot(refSlot);
      await expect(checker.checkAccountingOracleReport(0, ether("310"), ether("300"), 0, 0, 0, 10, 10))
        .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecreaseForSpan")
        .withArgs(20n * ether("1"), 10n * ether("1") + 10n * ether("0.101"), 18 * 24);
    });

    it(`works for happy path and report is not ready`, async () => {
      const numGenesis = Number(genesisTime);
      const refSlot = Math.floor(((await time.latest()) - numGenesis) / 12);
      await accountingOracle.setLastProcessingRefSlot(refSlot);

      // Expect to pass through
      await checker.checkAccountingOracleReport(0, 96 * 1e9, 96 * 1e9, 0, 0, 0, 10, 10);

      const zkOracle = await ethers.deployContract("ZkOracleMock");

      const clOraclesRole = await checker.SECOND_OPINION_MANAGER_ROLE();
      await checker.grantRole(clOraclesRole, deployer.address);

      await checker.setSecondOpinionOracleAndCLBalanceUpperMargin(await zkOracle.getAddress(), 74);

      await expect(
        checker.checkAccountingOracleReport(0, ether("330"), ether("300"), 0, 0, 0, 10, 10),
      ).to.be.revertedWithCustomError(checker, "NegativeRebaseFailedCLStateReportIsNotReady");

      await zkOracle.addReport(refSlot, {
        success: true,
        clBalanceGwei: gweis(300),
        numValidators: 0,
        exitedValidators: 0,
      });
      await expect(checker.checkAccountingOracleReport(0, ether("330"), ether("300"), 0, 0, 0, 10, 10))
        .to.emit(checker, "NegativeCLRebaseConfirmed")
        .withArgs(refSlot, ether("300"));
    });

    it(`works reports close together`, async () => {
      const numGenesis = Number(genesisTime);
      const refSlot = Math.floor(((await time.latest()) - numGenesis) / 12);
      await accountingOracle.setLastProcessingRefSlot(refSlot);

      const zkOracle = await ethers.deployContract("ZkOracleMock");

      const clOraclesRole = await checker.SECOND_OPINION_MANAGER_ROLE();
      await checker.grantRole(clOraclesRole, deployer.address);

      // 10000 BP - 100%
      // 74 BP - 0.74%
      await checker.setSecondOpinionOracleAndCLBalanceUpperMargin(await zkOracle.getAddress(), 74);

      // Second opinion balance is way bigger than general Oracle's (~1%)
      await zkOracle.addReport(refSlot, {
        success: true,
        clBalanceGwei: gweis(302),
        numValidators: 0,
        exitedValidators: 0,
      });
      await expect(checker.checkAccountingOracleReport(0, ether("330"), ether("299"), 0, 0, 0, 10, 10))
        .to.be.revertedWithCustomError(checker, "NegativeRebaseFailedCLBalanceMismatch")
        .withArgs(ether("299"), ether("302"), anyValue);

      // Second opinion balance is almost equal general Oracle's (<0.74%) - should pass
      await zkOracle.addReport(refSlot, {
        success: true,
        clBalanceGwei: gweis(301),
        numValidators: 0,
        exitedValidators: 0,
      });
      await expect(checker.checkAccountingOracleReport(0, ether("330"), ether("299"), 0, 0, 0, 10, 10))
        .to.emit(checker, "NegativeCLRebaseConfirmed")
        .withArgs(refSlot, ether("299"));

      // Second opinion balance is slightly less than general Oracle's (0.01%) - should fail
      await zkOracle.addReport(refSlot, { success: true, clBalanceGwei: 100, numValidators: 0, exitedValidators: 0 });
      await expect(checker.checkAccountingOracleReport(0, 110 * 1e9, 100.01 * 1e9, 0, 0, 0, 10, 10))
        .to.be.revertedWithCustomError(checker, "NegativeRebaseFailedCLBalanceMismatch")
        .withArgs(100.01 * 1e9, 100 * 1e9, anyValue);
    });
  });

  context("OracleReportSanityChecker roles", () => {
    it(`CL Oracle related functions require CL_BALANCE_DECREASE_LIMIT_MANAGER_ROLE`, async () => {
      const decreaseRole = await checker.CL_BALANCE_DECREASE_LIMIT_MANAGER_ROLE();

      await expect(checker.setCLBalanceDecreaseBPLimitAndHoursSpan(0, 0)).to.be.revertedWith(
        genAccessControlError(deployer.address, decreaseRole),
      );

      await checker.grantRole(decreaseRole, deployer.address);
      await expect(checker.setCLBalanceDecreaseBPLimitAndHoursSpan(320, 18 * 24)).to.not.be.reverted;
    });

    it(`CL Oracle related functions require SECOND_OPINION_MANAGER_ROLE`, async () => {
      const clOraclesRole = await checker.SECOND_OPINION_MANAGER_ROLE();

      await expect(checker.setSecondOpinionOracleAndCLBalanceUpperMargin(ZeroAddress, 74)).to.be.revertedWith(
        genAccessControlError(deployer.address, clOraclesRole),
      );

      await checker.grantRole(clOraclesRole, deployer.address);
      await expect(checker.setSecondOpinionOracleAndCLBalanceUpperMargin(ZeroAddress, 74)).to.not.be.reverted;
    });
  });
});
