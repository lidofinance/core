import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Accounting__MockForSanityChecker,
  AccountingOracle__MockForSanityChecker,
  Burner__MockForSanityChecker,
  LidoLocator__MockForSanityChecker,
  OracleReportSanityChecker,
  StakingRouter__MockForAccountingOracle,
  WithdrawalQueue__MockForSanityChecker,
} from "typechain-types";

import { ether, ONE_GWEI } from "lib";

import { Snapshot } from "test/suite";

const ONE_DAY = 24n * 60n * 60n;

describe("OracleReportSanityChecker.sol:checkModuleAndCLBalancesChangeRates", () => {
  type ModuleBalance = {
    id: bigint;
    validatorsBalanceWei: bigint;
    pendingWei?: bigint;
  };

  const limits = {
    exitedEthAmountPerDayLimit: 100n,
    appearedEthAmountPerDayLimit: 100n,
    annualBalanceIncreaseBPLimit: 1_000n,
    simulatedShareRateDeviationBPLimit: 250n,
    maxBalanceExitRequestedPerReportInEth: 65_000n,
    maxItemsPerExtraDataTransaction: 15n,
    maxNodeOperatorsPerExtraDataItem: 16n,
    requestTimestampMargin: 128n,
    maxPositiveTokenRebase: 5_000_000n,
    maxCLBalanceDecreaseBP: 360n,
    clBalanceOraclesErrorUpperBPLimit: 50n,
    consolidationEthAmountPerDayLimit: 10n,
    exitedValidatorEthAmountLimit: 1n,
  };

  let checker: OracleReportSanityChecker;
  let locator: LidoLocator__MockForSanityChecker;
  let burner: Burner__MockForSanityChecker;
  let accounting: Accounting__MockForSanityChecker;
  let withdrawalQueue: WithdrawalQueue__MockForSanityChecker;
  let stakingRouter: StakingRouter__MockForAccountingOracle;
  let accountingOracle: AccountingOracle__MockForSanityChecker;

  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let manager: HardhatEthersSigner;
  let elRewardsVault: HardhatEthersSigner;

  let originalState: string;

  const toGwei = (weiAmount: bigint) => weiAmount / ONE_GWEI;

  const toModuleInput = (modules: ModuleBalance[]) => {
    const ids = modules.map((m) => m.id);
    const validatorBalancesGweiByStakingModule = modules.map((m) => toGwei(m.validatorsBalanceWei));
    const pendingBalancesGwei = modules.map((m) => toGwei(m.pendingWei ?? 0n));
    const clValidatorsBalanceGwei = validatorBalancesGweiByStakingModule.reduce((sum, val) => sum + val, 0n);
    const clPendingBalanceGwei = pendingBalancesGwei.reduce((sum, val) => sum + val, 0n);

    return {
      ids,
      validatorBalancesGweiByStakingModule,
      pendingBalancesGwei,
      clValidatorsBalanceGwei,
      clPendingBalanceGwei,
    };
  };

  const seedPreviousBalances = async (modules: ModuleBalance[]) => {
    const input = toModuleInput(modules);
    await stakingRouter.reportValidatorBalancesByStakingModule(
      input.ids,
      input.validatorBalancesGweiByStakingModule,
      input.pendingBalancesGwei,
    );
  };

  const check = async (modules: ModuleBalance[], timeElapsed = ONE_DAY) => {
    const input = toModuleInput(modules);
    return checker.checkModuleAndCLBalancesChangeRates(
      input.ids,
      input.validatorBalancesGweiByStakingModule,
      input.pendingBalancesGwei,
      input.clValidatorsBalanceGwei,
      input.clPendingBalanceGwei,
      timeElapsed,
    );
  };

  before(async () => {
    [deployer, admin, manager, elRewardsVault] = await ethers.getSigners();

    withdrawalQueue = await ethers.deployContract("WithdrawalQueue__MockForSanityChecker");
    burner = await ethers.deployContract("Burner__MockForSanityChecker");
    accounting = await ethers.deployContract("Accounting__MockForSanityChecker");
    stakingRouter = await ethers.deployContract("StakingRouter__MockForAccountingOracle");

    accountingOracle = await ethers.deployContract("AccountingOracle__MockForSanityChecker", [
      deployer.address,
      12,
      1_606_824_023,
    ]);

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
        withdrawalVault: deployer.address,
        postTokenRebaseReceiver: deployer.address,
        oracleDaemonConfig: deployer.address,
        validatorExitDelayVerifier: deployer.address,
        triggerableWithdrawalsGateway: deployer.address,
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
      limits,
    ]);
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  it("passes for empty module arrays and zero totals", async () => {
    await expect(checker.checkModuleAndCLBalancesChangeRates([], [], [], 0n, 0n, ONE_DAY)).not.to.be.reverted;
  });

  it("reverts with InvalidClBalancesData on array length mismatch", async () => {
    await expect(
      checker.checkModuleAndCLBalancesChangeRates([1n], [1n], [], 1n, 0n, ONE_DAY),
    ).to.be.revertedWithCustomError(checker, "InvalidClBalancesData");
  });

  it("reverts with InconsistentValidatorsBalanceByModule when validators balance sum mismatches", async () => {
    await expect(checker.checkModuleAndCLBalancesChangeRates([1n, 2n], [10n, 20n], [1n, 2n], 40n, 3n, ONE_DAY))
      .to.be.revertedWithCustomError(checker, "InconsistentValidatorsBalanceByModule")
      .withArgs(40n, 30n);
  });

  it("reverts with InconsistentPendingBalanceByModule when pending sum mismatches", async () => {
    await expect(checker.checkModuleAndCLBalancesChangeRates([1n, 2n], [10n, 20n], [1n, 2n], 30n, 4n, ONE_DAY))
      .to.be.revertedWithCustomError(checker, "InconsistentPendingBalanceByModule")
      .withArgs(4n, 3n);
  });

  it("passes on boundary values with mixed module increase/decrease directions", async () => {
    await seedPreviousBalances([
      { id: 1n, validatorsBalanceWei: ether("100") },
      { id: 2n, validatorsBalanceWei: ether("100") },
    ]);

    await expect(
      check([
        { id: 1n, validatorsBalanceWei: ether("210") }, // +110 ETH
        { id: 2n, validatorsBalanceWei: ether("90") }, // -10 ETH
      ]),
    ).not.to.be.reverted;
  });

  it("reverts with AppearedEthAmountPerDayLimitExceeded when module increase exceeds appeared+consolidation", async () => {
    const currentIncreasePerDay = ether("111");
    const expectedLimitPerDay =
      (limits.appearedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1");

    await expect(check([{ id: 1n, validatorsBalanceWei: currentIncreasePerDay }]))
      .to.be.revertedWithCustomError(checker, "AppearedEthAmountPerDayLimitExceeded")
      .withArgs(expectedLimitPerDay, currentIncreasePerDay);
  });

  it("sums module increases across modules before checking appeared limit", async () => {
    const totalIncreasePerDay = ether("120");
    const expectedLimitPerDay =
      (limits.appearedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1");

    await expect(
      check([
        { id: 1n, validatorsBalanceWei: ether("60") },
        { id: 2n, validatorsBalanceWei: ether("60") },
      ]),
    )
      .to.be.revertedWithCustomError(checker, "AppearedEthAmountPerDayLimitExceeded")
      .withArgs(expectedLimitPerDay, totalIncreasePerDay);
  });

  it("reverts with ModuleBalanceDecreaseRatePerDayLimitExceeded when module decrease exceeds exited+consolidation", async () => {
    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: ether("111") }]);

    const decreasePerDay = ether("111");
    const expectedLimitPerDay =
      (limits.exitedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1");

    await expect(check([{ id: 1n, validatorsBalanceWei: 0n }]))
      .to.be.revertedWithCustomError(checker, "ModuleBalanceDecreaseRatePerDayLimitExceeded")
      .withArgs(expectedLimitPerDay, decreasePerDay);
  });

  it("does not apply total CL increase limit in module/consistency path", async () => {
    await expect(check([{ id: 1n, validatorsBalanceWei: ether("105") }])).not.to.be.reverted;
  });

  it("does not apply total CL decrease limit in module/consistency path", async () => {
    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: ether("105") }]);

    await expect(check([{ id: 1n, validatorsBalanceWei: 0n }])).not.to.be.reverted;
  });

  it("uses timeElapsed in per-day normalization (timeElapsed = 0 path)", async () => {
    const baseIncrease = ether("1");
    const normalizedIncreasePerDay = baseIncrease * 86_400n;
    const expectedLimitPerDay =
      (limits.appearedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1");

    await expect(check([{ id: 1n, validatorsBalanceWei: baseIncrease }], 0n))
      .to.be.revertedWithCustomError(checker, "AppearedEthAmountPerDayLimitExceeded")
      .withArgs(expectedLimitPerDay, normalizedIncreasePerDay);
  });

  it("applies dynamic slashing allowance to module and CL decrease limits", async () => {
    await seedPreviousBalances([{ id: 1n, validatorsBalanceWei: ether("1030") }]);

    await expect(check([{ id: 1n, validatorsBalanceWei: ether("900") }])).not.to.be.reverted;

    await checker.connect(admin).grantRole(await checker.MAX_CL_BALANCE_DECREASE_MANAGER_ROLE(), manager.address);
    await checker.connect(manager).setMaxCLBalanceDecreaseBP(0n);

    await expect(check([{ id: 1n, validatorsBalanceWei: ether("900") }]))
      .to.be.revertedWithCustomError(checker, "ModuleBalanceDecreaseRatePerDayLimitExceeded")
      .withArgs(
        (limits.exitedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1"),
        ether("130"),
      );
  });

  it("sums module decreases across modules before checking module decrease limit", async () => {
    await seedPreviousBalances([
      { id: 1n, validatorsBalanceWei: ether("70") },
      { id: 2n, validatorsBalanceWei: ether("41") },
    ]);

    await expect(
      check([
        { id: 1n, validatorsBalanceWei: 0n },
        { id: 2n, validatorsBalanceWei: 0n },
      ]),
    )
      .to.be.revertedWithCustomError(checker, "ModuleBalanceDecreaseRatePerDayLimitExceeded")
      .withArgs(
        (limits.exitedEthAmountPerDayLimit + limits.consolidationEthAmountPerDayLimit) * ether("1"),
        ether("111"),
      );
  });
});
