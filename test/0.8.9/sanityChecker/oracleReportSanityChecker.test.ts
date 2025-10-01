import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Accounting__MockForSanityChecker,
  AccountingOracle__MockForSanityChecker,
  Burner__MockForSanityChecker,
  LidoLocator__MockForSanityChecker,
  OracleReportSanityChecker,
  StakingRouter__MockForSanityChecker,
  WithdrawalQueue__MockForSanityChecker,
} from "typechain-types";

import { ether, getCurrentBlockTimestamp, impersonate, randomAddress } from "lib";
import { TOTAL_BASIS_POINTS } from "lib/constants";

import { Snapshot } from "test/suite";

const MAX_UINT16 = BigInt(2 ** 16);
const MAX_UINT32 = BigInt(2 ** 32);
const MAX_UINT64 = BigInt(2 ** 64);

describe("OracleReportSanityChecker.sol", () => {
  let checker: OracleReportSanityChecker;

  let locator: LidoLocator__MockForSanityChecker;
  let burner: Burner__MockForSanityChecker;
  let accounting: Accounting__MockForSanityChecker;
  let withdrawalQueue: WithdrawalQueue__MockForSanityChecker;
  let stakingRouter: StakingRouter__MockForSanityChecker;
  let accountingOracle: AccountingOracle__MockForSanityChecker;

  let withdrawalVault: HardhatEthersSigner;

  const defaultLimits = {
    exitedValidatorsPerDayLimit: 55n,
    appearedValidatorsPerDayLimit: 100n,
    annualBalanceIncreaseBPLimit: 10_00n, // 10%
    simulatedShareRateDeviationBPLimit: 2_50n, // 2.5%
    maxValidatorExitRequestsPerReport: 2000n,
    maxItemsPerExtraDataTransaction: 15n,
    maxNodeOperatorsPerExtraDataItem: 16n,
    requestTimestampMargin: 128n,
    maxPositiveTokenRebase: 5_000_000n, // 0.05%
    initialSlashingAmountPWei: 1000n,
    inactivityPenaltiesAmountPWei: 101n,
    clBalanceOraclesErrorUpperBPLimit: 50n, // 0.5%
  };

  const correctOracleReport = {
    timeElapsed: 24n * 60n * 60n,
    preCLBalance: ether("100000"),
    postCLBalance: ether("100001"),
    withdrawalVaultBalance: 0n,
    elRewardsVaultBalance: 0n,
    sharesRequestedToBurn: 0n,
    preCLValidators: 0n,
    postCLValidators: 0n,
    etherToLockForWithdrawals: 0n,
  };

  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let elRewardsVault: HardhatEthersSigner;

  let stranger: HardhatEthersSigner;
  let manager: HardhatEthersSigner;

  let originalState: string;

  before(async () => {
    [deployer, admin, elRewardsVault, stranger, manager, withdrawalVault] = await ethers.getSigners();

    await setBalance(withdrawalVault.address, ether("500"));

    withdrawalQueue = await ethers.deployContract("WithdrawalQueue__MockForSanityChecker");
    burner = await ethers.deployContract("Burner__MockForSanityChecker");
    accounting = await ethers.deployContract("Accounting__MockForSanityChecker", []);

    accountingOracle = await ethers.deployContract("AccountingOracle__MockForSanityChecker", [
      deployer.address,
      12, // seconds per slot
      1606824023, // genesis time
    ]);

    stakingRouter = await ethers.deployContract("StakingRouter__MockForSanityChecker");

    locator = await ethers.deployContract("LidoLocator__MockForSanityChecker", [
      {
        lido: deployer,
        depositSecurityModule: deployer,
        elRewardsVault: elRewardsVault,
        accountingOracle: accountingOracle,
        oracleReportSanityChecker: deployer,
        burner: burner,
        validatorsExitBusOracle: deployer,
        stakingRouter: stakingRouter,
        treasury: deployer,
        withdrawalQueue: withdrawalQueue,
        withdrawalVault: withdrawalVault,
        postTokenRebaseReceiver: deployer,
        oracleDaemonConfig: deployer,
        validatorExitDelayVerifier: deployer,
        triggerableWithdrawalsGateway: deployer,
        accounting: accounting,
        predepositGuarantee: deployer,
        wstETH: deployer,
        vaultHub: deployer,
        vaultFactory: deployer,
        lazyOracle: deployer,
        operatorGrid: deployer,
      },
    ]);

    checker = await ethers.deployContract("OracleReportSanityChecker", [
      locator,
      accountingOracle,
      accounting,
      admin,
      defaultLimits,
    ]);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("reverts if admin address is zero", async () => {
      await expect(
        ethers.deployContract("OracleReportSanityChecker", [
          locator,
          accountingOracle,
          accounting,
          ZeroAddress,
          defaultLimits,
        ]),
      ).to.be.revertedWithCustomError(checker, "AdminCannotBeZero");
    });
  });

  context("getReportDataCount", () => {
    it("retrieves correct report data count", async () => {
      expect(await checker.getReportDataCount()).to.equal(0);
    });
  });

  context("getLidoLocator", () => {
    it("retrieves correct locator address", async () => {
      expect(await checker.getLidoLocator()).to.equal(locator);
    });
  });

  context("getOracleReportLimits", () => {
    it("retrieves correct oracle report limits", async () => {
      const limits = await checker.getOracleReportLimits();
      expect(limits.exitedValidatorsPerDayLimit).to.equal(defaultLimits.exitedValidatorsPerDayLimit);
      expect(limits.appearedValidatorsPerDayLimit).to.equal(defaultLimits.appearedValidatorsPerDayLimit);
      expect(limits.annualBalanceIncreaseBPLimit).to.equal(defaultLimits.annualBalanceIncreaseBPLimit);
      expect(limits.maxValidatorExitRequestsPerReport).to.equal(defaultLimits.maxValidatorExitRequestsPerReport);
      expect(limits.maxItemsPerExtraDataTransaction).to.equal(defaultLimits.maxItemsPerExtraDataTransaction);
      expect(limits.maxNodeOperatorsPerExtraDataItem).to.equal(defaultLimits.maxNodeOperatorsPerExtraDataItem);
      expect(limits.requestTimestampMargin).to.equal(defaultLimits.requestTimestampMargin);
      expect(limits.maxPositiveTokenRebase).to.equal(defaultLimits.maxPositiveTokenRebase);
      expect(limits.clBalanceOraclesErrorUpperBPLimit).to.equal(defaultLimits.clBalanceOraclesErrorUpperBPLimit);
      expect(limits.initialSlashingAmountPWei).to.equal(defaultLimits.initialSlashingAmountPWei);
      expect(limits.inactivityPenaltiesAmountPWei).to.equal(defaultLimits.inactivityPenaltiesAmountPWei);
    });
  });

  context("getMaxPositiveTokenRebase", () => {
    it("returns correct max positive token rebase", async () => {
      expect(await checker.getMaxPositiveTokenRebase()).to.equal(defaultLimits.maxPositiveTokenRebase);
    });
  });

  context("setOracleReportLimits", () => {
    const newLimits = {
      exitedValidatorsPerDayLimit: 50,
      appearedValidatorsPerDayLimit: 75,
      annualBalanceIncreaseBPLimit: 15_00,
      simulatedShareRateDeviationBPLimit: 1_50, // 1.5%
      maxValidatorExitRequestsPerReport: 3000,
      maxItemsPerExtraDataTransaction: 15 + 1,
      maxNodeOperatorsPerExtraDataItem: 16 + 1,
      requestTimestampMargin: 2048,
      maxPositiveTokenRebase: 10_000_000,
      initialSlashingAmountPWei: 2000,
      inactivityPenaltiesAmountPWei: 303,
      clBalanceOraclesErrorUpperBPLimit: 12,
    };

    before(async () => {
      await checker.connect(admin).grantRole(await checker.ALL_LIMITS_MANAGER_ROLE(), manager);
    });

    after(async () => {
      await checker.connect(admin).revokeRole(await checker.ALL_LIMITS_MANAGER_ROLE(), manager);
    });

    it("reverts if called by non-manager", async () => {
      await expect(
        checker.connect(stranger).setOracleReportLimits(newLimits, ZeroAddress),
      ).to.be.revertedWithOZAccessControlError(stranger.address, await checker.ALL_LIMITS_MANAGER_ROLE());
    });

    it("sets limits correctly", async () => {
      const before = await checker.getOracleReportLimits();
      expect(before.exitedValidatorsPerDayLimit).to.not.equal(newLimits.exitedValidatorsPerDayLimit);
      expect(before.appearedValidatorsPerDayLimit).to.not.equal(newLimits.appearedValidatorsPerDayLimit);
      expect(before.annualBalanceIncreaseBPLimit).to.not.equal(newLimits.annualBalanceIncreaseBPLimit);
      expect(before.maxValidatorExitRequestsPerReport).to.not.equal(newLimits.maxValidatorExitRequestsPerReport);
      expect(before.maxItemsPerExtraDataTransaction).to.not.equal(newLimits.maxItemsPerExtraDataTransaction);
      expect(before.maxNodeOperatorsPerExtraDataItem).to.not.equal(newLimits.maxNodeOperatorsPerExtraDataItem);
      expect(before.requestTimestampMargin).to.not.equal(newLimits.requestTimestampMargin);
      expect(before.maxPositiveTokenRebase).to.not.equal(newLimits.maxPositiveTokenRebase);
      expect(before.clBalanceOraclesErrorUpperBPLimit).to.not.equal(newLimits.clBalanceOraclesErrorUpperBPLimit);
      expect(before.initialSlashingAmountPWei).to.not.equal(newLimits.initialSlashingAmountPWei);
      expect(before.inactivityPenaltiesAmountPWei).to.not.equal(newLimits.inactivityPenaltiesAmountPWei);

      await checker.connect(manager).setOracleReportLimits(newLimits, ZeroAddress);

      const after = await checker.getOracleReportLimits();
      expect(after.exitedValidatorsPerDayLimit).to.equal(newLimits.exitedValidatorsPerDayLimit);
      expect(after.appearedValidatorsPerDayLimit).to.equal(newLimits.appearedValidatorsPerDayLimit);
      expect(after.annualBalanceIncreaseBPLimit).to.equal(newLimits.annualBalanceIncreaseBPLimit);
      expect(after.maxValidatorExitRequestsPerReport).to.equal(newLimits.maxValidatorExitRequestsPerReport);
      expect(after.maxItemsPerExtraDataTransaction).to.equal(newLimits.maxItemsPerExtraDataTransaction);
      expect(after.maxNodeOperatorsPerExtraDataItem).to.equal(newLimits.maxNodeOperatorsPerExtraDataItem);
      expect(after.requestTimestampMargin).to.equal(newLimits.requestTimestampMargin);
      expect(after.maxPositiveTokenRebase).to.equal(newLimits.maxPositiveTokenRebase);
      expect(after.clBalanceOraclesErrorUpperBPLimit).to.equal(newLimits.clBalanceOraclesErrorUpperBPLimit);
      expect(after.initialSlashingAmountPWei).to.equal(newLimits.initialSlashingAmountPWei);
      expect(after.inactivityPenaltiesAmountPWei).to.equal(newLimits.inactivityPenaltiesAmountPWei);
      expect(after.clBalanceOraclesErrorUpperBPLimit).to.equal(newLimits.clBalanceOraclesErrorUpperBPLimit);
    });

    it("sets second opinion oracle", async () => {
      const secondOpinionOracle = randomAddress();
      await expect(checker.connect(manager).setOracleReportLimits(newLimits, secondOpinionOracle))
        .to.emit(checker, "SecondOpinionOracleChanged")
        .withArgs(secondOpinionOracle);

      expect(await checker.secondOpinionOracle()).to.equal(secondOpinionOracle);
    });
  });

  context("setExitedValidatorsPerDayLimit", () => {
    before(async () => {
      await checker.connect(admin).grantRole(await checker.EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE(), manager);
    });

    after(async () => {
      await checker.connect(admin).revokeRole(await checker.EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE(), manager);
    });

    it("reverts if called by non-manager", async () => {
      await expect(
        checker.connect(stranger).setExitedValidatorsPerDayLimit(100n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE(),
      );
    });

    it("reverts if limit is greater than max", async () => {
      await expect(checker.connect(manager).setExitedValidatorsPerDayLimit(MAX_UINT16)).to.be.revertedWithCustomError(
        checker,
        "IncorrectLimitValue",
      );
    });

    it("sets limit correctly and emits `ExitedValidatorsPerDayLimitSet` event", async () => {
      const before = await checker.getOracleReportLimits();
      expect(before.exitedValidatorsPerDayLimit).to.not.equal(100n);

      await expect(checker.connect(manager).setExitedValidatorsPerDayLimit(100n))
        .to.emit(checker, "ExitedValidatorsPerDayLimitSet")
        .withArgs(100n);

      const after = await checker.getOracleReportLimits();
      expect(after.exitedValidatorsPerDayLimit).to.equal(100n);
    });
  });

  context("setAppearedValidatorsPerDayLimit", () => {
    before(async () => {
      await checker.connect(admin).grantRole(await checker.APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE(), manager);
    });

    after(async () => {
      await checker.connect(admin).revokeRole(await checker.APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE(), manager);
    });

    it("reverts if called by non-manager", async () => {
      await expect(
        checker.connect(stranger).setAppearedValidatorsPerDayLimit(101n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE(),
      );
    });

    it("reverts if limit is greater than max", async () => {
      await expect(checker.connect(manager).setAppearedValidatorsPerDayLimit(MAX_UINT16)).to.be.revertedWithCustomError(
        checker,
        "IncorrectLimitValue",
      );
    });

    it("sets limit correctly and emits `AppearedValidatorsPerDayLimitSet` event", async () => {
      const before = await checker.getOracleReportLimits();
      expect(before.appearedValidatorsPerDayLimit).to.not.equal(101n);

      await expect(checker.connect(manager).setAppearedValidatorsPerDayLimit(101n))
        .to.emit(checker, "AppearedValidatorsPerDayLimitSet")
        .withArgs(101n);

      const after = await checker.getOracleReportLimits();
      expect(after.appearedValidatorsPerDayLimit).to.equal(101n);
    });
  });

  context("setAnnualBalanceIncreaseBPLimit", () => {
    before(async () => {
      await checker.connect(admin).grantRole(await checker.ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE(), manager);
    });

    after(async () => {
      await checker.connect(admin).revokeRole(await checker.ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE(), manager);
    });

    it("reverts if called by non-manager", async () => {
      await expect(
        checker.connect(stranger).setAnnualBalanceIncreaseBPLimit(100n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE(),
      );
    });

    it("reverts if limit is greater than max", async () => {
      await expect(
        checker.connect(manager).setAnnualBalanceIncreaseBPLimit(TOTAL_BASIS_POINTS + 1n),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");
    });

    it("sets limit correctly and emits `AnnualBalanceIncreaseBPLimitSet` event", async () => {
      const before = await checker.getOracleReportLimits();
      expect(before.annualBalanceIncreaseBPLimit).to.not.equal(100n);

      await expect(checker.connect(manager).setAnnualBalanceIncreaseBPLimit(100n))
        .to.emit(checker, "AnnualBalanceIncreaseBPLimitSet")
        .withArgs(100n);

      const after = await checker.getOracleReportLimits();
      expect(after.annualBalanceIncreaseBPLimit).to.equal(100n);
    });
  });

  context("setMaxExitRequestsPerOracleReport", () => {
    before(async () => {
      await checker.connect(admin).grantRole(await checker.MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE(), manager);
    });

    after(async () => {
      await checker.connect(admin).revokeRole(await checker.MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE(), manager);
    });

    it("reverts if called by non-manager", async () => {
      await expect(
        checker.connect(stranger).setMaxExitRequestsPerOracleReport(100n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE(),
      );
    });

    it("reverts if limit is greater than max", async () => {
      await expect(
        checker.connect(manager).setMaxExitRequestsPerOracleReport(MAX_UINT16),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");
    });

    it("sets limit correctly and emits `MaxValidatorExitRequestsPerReportSet` event", async () => {
      const before = await checker.getOracleReportLimits();
      expect(before.maxValidatorExitRequestsPerReport).to.not.equal(100n);

      await expect(checker.connect(manager).setMaxExitRequestsPerOracleReport(100n))
        .to.emit(checker, "MaxValidatorExitRequestsPerReportSet")
        .withArgs(100n);

      const after = await checker.getOracleReportLimits();
      expect(after.maxValidatorExitRequestsPerReport).to.equal(100n);
    });
  });

  context("setRequestTimestampMargin", () => {
    before(async () => {
      await checker.connect(admin).grantRole(await checker.REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE(), manager);
    });

    after(async () => {
      await checker.connect(admin).revokeRole(await checker.REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE(), manager);
    });

    it("reverts if called by non-manager", async () => {
      await expect(checker.connect(stranger).setRequestTimestampMargin(100n)).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE(),
      );
    });

    it("reverts if limit is greater than max", async () => {
      await expect(checker.connect(manager).setRequestTimestampMargin(MAX_UINT32)).to.be.revertedWithCustomError(
        checker,
        "IncorrectLimitValue",
      );
    });

    it("sets limit correctly and emits `RequestTimestampMarginSet` event", async () => {
      const before = await checker.getOracleReportLimits();
      expect(before.requestTimestampMargin).to.not.equal(100n);

      await expect(checker.connect(manager).setRequestTimestampMargin(100n))
        .to.emit(checker, "RequestTimestampMarginSet")
        .withArgs(100n);

      const after = await checker.getOracleReportLimits();
      expect(after.requestTimestampMargin).to.equal(100n);
    });
  });

  context("setMaxPositiveTokenRebase", () => {
    before(async () => {
      await checker.connect(admin).grantRole(await checker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(), manager);
    });

    after(async () => {
      await checker.connect(admin).revokeRole(await checker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(), manager);
    });

    it("reverts if called by non-manager", async () => {
      await expect(checker.connect(stranger).setMaxPositiveTokenRebase(100n)).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
      );
    });

    it("reverts if limit is greater than max", async () => {
      await expect(checker.connect(manager).setMaxPositiveTokenRebase(MAX_UINT64 + 1n)).to.be.revertedWithCustomError(
        checker,
        "IncorrectLimitValue",
      );
    });

    it("reverts if limit is less than min", async () => {
      await expect(checker.connect(manager).setMaxPositiveTokenRebase(0n)).to.be.revertedWithCustomError(
        checker,
        "IncorrectLimitValue",
      );
    });

    it("sets limit correctly and emits `MaxPositiveTokenRebaseSet` event", async () => {
      const before = await checker.getOracleReportLimits();
      expect(before.maxPositiveTokenRebase).to.not.equal(100n);

      await expect(checker.connect(manager).setMaxPositiveTokenRebase(100n))
        .to.emit(checker, "MaxPositiveTokenRebaseSet")
        .withArgs(100n);

      const after = await checker.getOracleReportLimits();
      expect(after.maxPositiveTokenRebase).to.equal(100n);
    });
  });

  context("setMaxItemsPerExtraDataTransaction", () => {
    before(async () => {
      await checker.connect(admin).grantRole(await checker.MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE(), manager);
    });

    after(async () => {
      await checker.connect(admin).revokeRole(await checker.MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE(), manager);
    });

    it("reverts if called by non-manager", async () => {
      await expect(
        checker.connect(stranger).setMaxItemsPerExtraDataTransaction(100n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE(),
      );
    });

    it("reverts if limit is greater than max", async () => {
      await expect(
        checker.connect(manager).setMaxItemsPerExtraDataTransaction(MAX_UINT16),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");
    });

    it("sets limit correctly and emits `MaxItemsPerExtraDataTransactionSet` event", async () => {
      const before = await checker.getOracleReportLimits();
      expect(before.maxItemsPerExtraDataTransaction).to.not.equal(100n);

      await expect(checker.connect(manager).setMaxItemsPerExtraDataTransaction(100n))
        .to.emit(checker, "MaxItemsPerExtraDataTransactionSet")
        .withArgs(100n);

      const after = await checker.getOracleReportLimits();
      expect(after.maxItemsPerExtraDataTransaction).to.equal(100n);
    });
  });

  context("setMaxNodeOperatorsPerExtraDataItem", () => {
    before(async () => {
      await checker.connect(admin).grantRole(await checker.MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE(), manager);
    });

    after(async () => {
      await checker.connect(admin).revokeRole(await checker.MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE(), manager);
    });

    it("reverts if called by non-manager", async () => {
      await expect(
        checker.connect(stranger).setMaxNodeOperatorsPerExtraDataItem(100n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE(),
      );
    });

    it("reverts if limit is greater than max", async () => {
      await expect(
        checker.connect(manager).setMaxNodeOperatorsPerExtraDataItem(MAX_UINT16),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");
    });

    it("sets limit correctly and emits `MaxNodeOperatorsPerExtraDataItemSet` event", async () => {
      const before = await checker.getOracleReportLimits();
      expect(before.maxNodeOperatorsPerExtraDataItem).to.not.equal(100n);

      await expect(checker.connect(manager).setMaxNodeOperatorsPerExtraDataItem(100n))
        .to.emit(checker, "MaxNodeOperatorsPerExtraDataItemSet")
        .withArgs(100n);

      const after = await checker.getOracleReportLimits();
      expect(after.maxNodeOperatorsPerExtraDataItem).to.equal(100n);
    });
  });

  context("setSecondOpinionOracleAndCLBalanceUpperMargin", () => {
    before(async () => {
      await checker.connect(admin).grantRole(await checker.SECOND_OPINION_MANAGER_ROLE(), manager);
    });

    after(async () => {
      await checker.connect(admin).revokeRole(await checker.SECOND_OPINION_MANAGER_ROLE(), manager);
    });

    it("reverts if called by non-manager", async () => {
      await expect(
        checker.connect(stranger).setSecondOpinionOracleAndCLBalanceUpperMargin(ZeroAddress, 100n),
      ).to.be.revertedWithOZAccessControlError(stranger.address, await checker.SECOND_OPINION_MANAGER_ROLE());
    });

    it("reverts if limit is greater than max", async () => {
      await expect(
        checker.connect(manager).setSecondOpinionOracleAndCLBalanceUpperMargin(ZeroAddress, TOTAL_BASIS_POINTS + 1n),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");
    });

    it("sets limit correctly and emits `CLBalanceOraclesErrorUpperBPLimitSet` event", async () => {
      await expect(checker.connect(manager).setSecondOpinionOracleAndCLBalanceUpperMargin(ZeroAddress, 100n))
        .to.emit(checker, "CLBalanceOraclesErrorUpperBPLimitSet")
        .withArgs(100n);
    });

    it("changes the second opinion oracle if it is new", async () => {
      const secondOpinionOracle = randomAddress();
      await expect(checker.connect(manager).setSecondOpinionOracleAndCLBalanceUpperMargin(secondOpinionOracle, 100n))
        .to.emit(checker, "SecondOpinionOracleChanged")
        .withArgs(secondOpinionOracle);

      expect(await checker.secondOpinionOracle()).to.equal(secondOpinionOracle);
    });
  });

  context("setInitialSlashingAndPenaltiesAmount", () => {
    before(async () => {
      await checker.connect(admin).grantRole(await checker.INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE(), manager);
    });

    after(async () => {
      await checker.connect(admin).revokeRole(await checker.INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE(), manager);
    });

    it("reverts if called by non-manager", async () => {
      await expect(
        checker.connect(stranger).setInitialSlashingAndPenaltiesAmount(100n, 100n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE(),
      );
    });

    it("reverts if initial slashing amount is greater than max", async () => {
      await expect(
        checker.connect(manager).setInitialSlashingAndPenaltiesAmount(MAX_UINT16, 100n),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");
    });

    it("reverts if penalties amount is greater than max", async () => {
      await expect(
        checker.connect(manager).setInitialSlashingAndPenaltiesAmount(100n, MAX_UINT16),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");
    });

    it("sets limit correctly and emits `InitialSlashingAmountSet` and `InactivityPenaltiesAmountSet` events", async () => {
      await expect(checker.connect(manager).setInitialSlashingAndPenaltiesAmount(100n, 100n))
        .to.emit(checker, "InitialSlashingAmountSet")
        .withArgs(100n)
        .to.emit(checker, "InactivityPenaltiesAmountSet")
        .withArgs(100n);
    });
  });

  context("smoothenTokenRebase", () => {
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

    const report = (
      overrides: Partial<{
        [key in keyof typeof defaultSmoothenTokenRebaseParams]: bigint;
      }> = {},
    ): [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint] => {
      const reportData = { ...defaultSmoothenTokenRebaseParams, ...overrides };
      return [
        reportData.preTotalPooledEther,
        reportData.preTotalShares,
        reportData.preCLBalance,
        reportData.postCLBalance,
        reportData.withdrawalVaultBalance,
        reportData.elRewardsVaultBalance,
        reportData.sharesRequestedToBurn,
        reportData.etherToLockForWithdrawals,
        reportData.newSharesToBurnForWithdrawals,
      ];
    };

    before(async () => {
      await checker.connect(admin).grantRole(await checker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(), manager);
    });

    after(async () => {
      await checker.connect(admin).revokeRole(await checker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(), manager);
    });

    it("works with zero data", async () => {
      const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
        ...report(),
      );

      expect(withdrawals).to.equal(0);
      expect(elRewards).to.equal(0);
      expect(sharesFromWQToBurn).to.equal(0);
      expect(sharesToBurn).to.equal(0);
    });

    context("trivial post CL < pre CL", () => {
      before(async () => {
        const newRebaseLimit = 100_000; // 0.01%
        await checker.connect(manager).setMaxPositiveTokenRebase(newRebaseLimit);
      });

      it("smoothens with no rewards and no withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("99"),
          }),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(0);
      });

      it("smoothens with el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("99"),
            elRewardsVaultBalance: ether("0.1"),
          }),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(ether("0.1"));
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(0);
      });

      it("smoothens with withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("99"),
            withdrawalVaultBalance: ether("0.1"),
          }),
        );

        expect(withdrawals).to.equal(ether("0.1"));
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(0);
      });

      it("smoothens with shares requested to burn", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("99"),
            sharesRequestedToBurn: ether("0.1"),
          }),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(ether("0.1"));
      });
    });

    context("trivial post CL > pre CL", () => {
      before(async () => {
        const newRebaseLimit = 100_000_000; // 10%
        await checker.connect(manager).setMaxPositiveTokenRebase(newRebaseLimit);
      });

      it("smoothens with no rewards and no withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("100.01"),
          }),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(0);
      });

      it("smoothens with el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("100.01"),
            elRewardsVaultBalance: ether("0.1"),
          }),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(ether("0.1"));
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(0);
      });

      it("smoothens with withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("100.01"),
            withdrawalVaultBalance: ether("0.1"),
          }),
        );

        expect(withdrawals).to.equal(ether("0.1"));
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(0);
      });

      it("smoothens with shares requested to burn", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("100.01"),
            sharesRequestedToBurn: ether("0.1"),
          }),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(ether("0.1"));
      });
    });

    context("non-trivial post CL < pre CL ", () => {
      before(async () => {
        const newRebaseLimit = 10_000_000; // 1%
        await checker.connect(manager).setMaxPositiveTokenRebase(newRebaseLimit);
      });

      it("smoothens with no rewards and no withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("99"),
          }),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(0);
      });

      it("smoothens with el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("99"),
            elRewardsVaultBalance: ether("5"),
          }),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(ether("2"));
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(0);
      });

      it("smoothens with withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("99"),
            withdrawalVaultBalance: ether("5"),
          }),
        );

        expect(withdrawals).to.equal(ether("2"));
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(0);
      });

      it("smoothens with withdrawals and el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("99"),
            withdrawalVaultBalance: ether("5"),
            elRewardsVaultBalance: ether("5"),
          }),
        );

        expect(withdrawals).to.equal(ether("2"));
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(0);
      });

      it("smoothens with shares requested to burn", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("99"),
            sharesRequestedToBurn: ether("5"),
          }),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(1980198019801980198n); // ether(100. - (99. / 1.01))
      });
    });

    context("non-trivial post CL > pre CL", () => {
      before(async () => {
        const newRebaseLimit = 20_000_000; // 2%
        await checker.connect(manager).setMaxPositiveTokenRebase(newRebaseLimit);
      });

      it("smoothens with no rewards and no withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("101"),
          }),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(0);
      });

      it("smoothens with el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("101"),
            elRewardsVaultBalance: ether("5"),
          }),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(ether("1"));
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(0);
      });

      it("smoothens with withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("101"),
            withdrawalVaultBalance: ether("5"),
          }),
        );

        expect(withdrawals).to.equal(ether("1"));
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(0);
      });

      it("smoothens with withdrawals and el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("101"),
            withdrawalVaultBalance: ether("5"),
            elRewardsVaultBalance: ether("5"),
          }),
        );

        expect(withdrawals).to.equal(ether("1"));
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(0);
      });

      it("smoothens with shares requested to burn", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({
            postCLBalance: ether("101"),
            sharesRequestedToBurn: ether("5"),
          }),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(0);
        expect(sharesToBurn).to.equal(980392156862745098n); // ether(100. - (101. / 1.02))
      });
    });

    context("non-trivial post CL < pre CL and withdrawals", () => {
      const defaultRebaseParams = {
        ...defaultSmoothenTokenRebaseParams,
        postCLBalance: ether("99"),
        etherToLockForWithdrawals: ether("10"),
        newSharesToBurnForWithdrawals: ether("10"),
      };

      before(async () => {
        const newRebaseLimit = 5_000_000; // 0.5%
        await checker.connect(manager).setMaxPositiveTokenRebase(newRebaseLimit);
      });

      it("smoothens with no rewards and no withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report(defaultRebaseParams),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(ether("10"));
        expect(sharesToBurn).to.equal(ether("10"));
      });

      it("smoothens with el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ ...defaultRebaseParams, elRewardsVaultBalance: ether("5") }),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(ether("1.5"));
        expect(sharesFromWQToBurn).to.equal(9950248756218905472n); // 100. - 90.5 / 1.005
        expect(sharesToBurn).to.equal(9950248756218905472n);
      });

      it("smoothens with withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ ...defaultRebaseParams, withdrawalVaultBalance: ether("5") }),
        );

        expect(withdrawals).to.equal(ether("1.5"));
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(9950248756218905472n); // 100. - 90.5 / 1.005
        expect(sharesToBurn).to.equal(9950248756218905472n);
      });

      it("smoothens with withdrawals and el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ ...defaultRebaseParams, withdrawalVaultBalance: ether("5"), elRewardsVaultBalance: ether("5") }),
        );

        expect(withdrawals).to.equal(ether("1.5"));
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(9950248756218905472n); // 100. - 90.5 / 1.005
        expect(sharesToBurn).to.equal(9950248756218905472n);
      });

      it("smoothens with shares requested to burn", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ ...defaultRebaseParams, sharesRequestedToBurn: ether("5") }),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(0);

        expect(sharesFromWQToBurn).to.equal(9950248756218905473n); // ether("100. - (90.5 / 1.005)")
        expect(sharesToBurn).to.equal(11442786069651741293n); // ether("100. - (89. / 1.005)")
      });
    });

    context("non-trivial post CL > pre CL and withdrawals", () => {
      const defaultRebaseParams = {
        ...defaultSmoothenTokenRebaseParams,
        postCLBalance: ether("102"),
        etherToLockForWithdrawals: ether("10"),
        newSharesToBurnForWithdrawals: ether("10"),
      };

      before(async () => {
        const newRebaseLimit = 40_000_000; // 4%
        await checker.connect(manager).setMaxPositiveTokenRebase(newRebaseLimit);
      });

      it("smoothens with no rewards and no withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report(defaultRebaseParams),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(ether("10"));
        expect(sharesToBurn).to.equal(ether("10"));
      });

      it("smoothens with el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ ...defaultRebaseParams, elRewardsVaultBalance: ether("5") }),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(ether("2"));
        expect(sharesFromWQToBurn).to.equal(9615384615384615384n);
        expect(sharesToBurn).to.equal(9615384615384615384n); // 100. - 94. / 1.04
      });

      it("smoothens with withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ ...defaultRebaseParams, withdrawalVaultBalance: ether("5") }),
        );

        expect(withdrawals).to.equal(ether("2"));
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(9615384615384615384n);
        expect(sharesToBurn).to.equal(9615384615384615384n); // 100. - 94. / 1.04
      });

      it("smoothens with withdrawals and el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ ...defaultRebaseParams, withdrawalVaultBalance: ether("5"), elRewardsVaultBalance: ether("5") }),
        );

        expect(withdrawals).to.equal(ether("2"));
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(9615384615384615384n);
        expect(sharesToBurn).to.equal(9615384615384615384n); // 100. - 94. / 1.04
      });

      it("smoothens with shares requested to burn", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ ...defaultRebaseParams, sharesRequestedToBurn: ether("5") }),
        );

        expect(withdrawals).to.equal(0);
        expect(elRewards).to.equal(0);
        expect(sharesFromWQToBurn).to.equal(9615384615384615385n);
        expect(sharesToBurn).to.equal(11538461538461538461n); // 100. - (92. / 1.04)
      });
    });

    context("share rate ~1 case with huge withdrawal", () => {
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

      before(async () => {
        const newRebaseLimit = 1_000_000; // 0.1%
        await checker.connect(manager).setMaxPositiveTokenRebase(newRebaseLimit);
      });

      it("smoothens the rebase", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report(rebaseParams),
        );

        expect(withdrawals).to.equal(ether("500"));
        expect(elRewards).to.equal(ether("500"));
        expect(sharesFromWQToBurn).to.equal(39960039960039960039960n); // ether(1000000 - 961000. / 1.001)
        expect(sharesToBurn).to.equal(39960039960039960039960n);
      });
    });

    context("rounding case from Görli", () => {
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

      before(async () => {
        const newRebaseLimit = 750_000; // 0.075% or 7.5 basis points
        await checker.connect(manager).setMaxPositiveTokenRebase(newRebaseLimit);
      });

      it("smoothens the rebase", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report(rebaseParams),
        );

        expect(withdrawals).to.equal(129959459000000000n);
        expect(elRewards).to.equal(95073654397722094176n);
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(0n);
      });
    });
  });

  // NB: negative rebase is handled in `oracleReportSanityChecker.negative-rebase.test.ts`
  context("checkAccountingOracleReport", () => {
    const report = (
      overrides: Partial<{
        [key in keyof typeof correctOracleReport]: bigint;
      }> = {},
    ): [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint] => {
      const reportData = { ...correctOracleReport, ...overrides };
      return [
        reportData.timeElapsed,
        reportData.preCLBalance,
        reportData.postCLBalance,
        reportData.withdrawalVaultBalance,
        reportData.elRewardsVaultBalance,
        reportData.sharesRequestedToBurn,
        reportData.preCLValidators,
        reportData.postCLValidators,
      ];
    };

    let accountingSigher: HardhatEthersSigner;
    before(async () => {
      accountingSigher = await impersonate(await locator.accounting(), ether("1"));
    });

    it("reverts when not called by accounting", async () => {
      await expect(checker.connect(stranger).checkAccountingOracleReport(...report())).to.be.revertedWithCustomError(
        checker,
        "CalledNotFromAccounting",
      );
    });

    it("reverts when actual withdrawal vault balance is less than passed", async () => {
      const currentWithdrawalVaultBalance = await ethers.provider.getBalance(withdrawalVault);

      await expect(
        checker.connect(accountingSigher).checkAccountingOracleReport(
          ...report({
            withdrawalVaultBalance: currentWithdrawalVaultBalance + 1n,
          }),
        ),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectWithdrawalsVaultBalance")
        .withArgs(currentWithdrawalVaultBalance);
    });

    it("reverts when actual el rewards vault balance is less than passed", async () => {
      const currentELRewardsVaultBalance = await ethers.provider.getBalance(elRewardsVault);

      await expect(
        checker.connect(accountingSigher).checkAccountingOracleReport(
          ...report({
            elRewardsVaultBalance: currentELRewardsVaultBalance + 1n,
          }),
        ),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectELRewardsVaultBalance")
        .withArgs(currentELRewardsVaultBalance);
    });

    it("reverts when actual shares to burn is less than passed", async () => {
      await burner.setSharesRequestedToBurn(10, 21);

      await expect(
        checker.connect(accountingSigher).checkAccountingOracleReport(
          ...report({
            sharesRequestedToBurn: 32n,
          }),
        ),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectSharesRequestedToBurn")
        .withArgs(31n);
    });

    it("reverts when reported values overcome annual CL balance limit", async () => {
      const maxBasisPoints = 10_000n;
      const secondsInOneYear = 365n * 24n * 60n * 60n;
      const postCLBalance = ether("150000");

      // This formula calculates the annualized balance increase in basis points (BP)
      // 1. Calculate the absolute balance increase: (postCLBalance - preCLBalance)
      // 2. Convert to a relative increase by dividing by preCLBalance
      // 3. Annualize by multiplying by (secondsInOneYear / timeElapsed)
      // 4. Convert to basis points by multiplying by maxBasisPoints (100_00n)
      // The result represents how much the balance would increase over a year at the current rate
      const annualBalanceIncrease =
        (secondsInOneYear * maxBasisPoints * (postCLBalance - correctOracleReport.preCLBalance)) /
        correctOracleReport.preCLBalance /
        correctOracleReport.timeElapsed;

      await expect(
        checker.connect(accountingSigher).checkAccountingOracleReport(...report({ postCLBalance: postCLBalance })),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceIncrease")
        .withArgs(annualBalanceIncrease);
    });

    it("reverts when amount of appeared validators is greater than possible", async () => {
      const insaneValidators = 100000n;
      await expect(
        checker
          .connect(accountingSigher)
          .checkAccountingOracleReport(
            ...report({ postCLValidators: correctOracleReport.preCLValidators + insaneValidators }),
          ),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectAppearedValidators")
        .withArgs(correctOracleReport.preCLValidators + insaneValidators);
    });

    it("passes all checks with correct oracle report data", async () => {
      await expect(checker.connect(accountingSigher).checkAccountingOracleReport(...report())).not.to.be.reverted;
    });

    it("handles zero time passed for annual balance increase", async () => {
      await expect(
        checker.connect(accountingSigher).checkAccountingOracleReport(
          ...report({
            postCLBalance: correctOracleReport.preCLBalance + 1000n,
            timeElapsed: 0n,
          }),
        ),
      ).not.to.be.reverted;
    });

    it("handles zero pre CL balance estimating balance increase", async () => {
      await expect(
        checker.connect(accountingSigher).checkAccountingOracleReport(
          ...report({
            preCLBalance: 0n,
            postCLBalance: 1000n,
          }),
        ),
      ).not.to.be.reverted;
    });

    it("handles appeared validators", async () => {
      await expect(
        checker.connect(accountingSigher).checkAccountingOracleReport(
          ...report({
            preCLValidators: correctOracleReport.preCLValidators,
            postCLValidators: correctOracleReport.preCLValidators + 2n,
          }),
        ),
      ).not.to.be.reverted;
    });

    it("handles zero time passed for appeared validators", async () => {
      await expect(
        checker.connect(accountingSigher).checkAccountingOracleReport(
          ...report({
            preCLValidators: correctOracleReport.preCLValidators,
            postCLValidators: correctOracleReport.preCLValidators + 2n,
            timeElapsed: 0n,
          }),
        ),
      ).not.to.be.reverted;
    });
  });

  context("checkExitBusOracleReport", () => {
    let maxExitRequests: bigint;

    before(async () => {
      maxExitRequests = (await checker.getOracleReportLimits()).maxValidatorExitRequestsPerReport;
    });

    it("reverts on too many exit requests", async () => {
      await expect(checker.checkExitBusOracleReport(maxExitRequests + 1n))
        .to.be.revertedWithCustomError(checker, "IncorrectNumberOfExitRequestsPerReport")
        .withArgs(maxExitRequests);
    });

    it("works with correct validators count", async () => {
      await expect(checker.checkExitBusOracleReport(maxExitRequests)).not.to.be.reverted;
    });
  });

  context("checkExitedValidatorsRatePerDay", () => {
    let maxExitedValidators: bigint;

    before(async () => {
      maxExitedValidators = (await checker.getOracleReportLimits()).exitedValidatorsPerDayLimit;
    });

    it("reverts on too many exited validators", async () => {
      await expect(checker.checkExitedValidatorsRatePerDay(maxExitedValidators + 1n))
        .to.be.revertedWithCustomError(checker, "ExitedValidatorsLimitExceeded")
        .withArgs(maxExitedValidators, maxExitedValidators + 1n);
    });

    it("works with correct exited validators count", async () => {
      await expect(checker.checkExitedValidatorsRatePerDay(maxExitedValidators)).not.to.be.reverted;
    });
  });

  context("checkNodeOperatorsPerExtraDataItemCount", () => {
    let maxCount: bigint;

    before(async () => {
      maxCount = (await checker.getOracleReportLimits()).maxNodeOperatorsPerExtraDataItem;
    });

    it("reverts on too many node operators", async () => {
      await expect(checker.checkNodeOperatorsPerExtraDataItemCount(12, maxCount + 1n))
        .to.be.revertedWithCustomError(checker, "TooManyNodeOpsPerExtraDataItem")
        .withArgs(12, maxCount + 1n);
    });

    it("works with correct count", async () => {
      await expect(checker.checkNodeOperatorsPerExtraDataItemCount(12, maxCount)).not.to.be.reverted;
    });
  });

  context("checkExtraDataItemsCountPerTransaction", () => {
    let maxCount: bigint;

    before(async () => {
      maxCount = (await checker.getOracleReportLimits()).maxItemsPerExtraDataTransaction;
    });

    it("reverts on too many items", async () => {
      await expect(checker.checkExtraDataItemsCountPerTransaction(maxCount + 1n))
        .to.be.revertedWithCustomError(checker, "TooManyItemsPerExtraDataTransaction")
        .withArgs(maxCount, maxCount + 1n);
    });

    it("works with correct count", async () => {
      await expect(checker.checkExtraDataItemsCountPerTransaction(maxCount)).not.to.be.reverted;
    });
  });

  context("checkWithdrawalQueueOracleReport", () => {
    const oldRequestId = 1n;
    const newRequestId = 2n;
    let oldRequestCreationTimestamp;
    let newRequestCreationTimestamp: bigint;

    const correctWithdrawalQueueOracleReport = {
      lastFinalizableRequestId: oldRequestId,
      refReportTimestamp: -1n,
    };

    before(async () => {
      const currentBlockTimestamp = await getCurrentBlockTimestamp();
      correctWithdrawalQueueOracleReport.refReportTimestamp = currentBlockTimestamp;
      oldRequestCreationTimestamp = currentBlockTimestamp - defaultLimits.requestTimestampMargin;

      correctWithdrawalQueueOracleReport.lastFinalizableRequestId = oldRequestCreationTimestamp;
      newRequestCreationTimestamp = currentBlockTimestamp - defaultLimits.requestTimestampMargin / 2n;

      await withdrawalQueue.setRequestTimestamp(oldRequestId, oldRequestCreationTimestamp);
      await withdrawalQueue.setRequestTimestamp(newRequestId, newRequestCreationTimestamp);

      await checker.connect(admin).grantRole(await checker.REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE(), manager);
    });

    after(async () => {
      await checker.connect(admin).revokeRole(await checker.REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE(), manager);
    });

    it("reverts when the creation timestamp of requestIdToFinalizeUpTo is too close to report timestamp", async () => {
      await expect(
        checker.checkWithdrawalQueueOracleReport(newRequestId, correctWithdrawalQueueOracleReport.refReportTimestamp),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectRequestFinalization")
        .withArgs(newRequestCreationTimestamp);
    });

    it("passes all checks with correct withdrawal queue report data", async () => {
      await checker.checkWithdrawalQueueOracleReport(
        correctWithdrawalQueueOracleReport.lastFinalizableRequestId,
        correctWithdrawalQueueOracleReport.refReportTimestamp,
      );
    });
  });
});
