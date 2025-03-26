import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Accounting__MockForSanityChecker,
  Burner__MockForSanityChecker,
  LidoLocator__MockForSanityChecker,
  OracleReportSanityChecker,
  StakingRouter__MockForSanityChecker,
  WithdrawalQueue__MockForSanityChecker,
} from "typechain-types";

import { ether, getCurrentBlockTimestamp, impersonate, randomAddress } from "lib";

import { Snapshot } from "test/suite";

const MAX_UINT16 = 2 ** 16;
const MAX_UINT32 = 2 ** 32;
const MAX_UINT64 = 2 ** 64;
const TOTAL_BASIS_POINTS = 100_00n;

describe("OracleReportSanityChecker.sol:misc", () => {
  let checker: OracleReportSanityChecker;
  let locator: LidoLocator__MockForSanityChecker;
  let burner: Burner__MockForSanityChecker;
  let accounting: Accounting__MockForSanityChecker;
  let withdrawalQueueMock: WithdrawalQueue__MockForSanityChecker;
  let stakingRouter: StakingRouter__MockForSanityChecker;

  let locatorAddress: string;
  let withdrawalVaultAddress: string;

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
    [deployer, admin, elRewardsVault, stranger, manager] = await ethers.getSigners();

    withdrawalVaultAddress = randomAddress();
    await setBalance(withdrawalVaultAddress, ether("500"));

    withdrawalQueueMock = await ethers.deployContract("WithdrawalQueue__MockForSanityChecker");
    burner = await ethers.deployContract("Burner__MockForSanityChecker");
    accounting = await ethers.deployContract("Accounting__MockForSanityChecker", []);

    const accountingOracle = await ethers.deployContract("AccountingOracle__MockForSanityChecker", [
      deployer.address,
      12, // seconds per slot
      1606824023, // genesis time
    ]);

    stakingRouter = await ethers.deployContract("StakingRouter__MockForSanityChecker");

    const accountingOracleAddress = await accountingOracle.getAddress();
    const burnerAddress = await burner.getAddress();
    const stakingRouterAddress = await stakingRouter.getAddress();
    const withdrawalQueueAddress = await withdrawalQueueMock.getAddress();
    const accountingAddress = await accounting.getAddress();

    locator = await ethers.getContractFactory("LidoLocator__MockForSanityChecker").then((factory) =>
      factory.deploy({
        lido: deployer.address,
        depositSecurityModule: deployer.address,
        elRewardsVault: elRewardsVault.address,
        accountingOracle: accountingOracleAddress,
        legacyOracle: deployer.address,
        oracleReportSanityChecker: deployer.address,
        burner: burnerAddress,
        validatorsExitBusOracle: deployer.address,
        stakingRouter: stakingRouterAddress,
        treasury: deployer.address,
        withdrawalQueue: withdrawalQueueAddress,
        withdrawalVault: withdrawalVaultAddress,
        postTokenRebaseReceiver: deployer.address,
        oracleDaemonConfig: deployer.address,
        accounting: accountingAddress,
        vaultHub: deployer.address,
        wstETH: deployer.address,
        predepositGuarantee: deployer.address,
      }),
    );

    locatorAddress = await locator.getAddress();
    checker = await ethers
      .getContractFactory("OracleReportSanityChecker")
      .then((f) => f.deploy(locatorAddress, admin, defaultLimits));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("reverts if admin address is zero", async () => {
      await expect(
        ethers.deployContract("OracleReportSanityChecker", [locatorAddress, ZeroAddress, defaultLimits]),
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
      expect(await checker.getLidoLocator()).to.equal(locatorAddress);
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

    // TODO: check why this is not work, it should be reverted with `IncorrectLimitValue`
    it.skip("reverts if limit is greater than max", async () => {
      await expect(checker.connect(manager).setMaxPositiveTokenRebase(MAX_UINT64)).to.be.revertedWithCustomError(
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

  context("smoothenTokenRebase", () => {});

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
      const currentWithdrawalVaultBalance = await ethers.provider.getBalance(withdrawalVaultAddress);

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

    it("reverts when ammount of appeared validators is greater than possible", async () => {
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

      await withdrawalQueueMock.setRequestTimestamp(oldRequestId, oldRequestCreationTimestamp);
      await withdrawalQueueMock.setRequestTimestamp(newRequestId, newRequestCreationTimestamp);

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

  // context("checkSimulatedShareRate", () => {
  //   const correctSimulatedShareRate = {
  //     postTotalPooledEther: ether("9"),
  //     postTotalShares: ether("4"),
  //     etherLockedOnWithdrawalQueue: ether("1"),
  //     sharesBurntFromWithdrawalQueue: ether("1"),
  //     simulatedShareRate: 2n * 10n ** 27n,
  //   };
  //   type CheckSimulatedShareRateParameters = [bigint, bigint, bigint, bigint, bigint];

  //   it("reverts with error IncorrectSimulatedShareRate() when simulated share rate is higher than expected", async () => {
  //     const simulatedShareRate = ether("2.1") * 10n ** 9n;
  //     const actualShareRate = 2n * 10n ** 27n;
  //     await expect(
  //       oracleReportSanityChecker.checkSimulatedShareRate(
  //         ...(Object.values({
  //           ...correctSimulatedShareRate,
  //           simulatedShareRate: simulatedShareRate,
  //         }) as CheckSimulatedShareRateParameters),
  //       ),
  //     )
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectSimulatedShareRate")
  //       .withArgs(simulatedShareRate, actualShareRate);
  //   });

  //   it("reverts with error IncorrectSimulatedShareRate() when simulated share rate is lower than expected", async () => {
  //     const simulatedShareRate = ether("1.9") * 10n ** 9n;
  //     const actualShareRate = 2n * 10n ** 27n;
  //     await expect(
  //       oracleReportSanityChecker.checkSimulatedShareRate(
  //         ...(Object.values({
  //           ...correctSimulatedShareRate,
  //           simulatedShareRate: simulatedShareRate,
  //         }) as CheckSimulatedShareRateParameters),
  //       ),
  //     )
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectSimulatedShareRate")
  //       .withArgs(simulatedShareRate, actualShareRate);
  //   });

  //   it("reverts with error ActualShareRateIsZero() when actual share rate is zero", async () => {
  //     await expect(
  //       oracleReportSanityChecker.checkSimulatedShareRate(
  //         ...(Object.values({
  //           ...correctSimulatedShareRate,
  //           etherLockedOnWithdrawalQueue: ether("0"),
  //           postTotalPooledEther: ether("0"),
  //         }) as CheckSimulatedShareRateParameters),
  //       ),
  //     ).to.be.revertedWithCustomError(oracleReportSanityChecker, "ActualShareRateIsZero");
  //   });

  //   it("passes all checks with correct share rate", async () => {
  //     await oracleReportSanityChecker.checkSimulatedShareRate(
  //       ...(Object.values(correctSimulatedShareRate) as CheckSimulatedShareRateParameters),
  //     );
  //   });
  // });

  // context("max positive rebase", () => {
  //   const defaultSmoothenTokenRebaseParams = {
  //     preTotalPooledEther: ether("100"),
  //     preTotalShares: ether("100"),
  //     preCLBalance: ether("100"),
  //     postCLBalance: ether("100"),
  //     withdrawalVaultBalance: 0n,
  //     elRewardsVaultBalance: 0n,
  //     sharesRequestedToBurn: 0n,
  //     etherToLockForWithdrawals: 0n,
  //     newSharesToBurnForWithdrawals: 0n,
  //   };
  //   type SmoothenTokenRebaseParameters = [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

  //   it("getMaxPositiveTokenRebase works", async () => {
  //     expect(await oracleReportSanityChecker.getMaxPositiveTokenRebase()).to.equal(
  //       defaultLimitsList.maxPositiveTokenRebase,
  //     );
  //   });

  //   it("setMaxPositiveTokenRebase works", async () => {
  //     const newRebaseLimit = 1_000_000;
  //     expect(newRebaseLimit).to.not.equal(defaultLimitsList.maxPositiveTokenRebase);

  //     await expect(
  //       oracleReportSanityChecker.connect(deployer).setMaxPositiveTokenRebase(newRebaseLimit),
  //     ).to.be.revertedWithOZAccessControlError(
  //       deployer.address,
  //       await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
  //     );

  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(
  //         await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
  //         managersRoster.maxPositiveTokenRebaseManagers[0],
  //       );
  //     const tx = await oracleReportSanityChecker
  //       .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
  //       .setMaxPositiveTokenRebase(newRebaseLimit);

  //     expect(await oracleReportSanityChecker.getMaxPositiveTokenRebase()).to.equal(newRebaseLimit);
  //     await expect(tx).to.emit(oracleReportSanityChecker, "MaxPositiveTokenRebaseSet").withArgs(newRebaseLimit);
  //   });

  //   it("all zero data works", async () => {
  //     const { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           preTotalPooledEther: 0,
  //           preTotalShares: 0,
  //           preCLBalance: 0,
  //           postCLBalance: 0,
  //         }) as SmoothenTokenRebaseParameters),
  //       );

  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(0);
  //   });

  //   it("trivial smoothen rebase works when post CL < pre CL and no withdrawals", async () => {
  //     const newRebaseLimit = 100_000; // 0.01%
  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(
  //         await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
  //         managersRoster.maxPositiveTokenRebaseManagers[0],
  //       );
  //     await oracleReportSanityChecker
  //       .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
  //       .setMaxPositiveTokenRebase(newRebaseLimit);

  //     let { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("99"),
  //         }) as SmoothenTokenRebaseParameters),
  //       );

  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(0);

  //     // el rewards
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("99"),
  //           elRewardsVaultBalance: ether("0.1"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(ether("0.1"));
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(0);
  //     // withdrawals
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("99"),
  //           withdrawalVaultBalance: ether("0.1"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(ether("0.1"));
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(0);
  //     // // shares requested to burn
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("99"),
  //           sharesRequestedToBurn: ether("0.1"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(ether("0.1"));
  //     expect(sharesToBurn).to.equal(ether("0.1"));
  //   });

  //   it("trivial smoothen rebase works when post CL > pre CL and no withdrawals", async () => {
  //     const newRebaseLimit = 100_000_000; // 10%
  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(
  //         await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
  //         managersRoster.maxPositiveTokenRebaseManagers[0],
  //       );
  //     await oracleReportSanityChecker
  //       .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
  //       .setMaxPositiveTokenRebase(newRebaseLimit);

  //     let { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("100.01"),
  //         }) as SmoothenTokenRebaseParameters),
  //       );
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(0);

  //     // el rewards
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("100.01"),
  //           elRewardsVaultBalance: ether("0.1"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(ether("0.1"));
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(0);
  //     // withdrawals
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("100.01"),
  //           withdrawalVaultBalance: ether("0.1"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(ether("0.1"));
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(0);
  //     // shares requested to burn
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("100.01"),
  //           sharesRequestedToBurn: ether("0.1"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(ether("0.1"));
  //     expect(sharesToBurn).to.equal(ether("0.1"));
  //   });

  //   it("non-trivial smoothen rebase works when post CL < pre CL and no withdrawals", async () => {
  //     const newRebaseLimit = 10_000_000; // 1%
  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(
  //         await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
  //         managersRoster.maxPositiveTokenRebaseManagers[0],
  //       );
  //     await oracleReportSanityChecker
  //       .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
  //       .setMaxPositiveTokenRebase(newRebaseLimit);

  //     let { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("99"),
  //         }) as SmoothenTokenRebaseParameters),
  //       );
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(0);
  //     // el rewards
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("99"),
  //           elRewardsVaultBalance: ether("5"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(ether("2"));
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(0);
  //     // withdrawals
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("99"),
  //           withdrawalVaultBalance: ether("5"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(ether("2"));
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(0);
  //     // withdrawals + el rewards
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("99"),
  //           withdrawalVaultBalance: ether("5"),
  //           elRewardsVaultBalance: ether("5"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(ether("2"));
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(0);
  //     // shares requested to burn
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("99"),
  //           sharesRequestedToBurn: ether("5"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal("1980198019801980198"); // ether(100. - (99. / 1.01))
  //     expect(sharesToBurn).to.equal("1980198019801980198"); // the same as above since no withdrawals
  //   });

  //   it("non-trivial smoothen rebase works when post CL > pre CL and no withdrawals", async () => {
  //     const newRebaseLimit = 20_000_000; // 2%
  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(
  //         await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
  //         managersRoster.maxPositiveTokenRebaseManagers[0],
  //       );
  //     await oracleReportSanityChecker
  //       .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
  //       .setMaxPositiveTokenRebase(newRebaseLimit);

  //     let { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("101"),
  //         }) as SmoothenTokenRebaseParameters),
  //       );
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(0);
  //     // el rewards
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("101"),
  //           elRewardsVaultBalance: ether("5"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(ether("1"));
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(0);
  //     // withdrawals
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("101"),
  //           withdrawalVaultBalance: ether("5"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(ether("1"));
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(0);
  //     // withdrawals + el rewards
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("101"),
  //           elRewardsVaultBalance: ether("5"),
  //           withdrawalVaultBalance: ether("5"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(ether("1"));
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(0);
  //     // shares requested to burn
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultSmoothenTokenRebaseParams,
  //           postCLBalance: ether("101"),
  //           sharesRequestedToBurn: ether("5"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal("980392156862745098"); // ether(100. - (101. / 1.02))
  //     expect(sharesToBurn).to.equal("980392156862745098"); // the same as above since no withdrawals
  //   });

  //   it("non-trivial smoothen rebase works when post CL < pre CL and withdrawals", async () => {
  //     const newRebaseLimit = 5_000_000; // 0.5%
  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(
  //         await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
  //         managersRoster.maxPositiveTokenRebaseManagers[0],
  //       );
  //     await oracleReportSanityChecker
  //       .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
  //       .setMaxPositiveTokenRebase(newRebaseLimit);

  //     const defaultRebaseParams = {
  //       ...defaultSmoothenTokenRebaseParams,
  //       postCLBalance: ether("99"),
  //       etherToLockForWithdrawals: ether("10"),
  //       newSharesToBurnForWithdrawals: ether("10"),
  //     };

  //     let { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values(defaultRebaseParams) as SmoothenTokenRebaseParameters),
  //       );
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(ether("10"));
  //     // el rewards
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultRebaseParams,
  //           elRewardsVaultBalance: ether("5"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(ether("1.5"));
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal("9950248756218905472"); // 100. - 90.5 / 1.005
  //     // withdrawals
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultRebaseParams,
  //           withdrawalVaultBalance: ether("5"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(ether("1.5"));
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal("9950248756218905472"); // 100. - 90.5 / 1.005
  //     // withdrawals + el rewards
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultRebaseParams,
  //           withdrawalVaultBalance: ether("5"),
  //           elRewardsVaultBalance: ether("5"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(ether("1.5"));
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal("9950248756218905472"); // 100. - 90.5 / 1.005
  //     // shares requested to burn
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultRebaseParams,
  //           sharesRequestedToBurn: ether("5"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal("1492537313432835820"); // ether("100. - (99. / 1.005))
  //     expect(sharesToBurn).to.equal("11442786069651741293"); // ether("100. - (89. / 1.005))
  //   });

  //   it("non-trivial smoothen rebase works when post CL > pre CL and withdrawals", async () => {
  //     const newRebaseLimit = 40_000_000; // 4%
  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(
  //         await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
  //         managersRoster.maxPositiveTokenRebaseManagers[0],
  //       );
  //     await oracleReportSanityChecker
  //       .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
  //       .setMaxPositiveTokenRebase(newRebaseLimit);

  //     const defaultRebaseParams = {
  //       ...defaultSmoothenTokenRebaseParams,
  //       postCLBalance: ether("102"),
  //       etherToLockForWithdrawals: ether("10"),
  //       newSharesToBurnForWithdrawals: ether("10"),
  //     };

  //     let { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values(defaultRebaseParams) as SmoothenTokenRebaseParameters),
  //       );
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(ether("10"));
  //     // el rewards
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultRebaseParams,
  //           elRewardsVaultBalance: ether("5"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(ether("2"));
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal("9615384615384615384"); // 100. - 94. / 1.04
  //     // withdrawals
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultRebaseParams,
  //           withdrawalVaultBalance: ether("5"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(ether("2"));
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal("9615384615384615384"); // 100. - 94. / 1.04
  //     // withdrawals + el rewards
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultRebaseParams,
  //           withdrawalVaultBalance: ether("5"),
  //           elRewardsVaultBalance: ether("5"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(ether("2"));
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal("9615384615384615384"); // 100. - 94. / 1.04
  //     // shares requested to burn
  //     ({ withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values({
  //           ...defaultRebaseParams,
  //           sharesRequestedToBurn: ether("5"),
  //         }) as SmoothenTokenRebaseParameters),
  //       ));
  //     expect(withdrawals).to.equal(0);
  //     expect(elRewards).to.equal(0);
  //     expect(simulatedSharesToBurn).to.equal("1923076923076923076"); // ether("100. - (102. / 1.04))
  //     expect(sharesToBurn).to.equal("11538461538461538461"); // ether("100. - (92. / 1.04))
  //   });

  //   it("share rate ~1 case with huge withdrawal", async () => {
  //     const newRebaseLimit = 1_000_000; // 0.1%
  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(
  //         await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
  //         managersRoster.maxPositiveTokenRebaseManagers[0],
  //       );
  //     await oracleReportSanityChecker
  //       .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
  //       .setMaxPositiveTokenRebase(newRebaseLimit);

  //     const rebaseParams = {
  //       preTotalPooledEther: ether("1000000"),
  //       preTotalShares: ether("1000000"),
  //       preCLBalance: ether("1000000"),
  //       postCLBalance: ether("1000000"),
  //       withdrawalVaultBalance: ether("500"),
  //       elRewardsVaultBalance: ether("500"),
  //       sharesRequestedToBurn: ether("0"),
  //       etherToLockForWithdrawals: ether("40000"),
  //       newSharesToBurnForWithdrawals: ether("40000"),
  //     };

  //     const { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values(rebaseParams) as SmoothenTokenRebaseParameters),
  //       );

  //     expect(withdrawals).to.equal(ether("500"));
  //     expect(elRewards).to.equal(ether("500"));
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal("39960039960039960039960"); // ether(1000000 - 961000. / 1.001)
  //   });

  //   it("rounding case from Görli", async () => {
  //     const newRebaseLimit = 750_000; // 0.075% or 7.5 basis points
  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(
  //         await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
  //         managersRoster.maxPositiveTokenRebaseManagers[0],
  //       );
  //     await oracleReportSanityChecker
  //       .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
  //       .setMaxPositiveTokenRebase(newRebaseLimit);

  //     const rebaseParams = {
  //       preTotalPooledEther: 125262263468962792235936n,
  //       preTotalShares: 120111767594397261197918n,
  //       preCLBalance: 113136253352529000000000n,
  //       postCLBalance: 113134996436274000000000n,
  //       withdrawalVaultBalance: 129959459000000000n,
  //       elRewardsVaultBalance: 6644376444653811679390n,
  //       sharesRequestedToBurn: 15713136097768852533n,
  //       etherToLockForWithdrawals: 0n,
  //       newSharesToBurnForWithdrawals: 0n,
  //     };

  //     const { withdrawals, elRewards, simulatedSharesToBurn, sharesToBurn } =
  //       await oracleReportSanityChecker.smoothenTokenRebase(
  //         ...(Object.values(rebaseParams) as SmoothenTokenRebaseParameters),
  //       );

  //     expect(withdrawals).to.equal(129959459000000000n);
  //     expect(elRewards).to.equal(95073654397722094176n);
  //     expect(simulatedSharesToBurn).to.equal(0);
  //     expect(sharesToBurn).to.equal(0);
  //   });
  // });

  // context("validators limits", () => {
  //   it("setExitedValidatorsPerDayLimit works", async () => {
  //     const oldExitedLimit = defaultLimitsList.exitedValidatorsPerDayLimit;

  //     await oracleReportSanityChecker.checkExitedValidatorsRatePerDay(oldExitedLimit);
  //     await expect(oracleReportSanityChecker.checkExitedValidatorsRatePerDay(oldExitedLimit + 1n))
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "ExitedValidatorsLimitExceeded")
  //       .withArgs(oldExitedLimit, oldExitedLimit + 1n);

  //     expect((await oracleReportSanityChecker.getOracleReportLimits()).exitedValidatorsPerDayLimit).to.be.equal(
  //       oldExitedLimit,
  //     );

  //     const newExitedLimit = 30n;
  //     expect(newExitedLimit).to.not.equal(oldExitedLimit);

  //     await expect(
  //       oracleReportSanityChecker.connect(deployer).setExitedValidatorsPerDayLimit(newExitedLimit),
  //     ).to.be.revertedWithOZAccessControlError(
  //       deployer.address,
  //       await oracleReportSanityChecker.EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE(),
  //     );

  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(
  //         await oracleReportSanityChecker.EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE(),
  //         managersRoster.exitedValidatorsPerDayLimitManagers[0],
  //       );
  //     const tx = await oracleReportSanityChecker
  //       .connect(managersRoster.exitedValidatorsPerDayLimitManagers[0])
  //       .setExitedValidatorsPerDayLimit(newExitedLimit);

  //     await expect(tx).to.emit(oracleReportSanityChecker, "ExitedValidatorsPerDayLimitSet").withArgs(newExitedLimit);

  //     expect((await oracleReportSanityChecker.getOracleReportLimits()).exitedValidatorsPerDayLimit).to.equal(
  //       newExitedLimit,
  //     );

  //     await oracleReportSanityChecker.checkExitedValidatorsRatePerDay(newExitedLimit);
  //     await expect(oracleReportSanityChecker.checkExitedValidatorsRatePerDay(newExitedLimit + 1n))
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "ExitedValidatorsLimitExceeded")
  //       .withArgs(newExitedLimit, newExitedLimit + 1n);
  //   });

  //   it("setAppearedValidatorsPerDayLimit works", async () => {
  //     const oldAppearedLimit = defaultLimitsList.appearedValidatorsPerDayLimit;

  //     await oracleReportSanityChecker.checkAccountingOracleReport(
  //       ...(Object.values({
  //         ...correctLidoOracleReport,
  //         postCLValidators: oldAppearedLimit,
  //       }) as CheckAccountingOracleReportParameters),
  //     );

  //     await expect(
  //       oracleReportSanityChecker.checkAccountingOracleReport(
  //         ...(Object.values({
  //           ...correctLidoOracleReport,
  //           postCLValidators: oldAppearedLimit + 1n,
  //         }) as CheckAccountingOracleReportParameters),
  //       ),
  //     )
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, `IncorrectAppearedValidators`)
  //       .withArgs(oldAppearedLimit + 1n);

  //     const newAppearedLimit = 30n;
  //     expect(newAppearedLimit).not.equal(oldAppearedLimit);

  //     await expect(
  //       oracleReportSanityChecker.connect(deployer).setAppearedValidatorsPerDayLimit(newAppearedLimit),
  //     ).to.be.revertedWithOZAccessControlError(
  //       deployer.address,
  //       await oracleReportSanityChecker.APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE(),
  //     );

  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(
  //         await oracleReportSanityChecker.APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE(),
  //         managersRoster.appearedValidatorsPerDayLimitManagers[0],
  //       );

  //     const tx = await oracleReportSanityChecker
  //       .connect(managersRoster.appearedValidatorsPerDayLimitManagers[0])
  //       .setAppearedValidatorsPerDayLimit(newAppearedLimit);

  //     await expect(tx)
  //       .to.emit(oracleReportSanityChecker, "AppearedValidatorsPerDayLimitSet")
  //       .withArgs(newAppearedLimit);

  //     expect((await oracleReportSanityChecker.getOracleReportLimits()).appearedValidatorsPerDayLimit).to.be.equal(
  //       newAppearedLimit,
  //     );

  //     await oracleReportSanityChecker.checkAccountingOracleReport(
  //       ...(Object.values({
  //         ...correctLidoOracleReport,
  //         postCLValidators: newAppearedLimit,
  //       }) as CheckAccountingOracleReportParameters),
  //     );
  //     await expect(
  //       oracleReportSanityChecker.checkAccountingOracleReport(
  //         ...(Object.values({
  //           ...correctLidoOracleReport,
  //           postCLValidators: newAppearedLimit + 1n,
  //         }) as CheckAccountingOracleReportParameters),
  //       ),
  //     )
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectAppearedValidators")
  //       .withArgs(newAppearedLimit + 1n);
  //   });
  // });

  // context("checkExitBusOracleReport", () => {
  //   beforeEach(async () => {
  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(await oracleReportSanityChecker.ALL_LIMITS_MANAGER_ROLE(), managersRoster.allLimitsManagers[0]);
  //     await oracleReportSanityChecker
  //       .connect(managersRoster.allLimitsManagers[0])
  //       .setOracleReportLimits(defaultLimitsList, ZeroAddress);
  //   });

  //   it("checkExitBusOracleReport works", async () => {
  //     const maxRequests = defaultLimitsList.maxValidatorExitRequestsPerReport;

  //     expect((await oracleReportSanityChecker.getOracleReportLimits()).maxValidatorExitRequestsPerReport).to.equal(
  //       maxRequests,
  //     );

  //     await oracleReportSanityChecker.checkExitBusOracleReport(maxRequests);
  //     await expect(oracleReportSanityChecker.checkExitBusOracleReport(maxRequests + 1n))
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectNumberOfExitRequestsPerReport")
  //       .withArgs(maxRequests);
  //   });

  //   it("setMaxExitRequestsPerOracleReport", async () => {
  //     const oldMaxRequests = defaultLimitsList.maxValidatorExitRequestsPerReport;
  //     await oracleReportSanityChecker.checkExitBusOracleReport(oldMaxRequests);
  //     await expect(oracleReportSanityChecker.checkExitBusOracleReport(oldMaxRequests + 1n))
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectNumberOfExitRequestsPerReport")
  //       .withArgs(oldMaxRequests);
  //     expect((await oracleReportSanityChecker.getOracleReportLimits()).maxValidatorExitRequestsPerReport).to.equal(
  //       oldMaxRequests,
  //     );

  //     const newMaxRequests = 306;
  //     expect(newMaxRequests).to.not.equal(oldMaxRequests);

  //     await expect(
  //       oracleReportSanityChecker.connect(deployer).setMaxExitRequestsPerOracleReport(newMaxRequests),
  //     ).to.be.revertedWithOZAccessControlError(
  //       deployer.address,
  //       await oracleReportSanityChecker.MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE(),
  //     );

  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(
  //         await oracleReportSanityChecker.MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE(),
  //         managersRoster.maxValidatorExitRequestsPerReportManagers[0],
  //       );
  //     const tx = await oracleReportSanityChecker
  //       .connect(managersRoster.maxValidatorExitRequestsPerReportManagers[0])
  //       .setMaxExitRequestsPerOracleReport(newMaxRequests);

  //     await expect(tx)
  //       .to.emit(oracleReportSanityChecker, "MaxValidatorExitRequestsPerReportSet")
  //       .withArgs(newMaxRequests);
  //     expect((await oracleReportSanityChecker.getOracleReportLimits()).maxValidatorExitRequestsPerReport).to.equal(
  //       newMaxRequests,
  //     );

  //     await oracleReportSanityChecker.checkExitBusOracleReport(newMaxRequests);
  //     await expect(oracleReportSanityChecker.checkExitBusOracleReport(newMaxRequests + 1))
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectNumberOfExitRequestsPerReport")
  //       .withArgs(newMaxRequests);
  //   });
  // });

  // context("extra data reporting", () => {
  //   beforeEach(async () => {
  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(await oracleReportSanityChecker.ALL_LIMITS_MANAGER_ROLE(), managersRoster.allLimitsManagers[0]);
  //     await oracleReportSanityChecker
  //       .connect(managersRoster.allLimitsManagers[0])
  //       .setOracleReportLimits(defaultLimitsList, ZeroAddress);
  //   });

  //   it("set maxNodeOperatorsPerExtraDataItem", async () => {
  //     const previousValue = (await oracleReportSanityChecker.getOracleReportLimits()).maxNodeOperatorsPerExtraDataItem;
  //     const newValue = 33;
  //     expect(newValue).to.not.equal(previousValue);
  //     await expect(
  //       oracleReportSanityChecker.connect(deployer).setMaxNodeOperatorsPerExtraDataItem(newValue),
  //     ).to.be.revertedWithOZAccessControlError(
  //       deployer.address,
  //       await oracleReportSanityChecker.MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE(),
  //     );
  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(
  //         await oracleReportSanityChecker.MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE(),
  //         managersRoster.maxNodeOperatorsPerExtraDataItemManagers[0],
  //       );
  //     const tx = await oracleReportSanityChecker
  //       .connect(managersRoster.maxNodeOperatorsPerExtraDataItemManagers[0])
  //       .setMaxNodeOperatorsPerExtraDataItem(newValue);
  //     expect((await oracleReportSanityChecker.getOracleReportLimits()).maxNodeOperatorsPerExtraDataItem).to.be.equal(
  //       newValue,
  //     );
  //     await expect(tx).to.emit(oracleReportSanityChecker, "MaxNodeOperatorsPerExtraDataItemSet").withArgs(newValue);
  //   });

  //   it("set maxItemsPerExtraDataTransaction", async () => {
  //     const previousValue = (await oracleReportSanityChecker.getOracleReportLimits()).maxItemsPerExtraDataTransaction;
  //     const newValue = 31;
  //     expect(newValue).to.not.equal(previousValue);
  //     await expect(
  //       oracleReportSanityChecker.connect(deployer).setMaxItemsPerExtraDataTransaction(newValue),
  //     ).to.be.revertedWithOZAccessControlError(
  //       deployer.address,
  //       await oracleReportSanityChecker.MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE(),
  //     );
  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(
  //         await oracleReportSanityChecker.MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE(),
  //         managersRoster.maxItemsPerExtraDataTransactionManagers[0],
  //       );
  //     const tx = await oracleReportSanityChecker
  //       .connect(managersRoster.maxItemsPerExtraDataTransactionManagers[0])
  //       .setMaxItemsPerExtraDataTransaction(newValue);
  //     expect((await oracleReportSanityChecker.getOracleReportLimits()).maxItemsPerExtraDataTransaction).to.be.equal(
  //       newValue,
  //     );
  //     await expect(tx).to.emit(oracleReportSanityChecker, "MaxItemsPerExtraDataTransactionSet").withArgs(newValue);
  //   });
  // });

  // context("check limit boundaries", () => {
  //   it("values must be less or equal to MAX_BASIS_POINTS", async () => {
  //     const MAX_BASIS_POINTS = 10000;
  //     const INVALID_BASIS_POINTS = MAX_BASIS_POINTS + 1;

  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(await oracleReportSanityChecker.ALL_LIMITS_MANAGER_ROLE(), managersRoster.allLimitsManagers[0]);

  //     await expect(
  //       oracleReportSanityChecker
  //         .connect(managersRoster.allLimitsManagers[0])
  //         .setOracleReportLimits(
  //           { ...defaultLimitsList, annualBalanceIncreaseBPLimit: INVALID_BASIS_POINTS },
  //           ZeroAddress,
  //         ),
  //     )
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
  //       .withArgs(INVALID_BASIS_POINTS, 0, MAX_BASIS_POINTS);

  //     await expect(
  //       oracleReportSanityChecker
  //         .connect(managersRoster.allLimitsManagers[0])
  //         .setOracleReportLimits({ ...defaultLimitsList, simulatedShareRateDeviationBPLimit: 10001 }, ZeroAddress),
  //     )
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
  //       .withArgs(INVALID_BASIS_POINTS, 0, MAX_BASIS_POINTS);
  //   });

  //   it("values must be less or equal to type(uint16).max", async () => {
  //     const MAX_UINT_16 = 65535;
  //     const INVALID_VALUE = MAX_UINT_16 + 1;

  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(await oracleReportSanityChecker.ALL_LIMITS_MANAGER_ROLE(), managersRoster.allLimitsManagers[0]);

  //     await expect(
  //       oracleReportSanityChecker
  //         .connect(managersRoster.allLimitsManagers[0])
  //         .setOracleReportLimits(
  //           { ...defaultLimitsList, maxValidatorExitRequestsPerReport: INVALID_VALUE },
  //           ZeroAddress,
  //         ),
  //     )
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
  //       .withArgs(INVALID_VALUE, 0, MAX_UINT_16);

  //     await expect(
  //       oracleReportSanityChecker
  //         .connect(managersRoster.allLimitsManagers[0])
  //         .setOracleReportLimits({ ...defaultLimitsList, exitedValidatorsPerDayLimit: INVALID_VALUE }, ZeroAddress),
  //     )
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
  //       .withArgs(INVALID_VALUE, 0, MAX_UINT_16);

  //     await expect(
  //       oracleReportSanityChecker
  //         .connect(managersRoster.allLimitsManagers[0])
  //         .setOracleReportLimits({ ...defaultLimitsList, appearedValidatorsPerDayLimit: INVALID_VALUE }, ZeroAddress),
  //     )
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
  //       .withArgs(INVALID_VALUE, 0, MAX_UINT_16);

  //     await expect(
  //       oracleReportSanityChecker
  //         .connect(managersRoster.allLimitsManagers[0])
  //         .setOracleReportLimits(
  //           { ...defaultLimitsList, maxNodeOperatorsPerExtraDataItem: INVALID_VALUE },
  //           ZeroAddress,
  //         ),
  //     )
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
  //       .withArgs(INVALID_VALUE, 0, MAX_UINT_16);

  //     await expect(
  //       oracleReportSanityChecker
  //         .connect(managersRoster.allLimitsManagers[0])
  //         .setOracleReportLimits({ ...defaultLimitsList, initialSlashingAmountPWei: INVALID_VALUE }, ZeroAddress),
  //     )
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
  //       .withArgs(INVALID_VALUE, 0, MAX_UINT_16);

  //     await expect(
  //       oracleReportSanityChecker
  //         .connect(managersRoster.allLimitsManagers[0])
  //         .setOracleReportLimits({ ...defaultLimitsList, inactivityPenaltiesAmountPWei: INVALID_VALUE }, ZeroAddress),
  //     )
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
  //       .withArgs(INVALID_VALUE, 0, MAX_UINT_16);
  //   });

  //   it("values must be less or equals to type(uint64).max", async () => {
  //     const MAX_UINT_64 = 2n ** 64n - 1n;
  //     const MAX_UINT_32 = 2n ** 32n - 1n;
  //     const INVALID_VALUE_UINT_64 = MAX_UINT_64 + 1n;
  //     const INVALID_VALUE_UINT_32 = MAX_UINT_32 + 1n;

  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(await oracleReportSanityChecker.ALL_LIMITS_MANAGER_ROLE(), managersRoster.allLimitsManagers[0]);
  //     await expect(
  //       oracleReportSanityChecker
  //         .connect(managersRoster.allLimitsManagers[0])
  //         .setOracleReportLimits({ ...defaultLimitsList, requestTimestampMargin: INVALID_VALUE_UINT_32 }, ZeroAddress),
  //     )
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
  //       .withArgs(INVALID_VALUE_UINT_32.toString(), 0, MAX_UINT_32);

  //     await expect(
  //       oracleReportSanityChecker
  //         .connect(managersRoster.allLimitsManagers[0])
  //         .setOracleReportLimits({ ...defaultLimitsList, maxPositiveTokenRebase: INVALID_VALUE_UINT_64 }, ZeroAddress),
  //     )
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
  //       .withArgs(INVALID_VALUE_UINT_64.toString(), 1, MAX_UINT_64);
  //   });

  //   it("value must be greater than zero", async () => {
  //     const MAX_UINT_64 = 2n ** 64n - 1n;
  //     const INVALID_VALUE = 0;

  //     await oracleReportSanityChecker
  //       .connect(admin)
  //       .grantRole(
  //         await oracleReportSanityChecker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
  //         managersRoster.maxPositiveTokenRebaseManagers[0],
  //       );
  //     await expect(
  //       oracleReportSanityChecker
  //         .connect(managersRoster.maxPositiveTokenRebaseManagers[0])
  //         .setMaxPositiveTokenRebase(0),
  //     )
  //       .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectLimitValue")
  //       .withArgs(INVALID_VALUE, 1n, MAX_UINT_64);
  //   });
  // });
});
