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
  OracleReportSanityCheckerWrapper,
  StakingRouter__MockForSanityChecker,
  WithdrawalQueue__MockForSanityChecker,
} from "typechain-types";

import { ether, impersonate } from "lib";
import { TOTAL_BASIS_POINTS } from "lib/constants";

import { Snapshot } from "test/suite";

const OVER_UINT16 = 1n << 16n;
const OVER_UINT32 = 1n << 32n;
const OVER_UINT64 = 1n << 64n;

describe("OracleReportSanityChecker.sol", () => {
  let checker: OracleReportSanityChecker;

  let locator: LidoLocator__MockForSanityChecker;
  let burner: Burner__MockForSanityChecker;
  let accounting: Accounting__MockForSanityChecker;
  let withdrawalQueue: WithdrawalQueue__MockForSanityChecker;
  let stakingRouter: StakingRouter__MockForSanityChecker;
  let accountingOracle: AccountingOracle__MockForSanityChecker;

  let withdrawalVault: HardhatEthersSigner;
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let elRewardsVault: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let manager: HardhatEthersSigner;

  const defaultLimits = {
    exitedEthAmountPerDayLimit: 55n,
    appearedEthAmountPerDayLimit: 100n,
    annualBalanceIncreaseBPLimit: 1_000n,
    simulatedShareRateDeviationBPLimit: 250n,
    maxBalanceExitRequestedPerReportInEth: 65_000n,
    maxEffectiveBalanceWeightWCType01: 32n,
    maxEffectiveBalanceWeightWCType02: 2_048n,
    maxItemsPerExtraDataTransaction: 15n,
    maxNodeOperatorsPerExtraDataItem: 16n,
    requestTimestampMargin: 128n,
    maxPositiveTokenRebase: 5_000_000n,
    maxCLBalanceDecreaseBP: 360n,
    clBalanceOraclesErrorUpperBPLimit: 50n,
    consolidationEthAmountPerDayLimit: 10n,
    exitedValidatorEthAmountLimit: 1n,
  };

  let originalState: string;

  before(async () => {
    [deployer, admin, elRewardsVault, stranger, manager, withdrawalVault] = await ethers.getSigners();

    await setBalance(withdrawalVault.address, ether("500"));

    withdrawalQueue = await ethers.deployContract("WithdrawalQueue__MockForSanityChecker");
    burner = await ethers.deployContract("Burner__MockForSanityChecker");
    accounting = await ethers.deployContract("Accounting__MockForSanityChecker", []);

    accountingOracle = await ethers.deployContract("AccountingOracle__MockForSanityChecker", [
      deployer.address,
      12,
      1_606_824_023,
    ]);

    stakingRouter = await ethers.deployContract("StakingRouter__MockForSanityChecker");

    locator = await ethers.deployContract("LidoLocator__MockForSanityChecker", [
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
        accounting: await accounting.getAddress(),
        predepositGuarantee: deployer.address,
        wstETH: deployer.address,
        vaultHub: deployer.address,
        vaultFactory: deployer.address,
        lazyOracle: deployer.address,
        operatorGrid: deployer.address,
        topUpGateway: deployer.address,
      },
    ]);

    checker = await ethers.deployContract("OracleReportSanityChecker", [
      await locator.getAddress(),
      await accounting.getAddress(),
      admin.address,
      defaultLimits,
    ]);
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  const deployCheckerWithLidoStats = async (
    contractVersion: bigint,
    balanceStats: { clActive: bigint; clPending: bigint; deposits: bigint } = {
      clActive: ether("100"),
      clPending: ether("7"),
      deposits: ether("3"),
    },
  ) => {
    const lido = await ethers.deployContract("Lido__MockForSanityChecker");
    await lido.mock__setContractVersion(contractVersion);
    await lido.mock__setBalanceStats(balanceStats.clActive, balanceStats.clPending, balanceStats.deposits);

    const migrationLocator = await ethers.deployContract("LidoLocator__MockForSanityChecker", [
      {
        lido: await lido.getAddress(),
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
        accounting: await accounting.getAddress(),
        predepositGuarantee: deployer.address,
        wstETH: deployer.address,
        vaultHub: deployer.address,
        vaultFactory: deployer.address,
        lazyOracle: deployer.address,
        operatorGrid: deployer.address,
        topUpGateway: deployer.address,
      },
    ]);

    const checkerWithLidoStats = await ethers.deployContract("OracleReportSanityChecker", [
      await migrationLocator.getAddress(),
      await accounting.getAddress(),
      admin.address,
      defaultLimits,
    ]);

    return { checkerWithLidoStats, lido };
  };

  context("constructor and getters", () => {
    it("reverts if admin is zero", async () => {
      await expect(
        ethers.deployContract("OracleReportSanityChecker", [
          await locator.getAddress(),
          await accounting.getAddress(),
          ZeroAddress,
          defaultLimits,
        ]),
      ).to.be.revertedWithCustomError(checker, "AdminCannotBeZero");
    });

    it("returns locator and initial limits", async () => {
      expect(await checker.getLidoLocator()).to.equal(await locator.getAddress());

      const limits = await checker.getOracleReportLimits();
      expect(limits.exitedEthAmountPerDayLimit).to.equal(defaultLimits.exitedEthAmountPerDayLimit);
      expect(limits.appearedEthAmountPerDayLimit).to.equal(defaultLimits.appearedEthAmountPerDayLimit);
      expect(limits.annualBalanceIncreaseBPLimit).to.equal(defaultLimits.annualBalanceIncreaseBPLimit);
      expect(limits.simulatedShareRateDeviationBPLimit).to.equal(defaultLimits.simulatedShareRateDeviationBPLimit);
      expect(limits.maxBalanceExitRequestedPerReportInEth).to.equal(
        defaultLimits.maxBalanceExitRequestedPerReportInEth,
      );
      expect(limits.maxEffectiveBalanceWeightWCType01).to.equal(defaultLimits.maxEffectiveBalanceWeightWCType01);
      expect(limits.maxEffectiveBalanceWeightWCType02).to.equal(defaultLimits.maxEffectiveBalanceWeightWCType02);
      expect(limits.maxItemsPerExtraDataTransaction).to.equal(defaultLimits.maxItemsPerExtraDataTransaction);
      expect(limits.maxNodeOperatorsPerExtraDataItem).to.equal(defaultLimits.maxNodeOperatorsPerExtraDataItem);
      expect(limits.requestTimestampMargin).to.equal(defaultLimits.requestTimestampMargin);
      expect(limits.maxPositiveTokenRebase).to.equal(defaultLimits.maxPositiveTokenRebase);
      expect(limits.maxCLBalanceDecreaseBP).to.equal(defaultLimits.maxCLBalanceDecreaseBP);
      expect(limits.clBalanceOraclesErrorUpperBPLimit).to.equal(defaultLimits.clBalanceOraclesErrorUpperBPLimit);
      expect(limits.consolidationEthAmountPerDayLimit).to.equal(defaultLimits.consolidationEthAmountPerDayLimit);
      expect(limits.exitedValidatorEthAmountLimit).to.equal(defaultLimits.exitedValidatorEthAmountLimit);
    });

    it("returns max positive token rebase and max CL decrease BP", async () => {
      expect(await checker.getMaxPositiveTokenRebase()).to.equal(defaultLimits.maxPositiveTokenRebase);
      expect(await checker.getMaxCLBalanceDecreaseBP()).to.equal(defaultLimits.maxCLBalanceDecreaseBP);
      expect(await checker.getMaxEffectiveBalanceWeightWCType01()).to.equal(
        defaultLimits.maxEffectiveBalanceWeightWCType01,
      );
      expect(await checker.getMaxEffectiveBalanceWeightWCType02()).to.equal(
        defaultLimits.maxEffectiveBalanceWeightWCType02,
      );
    });
  });

  context("limits management", () => {
    it("setOracleReportLimits: ACL and update", async () => {
      const newLimits = {
        ...defaultLimits,
        exitedEthAmountPerDayLimit: 42n,
        appearedEthAmountPerDayLimit: 88n,
        consolidationEthAmountPerDayLimit: 7n,
        exitedValidatorEthAmountLimit: 2n,
      };

      await checker.connect(admin).grantRole(await checker.ALL_LIMITS_MANAGER_ROLE(), manager.address);

      await expect(
        checker.connect(stranger).setOracleReportLimits(newLimits, ZeroAddress),
      ).to.be.revertedWithOZAccessControlError(stranger.address, await checker.ALL_LIMITS_MANAGER_ROLE());

      await expect(checker.connect(manager).setOracleReportLimits(newLimits, ZeroAddress))
        .to.emit(checker, "ExitedEthAmountPerDayLimitSet")
        .withArgs(42n)
        .to.emit(checker, "AppearedEthAmountPerDayLimitSet")
        .withArgs(88n)
        .to.emit(checker, "ConsolidationEthAmountPerDayLimitSet")
        .withArgs(7n)
        .to.emit(checker, "ExitedValidatorEthAmountLimitSet")
        .withArgs(2n);

      const limits = await checker.getOracleReportLimits();
      expect(limits.exitedEthAmountPerDayLimit).to.equal(42n);
      expect(limits.appearedEthAmountPerDayLimit).to.equal(88n);
      expect(limits.consolidationEthAmountPerDayLimit).to.equal(7n);
      expect(limits.exitedValidatorEthAmountLimit).to.equal(2n);
    });

    it("setExitedEthAmountPerDayLimit: validates bounds", async () => {
      await checker
        .connect(admin)
        .grantRole(await checker.EXITED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE(), manager.address);

      await expect(checker.connect(manager).setExitedEthAmountPerDayLimit(OVER_UINT32)).to.be.revertedWithCustomError(
        checker,
        "IncorrectLimitValue",
      );

      await expect(checker.connect(manager).setExitedEthAmountPerDayLimit(60n))
        .to.emit(checker, "ExitedEthAmountPerDayLimitSet")
        .withArgs(60n);

      expect((await checker.getOracleReportLimits()).exitedEthAmountPerDayLimit).to.equal(60n);
    });

    it("setExitedEthAmountPerDayLimit: ACL", async () => {
      await expect(checker.connect(stranger).setExitedEthAmountPerDayLimit(60n)).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.EXITED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE(),
      );
    });

    it("sets exited/appeared ETH limits via dedicated setters", async () => {
      await checker
        .connect(admin)
        .grantRole(await checker.EXITED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE(), manager.address);
      await checker
        .connect(admin)
        .grantRole(await checker.APPEARED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE(), manager.address);

      await checker.connect(manager).setExitedEthAmountPerDayLimit(61n);
      await checker.connect(manager).setAppearedEthAmountPerDayLimit(101n);

      const limits = await checker.getOracleReportLimits();
      expect(limits.exitedEthAmountPerDayLimit).to.equal(61n);
      expect(limits.appearedEthAmountPerDayLimit).to.equal(101n);
    });

    it("dedicated exited/appeared ETH setters emit events", async () => {
      await checker
        .connect(admin)
        .grantRole(await checker.EXITED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE(), manager.address);
      await checker
        .connect(admin)
        .grantRole(await checker.APPEARED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE(), manager.address);

      await expect(checker.connect(manager).setExitedEthAmountPerDayLimit(62n))
        .to.emit(checker, "ExitedEthAmountPerDayLimitSet")
        .withArgs(62n);
      await expect(checker.connect(manager).setAppearedEthAmountPerDayLimit(102n))
        .to.emit(checker, "AppearedEthAmountPerDayLimitSet")
        .withArgs(102n);
    });

    it("setExitedValidatorEthAmountLimit: validates min and updates", async () => {
      await checker
        .connect(admin)
        .grantRole(await checker.EXITED_VALIDATOR_ETH_AMOUNT_LIMIT_MANAGER_ROLE(), manager.address);

      await expect(checker.connect(manager).setExitedValidatorEthAmountLimit(0n)).to.be.revertedWithCustomError(
        checker,
        "IncorrectLimitValue",
      );

      await expect(checker.connect(manager).setExitedValidatorEthAmountLimit(3n))
        .to.emit(checker, "ExitedValidatorEthAmountLimitSet")
        .withArgs(3n);

      expect((await checker.getOracleReportLimits()).exitedValidatorEthAmountLimit).to.equal(3n);
    });

    it("setExitedValidatorEthAmountLimit: ACL", async () => {
      await expect(
        checker.connect(stranger).setExitedValidatorEthAmountLimit(2n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.EXITED_VALIDATOR_ETH_AMOUNT_LIMIT_MANAGER_ROLE(),
      );
    });

    it("setExitedValidatorEthAmountLimit: validates uint16 upper bound", async () => {
      await checker
        .connect(admin)
        .grantRole(await checker.EXITED_VALIDATOR_ETH_AMOUNT_LIMIT_MANAGER_ROLE(), manager.address);

      await expect(
        checker.connect(manager).setExitedValidatorEthAmountLimit(OVER_UINT16),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");
    });

    it("setRequestTimestampMargin validates uint32 bound", async () => {
      await checker.connect(admin).grantRole(await checker.REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE(), manager.address);

      await expect(checker.connect(manager).setRequestTimestampMargin(OVER_UINT32)).to.be.revertedWithCustomError(
        checker,
        "IncorrectLimitValue",
      );
    });

    it("setSecondOpinionOracleAndCLBalanceUpperMargin updates oracle and limit", async () => {
      await checker.connect(admin).grantRole(await checker.SECOND_OPINION_MANAGER_ROLE(), manager.address);

      const secondOpinion = deployer.address;
      await expect(checker.connect(manager).setSecondOpinionOracleAndCLBalanceUpperMargin(secondOpinion, 99n))
        .to.emit(checker, "SecondOpinionOracleChanged")
        .withArgs(secondOpinion)
        .to.emit(checker, "CLBalanceOraclesErrorUpperBPLimitSet")
        .withArgs(99n);

      expect(await checker.secondOpinionOracle()).to.equal(secondOpinion);
      expect((await checker.getOracleReportLimits()).clBalanceOraclesErrorUpperBPLimit).to.equal(99n);
    });

    it("setAppearedEthAmountPerDayLimit: ACL, bounds and update", async () => {
      await checker
        .connect(admin)
        .grantRole(await checker.APPEARED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE(), manager.address);

      await expect(
        checker.connect(stranger).setAppearedEthAmountPerDayLimit(120n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.APPEARED_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE(),
      );

      await expect(checker.connect(manager).setAppearedEthAmountPerDayLimit(OVER_UINT32)).to.be.revertedWithCustomError(
        checker,
        "IncorrectLimitValue",
      );

      await expect(checker.connect(manager).setAppearedEthAmountPerDayLimit(120n))
        .to.emit(checker, "AppearedEthAmountPerDayLimitSet")
        .withArgs(120n);

      expect((await checker.getOracleReportLimits()).appearedEthAmountPerDayLimit).to.equal(120n);
    });

    it("setConsolidationEthAmountPerDayLimit: ACL, bounds and update", async () => {
      await checker
        .connect(admin)
        .grantRole(await checker.CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE(), manager.address);

      await expect(
        checker.connect(stranger).setConsolidationEthAmountPerDayLimit(11n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE(),
      );

      await expect(
        checker.connect(manager).setConsolidationEthAmountPerDayLimit(OVER_UINT32),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");

      await expect(checker.connect(manager).setConsolidationEthAmountPerDayLimit(11n))
        .to.emit(checker, "ConsolidationEthAmountPerDayLimitSet")
        .withArgs(11n);

      expect((await checker.getOracleReportLimits()).consolidationEthAmountPerDayLimit).to.equal(11n);
    });

    it("setAnnualBalanceIncreaseBPLimit: ACL, bounds and update", async () => {
      await checker
        .connect(admin)
        .grantRole(await checker.ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE(), manager.address);

      await expect(
        checker.connect(stranger).setAnnualBalanceIncreaseBPLimit(250n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE(),
      );

      await expect(
        checker.connect(manager).setAnnualBalanceIncreaseBPLimit(TOTAL_BASIS_POINTS + 1n),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");

      await expect(checker.connect(manager).setAnnualBalanceIncreaseBPLimit(250n))
        .to.emit(checker, "AnnualBalanceIncreaseBPLimitSet")
        .withArgs(250n);

      expect((await checker.getOracleReportLimits()).annualBalanceIncreaseBPLimit).to.equal(250n);
    });

    it("setSimulatedShareRateDeviationBPLimit: ACL, bounds and update", async () => {
      await checker.connect(admin).grantRole(await checker.SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE(), manager.address);

      await expect(
        checker.connect(stranger).setSimulatedShareRateDeviationBPLimit(300n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE(),
      );

      await expect(
        checker.connect(manager).setSimulatedShareRateDeviationBPLimit(TOTAL_BASIS_POINTS + 1n),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");

      await expect(checker.connect(manager).setSimulatedShareRateDeviationBPLimit(300n))
        .to.emit(checker, "SimulatedShareRateDeviationBPLimitSet")
        .withArgs(300n);

      expect((await checker.getOracleReportLimits()).simulatedShareRateDeviationBPLimit).to.equal(300n);
    });

    it("setMaxBalanceExitRequestedPerReportInEth: ACL, bounds and update", async () => {
      await checker
        .connect(admin)
        .grantRole(await checker.MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE(), manager.address);

      await expect(
        checker.connect(stranger).setMaxBalanceExitRequestedPerReportInEth(60_000n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE(),
      );

      await expect(
        checker.connect(manager).setMaxBalanceExitRequestedPerReportInEth(OVER_UINT16),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");

      await expect(checker.connect(manager).setMaxBalanceExitRequestedPerReportInEth(60_000n))
        .to.emit(checker, "MaxBalanceExitRequestedPerReportInEthSet")
        .withArgs(60_000n);

      expect((await checker.getOracleReportLimits()).maxBalanceExitRequestedPerReportInEth).to.equal(60_000n);
    });

    it("setMaxBalanceExitRequestedPerReportInEth accepts zero", async () => {
      await checker
        .connect(admin)
        .grantRole(await checker.MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE(), manager.address);

      await expect(checker.connect(manager).setMaxBalanceExitRequestedPerReportInEth(0n))
        .to.emit(checker, "MaxBalanceExitRequestedPerReportInEthSet")
        .withArgs(0n);

      expect((await checker.getOracleReportLimits()).maxBalanceExitRequestedPerReportInEth).to.equal(0n);
    });

    it("setMaxEffectiveBalanceWeightWCType01: ACL, bounds and update", async () => {
      await checker
        .connect(admin)
        .grantRole(await checker.MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE(), manager.address);

      await expect(
        checker.connect(stranger).setMaxEffectiveBalanceWeightWCType01(64n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE(),
      );

      await expect(checker.connect(manager).setMaxEffectiveBalanceWeightWCType01(0n)).to.be.revertedWithCustomError(
        checker,
        "IncorrectLimitValue",
      );

      await expect(
        checker.connect(manager).setMaxEffectiveBalanceWeightWCType01(OVER_UINT16),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");

      await expect(checker.connect(manager).setMaxEffectiveBalanceWeightWCType01(64n))
        .to.emit(checker, "MaxEffectiveBalanceWeightWCType01Set")
        .withArgs(64n);

      expect((await checker.getOracleReportLimits()).maxEffectiveBalanceWeightWCType01).to.equal(64n);
      expect(await checker.getMaxEffectiveBalanceWeightWCType01()).to.equal(64n);
    });

    it("setMaxEffectiveBalanceWeightWCType02: ACL, bounds and update", async () => {
      await checker
        .connect(admin)
        .grantRole(await checker.MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE(), manager.address);

      await expect(
        checker.connect(stranger).setMaxEffectiveBalanceWeightWCType02(4_096n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE(),
      );

      await expect(checker.connect(manager).setMaxEffectiveBalanceWeightWCType02(0n)).to.be.revertedWithCustomError(
        checker,
        "IncorrectLimitValue",
      );

      await expect(
        checker.connect(manager).setMaxEffectiveBalanceWeightWCType02(OVER_UINT16),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");

      await expect(checker.connect(manager).setMaxEffectiveBalanceWeightWCType02(4_096n))
        .to.emit(checker, "MaxEffectiveBalanceWeightWCType02Set")
        .withArgs(4_096n);

      expect((await checker.getOracleReportLimits()).maxEffectiveBalanceWeightWCType02).to.equal(4_096n);
      expect(await checker.getMaxEffectiveBalanceWeightWCType02()).to.equal(4_096n);
    });

    it("limit setters do not emit events when the value does not change", async () => {
      await checker.connect(admin).grantRole(await checker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(), manager.address);
      await checker
        .connect(admin)
        .grantRole(await checker.MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE(), manager.address);
      await checker
        .connect(admin)
        .grantRole(await checker.MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE(), manager.address);

      await checker.connect(manager).setMaxPositiveTokenRebase(600_000n);
      await expect(checker.connect(manager).setMaxPositiveTokenRebase(600_000n)).to.not.emit(
        checker,
        "MaxPositiveTokenRebaseSet",
      );

      await checker.connect(manager).setMaxBalanceExitRequestedPerReportInEth(60_000n);
      await expect(checker.connect(manager).setMaxBalanceExitRequestedPerReportInEth(60_000n)).to.not.emit(
        checker,
        "MaxBalanceExitRequestedPerReportInEthSet",
      );

      await checker.connect(manager).setMaxEffectiveBalanceWeightWCType01(64n);
      await expect(checker.connect(manager).setMaxEffectiveBalanceWeightWCType01(64n)).to.not.emit(
        checker,
        "MaxEffectiveBalanceWeightWCType01Set",
      );
    });

    it("setMaxItemsPerExtraDataTransaction: ACL, bounds and update", async () => {
      await checker
        .connect(admin)
        .grantRole(await checker.MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE(), manager.address);

      await expect(
        checker.connect(stranger).setMaxItemsPerExtraDataTransaction(100n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE(),
      );

      await expect(
        checker.connect(manager).setMaxItemsPerExtraDataTransaction(OVER_UINT16),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");

      await expect(checker.connect(manager).setMaxItemsPerExtraDataTransaction(20n))
        .to.emit(checker, "MaxItemsPerExtraDataTransactionSet")
        .withArgs(20n);

      expect((await checker.getOracleReportLimits()).maxItemsPerExtraDataTransaction).to.equal(20n);
    });

    it("setMaxNodeOperatorsPerExtraDataItem: ACL, bounds and update", async () => {
      await checker
        .connect(admin)
        .grantRole(await checker.MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE(), manager.address);

      await expect(
        checker.connect(stranger).setMaxNodeOperatorsPerExtraDataItem(100n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE(),
      );

      await expect(
        checker.connect(manager).setMaxNodeOperatorsPerExtraDataItem(OVER_UINT16),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");

      await expect(checker.connect(manager).setMaxNodeOperatorsPerExtraDataItem(20n))
        .to.emit(checker, "MaxNodeOperatorsPerExtraDataItemSet")
        .withArgs(20n);

      expect((await checker.getOracleReportLimits()).maxNodeOperatorsPerExtraDataItem).to.equal(20n);
    });

    it("setRequestTimestampMargin updates value and emits event", async () => {
      await checker.connect(admin).grantRole(await checker.REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE(), manager.address);

      await expect(checker.connect(stranger).setRequestTimestampMargin(512n)).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE(),
      );

      await expect(checker.connect(manager).setRequestTimestampMargin(512n))
        .to.emit(checker, "RequestTimestampMarginSet")
        .withArgs(512n);

      expect((await checker.getOracleReportLimits()).requestTimestampMargin).to.equal(512n);
    });

    it("setMaxPositiveTokenRebase: ACL, min/max and update", async () => {
      await checker.connect(admin).grantRole(await checker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(), manager.address);

      await expect(
        checker.connect(stranger).setMaxPositiveTokenRebase(600_000n),
      ).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
      );

      await expect(checker.connect(manager).setMaxPositiveTokenRebase(0n)).to.be.revertedWithCustomError(
        checker,
        "IncorrectLimitValue",
      );
      await expect(checker.connect(manager).setMaxPositiveTokenRebase(OVER_UINT64)).to.be.revertedWithCustomError(
        checker,
        "IncorrectLimitValue",
      );

      await expect(checker.connect(manager).setMaxPositiveTokenRebase(600_000n))
        .to.emit(checker, "MaxPositiveTokenRebaseSet")
        .withArgs(600_000n);

      expect((await checker.getOracleReportLimits()).maxPositiveTokenRebase).to.equal(600_000n);
    });

    it("setMaxCLBalanceDecreaseBP: ACL, bounds and update", async () => {
      await checker.connect(admin).grantRole(await checker.MAX_CL_BALANCE_DECREASE_MANAGER_ROLE(), manager.address);

      await expect(checker.connect(stranger).setMaxCLBalanceDecreaseBP(200n)).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await checker.MAX_CL_BALANCE_DECREASE_MANAGER_ROLE(),
      );

      await expect(
        checker.connect(manager).setMaxCLBalanceDecreaseBP(TOTAL_BASIS_POINTS + 1n),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");

      await expect(checker.connect(manager).setMaxCLBalanceDecreaseBP(200n))
        .to.emit(checker, "MaxCLBalanceDecreaseBPSet")
        .withArgs(200n);

      expect((await checker.getOracleReportLimits()).maxCLBalanceDecreaseBP).to.equal(200n);
    });

    it("setSecondOpinionOracleAndCLBalanceUpperMargin validates basis points bound", async () => {
      await checker.connect(admin).grantRole(await checker.SECOND_OPINION_MANAGER_ROLE(), manager.address);

      await expect(
        checker.connect(manager).setSecondOpinionOracleAndCLBalanceUpperMargin(ZeroAddress, TOTAL_BASIS_POINTS + 1n),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");
    });

    it("setSecondOpinionOracleAndCLBalanceUpperMargin does not emit oracle change for same address", async () => {
      await checker.connect(admin).grantRole(await checker.SECOND_OPINION_MANAGER_ROLE(), manager.address);

      const secondOpinion = deployer.address;
      await checker.connect(manager).setSecondOpinionOracleAndCLBalanceUpperMargin(secondOpinion, 50n);
      await expect(
        checker.connect(manager).setSecondOpinionOracleAndCLBalanceUpperMargin(secondOpinion, 51n),
      ).to.not.emit(checker, "SecondOpinionOracleChanged");
    });

    it("setOracleReportLimits rejects invalid exitedValidatorEthAmountLimit", async () => {
      await checker.connect(admin).grantRole(await checker.ALL_LIMITS_MANAGER_ROLE(), manager.address);

      await expect(
        checker
          .connect(manager)
          .setOracleReportLimits({ ...defaultLimits, exitedValidatorEthAmountLimit: 0n }, ZeroAddress),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");

      await expect(
        checker
          .connect(manager)
          .setOracleReportLimits({ ...defaultLimits, exitedValidatorEthAmountLimit: OVER_UINT16 }, ZeroAddress),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");
    });

    it("setOracleReportLimits rejects invalid annualBalanceIncreaseBPLimit", async () => {
      await checker.connect(admin).grantRole(await checker.ALL_LIMITS_MANAGER_ROLE(), manager.address);

      await expect(
        checker
          .connect(manager)
          .setOracleReportLimits(
            { ...defaultLimits, annualBalanceIncreaseBPLimit: TOTAL_BASIS_POINTS + 1n },
            ZeroAddress,
          ),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");
    });

    it("setOracleReportLimits rejects invalid maxEffectiveBalanceWeight values", async () => {
      await checker.connect(admin).grantRole(await checker.ALL_LIMITS_MANAGER_ROLE(), manager.address);

      await expect(
        checker
          .connect(manager)
          .setOracleReportLimits({ ...defaultLimits, maxEffectiveBalanceWeightWCType01: 0n }, ZeroAddress),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");

      await expect(
        checker
          .connect(manager)
          .setOracleReportLimits({ ...defaultLimits, maxEffectiveBalanceWeightWCType02: OVER_UINT16 }, ZeroAddress),
      ).to.be.revertedWithCustomError(checker, "IncorrectLimitValue");
    });

    it("roundtrips limits at packed type boundaries", async () => {
      const wrapper = (await ethers.deployContract("OracleReportSanityCheckerWrapper", [
        await locator.getAddress(),
        await accounting.getAddress(),
        admin.address,
        defaultLimits,
      ])) as OracleReportSanityCheckerWrapper;

      const maxPackedLimits = {
        exitedEthAmountPerDayLimit: OVER_UINT32 - 1n,
        appearedEthAmountPerDayLimit: OVER_UINT32 - 1n,
        annualBalanceIncreaseBPLimit: TOTAL_BASIS_POINTS,
        simulatedShareRateDeviationBPLimit: TOTAL_BASIS_POINTS,
        maxBalanceExitRequestedPerReportInEth: OVER_UINT16 - 1n,
        maxEffectiveBalanceWeightWCType01: OVER_UINT16 - 1n,
        maxEffectiveBalanceWeightWCType02: OVER_UINT16 - 1n,
        maxItemsPerExtraDataTransaction: OVER_UINT16 - 1n,
        maxNodeOperatorsPerExtraDataItem: OVER_UINT16 - 1n,
        requestTimestampMargin: OVER_UINT32 - 1n,
        maxPositiveTokenRebase: OVER_UINT64 - 1n,
        maxCLBalanceDecreaseBP: TOTAL_BASIS_POINTS,
        clBalanceOraclesErrorUpperBPLimit: TOTAL_BASIS_POINTS,
        consolidationEthAmountPerDayLimit: OVER_UINT32 - 1n,
        exitedValidatorEthAmountLimit: OVER_UINT16 - 1n,
      };

      const roundtrip = await wrapper.roundtripRawLimits(maxPackedLimits);

      expect(roundtrip.exitedEthAmountPerDayLimit).to.equal(maxPackedLimits.exitedEthAmountPerDayLimit);
      expect(roundtrip.appearedEthAmountPerDayLimit).to.equal(maxPackedLimits.appearedEthAmountPerDayLimit);
      expect(roundtrip.annualBalanceIncreaseBPLimit).to.equal(maxPackedLimits.annualBalanceIncreaseBPLimit);
      expect(roundtrip.simulatedShareRateDeviationBPLimit).to.equal(maxPackedLimits.simulatedShareRateDeviationBPLimit);
      expect(roundtrip.maxBalanceExitRequestedPerReportInEth).to.equal(
        maxPackedLimits.maxBalanceExitRequestedPerReportInEth,
      );
      expect(roundtrip.maxEffectiveBalanceWeightWCType01).to.equal(maxPackedLimits.maxEffectiveBalanceWeightWCType01);
      expect(roundtrip.maxEffectiveBalanceWeightWCType02).to.equal(maxPackedLimits.maxEffectiveBalanceWeightWCType02);
      expect(roundtrip.maxItemsPerExtraDataTransaction).to.equal(maxPackedLimits.maxItemsPerExtraDataTransaction);
      expect(roundtrip.maxNodeOperatorsPerExtraDataItem).to.equal(maxPackedLimits.maxNodeOperatorsPerExtraDataItem);
      expect(roundtrip.requestTimestampMargin).to.equal(maxPackedLimits.requestTimestampMargin);
      expect(roundtrip.maxPositiveTokenRebase).to.equal(maxPackedLimits.maxPositiveTokenRebase);
      expect(roundtrip.maxCLBalanceDecreaseBP).to.equal(maxPackedLimits.maxCLBalanceDecreaseBP);
      expect(roundtrip.clBalanceOraclesErrorUpperBPLimit).to.equal(maxPackedLimits.clBalanceOraclesErrorUpperBPLimit);
      expect(roundtrip.consolidationEthAmountPerDayLimit).to.equal(maxPackedLimits.consolidationEthAmountPerDayLimit);
      expect(roundtrip.exitedValidatorEthAmountLimit).to.equal(maxPackedLimits.exitedValidatorEthAmountLimit);
    });

    it("packAndStore caches packed limits in wrapper storage", async () => {
      const wrapper = (await ethers.deployContract("OracleReportSanityCheckerWrapper", [
        await locator.getAddress(),
        await accounting.getAddress(),
        admin.address,
        defaultLimits,
      ])) as OracleReportSanityCheckerWrapper;

      await wrapper.packAndStore();

      const accountingPacked = await wrapper.exposeAccountingCorePackedLimits();
      expect(accountingPacked.exitedEthAmountPerDayLimit).to.equal(defaultLimits.exitedEthAmountPerDayLimit);
      expect(accountingPacked.appearedEthAmountPerDayLimit).to.equal(defaultLimits.appearedEthAmountPerDayLimit);
      expect(accountingPacked.consolidationEthAmountPerDayLimit).to.equal(
        defaultLimits.consolidationEthAmountPerDayLimit,
      );
      expect(accountingPacked.exitedValidatorEthAmountLimit).to.equal(defaultLimits.exitedValidatorEthAmountLimit);
      expect(accountingPacked.annualBalanceIncreaseBPLimit).to.equal(defaultLimits.annualBalanceIncreaseBPLimit);
      expect(accountingPacked.simulatedShareRateDeviationBPLimit).to.equal(
        defaultLimits.simulatedShareRateDeviationBPLimit,
      );
      expect(accountingPacked.maxPositiveTokenRebase).to.equal(defaultLimits.maxPositiveTokenRebase);
      expect(accountingPacked.maxCLBalanceDecreaseBP).to.equal(defaultLimits.maxCLBalanceDecreaseBP);
      expect(accountingPacked.clBalanceOraclesErrorUpperBPLimit).to.equal(
        defaultLimits.clBalanceOraclesErrorUpperBPLimit,
      );

      const operationalPacked = await wrapper.exposeOperationalPackedLimits();
      expect(operationalPacked.maxBalanceExitRequestedPerReportInEth).to.equal(
        defaultLimits.maxBalanceExitRequestedPerReportInEth,
      );
      expect(operationalPacked.maxEffectiveBalanceWeightWCType01).to.equal(
        defaultLimits.maxEffectiveBalanceWeightWCType01,
      );
      expect(operationalPacked.maxEffectiveBalanceWeightWCType02).to.equal(
        defaultLimits.maxEffectiveBalanceWeightWCType02,
      );
      expect(operationalPacked.maxItemsPerExtraDataTransaction).to.equal(defaultLimits.maxItemsPerExtraDataTransaction);
      expect(operationalPacked.maxNodeOperatorsPerExtraDataItem).to.equal(
        defaultLimits.maxNodeOperatorsPerExtraDataItem,
      );
      expect(operationalPacked.requestTimestampMargin).to.equal(defaultLimits.requestTimestampMargin);
    });

    it("slot-local setters do not affect the other packed storage block", async () => {
      await checker.connect(admin).grantRole(await checker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(), manager.address);
      await checker
        .connect(admin)
        .grantRole(await checker.MAX_BALANCE_EXIT_REQUESTED_PER_REPORT_IN_ETH_ROLE(), manager.address);
      await checker
        .connect(admin)
        .grantRole(await checker.MAX_EFFECTIVE_BALANCE_WEIGHTS_MANAGER_ROLE(), manager.address);

      const initialLimits = await checker.getOracleReportLimits();

      await checker.connect(manager).setMaxEffectiveBalanceWeightWCType01(64n);
      const afterOperationalUpdate = await checker.getOracleReportLimits();
      expect(afterOperationalUpdate.maxEffectiveBalanceWeightWCType01).to.equal(64n);
      expect(afterOperationalUpdate.maxPositiveTokenRebase).to.equal(initialLimits.maxPositiveTokenRebase);
      expect(afterOperationalUpdate.exitedEthAmountPerDayLimit).to.equal(initialLimits.exitedEthAmountPerDayLimit);
      expect(afterOperationalUpdate.consolidationEthAmountPerDayLimit).to.equal(
        initialLimits.consolidationEthAmountPerDayLimit,
      );

      await checker.connect(manager).setMaxPositiveTokenRebase(600_000n);
      const afterAccountingUpdate = await checker.getOracleReportLimits();
      expect(afterAccountingUpdate.maxPositiveTokenRebase).to.equal(600_000n);
      expect(afterAccountingUpdate.maxEffectiveBalanceWeightWCType01).to.equal(
        afterOperationalUpdate.maxEffectiveBalanceWeightWCType01,
      );
      expect(afterAccountingUpdate.requestTimestampMargin).to.equal(afterOperationalUpdate.requestTimestampMargin);
      expect(afterAccountingUpdate.maxItemsPerExtraDataTransaction).to.equal(
        afterOperationalUpdate.maxItemsPerExtraDataTransaction,
      );
    });

    it("packed limits helpers revert with BasisPointsOverflow on raw pack over MAX_BASIS_POINTS", async () => {
      const wrapper = (await ethers.deployContract("OracleReportSanityCheckerWrapper", [
        await locator.getAddress(),
        await accounting.getAddress(),
        admin.address,
        defaultLimits,
      ])) as OracleReportSanityCheckerWrapper;

      const malformedLimits = {
        ...defaultLimits,
        annualBalanceIncreaseBPLimit: TOTAL_BASIS_POINTS + 1n,
      };

      await expect(wrapper.packRawLimits(malformedLimits))
        .to.be.revertedWithCustomError(wrapper, "BasisPointsOverflow")
        .withArgs(TOTAL_BASIS_POINTS + 1n, TOTAL_BASIS_POINTS);
    });
  });

  context("standalone sanity checks", () => {
    it("checkExitBusOracleReport", async () => {
      const limit = (await checker.getOracleReportLimits()).maxBalanceExitRequestedPerReportInEth;

      await expect(checker.checkExitBusOracleReport(limit)).not.to.be.reverted;
      await expect(checker.checkExitBusOracleReport(limit + 1n))
        .to.be.revertedWithCustomError(checker, "IncorrectSumOfExitBalancePerReport")
        .withArgs(limit + 1n);
    });

    it("checkExitBusOracleReport allows zero and below-limit values", async () => {
      const limit = (await checker.getOracleReportLimits()).maxBalanceExitRequestedPerReportInEth;
      await expect(checker.checkExitBusOracleReport(0n)).not.to.be.reverted;
      await expect(checker.checkExitBusOracleReport(limit - 1n)).not.to.be.reverted;
    });

    it("checkExitedEthAmountPerDay uses timeElapsed (seconds)", async () => {
      const limits = await checker.getOracleReportLimits();
      const limitWithConsolidationInWei =
        (limits.exitedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1");
      const oneDay = 24n * 60n * 60n;
      const exitedValidatorEthAmountLimit = limits.exitedValidatorEthAmountLimit;
      const exitedValidatorEthAmountLimitInWei = exitedValidatorEthAmountLimit * ether("1");

      await expect(checker.checkExitedEthAmountPerDay(0n, oneDay)).not.to.be.reverted;

      const exitedValidatorsCountForDailyExceededRevert =
        limitWithConsolidationInWei / exitedValidatorEthAmountLimitInWei + 1n;
      const exitedPerDayForDailyExceededRevert =
        exitedValidatorsCountForDailyExceededRevert * exitedValidatorEthAmountLimitInWei;

      await expect(checker.checkExitedEthAmountPerDay(exitedValidatorsCountForDailyExceededRevert, oneDay))
        .to.be.revertedWithCustomError(checker, "ExitedEthAmountPerDayLimitExceeded")
        .withArgs(limitWithConsolidationInWei, exitedPerDayForDailyExceededRevert);

      const exitedPerDayForOneValidatorAndZeroTime = exitedValidatorEthAmountLimitInWei * 86_400n;
      const exitedValidatorsCountForGuaranteedRevert =
        limitWithConsolidationInWei / exitedPerDayForOneValidatorAndZeroTime + 1n;
      const exitedPerDayForGuaranteedRevert =
        exitedValidatorsCountForGuaranteedRevert * exitedPerDayForOneValidatorAndZeroTime;

      await expect(checker.checkExitedEthAmountPerDay(exitedValidatorsCountForGuaranteedRevert, 0n))
        .to.be.revertedWithCustomError(checker, "ExitedEthAmountPerDayLimitExceeded")
        .withArgs(limitWithConsolidationInWei, exitedPerDayForGuaranteedRevert);
    });

    it("checkAppearedEthAmountPerDay includes consolidation limit", async () => {
      const limits = await checker.getOracleReportLimits();
      const limitWithConsolidationInWei =
        (limits.appearedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1");

      await expect(checker.checkAppearedEthAmountPerDay(0n)).not.to.be.reverted;

      const guaranteedExceededAppearedPerDayValue = limitWithConsolidationInWei + 1n;

      await expect(checker.checkAppearedEthAmountPerDay(guaranteedExceededAppearedPerDayValue))
        .to.be.revertedWithCustomError(checker, "AppearedEthAmountPerDayLimitExceeded")
        .withArgs(limitWithConsolidationInWei, guaranteedExceededAppearedPerDayValue);
    });

    it("checkAppearedEthAmountPerDay allows exact configured limit", async () => {
      const limits = await checker.getOracleReportLimits();
      const limitWithConsolidationInWei =
        (limits.appearedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1");

      await expect(checker.checkAppearedEthAmountPerDay(limitWithConsolidationInWei)).not.to.be.reverted;
    });

    it("checkNodeOperatorsPerExtraDataItemCount", async () => {
      const limit = (await checker.getOracleReportLimits()).maxNodeOperatorsPerExtraDataItem;
      await expect(checker.checkNodeOperatorsPerExtraDataItemCount(12n, limit)).not.to.be.reverted;

      await expect(checker.checkNodeOperatorsPerExtraDataItemCount(12n, limit + 1n))
        .to.be.revertedWithCustomError(checker, "TooManyNodeOpsPerExtraDataItem")
        .withArgs(12n, limit + 1n);
    });

    it("checkExtraDataItemsCountPerTransaction", async () => {
      const limit = (await checker.getOracleReportLimits()).maxItemsPerExtraDataTransaction;
      await expect(checker.checkExtraDataItemsCountPerTransaction(limit)).not.to.be.reverted;

      await expect(checker.checkExtraDataItemsCountPerTransaction(limit + 1n))
        .to.be.revertedWithCustomError(checker, "TooManyItemsPerExtraDataTransaction")
        .withArgs(limit, limit + 1n);
    });

    it("checkWithdrawalQueueOracleReport", async () => {
      const now = 1_700_000_000n;
      const margin = (await checker.getOracleReportLimits()).requestTimestampMargin;

      const oldRequestId = 1n;
      const newRequestId = 2n;

      const oldTs = now - margin;
      const newTs = now - margin / 2n;

      await withdrawalQueue.setRequestTimestamp(oldRequestId, oldTs);
      await withdrawalQueue.setRequestTimestamp(newRequestId, newTs);

      await expect(checker.checkWithdrawalQueueOracleReport(oldRequestId, now)).not.to.be.reverted;

      await expect(checker.checkWithdrawalQueueOracleReport(newRequestId, now))
        .to.be.revertedWithCustomError(checker, "IncorrectRequestFinalization")
        .withArgs(newTs);
    });

    context("checkCLPendingBalanceIncrease cold start", () => {
      const oneDay = 24n * 60n * 60n;
      const noDeposits = 0n;
      const unexpectedPendingWei = 1n;
      const coldStartDepositsWei = ether("200");
      const largeColdStartDepositsWei = ether("1000000");
      const firstDayAppearedLimitWei = defaultLimits.appearedEthAmountPerDayLimit * ether("1");
      const pendingAfterExactFirstDayActivationWei = coldStartDepositsWei - firstDayAppearedLimitWei;
      const validatorsBeyondFirstDayLimitWei = firstDayAppearedLimitWei + 1n;
      const pendingAfterExceededFirstDayActivationWei = pendingAfterExactFirstDayActivationWei - 1n;

      it("allows a zero-balance first report without deposits", async () => {
        await expect(checker.checkCLPendingBalanceIncrease(oneDay, 0n, 0n, 0n, 0n, 0n, noDeposits)).not.to.be.reverted;
      });

      it("rejects a positive first report without deposits", async () => {
        await expect(checker.checkCLPendingBalanceIncrease(oneDay, 0n, 0n, 0n, unexpectedPendingWei, 0n, noDeposits))
          .to.be.revertedWithCustomError(checker, "IncorrectTotalPendingBalance")
          .withArgs(0n, 0n, unexpectedPendingWei);
      });

      it("allows the first-report total CL increase up to deposits", async () => {
        await expect(
          checker.checkCLPendingBalanceIncrease(oneDay, 0n, 0n, 0n, coldStartDepositsWei, 0n, coldStartDepositsWei),
        ).not.to.be.reverted;
      });

      it("does not cap first-report deposits by annual growth allowance when they remain pending", async () => {
        await expect(
          checker.checkCLPendingBalanceIncrease(
            oneDay,
            0n,
            0n,
            0n,
            largeColdStartDepositsWei,
            0n,
            largeColdStartDepositsWei,
          ),
        ).not.to.be.reverted;
      });

      it("limits first-report validator activation by appeared ETH amount per day", async () => {
        await expect(
          checker.checkCLPendingBalanceIncrease(
            oneDay,
            0n,
            0n,
            firstDayAppearedLimitWei,
            pendingAfterExactFirstDayActivationWei,
            0n,
            coldStartDepositsWei,
          ),
        ).not.to.be.reverted;

        await expect(
          checker.checkCLPendingBalanceIncrease(
            oneDay,
            0n,
            0n,
            validatorsBeyondFirstDayLimitWei,
            pendingAfterExceededFirstDayActivationWei,
            0n,
            coldStartDepositsWei,
          ),
        )
          .to.be.revertedWithCustomError(checker, "IncorrectTotalPendingBalance")
          .withArgs(
            pendingAfterExactFirstDayActivationWei,
            pendingAfterExceededFirstDayActivationWei,
            pendingAfterExceededFirstDayActivationWei,
          );
      });
    });

    context("checkCLPendingBalanceIncrease with existing state", () => {
      const oneDay = 24n * 60n * 60n;
      const previousValidatorsWei = ether("3650");
      const previousPendingWei = ether("2");
      const allowedActivationWei = ether("1");
      const excessiveActivationWei = ether("2");

      it("allows a non-cold-start report within the pending corridor", async () => {
        await expect(
          checker.checkCLPendingBalanceIncrease(
            oneDay,
            previousValidatorsWei,
            previousPendingWei,
            previousValidatorsWei + allowedActivationWei,
            previousPendingWei - allowedActivationWei,
            0n,
            0n,
          ),
        ).not.to.be.reverted;
      });

      it("reverts with IncorrectCLBalanceIncrease when appeared balance exceeds the pending-backed limit", async () => {
        await expect(
          checker.checkCLPendingBalanceIncrease(
            oneDay,
            previousValidatorsWei,
            0n,
            previousValidatorsWei + excessiveActivationWei,
            0n,
            0n,
            0n,
          ),
        )
          .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceIncrease")
          .withArgs(excessiveActivationWei);
      });

      it("reverts with InvalidClBalancesData when CL withdrawals exceed previous validators balance", async () => {
        await expect(
          checker.checkCLPendingBalanceIncrease(oneDay, ether("10"), 0n, 0n, 0n, ether("11"), 0n),
        ).to.be.revertedWithCustomError(checker, "InvalidClBalancesData");
      });
    });
  });

  context("checkCLBalancesConsistency", () => {
    it("reverts on array length mismatch", async () => {
      await expect(checker.checkCLBalancesConsistency([1n], [10n], [], 10n, 0n)).to.be.revertedWithCustomError(
        checker,
        "InvalidClBalancesData",
      );
    });

    it("reverts when module sums are inconsistent", async () => {
      await expect(checker.checkCLBalancesConsistency([1n, 2n], [10n, 20n], [1n, 2n], 40n, 3n))
        .to.be.revertedWithCustomError(checker, "InconsistentValidatorsBalanceByModule")
        .withArgs(40n, 30n);
    });

    it("passes with consistent data", async () => {
      await expect(checker.checkCLBalancesConsistency([1n, 2n], [10n, 20n], [1n, 2n], 30n, 3n)).not.to.be.reverted;
    });

    it("reverts when pending sums are inconsistent", async () => {
      await expect(checker.checkCLBalancesConsistency([1n, 2n], [10n, 20n], [1n, 2n], 30n, 4n))
        .to.be.revertedWithCustomError(checker, "InconsistentPendingBalanceByModule")
        .withArgs(4n, 3n);
    });

    it("passes for empty arrays and zero totals", async () => {
      await expect(checker.checkCLBalancesConsistency([], [], [], 0n, 0n)).not.to.be.reverted;
    });
  });

  context("checkAccountingOracleReport", () => {
    const baseReport = {
      timeElapsed: 24n * 60n * 60n,
      preCLBalance: ether("100000"),
      postCLBalance: ether("100001"),
      preCLPendingBalance: 0n,
      postCLPendingBalance: 0n,
      withdrawalVaultBalance: 0n,
      elRewardsVaultBalance: 0n,
      sharesRequestedToBurn: 0n,
      deposits: 0n,
      withdrawalsVaultTransfer: 0n,
    };

    const report = (
      overrides: Partial<typeof baseReport> = {},
    ): [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint] => {
      const r = { ...baseReport, ...overrides };
      return [
        r.timeElapsed,
        r.preCLBalance - r.preCLPendingBalance - r.deposits,
        r.preCLPendingBalance,
        r.postCLBalance - r.postCLPendingBalance,
        r.postCLPendingBalance,
        r.withdrawalVaultBalance,
        r.elRewardsVaultBalance,
        r.sharesRequestedToBurn,
        r.deposits,
        r.withdrawalsVaultTransfer,
      ];
    };

    let accountingSigner: HardhatEthersSigner;

    before(async () => {
      accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));
    });

    it("reverts when not called by accounting", async () => {
      await expect(checker.connect(stranger).checkAccountingOracleReport(...report())).to.be.revertedWithCustomError(
        checker,
        "CalledNotFromAccounting",
      );
    });

    it("reverts when withdrawal vault balance is overstated", async () => {
      const actual = await ethers.provider.getBalance(withdrawalVault.address);
      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(...report({ withdrawalVaultBalance: actual + 1n })),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectWithdrawalsVaultBalance")
        .withArgs(actual);
    });

    it("reverts when EL rewards vault balance is overstated", async () => {
      const actual = await ethers.provider.getBalance(elRewardsVault.address);
      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(...report({ elRewardsVaultBalance: actual + 1n })),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectELRewardsVaultBalance")
        .withArgs(actual);
    });

    it("reverts when withdrawals vault transfer exceeds reported vault balance", async () => {
      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(...report({ withdrawalVaultBalance: 10n, withdrawalsVaultTransfer: 11n })),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectWithdrawalsVaultTransfer")
        .withArgs(10n, 11n);
    });

    it("reverts when shares requested to burn are overstated", async () => {
      await burner.setSharesRequestedToBurn(10n, 21n);

      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(...report({ sharesRequestedToBurn: 32n })),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectSharesRequestedToBurn")
        .withArgs(31n);
    });

    it("reverts when positive CL increase exceeds the pending-backed one-day allowance", async () => {
      const preCLBalance = 3_650_000n;
      const postCLBalance = preCLBalance + 1_001n;
      const clIncrease = postCLBalance - preCLBalance;

      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(...report({ preCLBalance, postCLBalance })),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceIncrease")
        .withArgs(clIncrease);
    });

    it("reverts when a one-day positive CL increase exceeds the pending-backed allowance", async () => {
      const preCLBalance = ether("1000000");
      const postCLBalance = preCLBalance + ether("274");
      const clIncrease = ether("274");

      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(
          ...report({
            preCLBalance,
            postCLBalance,
            timeElapsed: 24n * 60n * 60n,
          }),
        ),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceIncrease")
        .withArgs(clIncrease);
    });

    it("passes with valid report", async () => {
      await expect(checker.connect(accountingSigner).checkAccountingOracleReport(...report())).not.to.be.reverted;
    });

    it("allows cold-start onboarding from deposits into pending and then into validators", async () => {
      const deposits = ether("200");
      const activated = ether("100");

      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(
          ...report({
            preCLBalance: deposits,
            postCLBalance: deposits,
            preCLPendingBalance: 0n,
            postCLPendingBalance: deposits,
            deposits,
          }),
        ),
      ).not.to.be.reverted;

      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(
          ...report({
            preCLBalance: deposits,
            postCLBalance: deposits,
            preCLPendingBalance: deposits,
            postCLPendingBalance: deposits - activated,
            deposits: 0n,
          }),
        ),
      ).not.to.be.reverted;
    });

    it("does not skip cold-start pending sanity on the first report", async () => {
      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(
          ...report({
            preCLBalance: 0n,
            postCLBalance: 1n,
            preCLPendingBalance: 0n,
            postCLPendingBalance: 1n,
            deposits: 0n,
          }),
        ),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectTotalPendingBalance")
        .withArgs(0n, 0n, 1n);
    });

    it("reverts when validator decrease is hidden by pending increase", async () => {
      const preCLBalance = ether("10000");
      const postCLBalance = preCLBalance;
      const postCLPendingBalance = ether("1000");
      const secondsInOneYear = 365n * 24n * 60n * 60n;
      const expectedMaxPendingLimit =
        (preCLBalance * defaultLimits.annualBalanceIncreaseBPLimit * baseReport.timeElapsed) /
        secondsInOneYear /
        TOTAL_BASIS_POINTS;

      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(
          ...report({
            preCLBalance,
            postCLBalance,
            postCLPendingBalance,
          }),
        ),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectTotalPendingBalance")
        .withArgs(0n, expectedMaxPendingLimit, postCLPendingBalance);
    });

    it("handles CL balance increase exactly at appeared ETH amount limit", async () => {
      const preCLBalance = ether("1000000");
      const postCLBalance = preCLBalance + ether("100");

      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(
          ...report({
            preCLBalance,
            postCLBalance,
            timeElapsed: 24n * 60n * 60n,
          }),
        ),
      ).not.to.be.reverted;
    });

    it("handles zero time elapsed path for annual increase", async () => {
      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(
          ...report({
            preCLBalance: ether("100000"),
            postCLBalance: ether("100000") + 1n,
            timeElapsed: 0n,
          }),
        ),
      ).not.to.be.reverted;
    });

    it("handles zero time elapsed path for CL balance increase normalization", async () => {
      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(
          ...report({
            preCLBalance: ether("1000000"),
            postCLBalance: ether("1000000") + 1n,
            timeElapsed: 0n,
          }),
        ),
      ).not.to.be.reverted;
    });

    it("handles zero pre CL balance for annual increase", async () => {
      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(
          ...report({
            preCLBalance: 1n,
            postCLBalance: 1n,
          }),
        ),
      ).not.to.be.reverted;
    });

    it("stores post-cl balance snapshots in reportData", async () => {
      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(...report({ preCLBalance: ether("100"), postCLBalance: ether("100") })),
      ).not.to.be.reverted;
      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(
            ...report({ preCLBalance: ether("100"), postCLBalance: ether("100"), deposits: 2n }),
          ),
      ).not.to.be.reverted;

      expect(await checker.getReportDataCount()).to.equal(2n);

      const first = await checker.reportData(0n);
      const second = await checker.reportData(1n);
      expect(first.timestamp).to.equal(24n * 60n * 60n);
      expect(first.clBalance).to.equal(ether("100"));
      expect(first.deposits).to.equal(0n);
      expect(first.clWithdrawals).to.equal(0n);
      expect(second.timestamp).to.equal(2n * 24n * 60n * 60n);
      expect(second.clBalance).to.equal(ether("100"));
      expect(second.deposits).to.equal(2n);
      expect(second.clWithdrawals).to.equal(0n);
    });
  });

  context("checkAccountingOracleReport: CL decrease window and second opinion", () => {
    const baseWindowReport = {
      timeElapsed: 24n * 60n * 60n,
      preCLBalance: ether("100"),
      postCLBalance: ether("100"),
      preCLPendingBalance: 0n,
      postCLPendingBalance: 0n,
      withdrawalVaultBalance: 0n,
      elRewardsVaultBalance: 0n,
      sharesRequestedToBurn: 0n,
      deposits: 0n,
      withdrawalsVaultTransfer: 0n,
    };

    const report = (
      overrides: Partial<typeof baseWindowReport> = {},
    ): [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint] => {
      const r = { ...baseWindowReport, ...overrides };
      return [
        r.timeElapsed,
        r.preCLBalance - r.preCLPendingBalance - r.deposits,
        r.preCLPendingBalance,
        r.postCLBalance - r.postCLPendingBalance,
        r.postCLPendingBalance,
        r.withdrawalVaultBalance,
        r.elRewardsVaultBalance,
        r.sharesRequestedToBurn,
        r.deposits,
        r.withdrawalsVaultTransfer,
      ];
    };

    let accountingSigner: HardhatEthersSigner;

    before(async () => {
      accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));
    });

    it("emits NegativeCLRebaseAccepted when decrease is within limit", async () => {
      await checker.connect(accountingSigner).checkAccountingOracleReport(...report());

      await accountingOracle.setLastProcessingRefSlot(42n);
      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(...report({ preCLBalance: ether("100"), postCLBalance: ether("97") })),
      )
        .to.emit(checker, "NegativeCLRebaseAccepted")
        .withArgs(42n, ether("97"), ether("3"), ether("3.6"));
    });

    it("uses 36-day timestamp window (not report count) and keeps left boundary report in range", async () => {
      const ONE_DAY = 24n * 60n * 60n;

      // Report timestamps become: day 1, day 10, day 46.
      // For the third report, windowStart = 46 - 36 = day 10.
      // So baseline must be day 10 report (left boundary is included), not day 1.
      await checker
        .connect(accountingSigner)
        .checkAccountingOracleReport(
          ...report({ timeElapsed: ONE_DAY, preCLBalance: ether("50"), postCLBalance: ether("50") }),
        );
      await checker
        .connect(accountingSigner)
        .checkAccountingOracleReport(
          ...report({ timeElapsed: 9n * ONE_DAY, preCLBalance: ether("100"), postCLBalance: ether("100") }),
        );

      await accountingOracle.setLastProcessingRefSlot(314n);
      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(
            ...report({ timeElapsed: 36n * ONE_DAY, preCLBalance: ether("100"), postCLBalance: ether("97") }),
          ),
      )
        .to.emit(checker, "NegativeCLRebaseAccepted")
        .withArgs(314n, ether("97"), ether("3"), ether("3.6"));

      expect(await checker.getReportDataCount()).to.equal(3n);
      const first = await checker.reportData(0n);
      const second = await checker.reportData(1n);
      const third = await checker.reportData(2n);
      expect(first.timestamp).to.equal(ONE_DAY);
      expect(second.timestamp).to.equal(10n * ONE_DAY);
      expect(third.timestamp).to.equal(46n * ONE_DAY);
    });

    it("excludes all outdated snapshots from the window after a long gap", async () => {
      const ONE_DAY = 24n * 60n * 60n;

      await checker
        .connect(accountingSigner)
        .checkAccountingOracleReport(
          ...report({ timeElapsed: ONE_DAY, preCLBalance: ether("100"), postCLBalance: ether("100") }),
        );
      await checker
        .connect(accountingSigner)
        .checkAccountingOracleReport(
          ...report({ timeElapsed: ONE_DAY, preCLBalance: ether("100"), postCLBalance: ether("100") }),
        );

      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(
            ...report({ timeElapsed: 48n * ONE_DAY, preCLBalance: ether("100"), postCLBalance: ether("90") }),
          ),
      ).not.to.be.reverted;

      expect(await checker.getReportDataCount()).to.equal(3n);
      const third = await checker.reportData(2n);
      expect(third.timestamp).to.equal(50n * ONE_DAY);
      expect(third.clBalance).to.equal(ether("90"));
    });

    it("uses absolute window diff between baseline and current balances", async () => {
      await checker.connect(admin).grantRole(await checker.MAX_CL_BALANCE_DECREASE_MANAGER_ROLE(), manager.address);
      await checker.connect(manager).setMaxCLBalanceDecreaseBP(1n);

      await checker
        .connect(accountingSigner)
        .checkAccountingOracleReport(...report({ preCLBalance: ether("100000"), postCLBalance: ether("100000") }));
      await checker
        .connect(accountingSigner)
        .checkAccountingOracleReport(...report({ preCLBalance: ether("100000"), postCLBalance: ether("100020") }));

      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(...report({ preCLBalance: ether("100020"), postCLBalance: ether("100015") })),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
        .withArgs(ether("15"), ether("10"));
    });

    it("reverts with IncorrectCLBalanceDecrease when decrease exceeds limit and no second opinion", async () => {
      await checker.connect(accountingSigner).checkAccountingOracleReport(...report());

      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(...report({ preCLBalance: ether("100"), postCLBalance: ether("90") })),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
        .withArgs(ether("10"), ether("3.6"));
    });

    it("reverts with IncorrectCLBalanceDecreaseWindowData on baseline/flows underflow", async () => {
      await checker.connect(accountingSigner).checkAccountingOracleReport(...report());

      await expect(
        checker.connect(accountingSigner).checkAccountingOracleReport(
          ...report({
            preCLBalance: ether("300"),
            postCLBalance: ether("90"),
            withdrawalVaultBalance: ether("200"),
            deposits: 0n,
          }),
        ),
      )
        .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecreaseWindowData")
        .withArgs(ether("100"), 0n, ether("200"));
    });

    it("reverts with NegativeRebaseFailedSecondOpinionReportIsNotReady when second opinion report is absent", async () => {
      const secondOpinion = await ethers.deployContract("SecondOpinionOracle__Mock");

      await checker.connect(admin).grantRole(await checker.SECOND_OPINION_MANAGER_ROLE(), manager.address);
      await checker
        .connect(manager)
        .setSecondOpinionOracleAndCLBalanceUpperMargin(await secondOpinion.getAddress(), 50n);

      await checker.connect(accountingSigner).checkAccountingOracleReport(...report());
      await accountingOracle.setLastProcessingRefSlot(77n);

      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(...report({ preCLBalance: ether("100"), postCLBalance: ether("90") })),
      ).to.be.revertedWithCustomError(checker, "NegativeRebaseFailedSecondOpinionReportIsNotReady");
    });

    it("reverts with NegativeRebaseFailedCLBalanceMismatch when second opinion CL balance is lower", async () => {
      const secondOpinion = await ethers.deployContract("SecondOpinionOracle__Mock");

      await checker.connect(admin).grantRole(await checker.SECOND_OPINION_MANAGER_ROLE(), manager.address);
      await checker
        .connect(manager)
        .setSecondOpinionOracleAndCLBalanceUpperMargin(await secondOpinion.getAddress(), 50n);

      await secondOpinion.addPlainReport(77n, ether("89") / 1_000_000_000n, 0n);
      await checker.connect(accountingSigner).checkAccountingOracleReport(...report());
      await accountingOracle.setLastProcessingRefSlot(77n);

      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(...report({ preCLBalance: ether("100"), postCLBalance: ether("90") })),
      )
        .to.be.revertedWithCustomError(checker, "NegativeRebaseFailedCLBalanceMismatch")
        .withArgs(ether("90"), ether("89"), 50n);
    });

    it("reverts with NegativeRebaseFailedCLBalanceMismatch when second opinion deviation exceeds upper BP limit", async () => {
      const secondOpinion = await ethers.deployContract("SecondOpinionOracle__Mock");

      await checker.connect(admin).grantRole(await checker.SECOND_OPINION_MANAGER_ROLE(), manager.address);
      await checker
        .connect(manager)
        .setSecondOpinionOracleAndCLBalanceUpperMargin(await secondOpinion.getAddress(), 50n);

      await secondOpinion.addPlainReport(77n, ether("100") / 1_000_000_000n, 0n);
      await checker.connect(accountingSigner).checkAccountingOracleReport(...report());
      await accountingOracle.setLastProcessingRefSlot(77n);

      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(...report({ preCLBalance: ether("100"), postCLBalance: ether("90") })),
      )
        .to.be.revertedWithCustomError(checker, "NegativeRebaseFailedCLBalanceMismatch")
        .withArgs(ether("90"), ether("100"), 50n);
    });

    it("reverts with NegativeRebaseFailedWithdrawalVaultBalanceMismatch when second opinion withdrawal balance differs", async () => {
      const secondOpinion = await ethers.deployContract("SecondOpinionOracle__Mock");

      await checker.connect(admin).grantRole(await checker.SECOND_OPINION_MANAGER_ROLE(), manager.address);
      await checker
        .connect(manager)
        .setSecondOpinionOracleAndCLBalanceUpperMargin(await secondOpinion.getAddress(), 50n);

      await secondOpinion.addPlainReport(77n, ether("90.4") / 1_000_000_000n, 1n);
      await checker.connect(accountingSigner).checkAccountingOracleReport(...report());
      await accountingOracle.setLastProcessingRefSlot(77n);

      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(...report({ preCLBalance: ether("100"), postCLBalance: ether("90") })),
      )
        .to.be.revertedWithCustomError(checker, "NegativeRebaseFailedWithdrawalVaultBalanceMismatch")
        .withArgs(0n, 1n);
    });

    it("emits NegativeCLRebaseConfirmed when second opinion validates report", async () => {
      const secondOpinion = await ethers.deployContract("SecondOpinionOracle__Mock");

      await checker.connect(admin).grantRole(await checker.SECOND_OPINION_MANAGER_ROLE(), manager.address);
      await checker
        .connect(manager)
        .setSecondOpinionOracleAndCLBalanceUpperMargin(await secondOpinion.getAddress(), 50n);

      await secondOpinion.addPlainReport(77n, ether("90.4") / 1_000_000_000n, 0n);
      await checker.connect(accountingSigner).checkAccountingOracleReport(...report());
      await accountingOracle.setLastProcessingRefSlot(77n);

      await expect(
        checker
          .connect(accountingSigner)
          .checkAccountingOracleReport(...report({ preCLBalance: ether("100"), postCLBalance: ether("90") })),
      )
        .to.emit(checker, "NegativeCLRebaseConfirmed")
        .withArgs(77n, ether("90"), 0n);
    });
  });

  context("checkSimulatedShareRate", () => {
    const SHARE_RATE_PRECISION_E27 = 10n ** 27n;

    const actualShareRate = (
      postInternalEther: bigint,
      postInternalShares: bigint,
      etherToFinalizeWQ: bigint,
      sharesToBurnForWithdrawals: bigint,
    ) =>
      ((postInternalEther + etherToFinalizeWQ) * SHARE_RATE_PRECISION_E27) /
      (postInternalShares + sharesToBurnForWithdrawals);

    it("passes when simulated rate equals actual rate", async () => {
      const postInternalEther = ether("100");
      const postInternalShares = ether("100");
      const simulated = actualShareRate(postInternalEther, postInternalShares, 0n, 0n);

      await expect(checker.checkSimulatedShareRate(postInternalEther, postInternalShares, 0n, 0n, simulated)).not.to.be
        .reverted;
    });

    it("passes when deviation is below configured limit", async () => {
      const postInternalEther = ether("100");
      const postInternalShares = ether("100");
      const actual = actualShareRate(postInternalEther, postInternalShares, 0n, 0n);
      const simulated = actual + (actual * 200n) / TOTAL_BASIS_POINTS;

      await expect(checker.checkSimulatedShareRate(postInternalEther, postInternalShares, 0n, 0n, simulated)).not.to.be
        .reverted;
    });

    it("reverts when deviation is above configured limit", async () => {
      const postInternalEther = ether("100");
      const postInternalShares = ether("100");
      const actual = actualShareRate(postInternalEther, postInternalShares, 0n, 0n);
      const simulated = actual + (actual * 251n) / TOTAL_BASIS_POINTS;

      await expect(checker.checkSimulatedShareRate(postInternalEther, postInternalShares, 0n, 0n, simulated))
        .to.be.revertedWithCustomError(checker, "IncorrectSimulatedShareRate")
        .withArgs(simulated, actual);
    });

    it("accounts for withdrawal finalization offsets in actual rate", async () => {
      const postInternalEther = ether("90");
      const postInternalShares = ether("90");
      const etherToFinalizeWQ = ether("10");
      const sharesToBurnForWithdrawals = ether("10");
      const simulated = actualShareRate(
        postInternalEther,
        postInternalShares,
        etherToFinalizeWQ,
        sharesToBurnForWithdrawals,
      );

      await expect(
        checker.checkSimulatedShareRate(
          postInternalEther,
          postInternalShares,
          etherToFinalizeWQ,
          sharesToBurnForWithdrawals,
          simulated,
        ),
      ).not.to.be.reverted;
    });
  });

  context("migrateBaselineSnapshot", () => {
    const MIGRATION_WITHDRAWALS = ether("57600");

    it("reverts if called by non-manager", async () => {
      const { checkerWithLidoStats: migrationChecker } = await deployCheckerWithLidoStats(4n);

      await expect(migrationChecker.connect(stranger).migrateBaselineSnapshot()).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await migrationChecker.MIGRATION_MANAGER_ROLE(),
      );
    });

    it("reverts on unexpected Lido version", async () => {
      const { checkerWithLidoStats: migrationChecker } = await deployCheckerWithLidoStats(3n);

      await migrationChecker.connect(admin).grantRole(await migrationChecker.MIGRATION_MANAGER_ROLE(), manager.address);
      await expect(migrationChecker.connect(manager).migrateBaselineSnapshot())
        .to.be.revertedWithCustomError(migrationChecker, "UnexpectedLidoVersion")
        .withArgs(3n, 4n);
    });

    it("seeds baseline and bootstrap report snapshots", async () => {
      const { checkerWithLidoStats: migrationChecker } = await deployCheckerWithLidoStats(4n);

      await migrationChecker.connect(admin).grantRole(await migrationChecker.MIGRATION_MANAGER_ROLE(), manager.address);
      await expect(migrationChecker.connect(manager).migrateBaselineSnapshot())
        .to.emit(migrationChecker, "BaselineSnapshotMigrated")
        .withArgs(ether("107"), ether("3"), MIGRATION_WITHDRAWALS);

      expect(await migrationChecker.getReportDataCount()).to.equal(2n);

      const baselineReport = await migrationChecker.reportData(0n);
      const bootstrapFlowReport = await migrationChecker.reportData(1n);

      expect(baselineReport.timestamp).to.equal(0n);
      expect(baselineReport.clBalance).to.equal(ether("107"));
      expect(baselineReport.deposits).to.equal(0n);
      expect(baselineReport.clWithdrawals).to.equal(0n);

      expect(bootstrapFlowReport.timestamp).to.equal(0n);
      expect(bootstrapFlowReport.clBalance).to.equal(ether("107"));
      expect(bootstrapFlowReport.deposits).to.equal(ether("3"));
      expect(bootstrapFlowReport.clWithdrawals).to.equal(MIGRATION_WITHDRAWALS);
    });

    it("uses migrated bootstrap flows in first CL decrease window check", async () => {
      const migratedCLBalance = ether("107000");
      const migrationDeposits = ether("3");
      const reportDecrease = ether("2500");

      const { checkerWithLidoStats: migrationChecker } = await deployCheckerWithLidoStats(4n, {
        clActive: ether("100000"),
        clPending: ether("7000"),
        deposits: migrationDeposits,
      });

      await migrationChecker.connect(admin).grantRole(await migrationChecker.MIGRATION_MANAGER_ROLE(), manager.address);
      await migrationChecker.connect(manager).migrateBaselineSnapshot();

      const accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));
      const withdrawalVaultBalance = await ethers.provider.getBalance(withdrawalVault.address);

      const maxAllowedCLBalanceDecrease =
        ((migratedCLBalance + migrationDeposits - MIGRATION_WITHDRAWALS) * defaultLimits.maxCLBalanceDecreaseBP) /
        TOTAL_BASIS_POINTS;

      await expect(
        migrationChecker
          .connect(accountingSigner)
          .checkAccountingOracleReport(
            24n * 60n * 60n,
            migratedCLBalance,
            0n,
            migratedCLBalance - reportDecrease,
            0n,
            withdrawalVaultBalance,
            0n,
            0n,
            0n,
            0n,
          ),
      )
        .to.be.revertedWithCustomError(migrationChecker, "IncorrectCLBalanceDecrease")
        .withArgs(reportDecrease, maxAllowedCLBalanceDecrease);
    });

    it("reverts when migration is called more than once", async () => {
      const { checkerWithLidoStats: migrationChecker } = await deployCheckerWithLidoStats(4n);

      await migrationChecker.connect(admin).grantRole(await migrationChecker.MIGRATION_MANAGER_ROLE(), manager.address);
      await migrationChecker.connect(manager).migrateBaselineSnapshot();
      await expect(migrationChecker.connect(manager).migrateBaselineSnapshot()).to.be.revertedWithCustomError(
        migrationChecker,
        "MigrationAlreadyDone",
      );
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
      await checker.connect(admin).grantRole(await checker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(), manager.address);
    });

    it("works with zero data", async () => {
      const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
        ...report(),
      );

      expect(withdrawals).to.equal(0n);
      expect(elRewards).to.equal(0n);
      expect(sharesFromWQToBurn).to.equal(0n);
      expect(sharesToBurn).to.equal(0n);
    });

    context("trivial post CL < pre CL", () => {
      before(async () => {
        await checker.connect(manager).setMaxPositiveTokenRebase(100_000n);
      });

      it("smoothens with no rewards and no withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ postCLBalance: ether("99") }),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(0n);
      });

      it("smoothens with el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ postCLBalance: ether("99"), elRewardsVaultBalance: ether("0.1") }),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(ether("0.1"));
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(0n);
      });

      it("smoothens with withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ postCLBalance: ether("99"), withdrawalVaultBalance: ether("0.1") }),
        );

        expect(withdrawals).to.equal(ether("0.1"));
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(0n);
      });

      it("smoothens with shares requested to burn", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ postCLBalance: ether("99"), sharesRequestedToBurn: ether("0.1") }),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(ether("0.1"));
      });
    });

    context("trivial post CL > pre CL", () => {
      before(async () => {
        await checker.connect(manager).setMaxPositiveTokenRebase(100_000_000n);
      });

      it("smoothens with no rewards and no withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ postCLBalance: ether("100.01") }),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(0n);
      });

      it("smoothens with el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ postCLBalance: ether("100.01"), elRewardsVaultBalance: ether("0.1") }),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(ether("0.1"));
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(0n);
      });

      it("smoothens with withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ postCLBalance: ether("100.01"), withdrawalVaultBalance: ether("0.1") }),
        );

        expect(withdrawals).to.equal(ether("0.1"));
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(0n);
      });

      it("smoothens with shares requested to burn", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ postCLBalance: ether("100.01"), sharesRequestedToBurn: ether("0.1") }),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(ether("0.1"));
      });
    });

    context("non-trivial post CL < pre CL", () => {
      before(async () => {
        await checker.connect(manager).setMaxPositiveTokenRebase(10_000_000n);
      });

      it("smoothens with no rewards and no withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ postCLBalance: ether("99") }),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(0n);
      });

      it("smoothens with el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ postCLBalance: ether("99"), elRewardsVaultBalance: ether("5") }),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(ether("2"));
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(0n);
      });

      it("smoothens with withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ postCLBalance: ether("99"), withdrawalVaultBalance: ether("5") }),
        );

        expect(withdrawals).to.equal(ether("2"));
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(0n);
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
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(0n);
      });

      it("smoothens with shares requested to burn", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ postCLBalance: ether("99"), sharesRequestedToBurn: ether("5") }),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(1980198019801980198n);
      });
    });

    context("non-trivial post CL > pre CL", () => {
      before(async () => {
        await checker.connect(manager).setMaxPositiveTokenRebase(20_000_000n);
      });

      it("smoothens with no rewards and no withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ postCLBalance: ether("101") }),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(0n);
      });

      it("smoothens with el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ postCLBalance: ether("101"), elRewardsVaultBalance: ether("5") }),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(ether("1"));
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(0n);
      });

      it("smoothens with withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ postCLBalance: ether("101"), withdrawalVaultBalance: ether("5") }),
        );

        expect(withdrawals).to.equal(ether("1"));
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(0n);
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
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(0n);
      });

      it("smoothens with shares requested to burn", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ postCLBalance: ether("101"), sharesRequestedToBurn: ether("5") }),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(0n);
        expect(sharesToBurn).to.equal(980392156862745098n);
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
        await checker.connect(manager).setMaxPositiveTokenRebase(5_000_000n);
      });

      it("smoothens with no rewards and no withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report(defaultRebaseParams),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(ether("10"));
        expect(sharesToBurn).to.equal(ether("10"));
      });

      it("smoothens with el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ ...defaultRebaseParams, elRewardsVaultBalance: ether("5") }),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(ether("1.5"));
        expect(sharesFromWQToBurn).to.equal(9950248756218905472n);
        expect(sharesToBurn).to.equal(9950248756218905472n);
      });

      it("smoothens with withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ ...defaultRebaseParams, withdrawalVaultBalance: ether("5") }),
        );

        expect(withdrawals).to.equal(ether("1.5"));
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(9950248756218905472n);
        expect(sharesToBurn).to.equal(9950248756218905472n);
      });

      it("smoothens with withdrawals and el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ ...defaultRebaseParams, withdrawalVaultBalance: ether("5"), elRewardsVaultBalance: ether("5") }),
        );

        expect(withdrawals).to.equal(ether("1.5"));
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(9950248756218905472n);
        expect(sharesToBurn).to.equal(9950248756218905472n);
      });

      it("smoothens with shares requested to burn", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ ...defaultRebaseParams, sharesRequestedToBurn: ether("5") }),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(9950248756218905473n);
        expect(sharesToBurn).to.equal(11442786069651741293n);
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
        await checker.connect(manager).setMaxPositiveTokenRebase(40_000_000n);
      });

      it("smoothens with no rewards and no withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report(defaultRebaseParams),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(ether("10"));
        expect(sharesToBurn).to.equal(ether("10"));
      });

      it("smoothens with el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ ...defaultRebaseParams, elRewardsVaultBalance: ether("5") }),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(ether("2"));
        expect(sharesFromWQToBurn).to.equal(9615384615384615384n);
        expect(sharesToBurn).to.equal(9615384615384615384n);
      });

      it("smoothens with withdrawals", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ ...defaultRebaseParams, withdrawalVaultBalance: ether("5") }),
        );

        expect(withdrawals).to.equal(ether("2"));
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(9615384615384615384n);
        expect(sharesToBurn).to.equal(9615384615384615384n);
      });

      it("smoothens with withdrawals and el rewards", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ ...defaultRebaseParams, withdrawalVaultBalance: ether("5"), elRewardsVaultBalance: ether("5") }),
        );

        expect(withdrawals).to.equal(ether("2"));
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(9615384615384615384n);
        expect(sharesToBurn).to.equal(9615384615384615384n);
      });

      it("smoothens with shares requested to burn", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report({ ...defaultRebaseParams, sharesRequestedToBurn: ether("5") }),
        );

        expect(withdrawals).to.equal(0n);
        expect(elRewards).to.equal(0n);
        expect(sharesFromWQToBurn).to.equal(9615384615384615385n);
        expect(sharesToBurn).to.equal(11538461538461538461n);
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
        sharesRequestedToBurn: 0n,
        etherToLockForWithdrawals: ether("40000"),
        newSharesToBurnForWithdrawals: ether("40000"),
      };

      before(async () => {
        await checker.connect(manager).setMaxPositiveTokenRebase(1_000_000n);
      });

      it("smoothens the rebase", async () => {
        const { withdrawals, elRewards, sharesFromWQToBurn, sharesToBurn } = await checker.smoothenTokenRebase(
          ...report(rebaseParams),
        );

        expect(withdrawals).to.equal(ether("500"));
        expect(elRewards).to.equal(ether("500"));
        expect(sharesFromWQToBurn).to.equal(39960039960039960039960n);
        expect(sharesToBurn).to.equal(39960039960039960039960n);
      });
    });

    context("rounding case from Goerli", () => {
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
        await checker.connect(manager).setMaxPositiveTokenRebase(750_000n);
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
});
