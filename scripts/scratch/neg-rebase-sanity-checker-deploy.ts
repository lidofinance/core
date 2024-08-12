import { ethers, network } from "hardhat";

import { ether } from "lib";
import { deployWithoutProxy } from "lib/deploy";
import { log, logWideSplitter } from "lib/log";
import { Sk } from "lib/state-file";

import { updateLidoLocatorImplementation } from "test/deploy";

async function main() {
  log.scriptStart(__filename);
  const deployer = process.env.DEPLOYER || "";

  // 0x8f6254332f69557A72b0DA2D5F0Bc07d4CA991E7 - for Sepolia
  const lidoLocatorAddressProxy = "0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb"; // state[Sk.lidoLocator].proxy.address;

  const admin = deployer;

  //
  // === OracleReportSanityChecker ===
  //

  const sanityChecks = {
    churnValidatorsPerDayLimit: 1500,
    deprecatedOneOffCLBalanceDecreaseBPLimit: 0, // 0%
    annualBalanceIncreaseBPLimit: 500, // 10%
    simulatedShareRateDeviationBPLimit: 2_50, // 2.5%
    maxValidatorExitRequestsPerReport: 2000,
    maxAccountingExtraDataListItemsCount: 100,
    maxNodeOperatorsPerExtraDataItemCount: 100,
    requestTimestampMargin: 128,
    maxPositiveTokenRebase: 5_000_000, // 0.05%
    initialSlashingAmountPWei: 1000, // 1 ETH = 1000 PWei
    inactivityPenaltiesAmountPWei: 101, // 0.101 ETH = 101 PWei
    clBalanceOraclesErrorUpperBPLimit: 74, // 0.74%
  };

  const oracleReportSanityCheckerArgs = [
    lidoLocatorAddressProxy,
    admin,
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
  );

  const sanityCheckerAddr = await oracleReportSanityChecker.getAddress();
  console.log("oracleReportSanityChecker", sanityCheckerAddr);

  const PROXY_CONTRACT_NAME = "OssifiableProxy";
  const proxyLocator = await ethers.getContractAt(PROXY_CONTRACT_NAME, lidoLocatorAddressProxy);
  const proxyAdmin = await proxyLocator.proxy__getAdmin();

  const [owner] = await ethers.getSigners();
  await owner.sendTransaction({
    to: proxyAdmin,
    value: ether("1.0"),
  });

  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [proxyAdmin],
  });

  const proxyAdminSigner = await ethers.getSigner(proxyAdmin);

  await updateLidoLocatorImplementation(
    lidoLocatorAddressProxy,
    {
      oracleReportSanityChecker: sanityCheckerAddr,
    },
    "LidoLocator",
    proxyAdminSigner,
  );

  const updatedLocator = await ethers.getContractAt("LidoLocator", lidoLocatorAddressProxy);
  const newReportedSanityCheckerAddr = await updatedLocator.oracleReportSanityChecker();
  if ((await updatedLocator.oracleReportSanityChecker()) !== sanityCheckerAddr) {
    console.log("newReportedSanityCheckerAddr", newReportedSanityCheckerAddr);
    console.log("sanityCheckerAddr", sanityCheckerAddr);
    throw new Error("Failed to update oracleReportSanityChecker");
  }

  logWideSplitter();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
