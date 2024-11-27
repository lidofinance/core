import { ethers } from "hardhat";

import { deployLidoLocatorImplementation, deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  // Extract necessary addresses and parameters from the state
  const locatorAddress = state[Sk.lidoLocator].proxy.address;

  const proxyContractsOwner = deployer;
  const admin = deployer;

  const sanityChecks = state["oracleReportSanityChecker"].deployParameters;

  // Deploy OracleReportSanityChecker
  const oracleReportSanityCheckerArgs = [
    locatorAddress,
    admin,
    [
      sanityChecks.exitedValidatorsPerDayLimit,
      sanityChecks.appearedValidatorsPerDayLimit,
      sanityChecks.annualBalanceIncreaseBPLimit,
      sanityChecks.simulatedShareRateDeviationBPLimit,
      sanityChecks.maxValidatorExitRequestsPerReport,
      sanityChecks.maxItemsPerExtraDataTransaction,
      sanityChecks.maxNodeOperatorsPerExtraDataItem,
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
  );

  await deployLidoLocatorImplementation(
    locatorAddress,
    { oracleReportSanityChecker: oracleReportSanityChecker.address },
    proxyContractsOwner,
  );
}
