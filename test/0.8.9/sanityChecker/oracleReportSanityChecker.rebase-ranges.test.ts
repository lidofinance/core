import { expect } from "chai";
import { keccak256, toUtf8Bytes, ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { ether } from "lib";

const ONE_DAY = 24n * 60n * 60n;
const ONE_HOUR = 60n * 60n;
const ONE_GWEI = 10n ** 9n;
const MAX_BASIS_POINTS = 10_000n;
const DAYS_PER_YEAR = 365n;
const ONE_YEAR = DAYS_PER_YEAR * ONE_DAY;
const REF_SLOT = 1_000n;
const REPORT_HASH = keccak256(toUtf8Bytes("report"));

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
  clRebaseDecreaseSoftBPLimit: 0n,
  clRebaseDecreaseHardBPLimit: 500n,
  consolidationEthAmountPerDayLimit: 0n,
  exitedValidatorEthAmountLimit: 32n,
  externalPendingBalanceCapEth: 0n,
};

describe("OracleReportSanityChecker: CL rebase ranges", () => {
  async function deployFixture() {
    const [deployer, admin, accounting, committee, withdrawalVault, elRewardsVault] = await ethers.getSigners();
    await setBalance(withdrawalVault.address, ether("1000"));
    await setBalance(elRewardsVault.address, ether("1000"));

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

    const checker = await ethers.deployContract("OracleReportSanityChecker", [
      await locator.getAddress(),
      accounting.address,
      admin.address,
      limits,
      ethers.ZeroAddress,
    ]);
    const secondOpinionOracle = await ethers.deployContract("SecondOpinionOracle", [admin.address, committee.address]);

    await checker.connect(admin).grantRole(await checker.SECOND_OPINION_MANAGER_ROLE(), admin.address);

    const setConsensusReport = async (hash = REPORT_HASH, processingStarted = true) => {
      await accountingOracle.setConsensusReport(hash, REF_SLOT, processingStarted);
    };
    const enableSecondOpinion = async (hash = REPORT_HASH) => {
      await checker.connect(admin).setSecondOpinionOracle(await secondOpinionOracle.getAddress());
      await secondOpinionOracle.connect(committee).setReportHash(REF_SLOT, hash);
    };

    return {
      admin,
      accounting,
      committee,
      checker,
      accountingOracle,
      secondOpinionOracle,
      stakingRouter,
      setConsensusReport,
      enableSecondOpinion,
    };
  }

  async function checkAggregate(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    preCLBalance: bigint,
    postCLBalance: bigint,
    withdrawalVaultBalance = 0n,
    deposits = 0n,
    timeElapsed = ONE_DAY,
  ) {
    return fixture.checker
      .connect(fixture.accounting)
      .checkAccountingOracleReport(
        timeElapsed,
        preCLBalance,
        0n,
        postCLBalance,
        0n,
        withdrawalVaultBalance,
        0n,
        0n,
        deposits,
      );
  }

  async function checkAggregateParts(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    values: {
      preValidators: bigint;
      prePending: bigint;
      postValidators: bigint;
      postPending: bigint;
      withdrawalVaultBalance?: bigint;
      deposits?: bigint;
      timeElapsed?: bigint;
    },
  ) {
    return fixture.checker
      .connect(fixture.accounting)
      .checkAccountingOracleReport(
        values.timeElapsed ?? ONE_DAY,
        values.preValidators,
        values.prePending,
        values.postValidators,
        values.postPending,
        values.withdrawalVaultBalance ?? 0n,
        0n,
        0n,
        values.deposits ?? 0n,
      );
  }

  it("processes values inside both soft limits without a second opinion", async () => {
    const fixture = await deployFixture();
    const preCLBalance = ether("1000");

    await expect(checkAggregate(fixture, preCLBalance, preCLBalance)).not.to.be.reverted;
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance + ether("0.2"))).not.to.be.reverted;
  });

  it("includes the reported Withdrawal Vault balance in CL accounting", async () => {
    const fixture = await deployFixture();
    const preCLBalance = ether("1000");

    await expect(checkAggregate(fixture, preCLBalance, preCLBalance - ether("10"), ether("10"))).not.to.be.reverted;
  });

  it("aggregates validator and pending balances on both sides of the report", async () => {
    const fixture = await deployFixture();

    await expect(
      checkAggregateParts(fixture, {
        preValidators: ether("900"),
        prePending: ether("100"),
        postValidators: ether("950"),
        postPending: ether("50"),
      }),
    ).not.to.be.reverted;

    await fixture.setConsensusReport();
    await expect(
      checkAggregateParts(fixture, {
        preValidators: ether("900"),
        prePending: ether("100"),
        postValidators: ether("950"),
        postPending: ether("50") - 1n,
      }),
    )
      .to.be.revertedWithCustomError(fixture.checker, "SecondOpinionReportNotReady")
      .withArgs(REF_SLOT);
  });

  it("treats deposits as principal instead of a positive rebase", async () => {
    const fixture = await deployFixture();
    const preCLBalance = ether("1000");
    const deposits = ether("32");

    await expect(checkAggregate(fixture, preCLBalance, preCLBalance + deposits, 0n, deposits)).not.to.be.reverted;
  });

  it("uses deposits in the principal when calculating an annual increase boundary", async () => {
    const fixture = await deployFixture();
    const preCLBalance = ether("3650");
    const deposits = ether("3650");
    const effectivePreCLBalance = preCLBalance + deposits;
    const softIncrease =
      (effectivePreCLBalance * limits.annualCLRebaseIncreaseSoftBPLimit * ONE_DAY) / (MAX_BASIS_POINTS * ONE_YEAR);
    await fixture.setConsensusReport();

    await expect(checkAggregate(fixture, preCLBalance, effectivePreCLBalance + softIncrease, 0n, deposits)).not.to.be
      .reverted;
    await expect(checkAggregate(fixture, preCLBalance, effectivePreCLBalance + softIncrease + 1n, 0n, deposits))
      .to.be.revertedWithCustomError(fixture.checker, "SecondOpinionReportNotReady")
      .withArgs(REF_SLOT);
  });

  it("requires the exact frozen report hash between the decrease limits", async () => {
    const fixture = await deployFixture();
    const preCLBalance = ether("1000");

    await fixture.setConsensusReport();
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance - 1n))
      .to.be.revertedWithCustomError(fixture.checker, "SecondOpinionReportNotReady")
      .withArgs(REF_SLOT);

    await fixture.checker.connect(fixture.admin).setSecondOpinionOracle(await fixture.secondOpinionOracle.getAddress());
    await fixture.secondOpinionOracle
      .connect(fixture.committee)
      .setReportHash(REF_SLOT, keccak256(toUtf8Bytes("other report")));
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance - 1n)).to.be.revertedWithCustomError(
      fixture.checker,
      "SecondOpinionReportHashMismatch",
    );

    await fixture.secondOpinionOracle.connect(fixture.committee).setReportHash(REF_SLOT, REPORT_HASH);
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance - 1n)).not.to.be.reverted;
  });

  it("does not accept an attestation before report processing is frozen", async () => {
    const fixture = await deployFixture();
    const preCLBalance = ether("1000");
    await fixture.setConsensusReport(REPORT_HASH, false);
    await fixture.enableSecondOpinion();

    await expect(checkAggregate(fixture, preCLBalance, preCLBalance - 1n))
      .to.be.revertedWithCustomError(fixture.checker, "ConsensusReportNotProcessing")
      .withArgs(REF_SLOT);
  });

  it("uses exact amount boundaries for the decrease ranges", async () => {
    const fixture = await deployFixture();
    const preCLBalance = ether("1000");
    const softDecrease = ether("10");
    const hardDecrease = ether("50");
    const decreaseLimitsRole = await fixture.checker.CL_REBASE_DECREASE_LIMITS_MANAGER_ROLE();
    await fixture.checker.connect(fixture.admin).grantRole(decreaseLimitsRole, fixture.admin.address);
    await fixture.checker.connect(fixture.admin).setCLRebaseDecreaseBPLimits(100n, 500n);
    await fixture.setConsensusReport();

    await expect(checkAggregate(fixture, preCLBalance, preCLBalance - softDecrease)).not.to.be.reverted;
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance - softDecrease - 1n))
      .to.be.revertedWithCustomError(fixture.checker, "SecondOpinionReportNotReady")
      .withArgs(REF_SLOT);

    await fixture.enableSecondOpinion();

    await expect(checkAggregate(fixture, preCLBalance, preCLBalance - hardDecrease)).not.to.be.reverted;
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance - hardDecrease - 1n))
      .to.be.revertedWithCustomError(fixture.checker, "CLRebaseDecreaseAboveHardLimit")
      .withArgs(hardDecrease + 1n, hardDecrease);
  });

  it("uses deposits in the principal and denominator of a decrease boundary", async () => {
    const fixture = await deployFixture();
    const preCLBalance = ether("500");
    const deposits = ether("500");
    const principalCLBalance = preCLBalance + deposits;
    const softDecrease = ether("10");
    const decreaseLimitsRole = await fixture.checker.CL_REBASE_DECREASE_LIMITS_MANAGER_ROLE();
    await fixture.checker.connect(fixture.admin).grantRole(decreaseLimitsRole, fixture.admin.address);
    await fixture.checker.connect(fixture.admin).setCLRebaseDecreaseBPLimits(100n, 500n);
    await fixture.setConsensusReport();

    await expect(checkAggregate(fixture, preCLBalance, principalCLBalance - softDecrease, 0n, deposits)).not.to.be
      .reverted;
    await expect(checkAggregate(fixture, preCLBalance, principalCLBalance - softDecrease - 1n, 0n, deposits))
      .to.be.revertedWithCustomError(fixture.checker, "SecondOpinionReportNotReady")
      .withArgs(REF_SLOT);
  });

  it("uses exact prorated amount boundaries for the annual increase ranges", async () => {
    const fixture = await deployFixture();
    const preCLBalance = ether("3650");
    const softIncrease = ether("1");
    const hardIncrease = ether("1.75");
    await fixture.setConsensusReport();

    await expect(checkAggregate(fixture, preCLBalance, preCLBalance + softIncrease)).not.to.be.reverted;
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance + softIncrease + 1n))
      .to.be.revertedWithCustomError(fixture.checker, "SecondOpinionReportNotReady")
      .withArgs(REF_SLOT);
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance + hardIncrease + 1n))
      .to.be.revertedWithCustomError(fixture.checker, "AnnualCLRebaseIncreaseAboveHardLimit")
      .withArgs(hardIncrease + 1n, hardIncrease);

    await fixture.enableSecondOpinion();
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance + hardIncrease)).not.to.be.reverted;
  });

  it("enforces zero-valued decrease and annual increase limit pairs at runtime", async () => {
    const fixture = await deployFixture();
    const preCLBalance = ether("1000");
    const decreaseLimitsRole = await fixture.checker.CL_REBASE_DECREASE_LIMITS_MANAGER_ROLE();
    const increaseLimitsRole = await fixture.checker.ANNUAL_CL_REBASE_INCREASE_LIMITS_MANAGER_ROLE();
    await fixture.checker.connect(fixture.admin).grantRole(decreaseLimitsRole, fixture.admin.address);
    await fixture.checker.connect(fixture.admin).grantRole(increaseLimitsRole, fixture.admin.address);
    await fixture.checker.connect(fixture.admin).setCLRebaseDecreaseBPLimits(0n, 0n);
    await fixture.checker.connect(fixture.admin).setAnnualCLRebaseIncreaseBPLimits(0n, 0n);

    await expect(checkAggregate(fixture, preCLBalance, preCLBalance)).not.to.be.reverted;
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance - 1n))
      .to.be.revertedWithCustomError(fixture.checker, "CLRebaseDecreaseAboveHardLimit")
      .withArgs(1n, 0n);
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance + 1n))
      .to.be.revertedWithCustomError(fixture.checker, "AnnualCLRebaseIncreaseAboveHardLimit")
      .withArgs(1n, 0n);
  });

  it("enforces maximum-valued decrease and annual increase limit pairs at runtime", async () => {
    const fixture = await deployFixture();
    const preCLBalance = ether("3650");
    const decreaseLimitsRole = await fixture.checker.CL_REBASE_DECREASE_LIMITS_MANAGER_ROLE();
    const increaseLimitsRole = await fixture.checker.ANNUAL_CL_REBASE_INCREASE_LIMITS_MANAGER_ROLE();
    await fixture.checker.connect(fixture.admin).grantRole(decreaseLimitsRole, fixture.admin.address);
    await fixture.checker.connect(fixture.admin).grantRole(increaseLimitsRole, fixture.admin.address);
    await fixture.checker.connect(fixture.admin).setCLRebaseDecreaseBPLimits(MAX_BASIS_POINTS, MAX_BASIS_POINTS);
    await fixture.checker.connect(fixture.admin).setAnnualCLRebaseIncreaseBPLimits(MAX_BASIS_POINTS, MAX_BASIS_POINTS);

    const oneDayIncreaseLimit = preCLBalance / DAYS_PER_YEAR;
    await expect(checkAggregate(fixture, preCLBalance, 0n)).not.to.be.reverted;
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance + oneDayIncreaseLimit)).not.to.be.reverted;
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance + oneDayIncreaseLimit + 1n))
      .to.be.revertedWithCustomError(fixture.checker, "AnnualCLRebaseIncreaseAboveHardLimit")
      .withArgs(oneDayIncreaseLimit + 1n, oneDayIncreaseLimit);
  });

  it("uses the one-hour fallback when the report elapsed time is zero", async () => {
    const fixture = await deployFixture();
    const preCLBalance = ether("3650");
    const annualDenominator = MAX_BASIS_POINTS * DAYS_PER_YEAR * ONE_DAY;
    const softIncrease = (preCLBalance * limits.annualCLRebaseIncreaseSoftBPLimit * ONE_HOUR) / annualDenominator;
    await fixture.setConsensusReport();

    await expect(checkAggregate(fixture, preCLBalance, preCLBalance + softIncrease, 0n, 0n, 0n)).not.to.be.reverted;
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance + softIncrease + 1n, 0n, 0n, 0n))
      .to.be.revertedWithCustomError(fixture.checker, "SecondOpinionReportNotReady")
      .withArgs(REF_SLOT);
  });

  it("uses a one-gwei balance floor for annual limits when the pre-CL balance is zero", async () => {
    const fixture = await deployFixture();
    const annualDenominator = MAX_BASIS_POINTS * DAYS_PER_YEAR * ONE_DAY;
    const softIncrease = (ONE_GWEI * limits.annualCLRebaseIncreaseSoftBPLimit * ONE_DAY) / annualDenominator;
    await fixture.setConsensusReport();

    await expect(checkAggregate(fixture, 0n, softIncrease)).not.to.be.reverted;
    await expect(checkAggregate(fixture, 0n, softIncrease + 1n))
      .to.be.revertedWithCustomError(fixture.checker, "SecondOpinionReportNotReady")
      .withArgs(REF_SLOT);
  });

  it("handles protocol-scale balances at both hard boundaries", async () => {
    const fixture = await deployFixture();
    const preCLBalance = ether("36000000");
    const hardDecrease = (preCLBalance * limits.clRebaseDecreaseHardBPLimit) / MAX_BASIS_POINTS;
    const hardIncrease =
      (preCLBalance * limits.annualCLRebaseIncreaseHardBPLimit * ONE_YEAR) / (MAX_BASIS_POINTS * ONE_YEAR);
    await fixture.setConsensusReport();
    await fixture.enableSecondOpinion();

    await expect(checkAggregate(fixture, preCLBalance, preCLBalance - hardDecrease)).not.to.be.reverted;
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance - hardDecrease - 1n))
      .to.be.revertedWithCustomError(fixture.checker, "CLRebaseDecreaseAboveHardLimit")
      .withArgs(hardDecrease + 1n, hardDecrease);
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance + hardIncrease, 0n, 0n, ONE_YEAR)).not.to.be
      .reverted;
    await expect(checkAggregate(fixture, preCLBalance, preCLBalance + hardIncrease + 1n, 0n, 0n, ONE_YEAR))
      .to.be.revertedWithCustomError(fixture.checker, "AnnualCLRebaseIncreaseAboveHardLimit")
      .withArgs(hardIncrease + 1n, hardIncrease);
  });

  it("does not apply range classification or second opinion to the deterministic module budget", async () => {
    const fixture = await deployFixture();
    const preCLBalance = ether("1000");
    await fixture.stakingRouter.mock__registerStakingModule(1n);
    await fixture.stakingRouter.reportValidatorBalancesByStakingModule([1n], [preCLBalance / 10n ** 9n]);
    await fixture.setConsensusReport(REPORT_HASH, false);

    const activatedBalance = ether("100");
    const postCLValidatorsBalance = preCLBalance + activatedBalance;
    await expect(
      fixture.checker.checkModuleAndCLBalancesChangeRates(
        [1n],
        [postCLValidatorsBalance],
        preCLBalance,
        activatedBalance,
        postCLValidatorsBalance,
        0n,
        0n,
        ONE_DAY,
      ),
    ).not.to.be.reverted;
  });

  it("rejects zero admin or committee addresses for the second-opinion oracle", async () => {
    const fixture = await deployFixture();

    await expect(
      ethers.deployContract("SecondOpinionOracle", [ethers.ZeroAddress, fixture.committee.address]),
    ).to.be.revertedWithCustomError(fixture.secondOpinionOracle, "AdminCannotBeZero");
    await expect(
      ethers.deployContract("SecondOpinionOracle", [fixture.admin.address, ethers.ZeroAddress]),
    ).to.be.revertedWithCustomError(fixture.secondOpinionOracle, "CommitteeCannotBeZero");
  });

  it("stores, replaces, and removes committee report hashes", async () => {
    const fixture = await deployFixture();
    const otherHash = keccak256(toUtf8Bytes("replacement"));

    expect(await fixture.secondOpinionOracle.getReportHash(REF_SLOT)).to.deep.equal([false, ZeroHash]);
    await expect(fixture.secondOpinionOracle.connect(fixture.admin).setReportHash(REF_SLOT, REPORT_HASH)).to.be
      .reverted;
    await expect(fixture.secondOpinionOracle.connect(fixture.committee).setReportHash(REF_SLOT, REPORT_HASH))
      .to.emit(fixture.secondOpinionOracle, "ReportHashSet")
      .withArgs(REF_SLOT, REPORT_HASH);
    expect(await fixture.secondOpinionOracle.getReportHash(REF_SLOT)).to.deep.equal([true, REPORT_HASH]);

    await fixture.secondOpinionOracle.connect(fixture.committee).setReportHash(REF_SLOT, otherHash);
    expect(await fixture.secondOpinionOracle.getReportHash(REF_SLOT)).to.deep.equal([true, otherHash]);

    await fixture.secondOpinionOracle.connect(fixture.committee).setReportHash(REF_SLOT, ZeroHash);
    expect(await fixture.secondOpinionOracle.getReportHash(REF_SLOT)).to.deep.equal([false, ZeroHash]);
  });
});
