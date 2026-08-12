import { ethers } from "hardhat";

import { AccountingOracle__factory } from "typechain-types";

import {
  ConstructorArgs,
  deployImplementation,
  getAddress,
  logArgs,
  logConfirmReview as logConfirmReview,
  logScriptHeader,
  logStartReview as logStartReview,
  readNetworkState,
  Sk,
} from "lib";

export async function main() {
  const state = readNetworkState();
  const deployer = (await ethers.provider.getSigner()).address;

  await logScriptHeader("SRv3/CMv2 — hoodi AO fix (update3)", deployer);

  //
  //  Collect all param values
  //
  const chainSpec = state[Sk.chainSpec];
  const locatorAddress = getAddress(Sk.lidoLocator, state);

  const aoConstructorArgs: ConstructorArgs<AccountingOracle__factory> = [
    locatorAddress,
    Number(chainSpec.secondsPerSlot),
    Number(chainSpec.genesisTime),
  ];

  logStartReview();
  await logArgs("AccountingOracle", aoConstructorArgs);
  await logConfirmReview();

  await deployImplementation(Sk.accountingOracle, "AccountingOracle", deployer, aoConstructorArgs);
}
