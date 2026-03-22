import { expect } from "chai";
import { parseUnits, ZeroAddress } from "ethers";
import { artifacts, ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Accounting__MockForSanityChecker,
  AccountingOracle__MockForSanityChecker,
  Lido__MockForSanityChecker,
  LidoLocator__MockForSanityChecker,
  OracleReportSanityChecker,
  StakingRouter__MockForSanityChecker,
} from "typechain-types";

import { ether, impersonate } from "lib";

import { Snapshot } from "test/suite";

const SLOTS_PER_DAY = 7200n;
const REPORTS_WINDOW = 36;
const MAX_BASIS_POINTS = 10_000n;
const MAX_CL_BALANCE_DECREASE_BP = 360n; // 3.6%

describe("OracleReportSanityChecker.sol:negative-rebase", () => {
  let locator: LidoLocator__MockForSanityChecker;
  let checker: OracleReportSanityChecker;
  let accountingOracle: AccountingOracle__MockForSanityChecker;
  let accounting: Accounting__MockForSanityChecker;
  let stakingRouter: StakingRouter__MockForSanityChecker;
  let lido: Lido__MockForSanityChecker;
  let deployer: HardhatEthersSigner;
  let withdrawalVault: HardhatEthersSigner;
  let accountingSigner: HardhatEthersSigner;

  const defaultLimitsList = {
    exitedEthAmountPerDayLimit: 50n,
    appearedEthAmountPerDayLimit: 75n,
    annualBalanceIncreaseBPLimit: 10_00n, // 10%
    simulatedShareRateDeviationBPLimit: 2_00n, // 2%
    maxBalanceExitRequestedPerReportInEth: 64_000n, // Max ~65K ETH (close to uint16 max)
    maxEffectiveBalanceWeightWCType01: 32n,
    maxEffectiveBalanceWeightWCType02: 2_048n,
    maxItemsPerExtraDataTransaction: 15n,
    maxNodeOperatorsPerExtraDataItem: 16n,
    requestTimestampMargin: 128n,
    maxPositiveTokenRebase: 5_000_000n,
    maxCLBalanceDecreaseBP: MAX_CL_BALANCE_DECREASE_BP,
    clBalanceOraclesErrorUpperBPLimit: 50n,
    consolidationEthAmountPerDayLimit: 0n,
    exitedValidatorEthAmountLimit: 1n,
  };

  let originalState: string;

  const callCheck = (
    preCLBalance: bigint,
    postCLBalance: bigint,
    withdrawalVaultBalance = 0n,
    deposits = 0n,
    withdrawalsVaultTransfer = 0n,
    timeElapsed = 24n * 60n * 60n,
    preCLPendingBalance = 0n,
    postCLPendingBalance = 0n,
  ) =>
    checker
      .connect(accountingSigner)
      .checkAccountingOracleReport(
        timeElapsed,
        preCLBalance - deposits - preCLPendingBalance,
        preCLPendingBalance,
        postCLBalance - postCLPendingBalance,
        postCLPendingBalance,
        withdrawalVaultBalance,
        0n,
        0n,
        deposits,
        withdrawalsVaultTransfer,
      );

  // Deposits remain in pending until they are activated on the validators side.
  const callCheckWithPendingDeposits = (
    preCLBalance: bigint,
    postCLBalance: bigint,
    deposits: bigint,
    {
      withdrawalVaultBalance = 0n,
      withdrawalsVaultTransfer = 0n,
      timeElapsed = 24n * 60n * 60n,
    }: {
      withdrawalVaultBalance?: bigint;
      withdrawalsVaultTransfer?: bigint;
      timeElapsed?: bigint;
    } = {},
  ) =>
    callCheck(
      preCLBalance,
      postCLBalance,
      withdrawalVaultBalance,
      deposits,
      withdrawalsVaultTransfer,
      timeElapsed,
      0n,
      deposits,
    );

  const maxDiffFor = (adjusted: bigint) => (adjusted * MAX_CL_BALANCE_DECREASE_BP) / MAX_BASIS_POINTS;

  const deploySecondOpinionOracle = async () => {
    const secondOpinionOracle = await ethers.deployContract("SecondOpinionOracle__Mock");

    const clOraclesRole = await checker.SECOND_OPINION_MANAGER_ROLE();
    await checker.grantRole(clOraclesRole, deployer.address);

    await checker.setSecondOpinionOracleAndCLBalanceUpperMargin(await secondOpinionOracle.getAddress(), 74n);
    return secondOpinionOracle;
  };

  before(async () => {
    [deployer, withdrawalVault] = await ethers.getSigners();
    await setBalance(withdrawalVault.address, ether("10000"));

    const sanityCheckerAddress = deployer.address;

    const burner = await ethers.deployContract("Burner__MockForSanityChecker", []);
    accounting = await ethers.deployContract("Accounting__MockForSanityChecker", []);

    accountingOracle = await ethers.deployContract("AccountingOracle__MockForSanityChecker", [
      deployer.address,
      12,
      1606824023,
    ]);
    stakingRouter = await ethers.deployContract("StakingRouter__MockForSanityChecker");
    lido = await ethers.deployContract("Lido__MockForSanityChecker");

    locator = await ethers.deployContract("LidoLocator__MockForSanityChecker", [
      {
        lido: await lido.getAddress(),
        depositSecurityModule: deployer.address,
        elRewardsVault: deployer.address,
        accountingOracle: await accountingOracle.getAddress(),
        oracleReportSanityChecker: sanityCheckerAddress,
        burner: await burner.getAddress(),
        validatorsExitBusOracle: deployer.address,
        stakingRouter: await stakingRouter.getAddress(),
        treasury: deployer.address,
        withdrawalQueue: deployer.address,
        withdrawalVault: withdrawalVault.address,
        postTokenRebaseReceiver: deployer.address,
        oracleDaemonConfig: deployer.address,
        validatorExitDelayVerifier: deployer.address,
        triggerableWithdrawalsGateway: deployer.address,
        consolidationGateway: deployer.address,
        accounting: await accounting.getAddress(),
        wstETH: deployer.address,
        vaultHub: deployer.address,
        vaultFactory: deployer.address,
        lazyOracle: deployer.address,
        predepositGuarantee: deployer.address,
        operatorGrid: deployer.address,
        topUpGateway: deployer.address,
      },
    ]);

    const factory = await ethers.getContractFactory("OracleReportSanityChecker");
    checker = await factory.deploy(
      await locator.getAddress(),
      await accounting.getAddress(),
      deployer.address,
      defaultLimitsList,
    );

    accountingSigner = await impersonate(await accounting.getAddress(), ether("1"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("OracleReportSanityChecker checkAccountingOracleReport authorization", () => {
    it("should allow calling from Accounting address", async () => {
      await callCheck(ether("100"), ether("100"));
    });

    it("should not allow calling from non-Accounting address", async () => {
      const [, otherClient] = await ethers.getSigners();
      await expect(
        checker.connect(otherClient).checkAccountingOracleReport(0, ether("100"), 0, ether("100"), 0, 0, 0, 0, 0, 0),
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

      const accountingCoreABI = artifact.abi.find(
        (entry) => entry.type === "function" && entry.name === "exposeAccountingCorePackedLimits",
      );
      const operationalABI = artifact.abi.find(
        (entry) => entry.type === "function" && entry.name === "exposeOperationalPackedLimits",
      );

      const sizeOfCalc = (x: string) => {
        switch (x) {
          case "uint256":
            return 256;
          case "uint128":
            return 128;
          case "uint64":
            return 64;
          case "uint32":
            return 32;
          case "uint16":
            return 16;
          case "uint8":
            return 8;
          default:
            expect.fail(`Unknown type ${x}`);
        }
      };

      const accountingCoreSizeInBits = accountingCoreABI.outputs[0].components
        .map((x: { type: string }) => x.type)
        .reduce((acc: number, x: string) => acc + sizeOfCalc(x), 0);
      const operationalSizeInBits = operationalABI.outputs[0].components
        .map((x: { type: string }) => x.type)
        .reduce((acc: number, x: string) => acc + sizeOfCalc(x), 0);

      expect(accountingCoreSizeInBits).to.lessThanOrEqual(256);
      expect(operationalSizeInBits).to.lessThanOrEqual(256);
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

  context("OracleReportSanityChecker balance-based CL decrease check", () => {
    let genesisTime: bigint;
    let baseRefSlot: bigint;

    before(async () => {
      genesisTime = await accountingOracle.GENESIS_TIME();
      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp;
      baseRefSlot = (BigInt(timestamp) - genesisTime) / 12n;
    });

    const setRefSlot = (slot: bigint) => accountingOracle.setLastProcessingRefSlot(slot);

    context("early exit predicate", () => {
      it("passes when postCL >= preCL (no decrease)", async () => {
        await expect(
          callCheck(ether("101"), ether("101.001"), 0n, 0n, 0n, 4n * 24n * 60n * 60n, ether("1"), ether("0.999")),
        ).not.to.be.reverted;
      });

      it("passes when postCL + withdrawals >= preCL", async () => {
        await expect(callCheck(ether("105"), ether("100"), ether("5"))).not.to.be.reverted;
      });

      it("passes when postCL + withdrawals == preCL", async () => {
        await expect(callCheck(ether("100"), ether("95"), ether("5"))).not.to.be.reverted;
      });

      it("passes when postCL == preCL", async () => {
        await expect(callCheck(ether("100"), ether("100"))).not.to.be.reverted;
      });

      it("does not use cumulative withdrawal vault balance for early exit when no new CL withdrawals", async () => {
        const baseline = ether("10000");
        const unchangedVaultBalance = ether("100");
        const postCL = ether("9550");
        const actualDiff = baseline - postCL;
        const adjusted = baseline - unchangedVaultBalance;
        const expectedMaxDiff = maxDiffFor(adjusted);

        await setRefSlot(baseRefSlot - 2n * SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        // First report with non-zero vault balance sets _lastVaultBalanceAfterTransfer.
        // Validators drop matches clWithdrawals (100 ETH) so no "appeared" balance.
        await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
        await callCheck(baseline, ether("9900"), unchangedVaultBalance, 0n, 0n);

        // Same vault balance on the next report means clWithdrawals == 0 for this period.
        // The check must not early-exit based on cumulative vault balance.
        await setRefSlot(baseRefSlot);
        await expect(callCheck(ether("9900"), postCL, unchangedVaultBalance, 0n, 0n))
          .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
          .withArgs(actualDiff, expectedMaxDiff);
      });
    });

    context("first report (no history)", () => {
      it("passes on first report even with large decrease", async () => {
        await expect(callCheck(ether("100"), ether("50"))).not.to.be.reverted;
      });
    });

    context("single-period decrease", () => {
      it("decrease within limit passes and emits NegativeCLRebaseAccepted", async () => {
        const baseline = ether("10000");
        const postCL = ether("9700");
        const actualDiff = baseline - postCL;
        const expectedMaxDiff = maxDiffFor(baseline);

        await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        await setRefSlot(baseRefSlot);
        await expect(callCheck(baseline, postCL))
          .to.emit(checker, "NegativeCLRebaseAccepted")
          .withArgs(baseRefSlot, postCL, actualDiff, expectedMaxDiff);
      });

      it("decrease exactly at limit passes", async () => {
        const baseline = ether("10000");
        const expectedMaxDiff = maxDiffFor(baseline);
        const postCL = baseline - expectedMaxDiff;

        await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        await setRefSlot(baseRefSlot);
        await expect(callCheck(baseline, postCL))
          .to.emit(checker, "NegativeCLRebaseAccepted")
          .withArgs(baseRefSlot, postCL, expectedMaxDiff, expectedMaxDiff);
      });

      it("decrease exceeding limit reverts with IncorrectCLBalanceDecrease", async () => {
        const baseline = ether("10000");
        const postCL = ether("9500");
        const actualDiff = baseline - postCL;
        const expectedMaxDiff = maxDiffFor(baseline);

        await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        await setRefSlot(baseRefSlot);
        await expect(callCheck(baseline, postCL))
          .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
          .withArgs(actualDiff, expectedMaxDiff);
      });
    });

    context("deposits and withdrawals adjustment", () => {
      it("deposits increase adjusted balance and allowed decrease", async () => {
        const baseline = ether("10000");
        const depositAmount = ether("500");
        const postCL = ether("9700");
        const principalCL = baseline + depositAmount;
        const actualDiff = baseline - postCL;
        const adjusted = baseline + depositAmount;
        const expectedMaxDiff = maxDiffFor(adjusted);

        await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        // adjusted includes depositAmount ->
        // expectedMaxDiff is larger than without deposits -> actualDiff fits
        await setRefSlot(baseRefSlot);
        await expect(callCheckWithPendingDeposits(principalCL, postCL, depositAmount))
          .to.emit(checker, "NegativeCLRebaseAccepted")
          .withArgs(baseRefSlot, postCL, actualDiff, expectedMaxDiff);
      });

      it("withdrawals decrease adjusted balance and allowed decrease", async () => {
        const baseline = ether("10000");
        const postCL = ether("9700");
        const wVault = ether("200");
        const actualDiff = baseline - postCL;
        const adjusted = baseline - wVault;
        const expectedMaxDiff = maxDiffFor(adjusted);

        await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        // adjusted = baseline - wVault ->
        // smaller expectedMaxDiff, but actualDiff still within limit
        await setRefSlot(baseRefSlot);
        await expect(callCheck(baseline, postCL, wVault))
          .to.emit(checker, "NegativeCLRebaseAccepted")
          .withArgs(baseRefSlot, postCL, actualDiff, expectedMaxDiff);
      });

      it("large withdrawals trigger stricter limit and cause revert", async () => {
        const baseline = ether("10000");
        const postCL = ether("9600");
        const wVault = ether("300");
        const actualDiff = baseline - postCL;
        const adjusted = baseline - wVault;
        const expectedMaxDiff = maxDiffFor(adjusted);

        await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        // adjusted = baseline - wVault ->
        // expectedMaxDiff shrinks below actualDiff -> reverts
        await setRefSlot(baseRefSlot);
        await expect(callCheck(baseline, postCL, wVault))
          .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
          .withArgs(actualDiff, expectedMaxDiff);
      });

      it("deposits and withdrawals combined over multiple reports", async () => {
        const baseline = ether("10000");
        const report2Deposits = ether("200");
        const report2Withdrawals = ether("100");
        const report3Deposits = ether("300");
        const report3Withdrawals = ether("50");
        const postCL = ether("9700");

        const actualDiff = baseline - postCL;
        const totalDeposits = report2Deposits + report3Deposits;
        const totalWithdrawals = report2Withdrawals + report3Withdrawals;
        const adjusted = baseline + totalDeposits - totalWithdrawals;
        const expectedMaxDiff = maxDiffFor(adjusted);

        await setRefSlot(baseRefSlot - 2n * SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
        await callCheckWithPendingDeposits(ether("10200"), ether("9900"), report2Deposits, {
          withdrawalVaultBalance: report2Withdrawals,
          withdrawalsVaultTransfer: report2Withdrawals,
        });

        // adjusted = baseline + totalDeposits - totalWithdrawals
        // actualDiff = baseline - postCL
        await setRefSlot(baseRefSlot);
        await expect(
          callCheckWithPendingDeposits(ether("10150"), postCL, report3Deposits, {
            withdrawalVaultBalance: report3Withdrawals,
            withdrawalsVaultTransfer: report3Withdrawals,
          }),
        )
          .to.emit(checker, "NegativeCLRebaseAccepted")
          .withArgs(baseRefSlot, postCL, actualDiff, expectedMaxDiff);
      });

      it("repeated withdrawalVaultBalance snapshots make the limit stricter", async () => {
        const baseline = ether("10000");
        const repeatedWVaultSnapshot = ether("150");
        const postCL = ether("9650");
        const actualDiff = baseline - postCL;
        const totalCLWithdrawals = repeatedWVaultSnapshot * 2n;
        const adjusted = baseline - totalCLWithdrawals;
        const expectedMaxDiff = maxDiffFor(adjusted);

        await setRefSlot(baseRefSlot - 3n * SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        // preCL <= postCL + wVault -> early exit, but CL withdrawals are still stored in reportData
        // Validators drop matches clWithdrawals so no "appeared" balance.
        await setRefSlot(baseRefSlot - 2n * SLOTS_PER_DAY);
        await callCheck(baseline, ether("9850"), repeatedWVaultSnapshot, 0n, repeatedWVaultSnapshot);

        // same for next report; repeated CL withdrawals tighten adjustedBase
        await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
        await callCheck(ether("9850"), ether("9700"), repeatedWVaultSnapshot, 0n, repeatedWVaultSnapshot);

        await setRefSlot(baseRefSlot);
        await expect(callCheck(ether("9800"), postCL))
          .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
          .withArgs(actualDiff, expectedMaxDiff);
      });
    });

    context("accumulation over multiple reports", () => {
      it("gradual decrease over several reports accumulates", async () => {
        const baseline = ether("10000");
        const finalPostCL = ether("9500");
        const cumulativeDiff = baseline - finalPostCL;
        const expectedMaxDiff = maxDiffFor(baseline);

        await setRefSlot(baseRefSlot - 2n * SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
        await callCheck(baseline, ether("9800"));

        // cumulativeDiff = baseline - finalPostCL
        // (summed over 2 decreases) > expectedMaxDiff
        await setRefSlot(baseRefSlot);
        await expect(callCheck(ether("9800"), finalPostCL))
          .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
          .withArgs(cumulativeDiff, expectedMaxDiff);
      });

      it("balance recovery within window via deposits", async () => {
        const baseline = ether("10000");

        await setRefSlot(baseRefSlot - 2n * SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
        await callCheck(baseline, ether("9700"));

        // deposits raise adjusted balance, increasing the allowed decrease
        await setRefSlot(baseRefSlot);
        await expect(callCheckWithPendingDeposits(ether("9700"), ether("9700"), ether("300"))).not.to.be.reverted;
      });

      it("single large decrease exceeds limit", async () => {
        const baseline = ether("10000");
        const postCL = ether("9300");
        const actualDiff = baseline - postCL;
        const expectedMaxDiff = maxDiffFor(baseline);

        await setRefSlot(baseRefSlot - 2n * SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
        await expect(callCheck(baseline, postCL))
          .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
          .withArgs(actualDiff, expectedMaxDiff);
      });
    });

    context("window boundary behavior", () => {
      it("window grows adaptively from 1 to 36", async () => {
        const baseline = ether("10000");
        const postCL = ether("9700");
        // actualDiff measured from baseline (window start), not from previous report
        const actualDiff = baseline - postCL;
        const expectedMaxDiff = maxDiffFor(baseline);

        await setRefSlot(baseRefSlot - 2n * SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
        await callCheck(baseline, ether("9800"));

        // window=2: cumulative actualDiff (300) < expectedMaxDiff (360) -> passes
        await setRefSlot(baseRefSlot);
        await expect(callCheck(ether("9800"), postCL))
          .to.emit(checker, "NegativeCLRebaseAccepted")
          .withArgs(baseRefSlot, postCL, actualDiff, expectedMaxDiff);
      });

      it("window = 1 with only 2 reports", async () => {
        const baseline = ether("10000");
        const postCL = ether("9700");
        const actualDiff = baseline - postCL;
        const expectedMaxDiff = maxDiffFor(baseline);

        await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        await setRefSlot(baseRefSlot);
        await expect(callCheck(baseline, postCL))
          .to.emit(checker, "NegativeCLRebaseAccepted")
          .withArgs(baseRefSlot, postCL, actualDiff, expectedMaxDiff);
      });

      it("uses X-36 report as baseline at full window", async () => {
        const totalReports = REPORTS_WINDOW + 1;
        const baseline = ether("10000");
        const stableBalance = ether("9600");
        const postCL = ether("9590");
        const wVaultReport1 = ether("400");
        const actualDiff = baseline - postCL;
        const adjusted = baseline - wVaultReport1;
        const expectedMaxDiff = maxDiffFor(adjusted);

        await setRefSlot(baseRefSlot - BigInt(totalReports) * SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        await setRefSlot(baseRefSlot - BigInt(totalReports - 1) * SLOTS_PER_DAY);
        await callCheck(baseline, stableBalance, wVaultReport1, 0n, wVaultReport1);

        for (let i = 2; i < REPORTS_WINDOW; i++) {
          await setRefSlot(baseRefSlot - BigInt(totalReports - i) * SLOTS_PER_DAY);
          await callCheck(stableBalance, stableBalance);
        }

        // At full window, baseline must still be report 0 (X-36), not report 1 (X-35).
        await setRefSlot(baseRefSlot);
        await expect(callCheck(stableBalance, postCL))
          .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
          .withArgs(actualDiff, expectedMaxDiff);
      });

      it("uses a 36-day window by timestamps when reports are delayed", async () => {
        const twoDaysInSeconds = 2n * 24n * 60n * 60n;
        const baseline = ether("10000");
        const postCL = ether("9700");
        const oldWindowWithdrawal = ether("5");
        const actualDiff = baseline - postCL;
        const expectedMaxDiff = maxDiffFor(baseline);

        await callCheck(baseline, baseline, 0n, 0n, 0n, twoDaysInSeconds);
        await callCheck(
          baseline + oldWindowWithdrawal,
          baseline,
          oldWindowWithdrawal,
          oldWindowWithdrawal,
          oldWindowWithdrawal,
          twoDaysInSeconds,
        );

        for (let i = 0; i < 17; ++i) {
          await callCheck(baseline, baseline, 0n, 0n, 0n, twoDaysInSeconds);
        }

        await setRefSlot(baseRefSlot);
        await expect(callCheck(baseline, postCL, 0n, 0n, 0n, twoDaysInSeconds))
          .to.emit(checker, "NegativeCLRebaseAccepted")
          .withArgs(baseRefSlot, postCL, actualDiff, expectedMaxDiff);
      });

      it("excludes baseline report flows from adjusted balance", async () => {
        const totalReports = REPORTS_WINDOW + 1;
        const baseline = ether("10000");
        const baselineWithdrawals = ether("2");
        const postCL = ether("9700");
        const actualDiff = baseline - postCL;
        const expectedMaxDiff = maxDiffFor(baseline);

        await setRefSlot(baseRefSlot - BigInt(totalReports) * SLOTS_PER_DAY);
        await callCheck(
          baseline + baselineWithdrawals,
          baseline,
          baselineWithdrawals,
          baselineWithdrawals,
          baselineWithdrawals,
        );

        for (let i = 1; i < REPORTS_WINDOW; i++) {
          await setRefSlot(baseRefSlot - BigInt(totalReports - i) * SLOTS_PER_DAY);
          await callCheck(baseline, baseline);
        }

        // Baseline report flows should not affect adjusted balance.
        await setRefSlot(baseRefSlot);
        await expect(callCheck(baseline, postCL))
          .to.emit(checker, "NegativeCLRebaseAccepted")
          .withArgs(baseRefSlot, postCL, actualDiff, expectedMaxDiff);
      });

      it("old data is evicted after window is full", async () => {
        const totalReports = REPORTS_WINDOW + 2;
        const baseline = ether("10000");
        const stableBalance = ether("9600");
        const postCL = ether("9590");
        const actualDiff = stableBalance - postCL;
        const expectedMaxDiff = maxDiffFor(stableBalance);

        await setRefSlot(baseRefSlot - BigInt(totalReports) * SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        // preCL <= postCL triggers early exit, storing stableBalance with zero deposits/withdrawals
        await setRefSlot(baseRefSlot - BigInt(totalReports - 1) * SLOTS_PER_DAY);
        await callCheck(stableBalance, stableBalance);

        for (let i = 2; i <= REPORTS_WINDOW; i++) {
          await setRefSlot(baseRefSlot - BigInt(totalReports - i) * SLOTS_PER_DAY);
          await callCheck(stableBalance, stableBalance);
        }

        // report 0 (baseline=10000) evicted -> new baseline = stableBalance
        // actualDiff = stableBalance - postCL (small) < expectedMaxDiff -> passes
        await setRefSlot(baseRefSlot);
        await expect(callCheck(stableBalance, postCL))
          .to.emit(checker, "NegativeCLRebaseAccepted")
          .withArgs(baseRefSlot, postCL, actualDiff, expectedMaxDiff);
      });

      it("before eviction the old baseline is still in window", async () => {
        const totalReports = REPORTS_WINDOW + 1;
        const baseline = ether("10000");
        const stableBalance = ether("9600");
        const postCL = ether("9590");
        const wVaultReport1 = ether("400");
        const actualDiff = baseline - postCL;
        const adjusted = baseline - wVaultReport1;
        const expectedMaxDiff = maxDiffFor(adjusted);

        await setRefSlot(baseRefSlot - BigInt(totalReports) * SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        await setRefSlot(baseRefSlot - BigInt(totalReports - 1) * SLOTS_PER_DAY);
        await callCheck(baseline, stableBalance, wVaultReport1, 0n, wVaultReport1);

        for (let i = 2; i < REPORTS_WINDOW; i++) {
          await setRefSlot(baseRefSlot - BigInt(totalReports - i) * SLOTS_PER_DAY);
          await callCheck(stableBalance, stableBalance);
        }

        // report 0 (baseline) still in window ->
        // actualDiff = baseline - postCL (large)
        // adjusted = baseline - wVaultReport1 ->
        // expectedMaxDiff is small -> actualDiff > expectedMaxDiff -> reverts
        await setRefSlot(baseRefSlot);
        await expect(callCheck(stableBalance, postCL))
          .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
          .withArgs(actualDiff, expectedMaxDiff);
      });

      it("eviction also removes old deposits from the window", async () => {
        const totalReports = REPORTS_WINDOW + 3;
        const baseline = ether("10000");
        const stableBalance = ether("9600");
        const postCL = ether("9590");
        const actualDiff = stableBalance - postCL;
        const expectedMaxDiff = maxDiffFor(stableBalance);

        await setRefSlot(baseRefSlot - BigInt(totalReports) * SLOTS_PER_DAY);
        await callCheck(baseline, baseline);

        // deposits=1000 and wVault=500 stored with report 1; after eviction they leave the window
        await setRefSlot(baseRefSlot - BigInt(totalReports - 1) * SLOTS_PER_DAY);
        await callCheckWithPendingDeposits(stableBalance, ether("9100"), ether("1000"), {
          withdrawalVaultBalance: ether("500"),
          withdrawalsVaultTransfer: ether("500"),
        });

        // clean transition to stableBalance (becomes new baseline after eviction)
        await setRefSlot(baseRefSlot - BigInt(totalReports - 2) * SLOTS_PER_DAY);
        await callCheck(stableBalance, stableBalance);

        for (let i = 3; i <= REPORTS_WINDOW + 1; i++) {
          await setRefSlot(baseRefSlot - BigInt(totalReports - i) * SLOTS_PER_DAY);
          await callCheck(stableBalance, stableBalance);
        }

        // reports 0 and 1 evicted (deposits=1000, wVault=500 gone)
        // new baseline = report 2 with zero deposits/withdrawals
        // adjusted = stableBalance -> expectedMaxDiff based on stableBalance only
        await setRefSlot(baseRefSlot);
        await expect(callCheck(stableBalance, postCL))
          .to.emit(checker, "NegativeCLRebaseAccepted")
          .withArgs(baseRefSlot, postCL, actualDiff, expectedMaxDiff);
      });
    });
  });

  context("OracleReportSanityChecker day-one attack", () => {
    let genesisTime: bigint;
    let baseRefSlot: bigint;

    before(async () => {
      genesisTime = await accountingOracle.GENESIS_TIME();
      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp;
      baseRefSlot = (BigInt(timestamp) - genesisTime) / 12n;
    });

    const setRefSlot = (slot: bigint) => accountingOracle.setLastProcessingRefSlot(slot);

    it("3.6% on day 1 passes, repeated 3.6% on day 2 reverts", async () => {
      const baseline = ether("10000");
      const day1PostCL = baseline - maxDiffFor(baseline);
      const day2PostCL = day1PostCL - maxDiffFor(day1PostCL);

      await setRefSlot(baseRefSlot - 2n * SLOTS_PER_DAY);
      await callCheck(baseline, baseline);

      // day 1: exactly at limit, passes
      await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
      await expect(callCheck(baseline, day1PostCL))
        .to.emit(checker, "NegativeCLRebaseAccepted")
        .withArgs(baseRefSlot - SLOTS_PER_DAY, day1PostCL, maxDiffFor(baseline), maxDiffFor(baseline));

      // day 2: cumulative baseline -> day2PostCL ≈ 7.2% > 3.6% limit
      await setRefSlot(baseRefSlot);
      await expect(callCheck(day1PostCL, day2PostCL)).to.be.revertedWithCustomError(
        checker,
        "IncorrectCLBalanceDecrease",
      );
    });

    it("small daily decreases accumulate and trigger revert", async () => {
      const baseline = ether("10000");
      const dailyDecrease = ether("100");
      const numReports = 5;
      const expectedMaxDiff = maxDiffFor(baseline);

      await setRefSlot(baseRefSlot - BigInt(numReports) * SLOTS_PER_DAY);
      await callCheck(baseline, baseline);

      // 3 reports of 1% decrease each: cumulative 3% < 3.6% limit
      let currentBalance = baseline;
      for (let i = 1; i <= 3; i++) {
        const newBalance = currentBalance - dailyDecrease;
        await setRefSlot(baseRefSlot - BigInt(numReports - i) * SLOTS_PER_DAY);
        await callCheck(currentBalance, newBalance);
        currentBalance = newBalance;
      }

      // 4th decrease: cumulativeDiff = 4 × dailyDecrease (4%)
      // > expectedMaxDiff (3.6%)
      const cumulativeDiff = baseline - (currentBalance - dailyDecrease);
      await setRefSlot(baseRefSlot);
      await expect(callCheck(currentBalance, currentBalance - dailyDecrease))
        .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecrease")
        .withArgs(cumulativeDiff, expectedMaxDiff);
    });
  });

  context("OracleReportSanityChecker edge cases", () => {
    let genesisTime: bigint;
    let baseRefSlot: bigint;

    before(async () => {
      genesisTime = await accountingOracle.GENESIS_TIME();
      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp;
      baseRefSlot = (BigInt(timestamp) - genesisTime) / 12n;
    });

    const setRefSlot = (slot: bigint) => accountingOracle.setLastProcessingRefSlot(slot);

    it("maxCLBalanceDecreaseBP = 0 forbids any decrease", async () => {
      const role = await checker.MAX_CL_BALANCE_DECREASE_MANAGER_ROLE();
      await checker.grantRole(role, deployer.address);
      await checker.setMaxCLBalanceDecreaseBP(0);

      await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
      await callCheck(ether("10000"), ether("10000"));

      await setRefSlot(baseRefSlot);
      await expect(callCheck(ether("10000"), ether("10000") - 1n)).to.be.revertedWithCustomError(
        checker,
        "IncorrectCLBalanceDecrease",
      );
    });

    it("maxCLBalanceDecreaseBP = 10000 allows any decrease", async () => {
      const role = await checker.MAX_CL_BALANCE_DECREASE_MANAGER_ROLE();
      await checker.grantRole(role, deployer.address);
      await checker.setMaxCLBalanceDecreaseBP(10000);

      const baseline = ether("10000");
      await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
      await callCheck(baseline, baseline);

      await setRefSlot(baseRefSlot);
      await expect(callCheck(baseline, ether("1")))
        .to.emit(checker, "NegativeCLRebaseAccepted")
        .withArgs(baseRefSlot, ether("1"), baseline - ether("1"), baseline);
    });

    it("reverts with IncorrectCLBalanceDecreaseWindowData when stored withdrawals exceed adjusted balance", async () => {
      const baseline = ether("100");
      const hugeWithdrawals = baseline + 1n;

      await setRefSlot(baseRefSlot - 3n * SLOTS_PER_DAY);
      await callCheck(baseline, baseline);

      await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
      await callCheck(baseline, 0n, baseline, 0n, baseline);

      // A tiny follow-up withdrawal pushes the cumulative window withdrawals above the baseline.
      await setRefSlot(baseRefSlot - 1n);
      await callCheck(1n, 0n, 1n, 0n, 1n);

      // adjusted = baseline + 0 - hugeWithdrawals -> invalid window inputs for subtraction
      await setRefSlot(baseRefSlot);
      await expect(callCheck(ether("80"), ether("50")))
        .to.be.revertedWithCustomError(checker, "IncorrectCLBalanceDecreaseWindowData")
        .withArgs(baseline, 0n, hugeWithdrawals);
    });

    it("reverts with IncorrectCLWithdrawalsVaultBalance when reported vault balance is below previous post-transfer state", async () => {
      await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
      // Leave 200 ETH in the vault after the report so the next report cannot go below it.
      await callCheck(ether("200"), 0n, ether("200"), 0n, 0n);

      await setRefSlot(baseRefSlot);
      await expect(callCheck(ether("100"), ether("100"), ether("199"), 0n, 0n))
        .to.be.revertedWithCustomError(checker, "IncorrectCLWithdrawalsVaultBalance")
        .withArgs(ether("199"), ether("200"));
    });

    it("reverts with IncorrectWithdrawalsVaultTransfer when transfer exceeds reported vault balance", async () => {
      await setRefSlot(baseRefSlot);
      await expect(callCheck(ether("100"), ether("100"), ether("100"), 0n, ether("101")))
        .to.be.revertedWithCustomError(checker, "IncorrectWithdrawalsVaultTransfer")
        .withArgs(ether("100"), ether("101"));
    });

    it("large balances (36M ETH) do not cause overflow", async () => {
      const totalCLBalance = ether("36000000");
      const depositAmount = ether("1000000");
      const decrease = maxDiffFor(totalCLBalance);

      await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
      await callCheckWithPendingDeposits(totalCLBalance + depositAmount, totalCLBalance, depositAmount);

      const postCL = totalCLBalance - decrease;
      await setRefSlot(baseRefSlot);
      await expect(callCheckWithPendingDeposits(postCL + depositAmount, postCL, depositAmount)).not.to.be.reverted;
    });

    it("getReportDataCount returns correct count after reports", async () => {
      expect(await checker.getReportDataCount()).to.equal(0);

      await callCheck(ether("10000"), ether("10000"));
      expect(await checker.getReportDataCount()).to.equal(1);

      await callCheck(ether("10000"), ether("10000"));
      expect(await checker.getReportDataCount()).to.equal(2);

      await callCheck(ether("10000"), ether("10000"));
      expect(await checker.getReportDataCount()).to.equal(3);
    });

    it("second opinion oracle is not consulted when decrease is within limit", async () => {
      await deploySecondOpinionOracle();

      const baseline = ether("10000");
      const postCL = ether("9700");
      const actualDiff = baseline - postCL;
      const expectedMaxDiff = maxDiffFor(baseline);

      await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
      await callCheck(baseline, baseline);

      // actualDiff < expectedMaxDiff -> within limit ->
      // Accepted (not Confirmed via second opinion)
      await setRefSlot(baseRefSlot);
      const tx = callCheck(baseline, postCL);
      await expect(tx)
        .to.emit(checker, "NegativeCLRebaseAccepted")
        .withArgs(baseRefSlot, postCL, actualDiff, expectedMaxDiff);
      await expect(tx).not.to.emit(checker, "NegativeCLRebaseConfirmed");
    });
  });

  context("OracleReportSanityChecker setMaxCLBalanceDecreaseBP validation", () => {
    it("accepts 0", async () => {
      const role = await checker.MAX_CL_BALANCE_DECREASE_MANAGER_ROLE();
      await checker.grantRole(role, deployer.address);
      await expect(checker.setMaxCLBalanceDecreaseBP(0)).not.to.be.reverted;
    });

    it("accepts 10000 (MAX_BASIS_POINTS)", async () => {
      const role = await checker.MAX_CL_BALANCE_DECREASE_MANAGER_ROLE();
      await checker.grantRole(role, deployer.address);
      await expect(checker.setMaxCLBalanceDecreaseBP(10000)).not.to.be.reverted;
    });

    it("reverts for 10001 with IncorrectLimitValue", async () => {
      const role = await checker.MAX_CL_BALANCE_DECREASE_MANAGER_ROLE();
      await checker.grantRole(role, deployer.address);
      await expect(checker.setMaxCLBalanceDecreaseBP(10001))
        .to.be.revertedWithCustomError(checker, "IncorrectLimitValue")
        .withArgs(10001, 0, 10000);
    });

    it("emits MaxCLBalanceDecreaseBPSet event on change", async () => {
      const role = await checker.MAX_CL_BALANCE_DECREASE_MANAGER_ROLE();
      await checker.grantRole(role, deployer.address);
      await expect(checker.setMaxCLBalanceDecreaseBP(500)).to.emit(checker, "MaxCLBalanceDecreaseBPSet").withArgs(500);
    });
  });

  context("OracleReportSanityChecker second opinion oracle", () => {
    let genesisTime: bigint;
    let baseRefSlot: bigint;

    before(async () => {
      genesisTime = await accountingOracle.GENESIS_TIME();
      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp;
      baseRefSlot = (BigInt(timestamp) - genesisTime) / 12n;
    });

    const setRefSlot = (slot: bigint) => accountingOracle.setLastProcessingRefSlot(slot);

    it("works for happy path and report is not ready", async () => {
      await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
      await callCheck(ether("10000"), ether("10000"));

      await setRefSlot(baseRefSlot);

      await callCheck(ether("10000"), ether("9700"));

      const secondOpinionOracle = await deploySecondOpinionOracle();

      await expect(callCheck(ether("10000"), ether("9500"))).to.be.revertedWithCustomError(
        checker,
        "NegativeRebaseFailedSecondOpinionReportIsNotReady",
      );

      await secondOpinionOracle.addReport(baseRefSlot, {
        success: true,
        clBalanceGwei: parseUnits("9500", "gwei"),
        withdrawalVaultBalanceWei: 0,
        numValidators: 0,
        exitedValidators: 0,
      });
      await expect(callCheck(ether("10000"), ether("9500")))
        .to.emit(checker, "NegativeCLRebaseConfirmed")
        .withArgs(baseRefSlot, ether("9500"), ether("0"));
    });

    it("works for reports close together", async () => {
      await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
      await callCheck(ether("10000"), ether("10000"));

      await setRefSlot(baseRefSlot);

      const secondOpinionOracle = await deploySecondOpinionOracle();

      // second opinion balance diverges too much (~1%) -> revert
      await secondOpinionOracle.addReport(baseRefSlot, {
        success: true,
        clBalanceGwei: parseUnits("9600", "gwei"),
        withdrawalVaultBalanceWei: 0,
        numValidators: 0,
        exitedValidators: 0,
      });

      await expect(callCheck(ether("10000"), ether("9500")))
        .to.be.revertedWithCustomError(checker, "NegativeRebaseFailedCLBalanceMismatch")
        .withArgs(ether("9500"), ether("9600"), anyValue);

      // second opinion balance within margin (<0.74%) -> passes
      await secondOpinionOracle.addReport(baseRefSlot, {
        success: true,
        clBalanceGwei: parseUnits("9510", "gwei"),
        withdrawalVaultBalanceWei: 0,
        numValidators: 0,
        exitedValidators: 0,
      });

      await expect(callCheck(ether("10000"), ether("9500")))
        .to.emit(checker, "NegativeCLRebaseConfirmed")
        .withArgs(baseRefSlot, ether("9500"), ether("0"));

      // second opinion balance higher than reported -> revert
      await secondOpinionOracle.addReport(baseRefSlot, {
        success: true,
        clBalanceGwei: parseUnits("9800", "gwei"),
        withdrawalVaultBalanceWei: 0,
        numValidators: 0,
        exitedValidators: 0,
      });

      await expect(callCheck(ether("10000"), ether("9500")))
        .to.be.revertedWithCustomError(checker, "NegativeRebaseFailedCLBalanceMismatch")
        .withArgs(ether("9500"), ether("9800"), anyValue);
    });

    it("works for reports with incorrect withdrawal vault balance", async () => {
      await setRefSlot(baseRefSlot - SLOTS_PER_DAY);
      await callCheck(ether("10000"), ether("10000"));

      await setRefSlot(baseRefSlot);

      const secondOpinionOracle = await deploySecondOpinionOracle();

      // withdrawal vault matches -> passes
      await secondOpinionOracle.addReport(baseRefSlot, {
        success: true,
        clBalanceGwei: parseUnits("9500", "gwei"),
        withdrawalVaultBalanceWei: ether("1"),
        numValidators: 0,
        exitedValidators: 0,
      });

      await expect(callCheck(ether("10000"), ether("9500"), ether("1")))
        .to.emit(checker, "NegativeCLRebaseConfirmed")
        .withArgs(baseRefSlot, ether("9500"), ether("1"));

      // withdrawal vault mismatch -> revert
      await secondOpinionOracle.addReport(baseRefSlot, {
        success: true,
        clBalanceGwei: parseUnits("9500", "gwei"),
        withdrawalVaultBalanceWei: 0,
        numValidators: 0,
        exitedValidators: 0,
      });

      await expect(callCheck(ether("10000"), ether("9500"), ether("1")))
        .to.be.revertedWithCustomError(checker, "NegativeRebaseFailedWithdrawalVaultBalanceMismatch")
        .withArgs(ether("1"), 0);
    });
  });

  context("OracleReportSanityChecker roles", () => {
    it("setMaxCLBalanceDecreaseBP requires MAX_CL_BALANCE_DECREASE_MANAGER_ROLE", async () => {
      const role = await checker.MAX_CL_BALANCE_DECREASE_MANAGER_ROLE();

      await expect(checker.setMaxCLBalanceDecreaseBP(500)).to.be.revertedWithOZAccessControlError(
        deployer.address,
        role,
      );

      await checker.grantRole(role, deployer.address);
      await expect(checker.setMaxCLBalanceDecreaseBP(500)).to.not.be.reverted;
    });

    it("SECOND_OPINION_MANAGER_ROLE works", async () => {
      const clOraclesRole = await checker.SECOND_OPINION_MANAGER_ROLE();

      await expect(
        checker.setSecondOpinionOracleAndCLBalanceUpperMargin(ZeroAddress, 74),
      ).to.be.revertedWithOZAccessControlError(deployer.address, clOraclesRole);

      await checker.grantRole(clOraclesRole, deployer.address);
      await expect(checker.setSecondOpinionOracleAndCLBalanceUpperMargin(ZeroAddress, 74)).to.not.be.reverted;
    });
  });

  context("OracleReportSanityChecker migrateBaselineSnapshot", () => {
    const CHURN_LIMIT = ether("57600");

    let genesisTime: bigint;
    let baseRefSlot: bigint;

    before(async () => {
      genesisTime = await accountingOracle.GENESIS_TIME();
      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp;
      baseRefSlot = (BigInt(timestamp) - genesisTime) / 12n;
    });

    const setRefSlot = (slot: bigint) => accountingOracle.setLastProcessingRefSlot(slot);

    it("requires MIGRATION_MANAGER_ROLE", async () => {
      const role = await checker.MIGRATION_MANAGER_ROLE();
      await expect(checker.migrateBaselineSnapshot()).to.be.revertedWithOZAccessControlError(deployer.address, role);
    });

    it("reverts with UnexpectedLidoVersion when version != 4", async () => {
      const role = await checker.MIGRATION_MANAGER_ROLE();
      await checker.grantRole(role, deployer.address);

      await lido.mock__setContractVersion(3);
      await expect(checker.migrateBaselineSnapshot())
        .to.be.revertedWithCustomError(checker, "UnexpectedLidoVersion")
        .withArgs(3, 4);
    });

    it("seeds baseline and bootstrap entries in reportData and emits event", async () => {
      const role = await checker.MIGRATION_MANAGER_ROLE();
      await checker.grantRole(role, deployer.address);

      const clActive = ether("10000000");
      const clPending = ether("500000");
      const deposits = ether("320000");
      const depositsCur = ether("320000");
      await lido.mock__setContractVersion(4);
      await lido.mock__setBalanceStats(clActive, clPending, deposits, depositsCur);

      const expectedCLBalance = clActive + clPending;

      await expect(checker.migrateBaselineSnapshot())
        .to.emit(checker, "BaselineSnapshotMigrated")
        .withArgs(expectedCLBalance, deposits, CHURN_LIMIT);

      expect(await checker.getReportDataCount()).to.equal(2);

      const baselineData = await checker.reportData(0);
      expect(baselineData.timestamp).to.equal(0n);
      expect(baselineData.clBalance).to.equal(expectedCLBalance);
      expect(baselineData.deposits).to.equal(0);
      expect(baselineData.clWithdrawals).to.equal(0);

      const bootstrapFlowData = await checker.reportData(1);
      expect(bootstrapFlowData.timestamp).to.equal(0n);
      expect(bootstrapFlowData.clBalance).to.equal(expectedCLBalance);
      expect(bootstrapFlowData.deposits).to.equal(deposits);
      expect(bootstrapFlowData.clWithdrawals).to.equal(CHURN_LIMIT);
    });

    it("reverts with MigrationAlreadyDone on second call", async () => {
      const role = await checker.MIGRATION_MANAGER_ROLE();
      await checker.grantRole(role, deployer.address);

      await lido.mock__setContractVersion(4);
      await lido.mock__setBalanceStats(ether("10000000"), ether("500000"), ether("320000"), ether("320000"));

      await checker.migrateBaselineSnapshot();
      await expect(checker.migrateBaselineSnapshot()).to.be.revertedWithCustomError(checker, "MigrationAlreadyDone");
    });

    it("after migration, decrease within limit passes", async () => {
      const role = await checker.MIGRATION_MANAGER_ROLE();
      await checker.grantRole(role, deployer.address);

      const clActive = ether("10000000");
      const clPending = ether("500000");
      const migrationDeposits = ether("320000");
      const migrationDepositsCur = ether("320000");
      await lido.mock__setContractVersion(4);
      await lido.mock__setBalanceStats(clActive, clPending, migrationDeposits, migrationDepositsCur);

      await checker.migrateBaselineSnapshot();

      // reportData[0] = baseline point with zero flows
      // reportData[1] = bootstrap flow chunk with migration deposits/withdrawals
      const baseline = clActive + clPending;
      const postCL = ether("10200000");
      const actualDiff = baseline - postCL;
      const adjusted = baseline + migrationDeposits - CHURN_LIMIT;
      const expectedMaxDiff = maxDiffFor(adjusted);

      // Pass the actual vault balance as WVB since migration initialized _lastVaultBalanceAfterTransfer
      const vaultBalance = await ethers.provider.getBalance(withdrawalVault.address);
      await setRefSlot(baseRefSlot);
      await expect(callCheck(baseline, postCL, vaultBalance))
        .to.emit(checker, "NegativeCLRebaseAccepted")
        .withArgs(baseRefSlot, postCL, actualDiff, expectedMaxDiff);
    });
  });
});
