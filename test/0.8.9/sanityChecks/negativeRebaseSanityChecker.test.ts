import { expect } from "chai";
import { parseUnits, ZeroAddress } from "ethers";
import { artifacts, ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import {
  AccountingOracle__MockForSanityChecker,
  LidoLocator__MockForSanityChecker,
  OracleReportSanityChecker,
  StakingRouter__MockForSanityChecker,
} from "typechain-types";

import { ether } from "lib";

// pnpm hardhat test --grep "OracleReportSanityChecker"

describe("OracleReportSanityChecker.sol", () => {
  let locator: LidoLocator__MockForSanityChecker;
  let checker: OracleReportSanityChecker;
  let accountingOracle: AccountingOracle__MockForSanityChecker;
  let stakingRouter: StakingRouter__MockForSanityChecker;
  let deployer: HardhatEthersSigner;
  let genesisTime: bigint;
  const SLOTS_PER_DAY = 7200;

  const defaultLimitsList = {
    exitedValidatorsPerDayLimit: 50,
    appearedValidatorsPerDayLimit: 75,
    annualBalanceIncreaseBPLimit: 10_00, // 10%
    simulatedShareRateDeviationBPLimit: 2_50, // 2.5%
    maxValidatorExitRequestsPerReport: 2000,
    maxItemsPerExtraDataTransaction: 15,
    maxNodeOperatorsPerExtraDataItem: 16,
    requestTimestampMargin: 128,
    maxPositiveTokenRebase: 5_000_000, // 0.05%
    initialSlashingAmountPWei: 1000, // 1 ETH = 1000 PWei
    inactivityPenaltiesAmountPWei: 101, // 0.101 ETH = 101 PWei
    clBalanceOraclesErrorUpperBPLimit: 74, // 0.74%
  };

  const gweis = (x: number) => parseUnits(x.toString(), "gwei");

  const genAccessControlError = (caller: string, role: string): string => {
    return `AccessControl: account ${caller.toLowerCase()} is missing role ${role}`;
  };

  const deploySecondOpinionOracle = async () => {
    const secondOpinionOracle = await ethers.deployContract("SecondOpinionOracleMock");

    const clOraclesRole = await checker.SECOND_OPINION_MANAGER_ROLE();
    await checker.grantRole(clOraclesRole, deployer.address);

    // 10000 BP - 100%
    // 74 BP - 0.74%
    await checker.setSecondOpinionOracleAndCLBalanceUpperMargin(await secondOpinionOracle.getAddress(), 74);
    return secondOpinionOracle;
  };

  beforeEach(async () => {
    [deployer] = await ethers.getSigners();

    accountingOracle = await ethers.deployContract("AccountingOracle__MockForSanityChecker", [
      deployer.address,
      12,
      1606824023,
    ]);
    genesisTime = await accountingOracle.GENESIS_TIME();
    const sanityChecker = deployer.address;
    const burner = await ethers.deployContract("BurnerStub", []);
    stakingRouter = await ethers.deployContract("StakingRouter__MockForSanityChecker");

    locator = await ethers.deployContract("LidoLocator__MockForSanityChecker", [
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
      expect(secondsPerSlot).to.equal(12);
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
          case "uint32":
            return 32;
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
      expect(await checker.sumNegativeRebasesNotOlderThan(timestamp - 18 * SLOTS_PER_DAY)).to.equal(100 + 150 + 5 + 10);
    });

    it(`returns exited validators count`, async () => {
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
    });

    it(`returns exited validators count for missed or non-existent report`, async () => {
      const checker = await newChecker();
      const timestamp = await time.latest();
      await checker.addReportData(timestamp - 19 * SLOTS_PER_DAY, 10, 100);
      await checker.addReportData(timestamp - 18 * SLOTS_PER_DAY, 11, 100);
      await checker.addReportData(timestamp - 15 * SLOTS_PER_DAY, 12, 100);
      await checker.addReportData(timestamp - 5 * SLOTS_PER_DAY, 13, 100);
      await checker.addReportData(timestamp - 2 * SLOTS_PER_DAY, 14, 100);
      await checker.addReportData(timestamp - 1 * SLOTS_PER_DAY, 15, 100);
      // Out of range: day -20
      expect(await checker.exitedValidatorsAtTimestamp(timestamp - 20 * SLOTS_PER_DAY)).to.equal(0);
      // Missed report: day -6
      expect(await checker.exitedValidatorsAtTimestamp(timestamp - 6 * SLOTS_PER_DAY)).to.equal(12);
      // Missed report: day -7
      expect(await checker.exitedValidatorsAtTimestamp(timestamp - 7 * SLOTS_PER_DAY)).to.equal(12);
      // Expected report: day 15
      expect(await checker.exitedValidatorsAtTimestamp(timestamp - 15 * SLOTS_PER_DAY)).to.equal(12);
      // Missed report: day -16
      expect(await checker.exitedValidatorsAtTimestamp(timestamp - 16 * SLOTS_PER_DAY)).to.equal(11);
    });
  });

  context("OracleReportSanityChecker additional balance decrease check", () => {
    it(`works for IncorrectCLBalanceDecrease`, async () => {
      await expect(checker.checkAccountingOracleReport(0, ether("320"), ether("300"), 0, 0, 0, 10, 10))
        .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
        .withArgs(20n * ether("1"), 10n * ether("1") + 10n * ether("0.101"));
    });

    it(`works as accamulation for IncorrectCLBalanceDecrease`, async () => {
      const refSlot = Math.floor(((await time.latest()) - Number(genesisTime)) / 12);
      const prevRefSlot = refSlot - SLOTS_PER_DAY;

      await accountingOracle.setLastProcessingRefSlot(prevRefSlot);
      await checker.checkAccountingOracleReport(0, ether("320"), ether("310"), 0, 0, 0, 10, 10);

      await accountingOracle.setLastProcessingRefSlot(refSlot);
      await expect(checker.checkAccountingOracleReport(0, ether("310"), ether("300"), 0, 0, 0, 10, 10))
        .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
        .withArgs(20n * ether("1"), 10n * ether("1") + 10n * ether("0.101"));
    });

    it(`works for happy path and report is not ready`, async () => {
      const numGenesis = Number(genesisTime);
      const refSlot = Math.floor(((await time.latest()) - numGenesis) / 12);
      await accountingOracle.setLastProcessingRefSlot(refSlot);

      // Expect to pass through
      await checker.checkAccountingOracleReport(0, 96 * 1e9, 96 * 1e9, 0, 0, 0, 10, 10);

      const secondOpinionOracle = await deploySecondOpinionOracle();

      await expect(
        checker.checkAccountingOracleReport(0, ether("330"), ether("300"), 0, 0, 0, 10, 10),
      ).to.be.revertedWithCustomError(checker, "NegativeRebaseFailedSecondOpinionReportIsNotReady");

      await secondOpinionOracle.addReport(refSlot, {
        success: true,
        clBalanceGwei: gweis(300),
        withdrawalVaultBalanceWei: 0,
        numValidators: 0,
        exitedValidators: 0,
      });
      await expect(checker.checkAccountingOracleReport(0, ether("330"), ether("300"), 0, 0, 0, 10, 10))
        .to.emit(checker, "NegativeCLRebaseConfirmed")
        .withArgs(refSlot, ether("300"), ether("0"));
    });

    it("works with staking router reports exited validators at day 18 and 54", async () => {
      const refSlot = Math.floor(((await time.latest()) - Number(genesisTime)) / 12);
      const refSlot17 = refSlot - 17 * SLOTS_PER_DAY;
      const refSlot18 = refSlot - 18 * SLOTS_PER_DAY;
      const refSlot54 = refSlot - 54 * SLOTS_PER_DAY;
      const refSlot55 = refSlot - 55 * SLOTS_PER_DAY;

      await stakingRouter.addStakingModuleExitedValidators(1, 1);
      await accountingOracle.setLastProcessingRefSlot(refSlot55);
      await checker.checkAccountingOracleReport(0, ether("320"), ether("320"), 0, 0, 0, 10, 10);

      await stakingRouter.removeStakingModule(1);
      await stakingRouter.addStakingModuleExitedValidators(1, 2);
      await accountingOracle.setLastProcessingRefSlot(refSlot54);
      await checker.checkAccountingOracleReport(0, ether("320"), ether("320"), 0, 0, 0, 10, 10);

      await stakingRouter.removeStakingModule(1);
      await stakingRouter.addStakingModuleExitedValidators(1, 3);
      await accountingOracle.setLastProcessingRefSlot(refSlot18);
      await checker.checkAccountingOracleReport(0, ether("320"), ether("320"), 0, 0, 0, 10, 10);

      await accountingOracle.setLastProcessingRefSlot(refSlot17);
      await checker.checkAccountingOracleReport(0, ether("320"), ether("315"), 0, 0, 0, 10, 10);

      await accountingOracle.setLastProcessingRefSlot(refSlot);
      await expect(checker.checkAccountingOracleReport(0, ether("315"), ether("300"), 0, 0, 0, 10, 10))
        .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
        .withArgs(20n * ether("1"), 7n * ether("1") + 8n * ether("0.101"));
    });

    it(`works for reports close together`, async () => {
      const numGenesis = Number(genesisTime);
      const refSlot = Math.floor(((await time.latest()) - numGenesis) / 12);
      await accountingOracle.setLastProcessingRefSlot(refSlot);

      const secondOpinionOracle = await deploySecondOpinionOracle();

      // Second opinion balance is way bigger than general Oracle's (~1%)
      await secondOpinionOracle.addReport(refSlot, {
        success: true,
        clBalanceGwei: gweis(302),
        withdrawalVaultBalanceWei: 0,
        numValidators: 0,
        exitedValidators: 0,
      });
      await expect(checker.checkAccountingOracleReport(0, ether("330"), ether("299"), 0, 0, 0, 10, 10))
        .to.be.revertedWithCustomError(checker, "NegativeRebaseFailedCLBalanceMismatch")
        .withArgs(ether("299"), ether("302"), anyValue);

      // Second opinion balance is almost equal general Oracle's (<0.74%) - should pass
      await secondOpinionOracle.addReport(refSlot, {
        success: true,
        clBalanceGwei: gweis(301),
        withdrawalVaultBalanceWei: 0,
        numValidators: 0,
        exitedValidators: 0,
      });
      await expect(checker.checkAccountingOracleReport(0, ether("330"), ether("299"), 0, 0, 0, 10, 10))
        .to.emit(checker, "NegativeCLRebaseConfirmed")
        .withArgs(refSlot, ether("299"), ether("0"));

      // Second opinion balance is slightly less than general Oracle's (0.01%) - should fail
      await secondOpinionOracle.addReport(refSlot, {
        success: true,
        clBalanceGwei: 100,
        withdrawalVaultBalanceWei: 0,
        numValidators: 0,
        exitedValidators: 0,
      });
      await expect(checker.checkAccountingOracleReport(0, 110 * 1e9, 100.01 * 1e9, 0, 0, 0, 10, 10))
        .to.be.revertedWithCustomError(checker, "NegativeRebaseFailedCLBalanceMismatch")
        .withArgs(100.01 * 1e9, 100 * 1e9, anyValue);
    });

    it(`works for reports with incorrect withdrawal vault balance`, async () => {
      const numGenesis = Number(genesisTime);
      const refSlot = Math.floor(((await time.latest()) - numGenesis) / 12);
      await accountingOracle.setLastProcessingRefSlot(refSlot);

      const secondOpinionOracle = await deploySecondOpinionOracle();

      // Second opinion balance is almost equal general Oracle's (<0.74%) and withdrawal vauls is the same - should pass
      await secondOpinionOracle.addReport(refSlot, {
        success: true,
        clBalanceGwei: gweis(300),
        withdrawalVaultBalanceWei: ether("1"),
        numValidators: 0,
        exitedValidators: 0,
      });
      await expect(checker.checkAccountingOracleReport(0, ether("330"), ether("299"), ether("1"), 0, 0, 10, 10))
        .to.emit(checker, "NegativeCLRebaseConfirmed")
        .withArgs(refSlot, ether("299"), ether("1"));

      // Second opinion withdrawal vault balance is different - should fail
      await secondOpinionOracle.addReport(refSlot, {
        success: true,
        clBalanceGwei: gweis(300),
        withdrawalVaultBalanceWei: 0,
        numValidators: 0,
        exitedValidators: 0,
      });
      await expect(checker.checkAccountingOracleReport(0, ether("330"), ether("299"), ether("1"), 0, 0, 10, 10))
        .to.be.revertedWithCustomError(checker, "NegativeRebaseFailedWithdrawalVaultBalanceMismatch")
        .withArgs(ether("1"), 0);
    });
  });

  context("OracleReportSanityChecker roles", () => {
    it(`CL Oracle related functions require INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE`, async () => {
      const role = await checker.INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE();

      await expect(checker.setInitialSlashingAndPenaltiesAmount(0, 0)).to.be.revertedWith(
        genAccessControlError(deployer.address, role),
      );

      await checker.grantRole(role, deployer.address);
      await expect(checker.setInitialSlashingAndPenaltiesAmount(1000, 101)).to.not.be.reverted;
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

  context("OracleReportSanityChecker checkAccountingOracleReport authorization", () => {
    it("should allow calling from Lido address", async () => {
      await checker.checkAccountingOracleReport(0, 110 * 1e9, 109.99 * 1e9, 0, 0, 0, 10, 10);
    });

    it("should not allow calling from non-Lido address", async () => {
      const [, otherClient] = await ethers.getSigners();
      await expect(
        checker.connect(otherClient).checkAccountingOracleReport(0, 110 * 1e9, 110.01 * 1e9, 0, 0, 0, 10, 10),
      ).to.be.revertedWithCustomError(checker, "CalledNotFromLido");
    });
  });
});
