import { expect } from "chai";
import { ethers } from "hardhat";

import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { ether } from "lib";

const ONE_DAY = 24n * 60n * 60n;
const ONE_HOUR = 60n * 60n;
const ONE_GWEI = 10n ** 9n;
const MAX_VALIDATOR_EFFECTIVE_BALANCE = ether("2048");
const TOTAL_BASIS_POINTS = 10_000n;
const DAYS_PER_YEAR = 365n;

const limits = {
  exitedEthAmountPerDayLimit: 100n,
  appearedEthAmountPerDayLimit: 100n,
  annualCLRebaseIncreaseSoftBPLimit: 2_000n,
  simulatedShareRateDeviationBPLimit: 250n,
  maxBalanceExitRequestedPerReportInEth: 65_000n,
  maxEffectiveBalanceWeightWCType01: 32n,
  maxEffectiveBalanceWeightWCType02: 2_048n,
  maxItemsPerExtraDataTransaction: 15n,
  maxNodeOperatorsPerExtraDataItem: 16n,
  requestTimestampMargin: 128n,
  annualCLRebaseIncreaseHardBPLimit: 3_000n,
  clRebaseDecreaseSoftBPLimit: 100n,
  clRebaseDecreaseHardBPLimit: 500n,
  consolidationEthAmountPerDayLimit: 10n,
  exitedValidatorEthAmountLimit: 32n,
  externalPendingBalanceCapEth: 5n,
};

