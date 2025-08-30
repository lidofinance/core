import { expect } from "chai";
import { parseUnits, ZeroAddress } from "ethers";
import { artifacts, ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Accounting__MockForSanityChecker,
  AccountingOracle__MockForSanityChecker,
  LidoLocator__MockForSanityChecker,
  OracleReportSanityChecker,
  StakingRouter__MockForSanityChecker,
} from "typechain-types";

import { ether, getCurrentBlockTimestamp, impersonate } from "lib";

import { Snapshot } from "test/suite";

const SLOTS_PER_DAY = 7200n;

describe("OracleReportSanityChecker.sol:negative-rebase", () => {
  let locator: LidoLocator__MockForSanityChecker;
  let checker: OracleReportSanityChecker;
  let accountingOracle: AccountingOracle__MockForSanityChecker;
  let accounting: Accounting__MockForSanityChecker;
  let stakingRouter: StakingRouter__MockForSanityChecker;
  let deployer: HardhatEthersSigner;
  let accountingSigner: HardhatEthersSigner;

  const defaultLimitsList = {
    exitedValidatorsPerDayLimit: 50n,
    appearedValidatorsPerDayLimit: 75n,
    annualBalanceIncreaseBPLimit: 10_00n, // 10%
    simulatedShareRateDeviationBPLimit: 2_00n, // 2%
    maxValidatorExitRequestsPerReport: 2000n,
    maxItemsPerExtraDataTransaction: 15n,
    maxNodeOperatorsPerExtraDataItem: 16n,
    requestTimestampMargin: 128n,
    maxPositiveTokenRebase: 5_000_000n, // 0.05%
    initialSlashingAmountPWei: 1000n, // 1 ETH = 1000 PWei
    inactivityPenaltiesAmountPWei: 101n, // 0.101 ETH = 101 PWei
    clBalanceOraclesErrorUpperBPLimit: 50n, // 0.5%
  };

  let originalState: string;

  const deploySecondOpinionOracle = async () => {
    const secondOpinionOracle = await ethers.deployContract("SecondOpinionOracle__Mock");

    const clOraclesRole = await checker.SECOND_OPINION_MANAGER_ROLE();
    await checker.grantRole(clOraclesRole, deployer.address);

    // 10000 BP - 100%
    // 74 BP - 0.74%
    await checker.setSecondOpinionOracleAndCLBalanceUpperMargin(await secondOpinionOracle.getAddress(), 74n);
    return secondOpinionOracle;
  };

  before(async () => {
    [deployer] = await ethers.getSigners();

    const sanityCheckerAddress = deployer.address;

    const burner = await ethers.deployContract("Burner__MockForSanityChecker", []);
    accounting = await ethers.deployContract("Accounting__MockForSanityChecker", []);

    accountingOracle = await ethers.deployContract("AccountingOracle__MockForSanityChecker", [
      deployer.address,
      12,
      1606824023,
    ]);
    stakingRouter = await ethers.deployContract("StakingRouter__MockForSanityChecker");

    locator = await ethers.deployContract("LidoLocator__MockForSanityChecker", [
      {
        lido: deployer.address,
        depositSecurityModule: deployer.address,
        elRewardsVault: deployer.address,
        accountingOracle: await accountingOracle.getAddress(),
        oracleReportSanityChecker: sanityCheckerAddress,
        burner: await burner.getAddress(),
        validatorsExitBusOracle: deployer.address,
        stakingRouter: await stakingRouter.getAddress(),
        treasury: deployer.address,
        withdrawalQueue: deployer.address,
        withdrawalVault: deployer.address,
        postTokenRebaseReceiver: deployer.address,
        oracleDaemonConfig: deployer.address,
        validatorExitDelayVerifier: deployer.address,
        triggerableWithdrawalsGateway: deployer.address,
        accounting: await accounting.getAddress(),
        wstETH: deployer.address,
        vaultHub: deployer.address,
        vaultFactory: deployer.address,
        lazyOracle: deployer.address,
        predepositGuarantee: deployer.address,
        operatorGrid: deployer.address,
      },
    ]);

    const locatorAddress = await locator.getAddress();
    const accountingOracleAddress = await accountingOracle.getAddress();
    const accountingAddress = await accounting.getAddress();

    checker = await ethers
      .getContractFactory("OracleReportSanityChecker")
      .then((f) =>
        f.deploy(locatorAddress, accountingOracleAddress, accountingAddress, deployer.address, defaultLimitsList),
      );

    accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("OracleReportSanityChecker checkAccountingOracleReport authorization", () => {
    it("should allow calling from Accounting address", async () => {
      await checker.connect(accountingSigner).checkAccountingOracleReport(0, 110 * 1e9, 109.99 * 1e9, 0, 0, 0, 10, 10);
    });

    it("should not allow calling from non-Accounting address", async () => {
      const [, otherClient] = await ethers.getSigners();
      await expect(
        checker.connect(otherClient).checkAccountingOracleReport(0, 110 * 1e9, 110.01 * 1e9, 0, 0, 0, 10, 10),
      ).to.be.revertedWithCustomError(checker, "CalledNotFromAccounting");
    });
  });

  context("OracleReportSanityChecker is functional", () => {
    it("base parameters are correct", async () => {
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

    it("second opinion can be changed or removed", async () => {
      expect(await checker.secondOpinionOracle()).to.equal(ZeroAddress);

      const clOraclesRole = await checker.SECOND_OPINION_MANAGER_ROLE();
      await checker.grantRole(clOraclesRole, deployer.address);

      await checker.setSecondOpinionOracleAndCLBalanceUpperMargin(deployer.address, 74);
      expect(await checker.secondOpinionOracle()).to.equal(deployer.address);

      const allLimitsRole = await checker.ALL_LIMITS_MANAGER_ROLE();
      await checker.grantRole(allLimitsRole, deployer.address);

      await checker.setOracleReportLimits(defaultLimitsList, ZeroAddress);
      expect(await checker.secondOpinionOracle()).to.equal(ZeroAddress);
    });
  });

  context("OracleReportSanityChecker rebase report data", () => {
    async function newChecker() {
      return await ethers.deployContract("OracleReportSanityCheckerWrapper", [
        await locator.getAddress(),
        await accountingOracle.getAddress(),
        await accounting.getAddress(),
        deployer.address,
        Object.values(defaultLimitsList),
      ]);
    }

    it("sums negative rebases for a few days", async () => {
      const reportChecker = await newChecker();
      const timestamp = await getCurrentBlockTimestamp();
      expect(await reportChecker.sumNegativeRebasesNotOlderThan(timestamp - 18n * SLOTS_PER_DAY)).to.equal(0);
      await reportChecker.addReportData(timestamp - 1n * SLOTS_PER_DAY, 10, 100);
      await reportChecker.addReportData(timestamp - 2n * SLOTS_PER_DAY, 10, 150);
      expect(await reportChecker.sumNegativeRebasesNotOlderThan(timestamp - 18n * SLOTS_PER_DAY)).to.equal(250);
    });

    it("sums negative rebases for 18 days", async () => {
      const reportChecker = await newChecker();
      const timestamp = await getCurrentBlockTimestamp();

      await reportChecker.addReportData(timestamp - 19n * SLOTS_PER_DAY, 0, 700);
      await reportChecker.addReportData(timestamp - 18n * SLOTS_PER_DAY, 0, 13);
      await reportChecker.addReportData(timestamp - 17n * SLOTS_PER_DAY, 0, 10);
      await reportChecker.addReportData(timestamp - 5n * SLOTS_PER_DAY, 0, 5);
      await reportChecker.addReportData(timestamp - 2n * SLOTS_PER_DAY, 0, 150);
      await reportChecker.addReportData(timestamp - 1n * SLOTS_PER_DAY, 0, 100);

      const expectedSum = await reportChecker.sumNegativeRebasesNotOlderThan(timestamp - 18n * SLOTS_PER_DAY);
      expect(expectedSum).to.equal(100 + 150 + 5 + 10);
    });

    it("returns exited validators count", async () => {
      const reportChecker = await newChecker();
      const timestamp = await getCurrentBlockTimestamp();

      await reportChecker.addReportData(timestamp - 19n * SLOTS_PER_DAY, 10, 100);
      await reportChecker.addReportData(timestamp - 18n * SLOTS_PER_DAY, 11, 100);
      await reportChecker.addReportData(timestamp - 17n * SLOTS_PER_DAY, 12, 100);
      await reportChecker.addReportData(timestamp - 5n * SLOTS_PER_DAY, 13, 100);
      await reportChecker.addReportData(timestamp - 2n * SLOTS_PER_DAY, 14, 100);
      await reportChecker.addReportData(timestamp - 1n * SLOTS_PER_DAY, 15, 100);

      expect(await reportChecker.exitedValidatorsAtTimestamp(timestamp - 19n * SLOTS_PER_DAY)).to.equal(10);
      expect(await reportChecker.exitedValidatorsAtTimestamp(timestamp - 18n * SLOTS_PER_DAY)).to.equal(11);
      expect(await reportChecker.exitedValidatorsAtTimestamp(timestamp - 1n * SLOTS_PER_DAY)).to.equal(15);
    });

    it("returns exited validators count for missed or non-existent report", async () => {
      const reportChecker = await newChecker();
      const timestamp = await getCurrentBlockTimestamp();
      await reportChecker.addReportData(timestamp - 19n * SLOTS_PER_DAY, 10, 100);
      await reportChecker.addReportData(timestamp - 18n * SLOTS_PER_DAY, 11, 100);
      await reportChecker.addReportData(timestamp - 15n * SLOTS_PER_DAY, 12, 100);
      await reportChecker.addReportData(timestamp - 5n * SLOTS_PER_DAY, 13, 100);
      await reportChecker.addReportData(timestamp - 2n * SLOTS_PER_DAY, 14, 100);
      await reportChecker.addReportData(timestamp - 1n * SLOTS_PER_DAY, 15, 100);

      // Out of range: day -20
      expect(await reportChecker.exitedValidatorsAtTimestamp(timestamp - 20n * SLOTS_PER_DAY)).to.equal(0);
      // Missed report: day -6
      expect(await reportChecker.exitedValidatorsAtTimestamp(timestamp - 6n * SLOTS_PER_DAY)).to.equal(12);
      // Missed report: day -7
      expect(await reportChecker.exitedValidatorsAtTimestamp(timestamp - 7n * SLOTS_PER_DAY)).to.equal(12);
      // Expected report: day 15
      expect(await reportChecker.exitedValidatorsAtTimestamp(timestamp - 15n * SLOTS_PER_DAY)).to.equal(12);
      // Missed report: day -16
      expect(await reportChecker.exitedValidatorsAtTimestamp(timestamp - 16n * SLOTS_PER_DAY)).to.equal(11);
    });
  });

  context("OracleReportSanityChecker additional balance decrease check", () => {
    it("works for IncorrectCLBalanceDecrease", async () => {
      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(0, ether("320"), ether("300"), 0, 0, 0, 10, 10),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
        .withArgs(20n * ether("1"), 10n * ether("1") + 10n * ether("0.101"));
    });

    it("works as accumulation for IncorrectCLBalanceDecrease", async () => {
      const genesisTime = await accountingOracle.GENESIS_TIME();
      const timestamp = await getCurrentBlockTimestamp();
      const refSlot = (timestamp - genesisTime) / 12n;
      const prevRefSlot = refSlot - SLOTS_PER_DAY;

      await accountingOracle.setLastProcessingRefSlot(prevRefSlot);
      await checker
        .connect(accountingSigner)
        .checkAccountingOracleReport(0, ether("320"), ether("310"), 0, 0, 0, 10, 10);

      await accountingOracle.setLastProcessingRefSlot(refSlot);
      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(0, ether("310"), ether("300"), 0, 0, 0, 10, 10),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
        .withArgs(20n * ether("1"), 10n * ether("1") + 10n * ether("0.101"));
    });

    it("works for happy path and report is not ready", async () => {
      const genesisTime = await accountingOracle.GENESIS_TIME();
      const timestamp = await getCurrentBlockTimestamp();
      const refSlot = (timestamp - genesisTime) / 12n;

      await accountingOracle.setLastProcessingRefSlot(refSlot);

      // Expect to pass through
      await checker.connect(accountingSigner).checkAccountingOracleReport(0, 96 * 1e9, 96 * 1e9, 0, 0, 0, 10, 10);

      const secondOpinionOracle = await deploySecondOpinionOracle();

      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(0, ether("330"), ether("300"), 0, 0, 0, 10, 10),
      ).to.be.revertedWithCustomError(checker, "NegativeRebaseFailedSecondOpinionReportIsNotReady");

      await secondOpinionOracle.addReport(refSlot, {
        success: true,
        clBalanceGwei: parseUnits("300", "gwei"),
        withdrawalVaultBalanceWei: 0,
        numValidators: 0,
        exitedValidators: 0,
      });
      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(0, ether("330"), ether("300"), 0, 0, 0, 10, 10),
      )
        .to.emit(checker, "NegativeCLRebaseConfirmed")
        .withArgs(refSlot, ether("300"), ether("0"));
    });

    it("works with staking router reports exited validators at day 18 and 54", async () => {
      const genesisTime = await accountingOracle.GENESIS_TIME();
      const timestamp = await getCurrentBlockTimestamp();
      const refSlot = (timestamp - genesisTime) / 12n;

      const refSlot17 = refSlot - 17n * SLOTS_PER_DAY;
      const refSlot18 = refSlot - 18n * SLOTS_PER_DAY;
      const refSlot54 = refSlot - 54n * SLOTS_PER_DAY;
      const refSlot55 = refSlot - 55n * SLOTS_PER_DAY;

      await stakingRouter.mock__addStakingModuleExitedValidators(1, 1);
      await accountingOracle.setLastProcessingRefSlot(refSlot55);
      await checker
        .connect(accountingSigner)
        .checkAccountingOracleReport(0, ether("320"), ether("320"), 0, 0, 0, 10, 10);

      await stakingRouter.mock__removeStakingModule(1);
      await stakingRouter.mock__addStakingModuleExitedValidators(1, 2);
      await accountingOracle.setLastProcessingRefSlot(refSlot54);
      await checker
        .connect(accountingSigner)
        .checkAccountingOracleReport(0, ether("320"), ether("320"), 0, 0, 0, 10, 10);

      await stakingRouter.mock__removeStakingModule(1);
      await stakingRouter.mock__addStakingModuleExitedValidators(1, 3);
      await accountingOracle.setLastProcessingRefSlot(refSlot18);
      await checker
        .connect(accountingSigner)
        .checkAccountingOracleReport(0, ether("320"), ether("320"), 0, 0, 0, 10, 10);

      await accountingOracle.setLastProcessingRefSlot(refSlot17);
      await checker
        .connect(accountingSigner)
        .checkAccountingOracleReport(0, ether("320"), ether("315"), 0, 0, 0, 10, 10);

      await accountingOracle.setLastProcessingRefSlot(refSlot);
      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(0, ether("315"), ether("300"), 0, 0, 0, 10, 10),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
        .withArgs(20n * ether("1"), 7n * ether("1") + 8n * ether("0.101"));
    });

    it("works for reports close together", async () => {
      const genesisTime = await accountingOracle.GENESIS_TIME();
      const timestamp = await getCurrentBlockTimestamp();
      const refSlot = (timestamp - genesisTime) / 12n;

      await accountingOracle.setLastProcessingRefSlot(refSlot);

      const secondOpinionOracle = await deploySecondOpinionOracle();

      // Second opinion balance is way bigger than general Oracle's (~1%)
      await secondOpinionOracle.addReport(refSlot, {
        success: true,
        clBalanceGwei: parseUnits("302", "gwei"),
        withdrawalVaultBalanceWei: 0,
        numValidators: 0,
        exitedValidators: 0,
      });

      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(0, ether("330"), ether("299"), 0, 0, 0, 10, 10),
      )
        .to.be.revertedWithCustomError(checker, "NegativeRebaseFailedCLBalanceMismatch")
        .withArgs(ether("299"), ether("302"), anyValue);

      // Second opinion balance is almost equal general Oracle's (<0.74%) - should pass
      await secondOpinionOracle.addReport(refSlot, {
        success: true,
        clBalanceGwei: parseUnits("301", "gwei"),
        withdrawalVaultBalanceWei: 0,
        numValidators: 0,
        exitedValidators: 0,
      });

      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(0, ether("330"), ether("299"), 0, 0, 0, 10, 10),
      )
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

      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(0, 110 * 1e9, 100.01 * 1e9, 0, 0, 0, 10, 10),
      )
        .to.be.revertedWithCustomError(checker, "NegativeRebaseFailedCLBalanceMismatch")
        .withArgs(100.01 * 1e9, 100 * 1e9, anyValue);
    });

    it("works for reports with incorrect withdrawal vault balance", async () => {
      const genesisTime = await accountingOracle.GENESIS_TIME();
      const timestamp = await getCurrentBlockTimestamp();
      const refSlot = (timestamp - genesisTime) / 12n;

      await accountingOracle.setLastProcessingRefSlot(refSlot);

      const secondOpinionOracle = await deploySecondOpinionOracle();

      // Second opinion balance is almost equal general Oracle's (<0.74%) and withdrawal value is the same - should pass
      await secondOpinionOracle.addReport(refSlot, {
        success: true,
        clBalanceGwei: parseUnits("300", "gwei"),
        withdrawalVaultBalanceWei: ether("1"),
        numValidators: 0,
        exitedValidators: 0,
      });

      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(0, ether("330"), ether("299"), ether("1"), 0, 0, 10, 10),
      )
        .to.emit(checker, "NegativeCLRebaseConfirmed")
        .withArgs(refSlot, ether("299"), ether("1"));

      // Second opinion withdrawal vault balance is different - should fail
      await secondOpinionOracle.addReport(refSlot, {
        success: true,
        clBalanceGwei: parseUnits("300", "gwei"),
        withdrawalVaultBalanceWei: 0,
        numValidators: 0,
        exitedValidators: 0,
      });

      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(0, ether("330"), ether("299"), ether("1"), 0, 0, 10, 10),
      )
        .to.be.revertedWithCustomError(checker, "NegativeRebaseFailedWithdrawalVaultBalanceMismatch")
        .withArgs(ether("1"), 0);
    });
  });

  context("OracleReportSanityChecker roles", () => {
    it("CL Oracle related functions require INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE", async () => {
      const role = await checker.INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE();

      await expect(checker.setInitialSlashingAndPenaltiesAmount(0, 0)).to.be.revertedWithOZAccessControlError(
        deployer.address,
        role,
      );

      await checker.grantRole(role, deployer.address);
      await expect(checker.setInitialSlashingAndPenaltiesAmount(1000, 101)).to.not.be.reverted;
    });

    it("CL Oracle related functions require SECOND_OPINION_MANAGER_ROLE", async () => {
      const clOraclesRole = await checker.SECOND_OPINION_MANAGER_ROLE();

      await expect(
        checker.setSecondOpinionOracleAndCLBalanceUpperMargin(ZeroAddress, 74),
      ).to.be.revertedWithOZAccessControlError(deployer.address, clOraclesRole);

      await checker.grantRole(clOraclesRole, deployer.address);
      await expect(checker.setSecondOpinionOracleAndCLBalanceUpperMargin(ZeroAddress, 74)).to.not.be.reverted;
    });
  });
});
