import * as process from "node:process";

import { ethers } from "hardhat";

import { deployWithoutProxy, ether, impersonate, Sk } from "lib";

import { updateLidoLocatorImplementation } from "../../../../test/deploy";

export async function main() {
  const deployer = process.env.DEPLOYER || (await ethers.provider.getSigner()).address;

  // Extract necessary addresses and parameters from the state
  const locatorAddress = process.env.MAINNET_LOCATOR_ADDRESS;
  const agent = process.env.MAINNET_AGENT_ADDRESS;

  const sanityChecks = {
    churnValidatorsPerDayLimit: 20000,
    deprecatedOneOffCLBalanceDecreaseBPLimit: 500,
    annualBalanceIncreaseBPLimit: 10_00, // 10%
    simulatedShareRateDeviationBPLimit: 50, // 0.5%
    maxValidatorExitRequestsPerReport: 600,
    maxAccountingExtraDataListItemsCount: 4,
    maxNodeOperatorsPerExtraDataItemCount: 50,
    requestTimestampMargin: 7680,
    maxPositiveTokenRebase: 750_000, // 0.0075%
    initialSlashingAmountPWei: 1000, // 1 ETH = 1000 PWei
    inactivityPenaltiesAmountPWei: 101, // 0.101 ETH = 101 PWei
    clBalanceOraclesErrorUpperBPLimit: 50, // 0.5%
  };

  // Deploy OracleReportSanityChecker
  const oracleReportSanityCheckerArgs = [
    locatorAddress,
    agent,
    [
      sanityChecks.churnValidatorsPerDayLimit,
      sanityChecks.deprecatedOneOffCLBalanceDecreaseBPLimit,
      sanityChecks.annualBalanceIncreaseBPLimit,
      sanityChecks.simulatedShareRateDeviationBPLimit,
      sanityChecks.maxValidatorExitRequestsPerReport,
      sanityChecks.maxAccountingExtraDataListItemsCount,
      sanityChecks.maxNodeOperatorsPerExtraDataItemCount,
      sanityChecks.requestTimestampMargin,
      sanityChecks.maxPositiveTokenRebase,
      sanityChecks.initialSlashingAmountPWei,
      sanityChecks.inactivityPenaltiesAmountPWei,
      sanityChecks.clBalanceOraclesErrorUpperBPLimit,
    ],
  ];

  const oracleReportSanityChecker = await deployWithoutProxy(
    Sk.oracleReportSanityChecker,
    "OracleReportSanityChecker",
    deployer,
    oracleReportSanityCheckerArgs,
    "address",
    false, // no need to save the contract in the state
  );

  const proxyLocator = await ethers.getContractAt("OssifiableProxy", locatorAddress);
  const proxyAdmin = await proxyLocator.proxy__getAdmin();

  const proxyAdminSigner = await impersonate(proxyAdmin, ether("100"));

  await updateLidoLocatorImplementation(
    locatorAddress,
    { oracleReportSanityChecker: oracleReportSanityChecker.address },
    "LidoLocator",
    proxyAdminSigner,
  );
}