describe("OracleReportSanityChecker: module and CL balances", () => {
  async function deployFixture() {
    const [deployer, admin, elRewardsVault, withdrawalVault] = await ethers.getSigners();
    const burner = await ethers.deployContract("Burner__MockForSanityChecker");
    const withdrawalQueue = await ethers.deployContract("WithdrawalQueue__MockForSanityChecker");
    const stakingRouter = await ethers.deployContract("StakingRouter__MockForAccountingOracle");
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
        accounting: deployer.address,
        predepositGuarantee: deployer.address,
        wstETH: deployer.address,
        vaultHub: deployer.address,
        vaultFactory: deployer.address,
        lazyOracle: deployer.address,
        operatorGrid: deployer.address,
        topUpGateway: deployer.address,
      },
    ]);
    const checker = await ethers.deployContract("OracleReportSanityChecker", [
      await locator.getAddress(),
      deployer.address,
      admin.address,
      limits,
      ethers.ZeroAddress,
    ]);

    const seedPreviousBalances = async (moduleIds: bigint[], validatorBalancesWei: bigint[]) => {
      for (const moduleId of moduleIds) {
        await stakingRouter.mock__registerStakingModule(moduleId);
      }
      await stakingRouter.reportValidatorBalancesByStakingModule(
        moduleIds,
        validatorBalancesWei.map((balance) => balance / ONE_GWEI),
      );
    };

    return { admin, checker, stakingRouter, seedPreviousBalances };
  }

  it("requires matching arrays and a module sum equal to the reported validators balance", async () => {
    const { checker } = await loadFixture(deployFixture);

    await expect(checker.checkModuleAndCLBalancesChangeRates([], [], 0n, 0n, 0n, 0n, 0n, ONE_DAY)).not.to.be.reverted;
    await expect(
      checker.checkModuleAndCLBalancesChangeRates([1n], [], 0n, 0n, 0n, 0n, 0n, ONE_DAY),
    ).to.be.revertedWithCustomError(checker, "InvalidClBalancesData");
    await expect(
      checker.checkModuleAndCLBalancesChangeRates(
        [1n, 2n],
        [ether("40"), ether("60")],
        0n,
        0n,
        ether("101"),
        0n,
        0n,
        ONE_DAY,
      ),
    )
      .to.be.revertedWithCustomError(checker, "InconsistentValidatorsBalanceByModule")
      .withArgs(ether("101"), ether("100"));
  });

  it("does not count the external pending allowance as activation-backed module growth", async () => {
    const { admin, checker, seedPreviousBalances } = await loadFixture(deployFixture);
    const validatorsBalance = ether("1000");
    const externalPending = ether(String(limits.externalPendingBalanceCapEth));
    const moduleGrowth = ether("1");
    const annualLimitsRole = await checker.ANNUAL_CL_REBASE_INCREASE_LIMITS_MANAGER_ROLE();
    const consolidationRole = await checker.CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE();
    await checker.connect(admin).grantRole(annualLimitsRole, admin.address);
    await checker.connect(admin).grantRole(consolidationRole, admin.address);
    await checker.connect(admin).setAnnualCLRebaseIncreaseBPLimits(0n, limits.annualCLRebaseIncreaseHardBPLimit);
    await checker.connect(admin).setConsolidationEthAmountPerDayLimit(0n);
    await seedPreviousBalances([1n], [validatorsBalance]);

    await expect(
      checker.checkModuleAndCLBalancesChangeRates(
        [1n],
        [validatorsBalance + moduleGrowth],
        validatorsBalance,
        0n,
        validatorsBalance + moduleGrowth,
        externalPending,
        0n,
        ONE_DAY,
      ),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalModuleValidatorsBalanceIncrease")
      .withArgs(0n, moduleGrowth);
  });

  it("allows ordinary gross growth concentrated in one module up to the annual soft allowance", async () => {
    const { admin, checker, seedPreviousBalances } = await loadFixture(deployFixture);
    const preModuleBalance = ether("500");
    const preValidators = ether("1000");
    const normalRewardsAllowance =
      (preValidators * limits.annualCLRebaseIncreaseSoftBPLimit) / (TOTAL_BASIS_POINTS * DAYS_PER_YEAR);
    const consolidationRole = await checker.CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE();
    await checker.connect(admin).grantRole(consolidationRole, admin.address);
    await checker.connect(admin).setConsolidationEthAmountPerDayLimit(0n);
    await seedPreviousBalances([1n, 2n], [preModuleBalance, preModuleBalance]);

    await expect(
      checker.checkModuleAndCLBalancesChangeRates(
        [1n, 2n],
        [preModuleBalance - normalRewardsAllowance, preModuleBalance + normalRewardsAllowance],
        preValidators,
        0n,
        preValidators,
        0n,
        0n,
        ONE_DAY,
      ),
    ).not.to.be.reverted;
  });

  it("enforces module growth on the first check when stored accounting is available", async () => {
    const { admin, checker, seedPreviousBalances } = await loadFixture(deployFixture);
    const preModuleBalance = ether("500");
    const preValidators = 2n * preModuleBalance;
    const redistribution = ether("1");
    const annualLimitsRole = await checker.ANNUAL_CL_REBASE_INCREASE_LIMITS_MANAGER_ROLE();
    const consolidationRole = await checker.CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE();
    await checker.connect(admin).grantRole(annualLimitsRole, admin.address);
    await checker.connect(admin).grantRole(consolidationRole, admin.address);
    await checker.connect(admin).setAnnualCLRebaseIncreaseBPLimits(0n, limits.annualCLRebaseIncreaseHardBPLimit);
    await checker.connect(admin).setConsolidationEthAmountPerDayLimit(0n);
    await seedPreviousBalances([1n, 2n], [preModuleBalance, preModuleBalance]);

    await expect(
      checker.checkModuleAndCLBalancesChangeRates(
        [1n, 2n],
        [preModuleBalance - redistribution, preModuleBalance + redistribution],
        preValidators,
        0n,
        preValidators,
        0n,
        0n,
        ONE_DAY,
      ),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalModuleValidatorsBalanceIncrease")
      .withArgs(0n, redistribution);
  });

  it("skips a new module's first nonzero balance, then enforces its stored baseline", async () => {
    const { admin, checker, stakingRouter } = await loadFixture(deployFixture);
    const moduleId = 1n;
    const firstBalance = ether("100");
    const moduleGrowth = ether("1");
    const annualLimitsRole = await checker.ANNUAL_CL_REBASE_INCREASE_LIMITS_MANAGER_ROLE();
    const consolidationRole = await checker.CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE();
    await checker.connect(admin).grantRole(annualLimitsRole, admin.address);
    await checker.connect(admin).grantRole(consolidationRole, admin.address);
    await checker.connect(admin).setAnnualCLRebaseIncreaseBPLimits(0n, limits.annualCLRebaseIncreaseHardBPLimit);
    await checker.connect(admin).setConsolidationEthAmountPerDayLimit(0n);
    await stakingRouter.mock__registerStakingModule(moduleId);

    await expect(checker.checkModuleAndCLBalancesChangeRates([moduleId], [0n], 0n, 0n, 0n, 0n, 0n, ONE_DAY)).not.to.be
      .reverted;

    await expect(
      checker.checkModuleAndCLBalancesChangeRates([moduleId], [firstBalance], 0n, 0n, firstBalance, 0n, 0n, ONE_DAY),
    ).not.to.be.reverted;

    await stakingRouter.reportValidatorBalancesByStakingModule([moduleId], [firstBalance / ONE_GWEI]);
    await expect(
      checker.checkModuleAndCLBalancesChangeRates(
        [moduleId],
        [firstBalance + moduleGrowth],
        firstBalance,
        0n,
        firstBalance + moduleGrowth,
        0n,
        0n,
        ONE_DAY,
      ),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalModuleValidatorsBalanceIncrease")
      .withArgs(0n, moduleGrowth);
  });

  it("treats a zero-balance module with reported exits as having an accounting baseline", async () => {
    const { admin, checker, stakingRouter } = await loadFixture(deployFixture);
    const moduleId = 1n;
    const unexpectedGrowth = ether("1");
    await checker
      .connect(admin)
      .grantRole(await checker.ANNUAL_CL_REBASE_INCREASE_LIMITS_MANAGER_ROLE(), admin.address);
    await checker
      .connect(admin)
      .grantRole(await checker.CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE(), admin.address);
    await checker.connect(admin).setAnnualCLRebaseIncreaseBPLimits(0n, limits.annualCLRebaseIncreaseHardBPLimit);
    await checker.connect(admin).setConsolidationEthAmountPerDayLimit(0n);
    await stakingRouter.mock__setStakingModuleExitedValidators(moduleId, 1n);

    await expect(
      checker.checkModuleAndCLBalancesChangeRates(
        [moduleId],
        [unexpectedGrowth],
        0n,
        0n,
        unexpectedGrowth,
        0n,
        0n,
        ONE_DAY,
      ),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalModuleValidatorsBalanceIncrease")
      .withArgs(0n, unexpectedGrowth);
  });

  it("prorates appeared and consolidation allowances for sub-day report intervals", async () => {
    const { admin, checker, seedPreviousBalances } = await loadFixture(deployFixture);
    const preModuleBalance = ether("3000");
    const preValidators = 2n * preModuleBalance;
    const halfDay = ONE_DAY / 2n;
    const appearedAllowance = ether(String(limits.appearedEthAmountPerDayLimit)) / 2n;
    const activationAtLimit = appearedAllowance + MAX_VALIDATOR_EFFECTIVE_BALANCE;
    const consolidationRole = await checker.CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE();
    const annualLimitsRole = await checker.ANNUAL_CL_REBASE_INCREASE_LIMITS_MANAGER_ROLE();
    await checker.connect(admin).grantRole(consolidationRole, admin.address);
    await checker.connect(admin).grantRole(annualLimitsRole, admin.address);
    await checker.connect(admin).setAnnualCLRebaseIncreaseBPLimits(0n, limits.annualCLRebaseIncreaseHardBPLimit);
    await seedPreviousBalances([1n, 2n], [preModuleBalance, preModuleBalance]);

    await expect(
      checker.checkModuleAndCLBalancesChangeRates(
        [1n, 2n],
        [preModuleBalance, preModuleBalance + activationAtLimit],
        preValidators,
        activationAtLimit,
        preValidators + activationAtLimit,
        0n,
        0n,
        halfDay,
      ),
    ).not.to.be.reverted;
    await expect(
      checker.checkModuleAndCLBalancesChangeRates(
        [1n, 2n],
        [preModuleBalance, preModuleBalance + activationAtLimit + 1n],
        preValidators,
        activationAtLimit + 1n,
        preValidators + activationAtLimit + 1n,
        0n,
        0n,
        halfDay,
      ),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalActivatedBalance")
      .withArgs(activationAtLimit, activationAtLimit + 1n);

    const oneHourConsolidationAllowance =
      (ether(String(limits.consolidationEthAmountPerDayLimit)) * ONE_HOUR) / ONE_DAY;
    await expect(
      checker.checkModuleAndCLBalancesChangeRates(
        [1n, 2n],
        [preModuleBalance - oneHourConsolidationAllowance, preModuleBalance + oneHourConsolidationAllowance],
        preValidators,
        0n,
        preValidators,
        0n,
        0n,
        0n,
      ),
    ).not.to.be.reverted;
    await expect(
      checker.checkModuleAndCLBalancesChangeRates(
        [1n, 2n],
        [preModuleBalance - oneHourConsolidationAllowance - 1n, preModuleBalance + oneHourConsolidationAllowance + 1n],
        preValidators,
        0n,
        preValidators,
        0n,
        0n,
        0n,
      ),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalModuleValidatorsBalanceIncrease")
      .withArgs(oneHourConsolidationAllowance, oneHourConsolidationAllowance + 1n);
  });

  it("prorates the annual soft allowance independently of the hard limit", async () => {
    const { admin, checker, seedPreviousBalances } = await loadFixture(deployFixture);
    const preModuleBalance = ether("1000");
    const preValidators = 2n * preModuleBalance;
    const halfDay = ONE_DAY / 2n;
    const softAllowance =
      (preValidators * limits.annualCLRebaseIncreaseSoftBPLimit * halfDay) /
      (TOTAL_BASIS_POINTS * DAYS_PER_YEAR * ONE_DAY);
    await checker
      .connect(admin)
      .grantRole(await checker.CONSOLIDATION_ETH_AMOUNT_PER_DAY_LIMIT_MANAGER_ROLE(), admin.address);
    await checker.connect(admin).setConsolidationEthAmountPerDayLimit(0n);
    await seedPreviousBalances([1n, 2n], [preModuleBalance, preModuleBalance]);

    await expect(
      checker.checkModuleAndCLBalancesChangeRates(
        [1n, 2n],
        [preModuleBalance - softAllowance, preModuleBalance + softAllowance],
        preValidators,
        0n,
        preValidators,
        0n,
        0n,
        halfDay,
      ),
    ).not.to.be.reverted;
    await expect(
      checker.checkModuleAndCLBalancesChangeRates(
        [1n, 2n],
        [preModuleBalance - softAllowance - 1n, preModuleBalance + softAllowance + 1n],
        preValidators,
        0n,
        preValidators,
        0n,
        0n,
        halfDay,
      ),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalModuleValidatorsBalanceIncrease")
      .withArgs(softAllowance, softAllowance + 1n);
  });

  it("subtracts activation and the annual soft allowance before applying the consolidation budget", async () => {
    const { checker, seedPreviousBalances } = await loadFixture(deployFixture);
    const preModuleBalance = ether("500");
    const preValidators = 2n * preModuleBalance;
    const activatedBalance = ether("32");
    const normalRewardsAllowance =
      ((preValidators + activatedBalance) * limits.annualCLRebaseIncreaseSoftBPLimit) /
      (TOTAL_BASIS_POINTS * DAYS_PER_YEAR);
    const consolidationAllowance = ether(String(limits.consolidationEthAmountPerDayLimit));
    const allowedGrossPositiveGrowth = activatedBalance + normalRewardsAllowance + consolidationAllowance;
    const offsettingModuleDecrease = normalRewardsAllowance + consolidationAllowance;
    await seedPreviousBalances([1n, 2n], [preModuleBalance, preModuleBalance]);

    await expect(
      checker.checkModuleAndCLBalancesChangeRates(
        [1n, 2n],
        [preModuleBalance - offsettingModuleDecrease, preModuleBalance + allowedGrossPositiveGrowth],
        preValidators,
        activatedBalance,
        preValidators + activatedBalance,
        0n,
        0n,
        ONE_DAY,
      ),
    ).not.to.be.reverted;

    await expect(
      checker.checkModuleAndCLBalancesChangeRates(
        [1n, 2n],
        [preModuleBalance - offsettingModuleDecrease - 1n, preModuleBalance + allowedGrossPositiveGrowth + 1n],
        preValidators,
        activatedBalance,
        preValidators + activatedBalance,
        0n,
        0n,
        ONE_DAY,
      ),
    )
      .to.be.revertedWithCustomError(checker, "IncorrectTotalModuleValidatorsBalanceIncrease")
      .withArgs(allowedGrossPositiveGrowth, allowedGrossPositiveGrowth + 1n);
  });
});
