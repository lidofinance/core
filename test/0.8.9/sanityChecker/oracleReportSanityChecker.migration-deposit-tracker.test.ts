import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Accounting__MockForSanityChecker,
  AccountingOracle__MockForSanityChecker,
  Lido__MockForSanityChecker,
  OracleReportSanityChecker,
} from "typechain-types";

import { ether, impersonate, randomAddress } from "lib";

import { DAY } from "./specs/lib";
import { migrationHoodiNegativeRebaseFormulaFixtureSet } from "./specs/negative-rebase/fixtures/migration-hoodi";

const MAX_BASIS_POINTS = 10_000n;

type CheckerFixture = {
  checker: OracleReportSanityChecker;
  accountingSigner: HardhatEthersSigner;
  lido: Lido__MockForSanityChecker;
};

const deployChecker = async (): Promise<CheckerFixture> => {
  const [deployer] = await ethers.getSigners();
  const withdrawalVaultAddress = randomAddress();
  await setBalance(withdrawalVaultAddress, 0n);

  const burner = await ethers.deployContract("Burner__MockForSanityChecker", []);
  const accounting = (await ethers.deployContract(
    "Accounting__MockForSanityChecker",
    [],
  )) as Accounting__MockForSanityChecker;
  const accountingOracle = (await ethers.deployContract("AccountingOracle__MockForSanityChecker", [
    deployer.address,
    12,
    1_606_824_023,
  ])) as AccountingOracle__MockForSanityChecker;
  const lido = (await ethers.deployContract("Lido__MockForSanityChecker")) as Lido__MockForSanityChecker;
  const stakingRouter = await ethers.deployContract("StakingRouter__MockForSanityChecker");

  const locator = await ethers.deployContract("LidoLocator__MockForSanityChecker", [
    {
      lido: await lido.getAddress(),
      depositSecurityModule: deployer.address,
      elRewardsVault: deployer.address,
      accountingOracle: await accountingOracle.getAddress(),
      oracleReportSanityChecker: deployer.address,
      burner: await burner.getAddress(),
      validatorsExitBusOracle: deployer.address,
      stakingRouter: await stakingRouter.getAddress(),
      treasury: deployer.address,
      withdrawalQueue: deployer.address,
      withdrawalVault: withdrawalVaultAddress,
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

  const checker = (await ethers.deployContract("OracleReportSanityChecker", [
    await locator.getAddress(),
    await accounting.getAddress(),
    deployer.address,
    migrationHoodiNegativeRebaseFormulaFixtureSet.limits,
  ])) as OracleReportSanityChecker;

  return {
    checker,
    accountingSigner: await impersonate(await accounting.getAddress(), ether("1")),
    lido,
  };
};

const report = (
  fixture: CheckerFixture,
  preValidatorsBalance: bigint,
  postValidatorsBalance: bigint,
  deposits: bigint,
) =>
  fixture.checker
    .connect(fixture.accountingSigner)
    .checkAccountingOracleReport(DAY, preValidatorsBalance, 0n, postValidatorsBalance, 0n, 0n, 0n, 0n, deposits, 0n);

describe("OracleReportSanityChecker.sol:migration deposit accounting", () => {
  it("reverts when migration reportData includes deposits that the first report also passes", async () => {
    const validatorsBalance = ether("3200");
    const migratedDeposits = ether("320");
    const realLoss = ether("100");
    const postReportCLBalance = validatorsBalance + migratedDeposits - realLoss;
    const limits = migrationHoodiNegativeRebaseFormulaFixtureSet.limits;
    const fixture = await deployChecker();

    await fixture.lido.mock__setContractVersion(4n);
    await fixture.lido.mock__setBalanceStats(validatorsBalance, migratedDeposits, migratedDeposits, migratedDeposits);

    await expect(fixture.checker.migrateBaselineSnapshot()).not.to.be.reverted;

    const migrationBaseline = await fixture.checker.reportData(0n);
    expect(migrationBaseline.clBalance, "migration baseline already includes migrated deposits").to.equal(
      validatorsBalance + migratedDeposits,
    );
    expect(migrationBaseline.deposits, "migration baseline stores zero report deposits").to.equal(0n);

    const doubleCountedWindowBase = migrationBaseline.clBalance + migratedDeposits;
    const doubleCountedLoss = realLoss + migratedDeposits;
    const doubleCountedWindowLimit = (doubleCountedWindowBase * limits.maxCLBalanceDecreaseBP) / MAX_BASIS_POINTS;

    await expect(report(fixture, validatorsBalance, postReportCLBalance, migratedDeposits))
      .to.be.revertedWithCustomError(fixture.checker, "IncorrectCLBalanceDecrease")
      .withArgs(doubleCountedLoss, doubleCountedWindowLimit);
  });
});
