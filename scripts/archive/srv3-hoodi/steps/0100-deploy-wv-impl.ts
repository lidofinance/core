import { ethers } from "hardhat";
import { readUpgradeParameters } from "scripts/utils/upgrade";

import { LidoLocator, WithdrawalVault__factory } from "typechain-types";

import {
  ConstructorArgs,
  deployImplementation,
  getAddress,
  loadContract,
  logArgs,
  logConfirmReview as logConfirmReview,
  logScriptHeader,
  logStartReview as logStartReview,
  readNetworkState,
  Sk,
} from "lib";

export async function main() {
  const state = readNetworkState();
  const parameters = readUpgradeParameters();
  const deployer = (await ethers.provider.getSigner()).address;

  await logScriptHeader("SRv3/CMv2 — Deploy & setup Base Contracts", deployer);

  //
  //  Collect all param values
  //

  const agentAddress = getAddress(Sk.appAgent, state);
  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);

  const lidoAddress = await locator.lido();
  const triggerableWithdrawalsGatewayAddress = await locator.triggerableWithdrawalsGateway();
  const consolidationGatewayAddress = await locator.consolidationGateway();

  //
  // Deploy Withdrawal Vault implementation
  //
  const withdrawalVaultConstructorArgs: ConstructorArgs<WithdrawalVault__factory> = [
    lidoAddress,
    agentAddress,
    triggerableWithdrawalsGatewayAddress,
    consolidationGatewayAddress,
    parameters.withdrawalVault.withdrawalRequestContract,
    parameters.withdrawalVault.consolidationRequestContract,
  ];

  logStartReview();
  await logArgs("WithdrawalVault", withdrawalVaultConstructorArgs);
  await logConfirmReview();

  await deployImplementation(Sk.withdrawalVault, "WithdrawalVault", deployer, withdrawalVaultConstructorArgs);
}
