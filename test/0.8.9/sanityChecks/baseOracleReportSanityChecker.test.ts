import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  BurnerStub,
  LidoLocator__MockForSanityChecker,
  OracleReportSanityChecker,
  StakingRouter__MockForSanityChecker,
  WithdrawalQueueStub,
} from "typechain-types";

import { ether, getCurrentBlockTimestamp, randomAddress } from "lib";

import { Snapshot } from "test/suite";

describe("OracleReportSanityChecker.sol", () => {
  let oracleReportSanityChecker: OracleReportSanityChecker;
  let lidoLocatorMock: LidoLocator__MockForSanityChecker;
  let burnerMock: BurnerStub;
  let withdrawalQueueMock: WithdrawalQueueStub;
  let originalState: string;

  let managersRoster: Record<string, HardhatEthersSigner[]>;

  const defaultLimitsList = {
    churnValidatorsPerDayLimit: 55n,
    deprecatedOneOffCLBalanceDecreaseBPLimit: 0n,
    annualBalanceIncreaseBPLimit: 10_00n, // 10%
    simulatedShareRateDeviationBPLimit: 2_50n, // 2.5%
    maxValidatorExitRequestsPerReport: 2000n,
    maxAccountingExtraDataListItemsCount: 15n,
    maxNodeOperatorsPerExtraDataItemCount: 16n,
    requestTimestampMargin: 128n,
    maxPositiveTokenRebase: 5_000_000n, // 0.05%
    initialSlashingAmountPWei: 1000n,
    inactivityPenaltiesAmountPWei: 101n,
    clBalanceOraclesErrorUpperBPLimit: 74n, // 0.74%
  };

  const correctLidoOracleReport = {
    timeElapsed: 24n * 60n * 60n,
    preCLBalance: ether("100000"),
    postCLBalance: ether("100001"),
    withdrawalVaultBalance: 0n,
    elRewardsVaultBalance: 0n,
    sharesRequestedToBurn: 0n,
    preCLValidators: 0n,
    postCLValidators: 0n,
  };
  type CheckAccountingOracleReportParameters = [number, bigint, bigint, number, number, number, number, number];
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let withdrawalVault: string;
  let elRewardsVault: HardhatEthersSigner;
  let stakingRouter: StakingRouter__MockForSanityChecker;
  let accounts: HardhatEthersSigner[];

  before(async () => {
    [deployer, admin, elRewardsVault, ...accounts] = await ethers.getSigners();
    withdrawalVault = randomAddress();
    await setBalance(withdrawalVault, ether("500"));

    // mine 1024 blocks with block duration 12 seconds
    await ethers.provider.send("hardhat_mine", ["0x" + Number(1024).toString(16), "0x" + Number(12).toString(16)]);
    withdrawalQueueMock = await ethers.deployContract("WithdrawalQueueStub");
    burnerMock = await ethers.deployContract("BurnerStub");
    const accountingOracle = await ethers.deployContract("AccountingOracle__MockForSanityChecker", [
      deployer.address,
      12,
      1606824023,
    ]);
    stakingRouter = await ethers.deployContract("StakingRouter__MockForSanityChecker");

    lidoLocatorMock = await ethers.deployContract("LidoLocator__MockForSanityChecker", [
      {
        lido: deployer.address,
        depositSecurityModule: deployer.address,
        elRewardsVault: elRewardsVault.address,
        accountingOracle: await accountingOracle.getAddress(),
        legacyOracle: deployer.address,
        oracleReportSanityChecker: deployer.address,
        burner: await burnerMock.getAddress(),
        validatorsExitBusOracle: deployer.address,
        stakingRouter: await stakingRouter.getAddress(),
        treasury: deployer.address,
        withdrawalQueue: await withdrawalQueueMock.getAddress(),
        withdrawalVault: withdrawalVault,
        postTokenRebaseReceiver: deployer.address,
        oracleDaemonConfig: deployer.address,
      },
    ]);
    managersRoster = {
      allLimitsManagers: accounts.slice(0, 2),
      churnValidatorsPerDayLimitManagers: accounts.slice(2, 4),
      initialSlashingAndPenaltiesManagers: accounts.slice(4, 6),
      annualBalanceIncreaseLimitManagers: accounts.slice(6, 8),
      shareRateDeviationLimitManagers: accounts.slice(8, 10),
      maxValidatorExitRequestsPerReportManagers: accounts.slice(10, 12),
      maxAccountingExtraDataListItemsCountManagers: accounts.slice(12, 14),
      maxNodeOperatorsPerExtraDataItemCountManagers: accounts.slice(14, 16),
      requestTimestampMarginManagers: accounts.slice(16, 18),
      maxPositiveTokenRebaseManagers: accounts.slice(18, 20),
    };
    oracleReportSanityChecker = await ethers.deployContract("OracleReportSanityChecker", [
      await lidoLocatorMock.getAddress(),
      admin.address,
      Object.values(defaultLimitsList),
    ]);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  it("constructor reverts if admin address is zero", async () => {
    await expect(
      ethers.deployContract("OracleReportSanityChecker", [
        await lidoLocatorMock.getAddress(),
        ZeroAddress,
        Object.values(defaultLimitsList),
      ]),
    ).to.be.revertedWithCustomError(oracleReportSanityChecker, "AdminCannotBeZero");
  });

  describe("Sanity checker public getters", () => {
    it("retrieves correct locator address", async () => {
      expect(await oracleReportSanityChecker.getLidoLocator()).to.equal(await lidoLocatorMock.getAddress());
    });

    it("retrieves correct report data count", async () => {
      expect(await oracleReportSanityChecker.getReportDataCount()).to.equal(0);
    });
  });

  describe("setOracleReportLimits()", () => {
    it("sets limits correctly", async () => {
      const newLimitsList = {
        churnValidatorsPerDayLimit: 50,
        deprecatedOneOffCLBalanceDecreaseBPLimit: 0,
        annualBalanceIncreaseBPLimit: 15_00,
        simulatedShareRateDeviationBPLimit: 1_50, // 1.5%
        maxValidatorExitRequestsPerReport: 3000,
        maxAccountingExtraDataListItemsCount: 15 + 1,
        maxNodeOperatorsPerExtraDataItemCount: 16 + 1,
        requestTimestampMargin: 2048,
        maxPositiveTokenRebase: 10_000_000,
        initialSlashingAmountPWei: 2000,
        inactivityPenaltiesAmountPWei: 303,
        clBalanceOraclesErrorUpperBPLimit: 12,
      };
      const limitsBefore = await oracleReportSanityChecker.getOracleReportLimits();
      expect(limitsBefore.churnValidatorsPerDayLimit).to.not.equal(newLimitsList.churnValidatorsPerDayLimit);
      expect(limitsBefore.annualBalanceIncreaseBPLimit).to.not.equal(newLimitsList.annualBalanceIncreaseBPLimit);
      expect(limitsBefore.simulatedShareRateDeviationBPLimit).to.not.equal(
        newLimitsList.simulatedShareRateDeviationBPLimit,
      );
      expect(limitsBefore.maxValidatorExitRequestsPerReport).to.not.equal(
        newLimitsList.maxValidatorExitRequestsPerReport,
      );
      expect(limitsBefore.maxAccountingExtraDataListItemsCount).to.not.equal(
        newLimitsList.maxAccountingExtraDataListItemsCount,
      );
      expect(limitsBefore.maxNodeOperatorsPerExtraDataItemCount).to.not.equal(
        newLimitsList.maxNodeOperatorsPerExtraDataItemCount,
      );
      expect(limitsBefore.requestTimestampMargin).to.not.equal(newLimitsList.requestTimestampMargin);
      expect(limitsBefore.maxPositiveTokenRebase).to.not.equal(newLimitsList.maxPositiveTokenRebase);
      expect(limitsBefore.clBalanceOraclesErrorUpperBPLimit).to.not.equal(
        newLimitsList.clBalanceOraclesErrorUpperBPLimit,
      );
      expect(limitsBefore.initialSlashingAmountPWei).to.not.equal(newLimitsList.initialSlashingAmountPWei);
      expect(limitsBefore.inactivityPenaltiesAmountPWei).to.not.equal(newLimitsList.inactivityPenaltiesAmountPWei);

      await expect(
        oracleReportSanityChecker.setOracleReportLimits(newLimitsList, ZeroAddress),
      ).to.be.revertedWithOZAccessControlError(
        deployer.address,
        await oracleReportSanityChecker.ALL_LIMITS_MANAGER_ROLE(),
      );

      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(await oracleReportSanityChecker.ALL_LIMITS_MANAGER_ROLE(), managersRoster.allLimitsManagers[0]);
      await oracleReportSanityChecker
        .connect(managersRoster.allLimitsManagers[0])
        .setOracleReportLimits(newLimitsList, ZeroAddress);

      const limitsAfter = await oracleReportSanityChecker.getOracleReportLimits();
      expect(limitsAfter.churnValidatorsPerDayLimit).to.equal(newLimitsList.churnValidatorsPerDayLimit);
      expect(limitsAfter.annualBalanceIncreaseBPLimit).to.equal(newLimitsList.annualBalanceIncreaseBPLimit);
      expect(limitsAfter.simulatedShareRateDeviationBPLimit).to.equal(newLimitsList.simulatedShareRateDeviationBPLimit);
      expect(limitsAfter.maxValidatorExitRequestsPerReport).to.equal(newLimitsList.maxValidatorExitRequestsPerReport);
      expect(limitsAfter.maxAccountingExtraDataListItemsCount).to.equal(
        newLimitsList.maxAccountingExtraDataListItemsCount,
      );
      expect(limitsAfter.maxNodeOperatorsPerExtraDataItemCount).to.equal(
        newLimitsList.maxNodeOperatorsPerExtraDataItemCount,
      );
      expect(limitsAfter.requestTimestampMargin).to.equal(newLimitsList.requestTimestampMargin);
      expect(limitsAfter.maxPositiveTokenRebase).to.equal(newLimitsList.maxPositiveTokenRebase);
      expect(limitsAfter.clBalanceOraclesErrorUpperBPLimit).to.equal(newLimitsList.clBalanceOraclesErrorUpperBPLimit);
      expect(limitsAfter.initialSlashingAmountPWei).to.equal(newLimitsList.initialSlashingAmountPWei);
      expect(limitsAfter.inactivityPenaltiesAmountPWei).to.equal(newLimitsList.inactivityPenaltiesAmountPWei);
    });
  });

  describe("checkAccountingOracleReport()", () => {
    beforeEach(async () => {
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(await oracleReportSanityChecker.ALL_LIMITS_MANAGER_ROLE(), managersRoster.allLimitsManagers[0]);
      await oracleReportSanityChecker
        .connect(managersRoster.allLimitsManagers[0])
        .setOracleReportLimits(defaultLimitsList, ZeroAddress);
    });

    it("reverts with error IncorrectWithdrawalsVaultBalance() when actual withdrawal vault balance is less than passed", async () => {
      const currentWithdrawalVaultBalance = await ethers.provider.getBalance(withdrawalVault);

      await expect(
        oracleReportSanityChecker.checkAccountingOracleReport(
          ...(Object.values({
            ...correctLidoOracleReport,
            withdrawalVaultBalance: currentWithdrawalVaultBalance + 1n,
          }) as CheckAccountingOracleReportParameters),
        ),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectWithdrawalsVaultBalance")
        .withArgs(currentWithdrawalVaultBalance);
    });

    it("reverts with error IncorrectELRewardsVaultBalance() when actual el rewards vault balance is less than passed", async () => {
      const currentELRewardsVaultBalance = await ethers.provider.getBalance(elRewardsVault);
      await expect(
        oracleReportSanityChecker.checkAccountingOracleReport(
          ...(Object.values({
            ...correctLidoOracleReport,
            elRewardsVaultBalance: currentELRewardsVaultBalance + 1n,
          }) as CheckAccountingOracleReportParameters),
        ),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectELRewardsVaultBalance")
        .withArgs(currentELRewardsVaultBalance);
    });

    it("reverts with error IncorrectSharesRequestedToBurn() when actual shares to burn is less than passed", async () => {
      await burnerMock.setSharesRequestedToBurn(10, 21);

      await expect(
        oracleReportSanityChecker.checkAccountingOracleReport(
          ...(Object.values({
            ...correctLidoOracleReport,
            sharesRequestedToBurn: 32,
          }) as CheckAccountingOracleReportParameters),
        ),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectSharesRequestedToBurn")
        .withArgs(31);
    });

    it("reverts with error IncorrectCLBalanceIncrease() when reported values overcome annual CL balance limit", async () => {
      const maxBasisPoints = 10_000n;
      const secondsInOneYear = 365n * 24n * 60n * 60n;
      const preCLBalance = BigInt(correctLidoOracleReport.preCLBalance);
      const postCLBalance = ether("150000");
      const timeElapsed = BigInt(correctLidoOracleReport.timeElapsed);
      const annualBalanceIncrease =
        (secondsInOneYear * maxBasisPoints * (postCLBalance - preCLBalance)) / preCLBalance / timeElapsed;

      await expect(
        oracleReportSanityChecker.checkAccountingOracleReport(
          ...(Object.values({
            ...correctLidoOracleReport,
            postCLBalance: postCLBalance,
          }) as CheckAccountingOracleReportParameters),
        ),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectCLBalanceIncrease")
        .withArgs(annualBalanceIncrease);
    });

    it("passes all checks with correct oracle report data", async () => {
      await oracleReportSanityChecker.checkAccountingOracleReport(
        ...(Object.values(correctLidoOracleReport) as CheckAccountingOracleReportParameters),
      );
    });

    it("set initial slashing and penalties Amount", async () => {
      const oldInitialSlashing = (await oracleReportSanityChecker.getOracleReportLimits()).initialSlashingAmountPWei;
      const oldPenalties = (await oracleReportSanityChecker.getOracleReportLimits()).inactivityPenaltiesAmountPWei;
      const newInitialSlashing = 2000;
      const newPenalties = 202;
      expect(newInitialSlashing).to.not.equal(oldInitialSlashing);
      expect(newPenalties).to.not.equal(oldPenalties);
      await expect(
        oracleReportSanityChecker
          .connect(deployer)
          .setInitialSlashingAndPenaltiesAmount(newInitialSlashing, newPenalties),
      ).to.be.revertedWithOZAccessControlError(
        deployer.address,
        await oracleReportSanityChecker.INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE(),
      );

      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE(),
          managersRoster.initialSlashingAndPenaltiesManagers[0],
        );
      const tx = await oracleReportSanityChecker
        .connect(managersRoster.initialSlashingAndPenaltiesManagers[0])
        .setInitialSlashingAndPenaltiesAmount(newInitialSlashing, newPenalties);
      await expect(tx)
        .to.emit(oracleReportSanityChecker, "InitialSlashingAmountSet")
        .withArgs(newInitialSlashing)
        .to.emit(oracleReportSanityChecker, "InactivityPenaltiesAmountSet")
        .withArgs(newPenalties);
      expect((await oracleReportSanityChecker.getOracleReportLimits()).initialSlashingAmountPWei).to.equal(
        newInitialSlashing,
      );
      expect((await oracleReportSanityChecker.getOracleReportLimits()).inactivityPenaltiesAmountPWei).to.equal(
        newPenalties,
      );
    });

    it("set CL state oracle and balance error margin limit", async () => {
      const previousOracle = await oracleReportSanityChecker.secondOpinionOracle();
      const previousErrorMargin = (await oracleReportSanityChecker.getOracleReportLimits())
        .clBalanceOraclesErrorUpperBPLimit;
      const newOracle = deployer.address;
      const newErrorMargin = 1;
      expect(newOracle).to.not.equal(previousOracle);
      expect(newErrorMargin).to.not.equal(previousErrorMargin);
      await expect(
        oracleReportSanityChecker
          .connect(deployer)
          .setSecondOpinionOracleAndCLBalanceUpperMargin(newOracle, newErrorMargin),
      ).to.be.revertedWithOZAccessControlError(
        deployer.address,
        await oracleReportSanityChecker.SECOND_OPINION_MANAGER_ROLE(),
      );

      const oracleManagerRole = await oracleReportSanityChecker.SECOND_OPINION_MANAGER_ROLE();
      const oracleManagerAccount = accounts[21];
      await oracleReportSanityChecker.connect(admin).grantRole(oracleManagerRole, oracleManagerAccount);

      const tx = await oracleReportSanityChecker
        .connect(oracleManagerAccount)
        .setSecondOpinionOracleAndCLBalanceUpperMargin(newOracle, newErrorMargin);

      expect(await oracleReportSanityChecker.secondOpinionOracle()).to.equal(newOracle);
      expect((await oracleReportSanityChecker.getOracleReportLimits()).clBalanceOraclesErrorUpperBPLimit).to.equal(
        newErrorMargin,
      );
      await expect(tx)
        .to.emit(oracleReportSanityChecker, "CLBalanceOraclesErrorUpperBPLimitSet")
        .withArgs(newErrorMargin)
        .to.emit(oracleReportSanityChecker, "SecondOpinionOracleChanged")
        .withArgs(newOracle);
    });

    it("set annual balance increase", async () => {
      const previousValue = (await oracleReportSanityChecker.getOracleReportLimits()).annualBalanceIncreaseBPLimit;
      const newValue = 9;
      expect(newValue).to.not.equal(previousValue);
      await expect(
        oracleReportSanityChecker.connect(deployer).setAnnualBalanceIncreaseBPLimit(newValue),
      ).to.be.revertedWithOZAccessControlError(
        deployer.address,
        await oracleReportSanityChecker.ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE(),
      );

      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE(),
          managersRoster.annualBalanceIncreaseLimitManagers[0],
        );
      const tx = await oracleReportSanityChecker
        .connect(managersRoster.annualBalanceIncreaseLimitManagers[0])
        .setAnnualBalanceIncreaseBPLimit(newValue);
      expect((await oracleReportSanityChecker.getOracleReportLimits()).annualBalanceIncreaseBPLimit).to.equal(newValue);
      await expect(tx).to.emit(oracleReportSanityChecker, "AnnualBalanceIncreaseBPLimitSet").withArgs(newValue);
    });

    it("handles zero time passed for annual balance increase", async () => {
      const preCLBalance = BigInt(correctLidoOracleReport.preCLBalance);
      const postCLBalance = preCLBalance + 1000n;

      await oracleReportSanityChecker.checkAccountingOracleReport(
        ...(Object.values({
          ...correctLidoOracleReport,
          postCLBalance: postCLBalance,
          timeElapsed: 0,
        }) as CheckAccountingOracleReportParameters),
      );
    });

    it("handles zero pre CL balance estimating balance increase", async () => {
      const preCLBalance = 0n;
      const postCLBalance = preCLBalance + 1000n;

      await oracleReportSanityChecker.checkAccountingOracleReport(
        ...(Object.values({
          ...correctLidoOracleReport,
          preCLBalance: preCLBalance.toString(),
          postCLBalance: postCLBalance.toString(),
        }) as CheckAccountingOracleReportParameters),
      );
    });

    it("handles zero time passed for appeared validators", async () => {
      const preCLValidators = BigInt(correctLidoOracleReport.preCLValidators);
      const postCLValidators = preCLValidators + 2n;

      await oracleReportSanityChecker.checkAccountingOracleReport(
        ...(Object.values({
          ...correctLidoOracleReport,
          preCLValidators: preCLValidators.toString(),
          postCLValidators: postCLValidators.toString(),
          timeElapsed: 0,
        }) as CheckAccountingOracleReportParameters),
      );
    });

    it("set simulated share rate deviation", async () => {
      const previousValue = (await oracleReportSanityChecker.getOracleReportLimits())
        .simulatedShareRateDeviationBPLimit;
      const newValue = 7;
      expect(newValue).to.not.equal(previousValue);

      await expect(
        oracleReportSanityChecker.connect(deployer).setSimulatedShareRateDeviationBPLimit(newValue),
      ).to.be.revertedWithOZAccessControlError(
        deployer.address,
        await oracleReportSanityChecker.SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE(),
      );
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE(),
          managersRoster.shareRateDeviationLimitManagers[0],
        );
      const tx = await oracleReportSanityChecker
        .connect(managersRoster.shareRateDeviationLimitManagers[0])
        .setSimulatedShareRateDeviationBPLimit(newValue);
      expect((await oracleReportSanityChecker.getOracleReportLimits()).simulatedShareRateDeviationBPLimit).to.equal(
        newValue,
      );
      await expect(tx).to.emit(oracleReportSanityChecker, "SimulatedShareRateDeviationBPLimitSet").withArgs(newValue);
    });
  });

  describe("checkWithdrawalQueueOracleReport()", () => {
    const oldRequestId = 1n;
    const newRequestId = 2n;
    let oldRequestCreationTimestamp;
    let newRequestCreationTimestamp: bigint;
    const correctWithdrawalQueueOracleReport = {
      lastFinalizableRequestId: oldRequestId,
      refReportTimestamp: -1n,
    };
    type CheckWithdrawalQueueOracleReportParameters = [bigint, bigint];

    before(async () => {
      const currentBlockTimestamp = await getCurrentBlockTimestamp();
      correctWithdrawalQueueOracleReport.refReportTimestamp = currentBlockTimestamp;
      oldRequestCreationTimestamp = currentBlockTimestamp - defaultLimitsList.requestTimestampMargin;
      correctWithdrawalQueueOracleReport.lastFinalizableRequestId = oldRequestCreationTimestamp;
      await withdrawalQueueMock.setRequestTimestamp(oldRequestId, oldRequestCreationTimestamp);
      newRequestCreationTimestamp = currentBlockTimestamp - defaultLimitsList.requestTimestampMargin / 2n;
      await withdrawalQueueMock.setRequestTimestamp(newRequestId, newRequestCreationTimestamp);
    });

    it("reverts with the error IncorrectRequestFinalization() when the creation timestamp of requestIdToFinalizeUpTo is too close to report timestamp", async () => {
      await expect(
        oracleReportSanityChecker.checkWithdrawalQueueOracleReport(
          ...(Object.values({
            ...correctWithdrawalQueueOracleReport,
            lastFinalizableRequestId: newRequestId,
          }) as CheckWithdrawalQueueOracleReportParameters),
        ),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectRequestFinalization")
        .withArgs(newRequestCreationTimestamp);
    });

    it("passes all checks with correct withdrawal queue report data", async () => {
      await oracleReportSanityChecker.checkWithdrawalQueueOracleReport(
        ...(Object.values(correctWithdrawalQueueOracleReport) as CheckWithdrawalQueueOracleReportParameters),
      );
    });

    it("set timestamp margin for finalization", async () => {
      const previousValue = (await oracleReportSanityChecker.getOracleReportLimits()).requestTimestampMargin;
      const newValue = 3302;
      expect(newValue).to.not.equal(previousValue);
      await expect(
        oracleReportSanityChecker.connect(deployer).setRequestTimestampMargin(newValue),
      ).to.be.revertedWithOZAccessControlError(
        deployer.address,
        await oracleReportSanityChecker.REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE(),
      );
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE(),
          managersRoster.requestTimestampMarginManagers[0],
        );
      const tx = await oracleReportSanityChecker
        .connect(managersRoster.requestTimestampMarginManagers[0])
        .setRequestTimestampMargin(newValue);
      expect((await oracleReportSanityChecker.getOracleReportLimits()).requestTimestampMargin).to.equal(newValue);
      await expect(tx).to.emit(oracleReportSanityChecker, "RequestTimestampMarginSet").withArgs(newValue);
    });
  });

  describe("checkSimulatedShareRate", () => {
    const correctSimulatedShareRate = {
      postTotalPooledEther: ether("9"),
      postTotalShares: ether("4"),
      etherLockedOnWithdrawalQueue: ether("1"),
      sharesBurntFromWithdrawalQueue: ether("1"),
      simulatedShareRate: 2n * 10n ** 27n,
    };
    type CheckSimulatedShareRateParameters = [bigint, bigint, bigint, bigint, bigint];

    it("reverts with error IncorrectSimulatedShareRate() when simulated share rate is higher than expected", async () => {
      const simulatedShareRate = ether("2.1") * 10n ** 9n;
      const actualShareRate = 2n * 10n ** 27n;
      await expect(
        oracleReportSanityChecker.checkSimulatedShareRate(
          ...(Object.values({
            ...correctSimulatedShareRate,
            simulatedShareRate: simulatedShareRate,
          }) as CheckSimulatedShareRateParameters),
        ),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectSimulatedShareRate")
        .withArgs(simulatedShareRate, actualShareRate);
    });

    it("reverts with error IncorrectSimulatedShareRate() when simulated share rate is lower than expected", async () => {
      const simulatedShareRate = ether("1.9") * 10n ** 9n;
      const actualShareRate = 2n * 10n ** 27n;
      await expect(
        oracleReportSanityChecker.checkSimulatedShareRate(
          ...(Object.values({
            ...correctSimulatedShareRate,
            simulatedShareRate: simulatedShareRate,
          }) as CheckSimulatedShareRateParameters),
        ),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectSimulatedShareRate")
        .withArgs(simulatedShareRate, actualShareRate);
    });

    it("reverts with error ActualShareRateIsZero() when actual share rate is zero", async () => {
      await expect(
        oracleReportSanityChecker.checkSimulatedShareRate(
          ...(Object.values({
            ...correctSimulatedShareRate,
            etherLockedOnWithdrawalQueue: ether("0"),
            postTotalPooledEther: ether("0"),
          }) as CheckSimulatedShareRateParameters),
        ),
      ).to.be.revertedWithCustomError(oracleReportSanityChecker, "ActualShareRateIsZero");
    });

    it("passes all checks with correct share rate", async () => {
      await oracleReportSanityChecker.checkSimulatedShareRate(
        ...(Object.values(correctSimulatedShareRate) as CheckSimulatedShareRateParameters),
      );
    });
  });

  describe("max positive rebase", () => {
    const defaultSmoothenTokenRebaseParams = {
      preTotalPooledEther: ether("100"),
      preTotalShares: ether("100"),
      preCLBalance: ether("100"),
      postCLBalance: ether("100"),
      withdrawalVaultBalance: 0n,
      elRewardsVaultBalance: 0n,
      sharesRequestedToBurn: 0n,
      etherToLockForWithdrawals: 0n,
      newSharesToBurnForWithdrawals: 0n,
    };
    type SmoothenTokenRebaseParameters = [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

    it("getMaxPositiveTokenRebase works", async () => {
      expect(await oracleReportSanityChecker.getMaxPositiveTokenRebase()).to.equal(
        defaultLimitsList.maxPositiveTokenRebase,
      );
    });

    it("setMaxPositiveTokenRebase works", async () => {
      const newRebaseLimit = 1_000_000;
      expect(newRebaseLimit).to.not.equal(defaultLimitsList.maxPositiveTokenRebase);

      await expect(
        oracleReportSanityChecker.connect(deployer).setMaxPositiveTokenRebase(newRebaseLimit),
      ).to.be.revertedWithOZAccessControlError(
        deployer.address,
        await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
      );

      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
          managersRoster.maxPositiveTokenRebaseManagers[0],
        );
      const tx = await oracleReportSanityChecker
        .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
        .setMaxPositiveTokenRebase(newRebaseLimit);

      expect(await oracleReportSanityChecker.getMaxPositiveTokenRebase()).to.equal(newRebaseLimit);
      await expect(tx).to.emit(oracleReportSanityChecker, "MaxPositiveTokenRebaseSet").withArgs(newRebaseLimit);
    });

    it("all zero data works", async () => {
      const { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            preTotalPooledEther: 0,
            preTotalShares: 0,
            preCLBalance: 0,
            postCLBalance: 0,
          }) as SmoothenTokenRebaseParameters),
        );

      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);
    });

    it("trivial smoothen rebase works when post CL < pre CL and no withdrawals", async () => {
      const newRebaseLimit = 100_000; // 0.01%
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
          managersRoster.maxPositiveTokenRebaseManagers[0],
        );
      await oracleReportSanityChecker
        .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
        .setMaxPositiveTokenRebase(newRebaseLimit);

      let { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("99"),
          }) as SmoothenTokenRebaseParameters),
        );

      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);

      // el rewards
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("99"),
            elRewardsVaultBalance: ether("0.1"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(ether("0.1"));
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);
      // withdrawals
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("99"),
            withdrawalVaultBalance: ether("0.1"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(ether("0.1"));
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);
      // // shares requested to burn
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("99"),
            sharesRequestedToBurn: ether("0.1"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(ether("0.1"));
      expect(sharesToBurn).to.equal(ether("0.1"));
    });

    it("trivial smoothen rebase works when post CL > pre CL and no withdrawals", async () => {
      const newRebaseLimit = 100_000_000; // 10%
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
          managersRoster.maxPositiveTokenRebaseManagers[0],
        );
      await oracleReportSanityChecker
        .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
        .setMaxPositiveTokenRebase(newRebaseLimit);

      let { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("100.01"),
          }) as SmoothenTokenRebaseParameters),
        );
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);

      // el rewards
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("100.01"),
            elRewardsVaultBalance: ether("0.1"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(ether("0.1"));
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);
      // withdrawals
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("100.01"),
            withdrawalVaultBalance: ether("0.1"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(ether("0.1"));
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);
      // shares requested to burn
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("100.01"),
            sharesRequestedToBurn: ether("0.1"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(ether("0.1"));
      expect(sharesToBurn).to.equal(ether("0.1"));
    });

    it("non-trivial smoothen rebase works when post CL < pre CL and no withdrawals", async () => {
      const newRebaseLimit = 10_000_000; // 1%
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
          managersRoster.maxPositiveTokenRebaseManagers[0],
        );
      await oracleReportSanityChecker
        .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
        .setMaxPositiveTokenRebase(newRebaseLimit);

      let { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("99"),
          }) as SmoothenTokenRebaseParameters),
        );
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);
      // el rewards
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("99"),
            elRewardsVaultBalance: ether("5"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(ether("2"));
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);
      // withdrawals
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("99"),
            withdrawalVaultBalance: ether("5"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(ether("2"));
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);
      // withdrawals + el rewards
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("99"),
            withdrawalVaultBalance: ether("5"),
            elRewardsVaultBalance: ether("5"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(ether("2"));
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);
      // shares requested to burn
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("99"),
            sharesRequestedToBurn: ether("5"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal("1980198019801980198"); // ether(100. - (99. / 1.01))
      expect(sharesToBurn).to.equal("1980198019801980198"); // the same as above since no withdrawals
    });

    it("non-trivial smoothen rebase works when post CL > pre CL and no withdrawals", async () => {
      const newRebaseLimit = 20_000_000; // 2%
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
          managersRoster.maxPositiveTokenRebaseManagers[0],
        );
      await oracleReportSanityChecker
        .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
        .setMaxPositiveTokenRebase(newRebaseLimit);

      let { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("101"),
          }) as SmoothenTokenRebaseParameters),
        );
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);
      // el rewards
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("101"),
            elRewardsVaultBalance: ether("5"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(ether("1"));
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);
      // withdrawals
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("101"),
            withdrawalVaultBalance: ether("5"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(ether("1"));
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);
      // withdrawals + el rewards
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("101"),
            elRewardsVaultBalance: ether("5"),
            withdrawalVaultBalance: ether("5"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(ether("1"));
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);
      // shares requested to burn
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultSmoothenTokenRebaseParams,
            postCLBalance: ether("101"),
            sharesRequestedToBurn: ether("5"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal("980392156862745098"); // ether(100. - (101. / 1.02))
      expect(sharesToBurn).to.equal("980392156862745098"); // the same as above since no withdrawals
    });

    it("non-trivial smoothen rebase works when post CL < pre CL and withdrawals", async () => {
      const newRebaseLimit = 5_000_000; // 0.5%
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
          managersRoster.maxPositiveTokenRebaseManagers[0],
        );
      await oracleReportSanityChecker
        .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
        .setMaxPositiveTokenRebase(newRebaseLimit);

      const defaultRebaseParams = {
        ...defaultSmoothenTokenRebaseParams,
        postCLBalance: ether("99"),
        etherToLockForWithdrawals: ether("10"),
        newSharesToBurnForWithdrawals: ether("10"),
      };

      let { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values(defaultRebaseParams) as SmoothenTokenRebaseParameters),
        );
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(ether("10"));
      // el rewards
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultRebaseParams,
            elRewardsVaultBalance: ether("5"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(ether("1.5"));
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal("9950248756218905472"); // 100. - 90.5 / 1.005
      // withdrawals
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultRebaseParams,
            withdrawalVaultBalance: ether("5"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(ether("1.5"));
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal("9950248756218905472"); // 100. - 90.5 / 1.005
      // withdrawals + el rewards
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultRebaseParams,
            withdrawalVaultBalance: ether("5"),
            elRewardsVaultBalance: ether("5"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(ether("1.5"));
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal("9950248756218905472"); // 100. - 90.5 / 1.005
      // shares requested to burn
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultRebaseParams,
            sharesRequestedToBurn: ether("5"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal("1492537313432835820"); // ether("100. - (99. / 1.005))
      expect(sharesToBurn).to.equal("11442786069651741293"); // ether("100. - (89. / 1.005))
    });

    it("non-trivial smoothen rebase works when post CL > pre CL and withdrawals", async () => {
      const newRebaseLimit = 40_000_000; // 4%
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
          managersRoster.maxPositiveTokenRebaseManagers[0],
        );
      await oracleReportSanityChecker
        .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
        .setMaxPositiveTokenRebase(newRebaseLimit);

      const defaultRebaseParams = {
        ...defaultSmoothenTokenRebaseParams,
        postCLBalance: ether("102"),
        etherToLockForWithdrawals: ether("10"),
        newSharesToBurnForWithdrawals: ether("10"),
      };

      let { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values(defaultRebaseParams) as SmoothenTokenRebaseParameters),
        );
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(ether("10"));
      // el rewards
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultRebaseParams,
            elRewardsVaultBalance: ether("5"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(ether("2"));
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal("9615384615384615384"); // 100. - 94. / 1.04
      // withdrawals
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultRebaseParams,
            withdrawalVaultBalance: ether("5"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(ether("2"));
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal("9615384615384615384"); // 100. - 94. / 1.04
      // withdrawals + el rewards
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultRebaseParams,
            withdrawalVaultBalance: ether("5"),
            elRewardsVaultBalance: ether("5"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(ether("2"));
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal("9615384615384615384"); // 100. - 94. / 1.04
      // shares requested to burn
      ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values({
            ...defaultRebaseParams,
            sharesRequestedToBurn: ether("5"),
          }) as SmoothenTokenRebaseParameters),
        ));
      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(0);
      expect(simulatedSharesToBurn).to.equal("1923076923076923076"); // ether("100. - (102. / 1.04))
      expect(sharesToBurn).to.equal("11538461538461538461"); // ether("100. - (92. / 1.04))
    });

    it("share rate ~1 case with huge withdrawal", async () => {
      const newRebaseLimit = 1_000_000; // 0.1%
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
          managersRoster.maxPositiveTokenRebaseManagers[0],
        );
      await oracleReportSanityChecker
        .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
        .setMaxPositiveTokenRebase(newRebaseLimit);

      const rebaseParams = {
        preTotalPooledEther: ether("1000000"),
        preTotalShares: ether("1000000"),
        preCLBalance: ether("1000000"),
        postCLBalance: ether("1000000"),
        withdrawalVaultBalance: ether("500"),
        elRewardsVaultBalance: ether("500"),
        sharesRequestedToBurn: ether("0"),
        etherToLockForWithdrawals: ether("40000"),
        newSharesToBurnForWithdrawals: ether("40000"),
      };

      const { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values(rebaseParams) as SmoothenTokenRebaseParameters),
        );

      expect(withdrawals).to.equal(ether("500"));
      expect(elRewards).to.equal(ether("500"));
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal("39960039960039960039960"); // ether(1000000 - 961000. / 1.001)
    });

    it("rounding case from Görli", async () => {
      const newRebaseLimit = 750_000; // 0.075% or 7.5 basis points
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
          managersRoster.maxPositiveTokenRebaseManagers[0],
        );
      await oracleReportSanityChecker
        .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
        .setMaxPositiveTokenRebase(newRebaseLimit);

      const rebaseParams = {
        preTotalPooledEther: 125262263468962792235936n,
        preTotalShares: 120111767594397261197918n,
        preCLBalance: 113136253352529000000000n,
        postCLBalance: 113134996436274000000000n,
        withdrawalVaultBalance: 129959459000000000n,
        elRewardsVaultBalance: 6644376444653811679390n,
        sharesRequestedToBurn: 15713136097768852533n,
        etherToLockForWithdrawals: 0n,
        newSharesToBurnForWithdrawals: 0n,
      };

      const { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
        await oracleReportSanityChecker.smoothenTokenRebase(
          ...(Object.values(rebaseParams) as SmoothenTokenRebaseParameters),
        );

      expect(withdrawals).to.equal(129959459000000000n);
      expect(elRewards).to.equal(95073654397722094176n);
      expect(simulatedSharesToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);
    });
  });

  describe("churn limit", () => {
    it("setChurnValidatorsPerDayLimit works", async () => {
      const oldChurnLimit = defaultLimitsList.churnValidatorsPerDayLimit;

      await oracleReportSanityChecker.checkExitedValidatorsRatePerDay(oldChurnLimit);
      await expect(oracleReportSanityChecker.checkExitedValidatorsRatePerDay(oldChurnLimit + 1n))
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "ExitedValidatorsLimitExceeded")
        .withArgs(oldChurnLimit, oldChurnLimit + 1n);

      const { churnValidatorsPerDayLimit } = await oracleReportSanityChecker.getOracleReportLimits();
      expect(churnValidatorsPerDayLimit).to.equal(oldChurnLimit);

      const newChurnLimit = 30;
      expect(newChurnLimit).to.not.equal(oldChurnLimit);

      await expect(
        oracleReportSanityChecker.connect(deployer).setChurnValidatorsPerDayLimit(newChurnLimit),
      ).to.be.revertedWithOZAccessControlError(
        deployer.address,
        await oracleReportSanityChecker.CHURN_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE(),
      );

      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.CHURN_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE(),
          managersRoster.churnValidatorsPerDayLimitManagers[0],
        );
      const tx = await oracleReportSanityChecker
        .connect(managersRoster.churnValidatorsPerDayLimitManagers[0])
        .setChurnValidatorsPerDayLimit(newChurnLimit);

      await expect(tx).to.emit(oracleReportSanityChecker, "ChurnValidatorsPerDayLimitSet").withArgs(newChurnLimit);
      // assert.emits(tx, 'ChurnValidatorsPerDayLimitSet', { churnValidatorsPerDayLimit: newChurnLimit })
      expect((await oracleReportSanityChecker.getOracleReportLimits()).churnValidatorsPerDayLimit).to.equal(
        newChurnLimit,
      );

      await oracleReportSanityChecker.checkExitedValidatorsRatePerDay(newChurnLimit);
      await expect(oracleReportSanityChecker.checkExitedValidatorsRatePerDay(newChurnLimit + 1))
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "ExitedValidatorsLimitExceeded")
        .withArgs(newChurnLimit, newChurnLimit + 1);
    });

    it("checkAccountingOracleReport: churnLimit works", async () => {
      const churnLimit = defaultLimitsList.churnValidatorsPerDayLimit;

      const { churnValidatorsPerDayLimit } = await oracleReportSanityChecker.getOracleReportLimits();
      expect(churnValidatorsPerDayLimit).to.equal(churnLimit);

      await oracleReportSanityChecker.checkAccountingOracleReport(
        ...(Object.values({
          ...correctLidoOracleReport,
          postCLValidators: churnLimit,
        }) as CheckAccountingOracleReportParameters),
      );
      await expect(
        oracleReportSanityChecker.checkAccountingOracleReport(
          ...(Object.values({
            ...correctLidoOracleReport,
            postCLValidators: churnLimit + 1n,
          }) as CheckAccountingOracleReportParameters),
        ),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectAppearedValidators")
        .withArgs(churnLimit, churnLimit + 1n);
    });
  });

  describe("checkExitBusOracleReport", () => {
    beforeEach(async () => {
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(await oracleReportSanityChecker.ALL_LIMITS_MANAGER_ROLE(), managersRoster.allLimitsManagers[0]);
      await oracleReportSanityChecker
        .connect(managersRoster.allLimitsManagers[0])
        .setOracleReportLimits(defaultLimitsList, ZeroAddress);
    });

    it("checkExitBusOracleReport works", async () => {
      const maxRequests = defaultLimitsList.maxValidatorExitRequestsPerReport;

      expect((await oracleReportSanityChecker.getOracleReportLimits()).maxValidatorExitRequestsPerReport).to.equal(
        maxRequests,
      );

      await oracleReportSanityChecker.checkExitBusOracleReport(maxRequests);
      await expect(oracleReportSanityChecker.checkExitBusOracleReport(maxRequests + 1n))
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectNumberOfExitRequestsPerReport")
        .withArgs(maxRequests);
    });

    it("setMaxExitRequestsPerOracleReport", async () => {
      const oldMaxRequests = defaultLimitsList.maxValidatorExitRequestsPerReport;
      await oracleReportSanityChecker.checkExitBusOracleReport(oldMaxRequests);
      await expect(oracleReportSanityChecker.checkExitBusOracleReport(oldMaxRequests + 1n))
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectNumberOfExitRequestsPerReport")
        .withArgs(oldMaxRequests);
      expect((await oracleReportSanityChecker.getOracleReportLimits()).maxValidatorExitRequestsPerReport).to.equal(
        oldMaxRequests,
      );

      const newMaxRequests = 306;
      expect(newMaxRequests).to.not.equal(oldMaxRequests);

      await expect(
        oracleReportSanityChecker.connect(deployer).setMaxExitRequestsPerOracleReport(newMaxRequests),
      ).to.be.revertedWithOZAccessControlError(
        deployer.address,
        await oracleReportSanityChecker.MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE(),
      );

      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE(),
          managersRoster.maxValidatorExitRequestsPerReportManagers[0],
        );
      const tx = await oracleReportSanityChecker
        .connect(managersRoster.maxValidatorExitRequestsPerReportManagers[0])
        .setMaxExitRequestsPerOracleReport(newMaxRequests);

      await expect(tx)
        .to.emit(oracleReportSanityChecker, "MaxValidatorExitRequestsPerReportSet")
        .withArgs(newMaxRequests);
      expect((await oracleReportSanityChecker.getOracleReportLimits()).maxValidatorExitRequestsPerReport).to.equal(
        newMaxRequests,
      );

      await oracleReportSanityChecker.checkExitBusOracleReport(newMaxRequests);
      await expect(oracleReportSanityChecker.checkExitBusOracleReport(newMaxRequests + 1))
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectNumberOfExitRequestsPerReport")
        .withArgs(newMaxRequests);
    });
  });

  describe("extra data reporting", () => {
    beforeEach(async () => {
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(await oracleReportSanityChecker.ALL_LIMITS_MANAGER_ROLE(), managersRoster.allLimitsManagers[0]);
      await oracleReportSanityChecker
        .connect(managersRoster.allLimitsManagers[0])
        .setOracleReportLimits(defaultLimitsList, ZeroAddress);
    });

    it("set maxNodeOperatorsPerExtraDataItemCount", async () => {
      const previousValue = (await oracleReportSanityChecker.getOracleReportLimits())
        .maxNodeOperatorsPerExtraDataItemCount;
      const newValue = 33;
      expect(newValue).to.not.equal(previousValue);
      await expect(
        oracleReportSanityChecker.connect(deployer).setMaxNodeOperatorsPerExtraDataItemCount(newValue),
      ).to.be.revertedWithOZAccessControlError(
        deployer.address,
        await oracleReportSanityChecker.MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_COUNT_ROLE(),
      );
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_COUNT_ROLE(),
          managersRoster.maxNodeOperatorsPerExtraDataItemCountManagers[0],
        );
      const tx = await oracleReportSanityChecker
        .connect(managersRoster.maxNodeOperatorsPerExtraDataItemCountManagers[0])
        .setMaxNodeOperatorsPerExtraDataItemCount(newValue);
      expect(
        (await oracleReportSanityChecker.getOracleReportLimits()).maxNodeOperatorsPerExtraDataItemCount,
      ).to.equal(newValue);
      await expect(tx)
        .to.emit(oracleReportSanityChecker, "MaxNodeOperatorsPerExtraDataItemCountSet")
        .withArgs(newValue);
    });

    it("set maxAccountingExtraDataListItemsCount", async () => {
      const previousValue = (await oracleReportSanityChecker.getOracleReportLimits())
        .maxAccountingExtraDataListItemsCount;
      const newValue = 31;
      expect(newValue).to.not.equal(previousValue);
      await expect(
        oracleReportSanityChecker.connect(deployer).setMaxAccountingExtraDataListItemsCount(newValue),
      ).to.be.revertedWithOZAccessControlError(
        deployer.address,
        await oracleReportSanityChecker.MAX_ACCOUNTING_EXTRA_DATA_LIST_ITEMS_COUNT_ROLE(),
      );
      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.MAX_ACCOUNTING_EXTRA_DATA_LIST_ITEMS_COUNT_ROLE(),
          managersRoster.maxAccountingExtraDataListItemsCountManagers[0],
        );
      const tx = await oracleReportSanityChecker
        .connect(managersRoster.maxAccountingExtraDataListItemsCountManagers[0])
        .setMaxAccountingExtraDataListItemsCount(newValue);
      expect(
        (await oracleReportSanityChecker.getOracleReportLimits()).maxAccountingExtraDataListItemsCount,
      ).to.equal(newValue);
      await expect(tx).to.emit(oracleReportSanityChecker, "MaxAccountingExtraDataListItemsCountSet").withArgs(newValue);
    });

    it("checkNodeOperatorsPerExtraDataItemCount", async () => {
      const maxCount = (await oracleReportSanityChecker.getOracleReportLimits()).maxNodeOperatorsPerExtraDataItemCount;

      await oracleReportSanityChecker.checkNodeOperatorsPerExtraDataItemCount(12, maxCount);

      await expect(oracleReportSanityChecker.checkNodeOperatorsPerExtraDataItemCount(12, maxCount + 1n))
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "TooManyNodeOpsPerExtraDataItem")
        .withArgs(12, maxCount + 1n);
    });

    it("checkAccountingExtraDataListItemsCount", async () => {
      const maxCount = (await oracleReportSanityChecker.getOracleReportLimits()).maxAccountingExtraDataListItemsCount;

      await oracleReportSanityChecker.checkAccountingExtraDataListItemsCount(maxCount);

      await expect(oracleReportSanityChecker.checkAccountingExtraDataListItemsCount(maxCount + 1n))
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "MaxAccountingExtraDataItemsCountExceeded")
        .withArgs(maxCount, maxCount + 1n);
    });
  });

  describe("check limit boundaries", () => {
    it("values must be less or equal to MAX_BASIS_POINTS", async () => {
      const MAX_BASIS_POINTS = 10000;
      const INVALID_BASIS_POINTS = MAX_BASIS_POINTS + 1;

      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(await oracleReportSanityChecker.ALL_LIMITS_MANAGER_ROLE(), managersRoster.allLimitsManagers[0]);

      await expect(
        oracleReportSanityChecker
          .connect(managersRoster.allLimitsManagers[0])
          .setOracleReportLimits(
            { ...defaultLimitsList, annualBalanceIncreaseBPLimit: INVALID_BASIS_POINTS },
            ZeroAddress,
          ),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
        .withArgs(INVALID_BASIS_POINTS, 0, MAX_BASIS_POINTS);

      await expect(
        oracleReportSanityChecker
          .connect(managersRoster.allLimitsManagers[0])
          .setOracleReportLimits({ ...defaultLimitsList, simulatedShareRateDeviationBPLimit: 10001 }, ZeroAddress),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
        .withArgs(INVALID_BASIS_POINTS, 0, MAX_BASIS_POINTS);
    });

    it("values must be less or equal to type(uint16).max", async () => {
      const MAX_UINT_16 = 65535;
      const INVALID_VALUE = MAX_UINT_16 + 1;

      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(await oracleReportSanityChecker.ALL_LIMITS_MANAGER_ROLE(), managersRoster.allLimitsManagers[0]);
      await expect(
        oracleReportSanityChecker
          .connect(managersRoster.allLimitsManagers[0])
          .setOracleReportLimits({ ...defaultLimitsList, churnValidatorsPerDayLimit: INVALID_VALUE }, ZeroAddress),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
        .withArgs(INVALID_VALUE, 0, MAX_UINT_16);

      await expect(
        oracleReportSanityChecker
          .connect(managersRoster.allLimitsManagers[0])
          .setOracleReportLimits(
            { ...defaultLimitsList, maxValidatorExitRequestsPerReport: INVALID_VALUE },
            ZeroAddress,
          ),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
        .withArgs(INVALID_VALUE, 0, MAX_UINT_16);

      await expect(
        oracleReportSanityChecker
          .connect(managersRoster.allLimitsManagers[0])
          .setOracleReportLimits(
            { ...defaultLimitsList, maxAccountingExtraDataListItemsCount: INVALID_VALUE },
            ZeroAddress,
          ),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
        .withArgs(INVALID_VALUE, 0, MAX_UINT_16);

      await expect(
        oracleReportSanityChecker
          .connect(managersRoster.allLimitsManagers[0])
          .setOracleReportLimits(
            { ...defaultLimitsList, maxNodeOperatorsPerExtraDataItemCount: INVALID_VALUE },
            ZeroAddress,
          ),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
        .withArgs(INVALID_VALUE, 0, MAX_UINT_16);

      await expect(
        oracleReportSanityChecker
          .connect(managersRoster.allLimitsManagers[0])
          .setOracleReportLimits({ ...defaultLimitsList, initialSlashingAmountPWei: INVALID_VALUE }, ZeroAddress),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
        .withArgs(INVALID_VALUE, 0, MAX_UINT_16);

      await expect(
        oracleReportSanityChecker
          .connect(managersRoster.allLimitsManagers[0])
          .setOracleReportLimits({ ...defaultLimitsList, inactivityPenaltiesAmountPWei: INVALID_VALUE }, ZeroAddress),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
        .withArgs(INVALID_VALUE, 0, MAX_UINT_16);
    });

    it("values must be less or equals to type(uint64).max", async () => {
      const MAX_UINT_64 = 2n ** 64n - 1n;
      const MAX_UINT_48 = 2n ** 48n - 1n;
      const INVALID_VALUE = MAX_UINT_64 + 1n;

      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(await oracleReportSanityChecker.ALL_LIMITS_MANAGER_ROLE(), managersRoster.allLimitsManagers[0]);
      await expect(
        oracleReportSanityChecker
          .connect(managersRoster.allLimitsManagers[0])
          .setOracleReportLimits({ ...defaultLimitsList, requestTimestampMargin: INVALID_VALUE }, ZeroAddress),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
        .withArgs(INVALID_VALUE.toString(), 0, MAX_UINT_48);

      await expect(
        oracleReportSanityChecker
          .connect(managersRoster.allLimitsManagers[0])
          .setOracleReportLimits({ ...defaultLimitsList, maxPositiveTokenRebase: INVALID_VALUE }, ZeroAddress),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
        .withArgs(INVALID_VALUE.toString(), 1, MAX_UINT_64);
    });

    it("value must be greater than zero", async () => {
      const MAX_UINT_64 = 2n ** 64n - 1n;
      const INVALID_VALUE = 0;

      await oracleReportSanityChecker
        .connect(admin)
        .grantRole(
          await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
          managersRoster.maxPositiveTokenRebaseManagers[0],
        );
      await expect(
        oracleReportSanityChecker
          .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
          .setMaxPositiveTokenRebase(0),
      )
        .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
        .withArgs(INVALID_VALUE, 1, MAX_UINT_64);
    });
  });
});
