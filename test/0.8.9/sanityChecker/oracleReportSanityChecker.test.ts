import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { artifacts, ethers } from "hardhat";

import { loadFixture, setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { ether } from "lib";

const ONE_DAY = 24n * 60n * 60n;
const TOTAL_BASIS_POINTS = 10_000n;
const OVER_UINT16 = 1n << 16n;
const OVER_UINT32 = 1n << 32n;

const limits = {
  exitedEthAmountPerDayLimit: 55n,
  appearedEthAmountPerDayLimit: 100n,
  annualCLRebaseIncreaseSoftBPLimit: 1_000n,
  simulatedShareRateDeviationBPLimit: 250n,
  maxBalanceExitRequestedPerReportInEth: 65_000n,
  maxEffectiveBalanceWeightWCType01: 32n,
  maxEffectiveBalanceWeightWCType02: 2_048n,
  maxItemsPerExtraDataTransaction: 15n,
  maxNodeOperatorsPerExtraDataItem: 16n,
  requestTimestampMargin: 128n,
  annualCLRebaseIncreaseHardBPLimit: 1_750n,
  clRebaseDecreaseSoftBPLimit: 100n,
  clRebaseDecreaseHardBPLimit: 500n,
  consolidationEthAmountPerDayLimit: 10n,
  exitedValidatorEthAmountLimit: 32n,
  externalPendingBalanceCapEth: 5n,
};

type Limits = typeof limits;

const expectLimits = (actual: unknown, expected: Limits) => {
  const namedResult = actual as Record<keyof Limits, bigint>;
  for (const [name, value] of Object.entries(expected)) {
    expect(namedResult[name as keyof Limits], name).to.equal(value);
  }
};

describe("OracleReportSanityChecker", () => {
  async function deployFixture() {
    const [deployer, admin, accounting, manager, stranger, withdrawalVault, elRewardsVault] = await ethers.getSigners();

    await setBalance(withdrawalVault.address, ether("500"));
    await setBalance(elRewardsVault.address, ether("400"));

    const burner = await ethers.deployContract("Burner__MockForSanityChecker");
    const withdrawalQueue = await ethers.deployContract("WithdrawalQueue__MockForSanityChecker");
    const stakingRouter = await ethers.deployContract("StakingRouter__MockForSanityChecker");
    const accountingOracle = await ethers.deployContract("AccountingOracle__MockForSanityChecker", [
      deployer.address,
      12n,
      1_606_824_023n,
    ]);
    const locator = await ethers.deployContract("LidoLocator__MockForSanityChecker", [
      {
        lido: deployer.address,
        depositSecurityModule: deployer.address,
        elRewardsVault: elRewardsVault.address,
        accountingOracle: await accountingOracle.getAddress(),
        oracleReportSanityChecker: deployer.address,
        burner: await burner.getAddress(),
        validatorsExitBusOracle: deployer.address,
        stakingRouter: await stakingRouter.getAddress(),
        treasury: deployer.address,
        withdrawalQueue: await withdrawalQueue.getAddress(),
        withdrawalVault: withdrawalVault.address,
        postTokenRebaseReceiver: deployer.address,
        oracleDaemonConfig: deployer.address,
        validatorExitDelayVerifier: deployer.address,
        triggerableWithdrawalsGateway: deployer.address,
        consolidationGateway: deployer.address,
        accounting: accounting.address,
        predepositGuarantee: deployer.address,
        wstETH: deployer.address,
        vaultHub: deployer.address,
        vaultFactory: deployer.address,
        lazyOracle: deployer.address,
        operatorGrid: deployer.address,
        topUpGateway: deployer.address,
      },
    ]);
    const checker = await ethers.deployContract("OracleReportSanityCheckerWrapper", [
      await locator.getAddress(),
      accounting.address,
      admin.address,
      limits,
      false,
    ]);

    return {
      admin,
      accounting,
      manager,
      stranger,
      withdrawalVault,
      elRewardsVault,
      burner,
      withdrawalQueue,
      locator,
      checker,
    };
  }

  describe("construction and limits", () => {
    it("sets the locator, admin, and the complete initial limits list", async () => {
      const { admin, locator, checker } = await loadFixture(deployFixture);

      expect(await checker.getLidoLocator()).to.equal(await locator.getAddress());
      expect(await checker.hasRole(await checker.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expectLimits(await checker.getOracleReportLimits(), limits);
      expect(await checker.getMaxEffectiveBalanceWeightWCType01()).to.equal(limits.maxEffectiveBalanceWeightWCType01);
      expect(await checker.getMaxEffectiveBalanceWeightWCType02()).to.equal(limits.maxEffectiveBalanceWeightWCType02);
    });

    it("sets the initial second-opinion provider", async () => {
      const { accounting, admin, locator, manager } = await loadFixture(deployFixture);
      const checker = await ethers.deployContract("OracleReportSanityChecker", [
        await locator.getAddress(),
        accounting.address,
        admin.address,
        limits,
        manager.address,
      ]);

      expect(await checker.secondOpinionOracle()).to.equal(manager.address);
    });

    it("rejects a zero admin and malformed soft/hard pairs", async () => {
      const { accounting, locator, checker } = await loadFixture(deployFixture);

      await expect(
        ethers.deployContract("OracleReportSanityChecker", [
          await locator.getAddress(),
          accounting.address,
          ZeroAddress,
          limits,
          ZeroAddress,
        ]),
      ).to.be.revertedWithCustomError(checker, "AdminCannotBeZero");

      const malformedLimits = {
        ...limits,
        annualCLRebaseIncreaseSoftBPLimit: 1_001n,
        annualCLRebaseIncreaseHardBPLimit: 1_000n,
      };
      await expect(
        ethers.deployContract("OracleReportSanityChecker", [
          await locator.getAddress(),
          accounting.address,
          accounting.address,
          malformedLimits,
          ZeroAddress,
        ]),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(1_001n, 0n, 1_000n);
    });

    it("setExitedEthAmountPerDayLimit: enforces ACL and uint32 bounds, updates and emits", async () => {
      const { admin, manager, stranger, checker } = await loadFixture(deployFixture);
      const role = await checker.EXITED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE();

      await expect(checker.connect(stranger).setExitedEthAmountPerDayLimit(60n)).to.be.revertedWithOZAccessControlError(
        stranger.address,
        role,
      );

      await checker.connect(admin).grantRole(role, manager.address);
      await expect(checker.connect(manager).setExitedEthAmountPerDayLimit(OVER_UINT32))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(OVER_UINT32, 0n, OVER_UINT32 - 1n);
      await expect(checker.connect(manager).setExitedEthAmountPerDayLimit(0n))
        .to.emit(checker, "ExitedEthAmountPerDayLimitSet")
        .withArgs(0n);
      await expect(checker.connect(manager).setExitedEthAmountPerDayLimit(OVER_UINT32 - 1n))
        .to.emit(checker, "ExitedEthAmountPerDayLimitSet")
        .withArgs(OVER_UINT32 - 1n);

      expect((await checker.getOracleReportLimits()).exitedEthAmountPerDayLimit).to.equal(OVER_UINT32 - 1n);
    });

    it("setAppearedEthAmountPerDayLimit: enforces ACL and uint32 bounds, updates and emits", async () => {
      const { admin, manager, stranger, checker } = await loadFixture(deployFixture);
      const role = await checker.APPEARED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE();

      await expect(
        checker.connect(stranger).setAppearedEthAmountPerDayLimit(120n),
      ).to.be.revertedWithOZAccessControlError(stranger.address, role);

      await checker.connect(admin).grantRole(role, manager.address);
      await expect(checker.connect(manager).setAppearedEthAmountPerDayLimit(OVER_UINT32))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(OVER_UINT32, 0n, OVER_UINT32 - 1n);
      await expect(checker.connect(manager).setAppearedEthAmountPerDayLimit(0n))
        .to.emit(checker, "AppearedEthAmountPerDayLimitSet")
        .withArgs(0n);
      await expect(checker.connect(manager).setAppearedEthAmountPerDayLimit(OVER_UINT32 - 1n))
        .to.emit(checker, "AppearedEthAmountPerDayLimitSet")
        .withArgs(OVER_UINT32 - 1n);

      expect((await checker.getOracleReportLimits()).appearedEthAmountPerDayLimit).to.equal(OVER_UINT32 - 1n);
    });

    it("setConsolidationEthAmountPerDayLimit: enforces ACL and uint32 bounds, updates and emits", async () => {
      const { admin, manager, stranger, checker } = await loadFixture(deployFixture);
      const role = await checker.CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE();

      await expect(
        checker.connect(stranger).setConsolidationEthAmountPerDayLimit(11n),
      ).to.be.revertedWithOZAccessControlError(stranger.address, role);

      await checker.connect(admin).grantRole(role, manager.address);
      await expect(checker.connect(manager).setConsolidationEthAmountPerDayLimit(OVER_UINT32))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(OVER_UINT32, 0n, OVER_UINT32 - 1n);
      await expect(checker.connect(manager).setConsolidationEthAmountPerDayLimit(0n))
        .to.emit(checker, "ConsolidationEthAmountPerDayLimitSet")
        .withArgs(0n);
      await expect(checker.connect(manager).setConsolidationEthAmountPerDayLimit(OVER_UINT32 - 1n))
        .to.emit(checker, "ConsolidationEthAmountPerDayLimitSet")
        .withArgs(OVER_UINT32 - 1n);

      expect((await checker.getOracleReportLimits()).consolidationEthAmountPerDayLimit).to.equal(OVER_UINT32 - 1n);
    });

    it("setExitedValidatorEthAmountLimit: enforces ACL and uint16 bounds, updates and emits", async () => {
      const { admin, manager, stranger, checker } = await loadFixture(deployFixture);
      const role = await checker.EXITED_VALIDATOR_ETH_AMOUNT_LIMIT_MANAGER_ROLE();

      await expect(
        checker.connect(stranger).setExitedValidatorEthAmountLimit(2n),
      ).to.be.revertedWithOZAccessControlError(stranger.address, role);

      await checker.connect(admin).grantRole(role, manager.address);
      await expect(checker.connect(manager).setExitedValidatorEthAmountLimit(0n))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(0n, 1n, OVER_UINT16 - 1n);
      await expect(checker.connect(manager).setExitedValidatorEthAmountLimit(OVER_UINT16))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(OVER_UINT16, 1n, OVER_UINT16 - 1n);
      await expect(checker.connect(manager).setExitedValidatorEthAmountLimit(1n))
        .to.emit(checker, "ExitedValidatorEthAmountLimitSet")
        .withArgs(1n);
      await expect(checker.connect(manager).setExitedValidatorEthAmountLimit(OVER_UINT16 - 1n))
        .to.emit(checker, "ExitedValidatorEthAmountLimitSet")
        .withArgs(OVER_UINT16 - 1n);

      expect((await checker.getOracleReportLimits()).exitedValidatorEthAmountLimit).to.equal(OVER_UINT16 - 1n);
    });

    it("setExternalPendingBalanceCapEth: enforces ACL and uint16 bounds, updates and emits", async () => {
      const { admin, manager, stranger, checker } = await loadFixture(deployFixture);
      const role = await checker.EXTERNAL_PENDING_BALANCE_CAP_MANAGER_ROLE();

      await expect(
        checker.connect(stranger).setExternalPendingBalanceCapEth(6n),
      ).to.be.revertedWithOZAccessControlError(stranger.address, role);

      await checker.connect(admin).grantRole(role, manager.address);
      await expect(checker.connect(manager).setExternalPendingBalanceCapEth(OVER_UINT16))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(OVER_UINT16, 0n, OVER_UINT16 - 1n);
      await expect(checker.connect(manager).setExternalPendingBalanceCapEth(0n))
        .to.emit(checker, "ExternalPendingBalanceCapEthSet")
        .withArgs(0n);
      await expect(checker.connect(manager).setExternalPendingBalanceCapEth(OVER_UINT16 - 1n))
        .to.emit(checker, "ExternalPendingBalanceCapEthSet")
        .withArgs(OVER_UINT16 - 1n);

      expect((await checker.getOracleReportLimits()).externalPendingBalanceCapEth).to.equal(OVER_UINT16 - 1n);
    });

    it("updates the annual increase soft/hard pair atomically", async () => {
      const { admin, manager, stranger, checker } = await loadFixture(deployFixture);
      const role = await checker.ANNUAL_CL_REBASE_INCREASE_LIMITS_MANAGER_ROLE();
      await checker.connect(admin).grantRole(role, manager.address);

      await expect(
        checker.connect(stranger).setAnnualCLRebaseIncreaseBPLimits(500n, 1_200n),
      ).to.be.revertedWithOZAccessControlError(stranger.address, role);
      await expect(checker.connect(manager).setAnnualCLRebaseIncreaseBPLimits(1_201n, 1_200n))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(1_201n, 0n, 1_200n);
      await expect(checker.connect(manager).setAnnualCLRebaseIncreaseBPLimits(0n, TOTAL_BASIS_POINTS + 1n))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(TOTAL_BASIS_POINTS + 1n, 0n, TOTAL_BASIS_POINTS);
      await expect(checker.connect(manager).setAnnualCLRebaseIncreaseBPLimits(0n, 0n))
        .to.emit(checker, "AnnualCLRebaseIncreaseBPLimitsSet")
        .withArgs(0n, 0n);
      await expect(checker.connect(manager).setAnnualCLRebaseIncreaseBPLimits(TOTAL_BASIS_POINTS, TOTAL_BASIS_POINTS))
        .to.emit(checker, "AnnualCLRebaseIncreaseBPLimitsSet")
        .withArgs(TOTAL_BASIS_POINTS, TOTAL_BASIS_POINTS);

      const updated = await checker.getOracleReportLimits();
      expect(updated.annualCLRebaseIncreaseSoftBPLimit).to.equal(TOTAL_BASIS_POINTS);
      expect(updated.annualCLRebaseIncreaseHardBPLimit).to.equal(TOTAL_BASIS_POINTS);
    });

    it("setSimulatedShareRateDeviationBPLimit: enforces ACL and BP bounds, updates and emits", async () => {
      const { admin, manager, stranger, checker } = await loadFixture(deployFixture);
      const role = await checker.SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE();

      await expect(
        checker.connect(stranger).setSimulatedShareRateDeviationBPLimit(300n),
      ).to.be.revertedWithOZAccessControlError(stranger.address, role);

      await checker.connect(admin).grantRole(role, manager.address);
      await expect(checker.connect(manager).setSimulatedShareRateDeviationBPLimit(TOTAL_BASIS_POINTS + 1n))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(TOTAL_BASIS_POINTS + 1n, 0n, TOTAL_BASIS_POINTS);
      await expect(checker.connect(manager).setSimulatedShareRateDeviationBPLimit(0n))
        .to.emit(checker, "SimulatedShareRateDeviationBPLimitSet")
        .withArgs(0n);
      await expect(checker.connect(manager).setSimulatedShareRateDeviationBPLimit(TOTAL_BASIS_POINTS))
        .to.emit(checker, "SimulatedShareRateDeviationBPLimitSet")
        .withArgs(TOTAL_BASIS_POINTS);

      expect((await checker.getOracleReportLimits()).simulatedShareRateDeviationBPLimit).to.equal(TOTAL_BASIS_POINTS);
    });

    it("setMaxBalanceExitRequestedPerReportInEth: enforces ACL and uint16 bounds, updates and emits", async () => {
      const { admin, manager, stranger, checker } = await loadFixture(deployFixture);
      const role = await checker.MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE();

      await expect(
        checker.connect(stranger).setMaxBalanceExitRequestedPerReportInEth(60_000n),
      ).to.be.revertedWithOZAccessControlError(stranger.address, role);

      await checker.connect(admin).grantRole(role, manager.address);
      await expect(checker.connect(manager).setMaxBalanceExitRequestedPerReportInEth(OVER_UINT16))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(OVER_UINT16, 0n, OVER_UINT16 - 1n);
      await expect(checker.connect(manager).setMaxBalanceExitRequestedPerReportInEth(0n))
        .to.emit(checker, "MaxBalanceExitRequestedPerReportInEthSet")
        .withArgs(0n);
      await expect(checker.connect(manager).setMaxBalanceExitRequestedPerReportInEth(OVER_UINT16 - 1n))
        .to.emit(checker, "MaxBalanceExitRequestedPerReportInEthSet")
        .withArgs(OVER_UINT16 - 1n);

      expect((await checker.getOracleReportLimits()).maxBalanceExitRequestedPerReportInEth).to.equal(OVER_UINT16 - 1n);
    });

    it("setMaxEffectiveBalanceWeightWCType01: enforces ACL and uint16 bounds, updates and emits", async () => {
      const { admin, manager, stranger, checker } = await loadFixture(deployFixture);
      const role = await checker.MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE();

      await expect(
        checker.connect(stranger).setMaxEffectiveBalanceWeightWCType01(64n),
      ).to.be.revertedWithOZAccessControlError(stranger.address, role);

      await checker.connect(admin).grantRole(role, manager.address);
      await expect(checker.connect(manager).setMaxEffectiveBalanceWeightWCType01(0n))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(0n, 1n, OVER_UINT16 - 1n);
      await expect(checker.connect(manager).setMaxEffectiveBalanceWeightWCType01(OVER_UINT16))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(OVER_UINT16, 1n, OVER_UINT16 - 1n);
      await expect(checker.connect(manager).setMaxEffectiveBalanceWeightWCType01(1n))
        .to.emit(checker, "MaxEffectiveBalanceWeightWCType01Set")
        .withArgs(1n);
      await expect(checker.connect(manager).setMaxEffectiveBalanceWeightWCType01(OVER_UINT16 - 1n))
        .to.emit(checker, "MaxEffectiveBalanceWeightWCType01Set")
        .withArgs(OVER_UINT16 - 1n);

      expect((await checker.getOracleReportLimits()).maxEffectiveBalanceWeightWCType01).to.equal(OVER_UINT16 - 1n);
      expect(await checker.getMaxEffectiveBalanceWeightWCType01()).to.equal(OVER_UINT16 - 1n);
    });

    it("setMaxEffectiveBalanceWeightWCType02: enforces ACL and uint16 bounds, updates and emits", async () => {
      const { admin, manager, stranger, checker } = await loadFixture(deployFixture);
      const role = await checker.MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE();

      await expect(
        checker.connect(stranger).setMaxEffectiveBalanceWeightWCType02(4_096n),
      ).to.be.revertedWithOZAccessControlError(stranger.address, role);

      await checker.connect(admin).grantRole(role, manager.address);
      await expect(checker.connect(manager).setMaxEffectiveBalanceWeightWCType02(0n))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(0n, 1n, OVER_UINT16 - 1n);
      await expect(checker.connect(manager).setMaxEffectiveBalanceWeightWCType02(OVER_UINT16))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(OVER_UINT16, 1n, OVER_UINT16 - 1n);
      await expect(checker.connect(manager).setMaxEffectiveBalanceWeightWCType02(1n))
        .to.emit(checker, "MaxEffectiveBalanceWeightWCType02Set")
        .withArgs(1n);
      await expect(checker.connect(manager).setMaxEffectiveBalanceWeightWCType02(OVER_UINT16 - 1n))
        .to.emit(checker, "MaxEffectiveBalanceWeightWCType02Set")
        .withArgs(OVER_UINT16 - 1n);

      expect((await checker.getOracleReportLimits()).maxEffectiveBalanceWeightWCType02).to.equal(OVER_UINT16 - 1n);
      expect(await checker.getMaxEffectiveBalanceWeightWCType02()).to.equal(OVER_UINT16 - 1n);
    });

    it("setRequestTimestampMargin: enforces ACL and uint32 bounds, updates and emits", async () => {
      const { admin, manager, stranger, checker } = await loadFixture(deployFixture);
      const role = await checker.REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE();

      await expect(checker.connect(stranger).setRequestTimestampMargin(512n)).to.be.revertedWithOZAccessControlError(
        stranger.address,
        role,
      );

      await checker.connect(admin).grantRole(role, manager.address);
      await expect(checker.connect(manager).setRequestTimestampMargin(OVER_UINT32))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(OVER_UINT32, 0n, OVER_UINT32 - 1n);
      await expect(checker.connect(manager).setRequestTimestampMargin(0n))
        .to.emit(checker, "RequestTimestampMarginSet")
        .withArgs(0n);
      await expect(checker.connect(manager).setRequestTimestampMargin(OVER_UINT32 - 1n))
        .to.emit(checker, "RequestTimestampMarginSet")
        .withArgs(OVER_UINT32 - 1n);

      expect((await checker.getOracleReportLimits()).requestTimestampMargin).to.equal(OVER_UINT32 - 1n);
    });

    it("setMaxItemsPerExtraDataTransaction: enforces ACL and uint16 bounds, updates and emits", async () => {
      const { admin, manager, stranger, checker } = await loadFixture(deployFixture);
      const role = await checker.MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE();

      await expect(
        checker.connect(stranger).setMaxItemsPerExtraDataTransaction(20n),
      ).to.be.revertedWithOZAccessControlError(stranger.address, role);

      await checker.connect(admin).grantRole(role, manager.address);
      await expect(checker.connect(manager).setMaxItemsPerExtraDataTransaction(OVER_UINT16))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(OVER_UINT16, 0n, OVER_UINT16 - 1n);
      await expect(checker.connect(manager).setMaxItemsPerExtraDataTransaction(0n))
        .to.emit(checker, "MaxItemsPerExtraDataTransactionSet")
        .withArgs(0n);
      await expect(checker.connect(manager).setMaxItemsPerExtraDataTransaction(OVER_UINT16 - 1n))
        .to.emit(checker, "MaxItemsPerExtraDataTransactionSet")
        .withArgs(OVER_UINT16 - 1n);

      expect((await checker.getOracleReportLimits()).maxItemsPerExtraDataTransaction).to.equal(OVER_UINT16 - 1n);
    });

    it("setMaxNodeOperatorsPerExtraDataItem: enforces ACL and uint16 bounds, updates and emits", async () => {
      const { admin, manager, stranger, checker } = await loadFixture(deployFixture);
      const role = await checker.MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE();

      await expect(
        checker.connect(stranger).setMaxNodeOperatorsPerExtraDataItem(20n),
      ).to.be.revertedWithOZAccessControlError(stranger.address, role);

      await checker.connect(admin).grantRole(role, manager.address);
      await expect(checker.connect(manager).setMaxNodeOperatorsPerExtraDataItem(OVER_UINT16))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(OVER_UINT16, 0n, OVER_UINT16 - 1n);
      await expect(checker.connect(manager).setMaxNodeOperatorsPerExtraDataItem(0n))
        .to.emit(checker, "MaxNodeOperatorsPerExtraDataItemSet")
        .withArgs(0n);
      await expect(checker.connect(manager).setMaxNodeOperatorsPerExtraDataItem(OVER_UINT16 - 1n))
        .to.emit(checker, "MaxNodeOperatorsPerExtraDataItemSet")
        .withArgs(OVER_UINT16 - 1n);

      expect((await checker.getOracleReportLimits()).maxNodeOperatorsPerExtraDataItem).to.equal(OVER_UINT16 - 1n);
    });

    it("setSecondOpinionOracle: enforces ACL, updates and emits", async () => {
      const { admin, manager, stranger, checker } = await loadFixture(deployFixture);
      const role = await checker.SECOND_OPINION_MANAGER_ROLE();

      await expect(
        checker.connect(stranger).setSecondOpinionOracle(manager.address),
      ).to.be.revertedWithOZAccessControlError(stranger.address, role);

      await checker.connect(admin).grantRole(role, manager.address);
      await expect(checker.connect(manager).setSecondOpinionOracle(stranger.address))
        .to.emit(checker, "SecondOpinionOracleChanged")
        .withArgs(stranger.address);
      expect(await checker.secondOpinionOracle()).to.equal(stranger.address);

      await expect(checker.connect(manager).setSecondOpinionOracle(ZeroAddress))
        .to.emit(checker, "SecondOpinionOracleChanged")
        .withArgs(ZeroAddress);
      expect(await checker.secondOpinionOracle()).to.equal(ZeroAddress);
    });

    it("updates the CL decrease soft/hard pair atomically", async () => {
      const { admin, manager, stranger, checker } = await loadFixture(deployFixture);
      const role = await checker.CL_REBASE_DECREASE_LIMITS_MANAGER_ROLE();
      await checker.connect(admin).grantRole(role, manager.address);

      await expect(
        checker.connect(stranger).setCLRebaseDecreaseBPLimits(50n, 300n),
      ).to.be.revertedWithOZAccessControlError(stranger.address, role);
      await expect(checker.connect(manager).setCLRebaseDecreaseBPLimits(0n, TOTAL_BASIS_POINTS + 1n))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(TOTAL_BASIS_POINTS + 1n, 0n, TOTAL_BASIS_POINTS);
      await expect(checker.connect(manager).setCLRebaseDecreaseBPLimits(301n, 300n))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(301n, 0n, 300n);
      await expect(checker.connect(manager).setCLRebaseDecreaseBPLimits(0n, 0n))
        .to.emit(checker, "CLRebaseDecreaseBPLimitsSet")
        .withArgs(0n, 0n);
      await expect(checker.connect(manager).setCLRebaseDecreaseBPLimits(TOTAL_BASIS_POINTS, TOTAL_BASIS_POINTS))
        .to.emit(checker, "CLRebaseDecreaseBPLimitsSet")
        .withArgs(TOTAL_BASIS_POINTS, TOTAL_BASIS_POINTS);

      const updated = await checker.getOracleReportLimits();
      expect(updated.clRebaseDecreaseSoftBPLimit).to.equal(TOTAL_BASIS_POINTS);
      expect(updated.clRebaseDecreaseHardBPLimit).to.equal(TOTAL_BASIS_POINTS);
    });

    it("updates all limits and the second-opinion provider through the bulk setter", async () => {
      const { admin, manager, stranger, checker } = await loadFixture(deployFixture);
      const role = await checker.ALL_LIMITS_MANAGER_ROLE();
      const updatedLimits: Limits = {
        exitedEthAmountPerDayLimit: 56n,
        appearedEthAmountPerDayLimit: 101n,
        annualCLRebaseIncreaseSoftBPLimit: 500n,
        simulatedShareRateDeviationBPLimit: 251n,
        maxBalanceExitRequestedPerReportInEth: 64_000n,
        maxEffectiveBalanceWeightWCType01: 33n,
        maxEffectiveBalanceWeightWCType02: 2_047n,
        maxItemsPerExtraDataTransaction: 16n,
        maxNodeOperatorsPerExtraDataItem: 17n,
        requestTimestampMargin: 129n,
        annualCLRebaseIncreaseHardBPLimit: 1_200n,
        clRebaseDecreaseSoftBPLimit: 50n,
        clRebaseDecreaseHardBPLimit: 300n,
        consolidationEthAmountPerDayLimit: 11n,
        exitedValidatorEthAmountLimit: 33n,
        externalPendingBalanceCapEth: 6n,
      };

      await expect(
        checker.connect(stranger).setOracleReportLimits(updatedLimits, manager.address),
      ).to.be.revertedWithOZAccessControlError(stranger.address, role);

      await checker.connect(admin).grantRole(role, manager.address);
      await expect(
        checker
          .connect(manager)
          .setOracleReportLimits({ ...updatedLimits, annualCLRebaseIncreaseSoftBPLimit: 1_201n }, manager.address),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(1_201n, 0n, 1_200n);
      await expect(
        checker
          .connect(manager)
          .setOracleReportLimits({ ...updatedLimits, clRebaseDecreaseSoftBPLimit: 301n }, manager.address),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(301n, 0n, 300n);
      expect(await checker.secondOpinionOracle()).to.equal(ZeroAddress);

      const updateTx = checker.connect(manager).setOracleReportLimits(updatedLimits, manager.address);
      await expect(updateTx).to.emit(checker, "SecondOpinionOracleChanged").withArgs(manager.address);
      await expect(updateTx).to.emit(checker, "ExitedEthAmountPerDayLimitSet").withArgs(56n);
      await expect(updateTx).to.emit(checker, "AnnualCLRebaseIncreaseBPLimitsSet").withArgs(500n, 1_200n);
      await expect(updateTx).to.emit(checker, "CLRebaseDecreaseBPLimitsSet").withArgs(50n, 300n);
      expectLimits(await checker.getOracleReportLimits(), updatedLimits);
      expect(await checker.secondOpinionOracle()).to.equal(manager.address);

      await expect(checker.connect(manager).setOracleReportLimits(updatedLimits, ZeroAddress))
        .to.emit(checker, "SecondOpinionOracleChanged")
        .withArgs(ZeroAddress);
      expect(await checker.secondOpinionOracle()).to.equal(ZeroAddress);
    });

    it("validates every limit family through the bulk setter", async () => {
      const { admin, manager, checker } = await loadFixture(deployFixture);
      await checker.connect(admin).grantRole(await checker.ALL_LIMITS_MANAGER_ROLE(), manager.address);

      const invalidLimits: Array<[Partial<Limits>, bigint, bigint, bigint]> = [
        [{ exitedEthAmountPerDayLimit: OVER_UINT32 }, OVER_UINT32, 0n, OVER_UINT32 - 1n],
        [{ exitedValidatorEthAmountLimit: 0n }, 0n, 1n, OVER_UINT16 - 1n],
        [{ externalPendingBalanceCapEth: OVER_UINT16 }, OVER_UINT16, 0n, OVER_UINT16 - 1n],
        [
          { simulatedShareRateDeviationBPLimit: TOTAL_BASIS_POINTS + 1n },
          TOTAL_BASIS_POINTS + 1n,
          0n,
          TOTAL_BASIS_POINTS,
        ],
        [{ maxEffectiveBalanceWeightWCType01: 0n }, 0n, 1n, OVER_UINT16 - 1n],
        [{ maxEffectiveBalanceWeightWCType02: OVER_UINT16 }, OVER_UINT16, 1n, OVER_UINT16 - 1n],
      ];

      for (const [override, value, min, max] of invalidLimits) {
        await expect(checker.connect(manager).setOracleReportLimits({ ...limits, ...override }, ZeroAddress))
          .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
          .withArgs(value, min, max);
      }
    });

    it("dedicated setters do not emit events when values are unchanged", async () => {
      const { admin, manager, checker } = await loadFixture(deployFixture);
      const roles = [
        await checker.EXITED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE(),
        await checker.APPEARED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE(),
        await checker.CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE(),
        await checker.EXITED_VALIDATOR_ETH_AMOUNT_LIMIT_MANAGER_ROLE(),
        await checker.EXTERNAL_PENDING_BALANCE_CAP_MANAGER_ROLE(),
        await checker.ANNUAL_CL_REBASE_INCREASE_LIMITS_MANAGER_ROLE(),
        await checker.SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE(),
        await checker.MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE(),
        await checker.MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE(),
        await checker.MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE(),
        await checker.MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE(),
        await checker.REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE(),
        await checker.SECOND_OPINION_MANAGER_ROLE(),
        await checker.CL_REBASE_DECREASE_LIMITS_MANAGER_ROLE(),
      ];
      for (const role of roles) {
        await checker.connect(admin).grantRole(role, manager.address);
      }

      await expect(
        checker.connect(manager).setExitedEthAmountPerDayLimit(limits.exitedEthAmountPerDayLimit),
      ).to.not.emit(checker, "ExitedEthAmountPerDayLimitSet");
      await expect(
        checker.connect(manager).setAppearedEthAmountPerDayLimit(limits.appearedEthAmountPerDayLimit),
      ).to.not.emit(checker, "AppearedEthAmountPerDayLimitSet");
      await expect(
        checker.connect(manager).setConsolidationEthAmountPerDayLimit(limits.consolidationEthAmountPerDayLimit),
      ).to.not.emit(checker, "ConsolidationEthAmountPerDayLimitSet");
      await expect(
        checker.connect(manager).setExitedValidatorEthAmountLimit(limits.exitedValidatorEthAmountLimit),
      ).to.not.emit(checker, "ExitedValidatorEthAmountLimitSet");
      await expect(
        checker.connect(manager).setExternalPendingBalanceCapEth(limits.externalPendingBalanceCapEth),
      ).to.not.emit(checker, "ExternalPendingBalanceCapEthSet");
      await expect(
        checker
          .connect(manager)
          .setAnnualCLRebaseIncreaseBPLimits(
            limits.annualCLRebaseIncreaseSoftBPLimit,
            limits.annualCLRebaseIncreaseHardBPLimit,
          ),
      ).to.not.emit(checker, "AnnualCLRebaseIncreaseBPLimitsSet");
      await expect(
        checker.connect(manager).setSimulatedShareRateDeviationBPLimit(limits.simulatedShareRateDeviationBPLimit),
      ).to.not.emit(checker, "SimulatedShareRateDeviationBPLimitSet");
      await expect(
        checker.connect(manager).setMaxBalanceExitRequestedPerReportInEth(limits.maxBalanceExitRequestedPerReportInEth),
      ).to.not.emit(checker, "MaxBalanceExitRequestedPerReportInEthSet");
      await expect(
        checker.connect(manager).setMaxEffectiveBalanceWeightWCType01(limits.maxEffectiveBalanceWeightWCType01),
      ).to.not.emit(checker, "MaxEffectiveBalanceWeightWCType01Set");
      await expect(
        checker.connect(manager).setMaxEffectiveBalanceWeightWCType02(limits.maxEffectiveBalanceWeightWCType02),
      ).to.not.emit(checker, "MaxEffectiveBalanceWeightWCType02Set");
      await expect(
        checker.connect(manager).setMaxItemsPerExtraDataTransaction(limits.maxItemsPerExtraDataTransaction),
      ).to.not.emit(checker, "MaxItemsPerExtraDataTransactionSet");
      await expect(
        checker.connect(manager).setMaxNodeOperatorsPerExtraDataItem(limits.maxNodeOperatorsPerExtraDataItem),
      ).to.not.emit(checker, "MaxNodeOperatorsPerExtraDataItemSet");
      await expect(checker.connect(manager).setRequestTimestampMargin(limits.requestTimestampMargin)).to.not.emit(
        checker,
        "RequestTimestampMarginSet",
      );
      await expect(checker.connect(manager).setSecondOpinionOracle(ZeroAddress)).to.not.emit(
        checker,
        "SecondOpinionOracleChanged",
      );
      await expect(
        checker
          .connect(manager)
          .setCLRebaseDecreaseBPLimits(limits.clRebaseDecreaseSoftBPLimit, limits.clRebaseDecreaseHardBPLimit),
      ).to.not.emit(checker, "CLRebaseDecreaseBPLimitsSet");

      expectLimits(await checker.getOracleReportLimits(), limits);
      expect(await checker.secondOpinionOracle()).to.equal(ZeroAddress);
    });

    it("slot-local setters preserve the other packed storage block", async () => {
      const { admin, manager, checker } = await loadFixture(deployFixture);
      const accountingRole = await checker.ANNUAL_CL_REBASE_INCREASE_LIMITS_MANAGER_ROLE();
      const operationalRole = await checker.MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE();
      await checker.connect(admin).grantRole(accountingRole, manager.address);
      await checker.connect(admin).grantRole(operationalRole, manager.address);

      await checker.connect(manager).setMaxEffectiveBalanceWeightWCType01(64n);
      const afterOperationalUpdate = await checker.getOracleReportLimits();
      expectLimits(afterOperationalUpdate, { ...limits, maxEffectiveBalanceWeightWCType01: 64n });

      await checker.connect(manager).setAnnualCLRebaseIncreaseBPLimits(500n, 1_200n);
      const afterAccountingUpdate = await checker.getOracleReportLimits();
      expectLimits(afterAccountingUpdate, {
        ...limits,
        maxEffectiveBalanceWeightWCType01: 64n,
        annualCLRebaseIncreaseSoftBPLimit: 500n,
        annualCLRebaseIncreaseHardBPLimit: 1_200n,
      });
    });

    it("roundtrips both packed slots at their type boundaries", async () => {
      const { checker } = await loadFixture(deployFixture);
      const maxPackedLimits: Limits = {
        exitedEthAmountPerDayLimit: OVER_UINT32 - 1n,
        appearedEthAmountPerDayLimit: OVER_UINT32 - 1n,
        annualCLRebaseIncreaseSoftBPLimit: TOTAL_BASIS_POINTS,
        simulatedShareRateDeviationBPLimit: TOTAL_BASIS_POINTS,
        maxBalanceExitRequestedPerReportInEth: OVER_UINT16 - 1n,
        maxEffectiveBalanceWeightWCType01: OVER_UINT16 - 1n,
        maxEffectiveBalanceWeightWCType02: OVER_UINT16 - 1n,
        maxItemsPerExtraDataTransaction: OVER_UINT16 - 1n,
        maxNodeOperatorsPerExtraDataItem: OVER_UINT16 - 1n,
        requestTimestampMargin: OVER_UINT32 - 1n,
        annualCLRebaseIncreaseHardBPLimit: TOTAL_BASIS_POINTS,
        clRebaseDecreaseSoftBPLimit: TOTAL_BASIS_POINTS,
        clRebaseDecreaseHardBPLimit: TOTAL_BASIS_POINTS,
        consolidationEthAmountPerDayLimit: OVER_UINT32 - 1n,
        exitedValidatorEthAmountLimit: OVER_UINT16 - 1n,
        externalPendingBalanceCapEth: OVER_UINT16 - 1n,
      };

      expectLimits(await checker.roundtripRawLimits(maxPackedLimits), maxPackedLimits);

      await checker.packAndStore();
      const accountingPacked = await checker.exposeAccountingCorePackedLimits();
      expect(accountingPacked.annualCLRebaseIncreaseSoftBPLimit).to.equal(limits.annualCLRebaseIncreaseSoftBPLimit);
      expect(accountingPacked.annualCLRebaseIncreaseHardBPLimit).to.equal(limits.annualCLRebaseIncreaseHardBPLimit);
      expect(accountingPacked.clRebaseDecreaseSoftBPLimit).to.equal(limits.clRebaseDecreaseSoftBPLimit);
      expect(accountingPacked.clRebaseDecreaseHardBPLimit).to.equal(limits.clRebaseDecreaseHardBPLimit);
      expect(accountingPacked.externalPendingBalanceCapEth).to.equal(limits.externalPendingBalanceCapEth);

      const operationalPacked = await checker.exposeOperationalPackedLimits();
      expect(operationalPacked.maxBalanceExitRequestedPerReportInEth).to.equal(
        limits.maxBalanceExitRequestedPerReportInEth,
      );
      expect(operationalPacked.requestTimestampMargin).to.equal(limits.requestTimestampMargin);
    });

    it("keeps each packed limits struct within one storage slot", async () => {
      const artifact = await artifacts.readArtifact("OracleReportSanityCheckerWrapper");
      const integerWidth = (type: string) => {
        const match = /^uint(\d+)$/.exec(type);
        expect(match, `unexpected packed field type ${type}`).not.to.equal(null);
        return Number(match![1]);
      };
      const packedStructBits = (functionName: string) => {
        const entry = artifact.abi.find((item) => item.type === "function" && item.name === functionName);
        expect(entry, `${functionName} ABI entry`).not.to.equal(undefined);
        const output = "outputs" in entry! ? entry!.outputs?.[0] : undefined;
        expect(output?.components, `${functionName} tuple output`).not.to.equal(undefined);
        return output!.components!.reduce(
          (sum: number, component: { type: string }) => sum + integerWidth(component.type),
          0,
        );
      };

      expect(packedStructBits("exposeAccountingCorePackedLimits")).to.be.lessThanOrEqual(256);
      expect(packedStructBits("exposeOperationalPackedLimits")).to.be.lessThanOrEqual(256);
    });

    it("rejects overflowing basis points in the raw packer", async () => {
      const { checker } = await loadFixture(deployFixture);

      await expect(
        checker.packRawLimits({
          ...limits,
          annualCLRebaseIncreaseSoftBPLimit: TOTAL_BASIS_POINTS + 1n,
        }),
      )
        .to.be.revertedWithCustomError(checker, "BasisPointsOverflow")
        .withArgs(TOTAL_BASIS_POINTS + 1n, TOTAL_BASIS_POINTS);
    });
  });

  describe("retained standalone checks", () => {
    it("checks exit balance, node-operator count, and extra-data item count at exact boundaries", async () => {
      const { checker } = await loadFixture(deployFixture);

      await expect(checker.checkExitBusOracleReport(0n)).not.to.be.reverted;
      await expect(checker.checkExitBusOracleReport(limits.maxBalanceExitRequestedPerReportInEth - 1n)).not.to.be
        .reverted;
      await expect(checker.checkExitBusOracleReport(limits.maxBalanceExitRequestedPerReportInEth)).not.to.be.reverted;
      await expect(checker.checkExitBusOracleReport(limits.maxBalanceExitRequestedPerReportInEth + 1n))
        .to.be.revertedWithCustomError(checker, "IncorrectSumOfExitBalancePerReport")
        .withArgs(limits.maxBalanceExitRequestedPerReportInEth + 1n);

      await expect(checker.checkNodeOperatorsPerExtraDataItemCount(7n, limits.maxNodeOperatorsPerExtraDataItem)).not.to
        .be.reverted;
      await expect(checker.checkNodeOperatorsPerExtraDataItemCount(7n, limits.maxNodeOperatorsPerExtraDataItem + 1n))
        .to.be.revertedWithCustomError(checker, "TooManyNodeOpsPerExtraDataItem")
        .withArgs(7n, limits.maxNodeOperatorsPerExtraDataItem + 1n);

      await expect(checker.checkExtraDataItemsCountPerTransaction(limits.maxItemsPerExtraDataTransaction)).not.to.be
        .reverted;
      await expect(checker.checkExtraDataItemsCountPerTransaction(limits.maxItemsPerExtraDataTransaction + 1n))
        .to.be.revertedWithCustomError(checker, "TooManyItemsPerExtraDataTransaction")
        .withArgs(limits.maxItemsPerExtraDataTransaction, limits.maxItemsPerExtraDataTransaction + 1n);
    });

    it("normalizes newly exited validators by elapsed time", async () => {
      const { checker } = await loadFixture(deployFixture);
      const dailyLimit = ether(
        String((limits.exitedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * 2n),
      );

      await expect(checker.checkExitedValidatorsCount(4n, ONE_DAY)).not.to.be.reverted;
      await expect(checker.checkExitedValidatorsCount(5n, ONE_DAY))
        .to.be.revertedWithCustomError(checker, "ExitedEthAmountPerDayLimitExceeded")
        .withArgs(dailyLimit, ether("160"));

      await expect(checker.checkExitedValidatorsCount(0n, 0n)).not.to.be.reverted;
      await expect(checker.checkExitedValidatorsCount(1n, 0n))
        .to.be.revertedWithCustomError(checker, "ExitedEthAmountPerDayLimitExceeded")
        .withArgs(dailyLimit, ether("2764800"));
    });

    it("enforces the withdrawal request timestamp margin", async () => {
      const { withdrawalQueue, checker } = await loadFixture(deployFixture);
      await withdrawalQueue.setRequestTimestamp(7n, 1_000n);

      await expect(checker.checkWithdrawalQueueOracleReport(7n, 1_127n))
        .to.be.revertedWithCustomError(checker, "IncorrectRequestFinalization")
        .withArgs(1_000n);
      await expect(checker.checkWithdrawalQueueOracleReport(7n, 1_128n)).not.to.be.reverted;
    });
  });

  describe("live report values", () => {
    it("checks the live vault balances and burner request without retaining a vault baseline", async () => {
      const { accounting, stranger, withdrawalVault, elRewardsVault, burner, checker } =
        await loadFixture(deployFixture);
      await burner.setSharesRequestedToBurn(5n, 7n);

      await expect(
        checker
          .connect(accounting)
          .checkAccountingOracleReport(ONE_DAY, ether("1000"), 0n, ether("990"), 0n, ether("10"), ether("20"), 12n, 0n),
      ).not.to.be.reverted;

      await expect(
        checker.connect(stranger).checkAccountingOracleReport(ONE_DAY, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n),
      ).to.be.revertedWithCustomError(checker, "CalledNotFromAccounting");

      const actualWithdrawalVaultBalance = await ethers.provider.getBalance(withdrawalVault.address);
      await expect(
        checker
          .connect(accounting)
          .checkAccountingOracleReport(ONE_DAY, 0n, 0n, 0n, 0n, actualWithdrawalVaultBalance + 1n, 0n, 0n, 0n),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectWithdrawalsVaultBalance")
        .withArgs(actualWithdrawalVaultBalance);

      const actualELRewardsVaultBalance = await ethers.provider.getBalance(elRewardsVault.address);
      await expect(
        checker
          .connect(accounting)
          .checkAccountingOracleReport(ONE_DAY, 0n, 0n, 0n, 0n, 0n, actualELRewardsVaultBalance + 1n, 0n, 0n),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectELRewardsVaultBalance")
        .withArgs(actualELRewardsVaultBalance);

      await expect(checker.connect(accounting).checkAccountingOracleReport(ONE_DAY, 0n, 0n, 0n, 0n, 0n, 0n, 13n, 0n))
        .to.be.revertedWithCustomError(checker, "IncorrectSharesRequestedToBurn")
        .withArgs(12n);
    });
  });

  describe("simulated share rate", () => {
    it("accounts for withdrawal finalization offsets and applies the BP boundary symmetrically", async () => {
      const { checker } = await loadFixture(deployFixture);
      const shareRatePrecision = 10n ** 27n;
      const postInternalEther = ether("90");
      const postInternalShares = ether("90");
      const etherToFinalize = ether("10");
      const sharesToBurn = ether("10");
      const actualShareRate = shareRatePrecision;
      const allowedDeviation = (actualShareRate * limits.simulatedShareRateDeviationBPLimit) / TOTAL_BASIS_POINTS;

      await expect(
        checker.checkSimulatedShareRate(
          postInternalEther,
          postInternalShares,
          etherToFinalize,
          sharesToBurn,
          actualShareRate + allowedDeviation,
        ),
      ).not.to.be.reverted;
      await expect(
        checker.checkSimulatedShareRate(
          postInternalEther,
          postInternalShares,
          etherToFinalize,
          sharesToBurn,
          actualShareRate - allowedDeviation,
        ),
      ).not.to.be.reverted;

      const excessiveRate = actualShareRate + allowedDeviation + actualShareRate / TOTAL_BASIS_POINTS;
      await expect(
        checker.checkSimulatedShareRate(
          postInternalEther,
          postInternalShares,
          etherToFinalize,
          sharesToBurn,
          excessiveRate,
        ),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectSimulatedShareRate")
        .withArgs(excessiveRate, actualShareRate);
    });
  });
});
