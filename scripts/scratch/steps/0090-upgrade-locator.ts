import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { LidoLocator } from "typechain-types";

import { updateProxyImplementation } from "lib/deploy";
import { getAddress, readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  // Extract necessary addresses and parameters from the state using getAddress
  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const proxyContractsOwner = deployer;

  // Update LidoLocator with valid implementation
  const locatorConfig: LidoLocator.ConfigStruct = {
    accountingOracle: getAddress(Sk.accountingOracle, state),
    depositSecurityModule: getAddress(Sk.depositSecurityModule, state),
    elRewardsVault: getAddress(Sk.executionLayerRewardsVault, state),
    lido: getAddress(Sk.appLido, state),
    oracleReportSanityChecker: getAddress(Sk.oracleReportSanityChecker, state),
    postTokenRebaseReceiver: ZeroAddress,
    burner: getAddress(Sk.burner, state),
    stakingRouter: getAddress(Sk.stakingRouter, state),
    treasury: getAddress(Sk.appAgent, state),
    validatorsExitBusOracle: getAddress(Sk.validatorsExitBusOracle, state),
    withdrawalQueue: getAddress(Sk.withdrawalQueueERC721, state),
    withdrawalVault: getAddress(Sk.withdrawalVault, state),
    validatorExitDelayVerifier: getAddress(Sk.validatorExitDelayVerifier, state),
    triggerableWithdrawalsGateway: getAddress(Sk.triggerableWithdrawalsGateway, state),
    oracleDaemonConfig: getAddress(Sk.oracleDaemonConfig, state),
    accounting: getAddress(Sk.accounting, state),
    predepositGuarantee: getAddress(Sk.predepositGuarantee, state),
    wstETH: getAddress(Sk.wstETH, state),
    vaultHub: getAddress(Sk.vaultHub, state),
    vaultFactory: getAddress(Sk.stakingVaultFactory, state),
    lazyOracle: getAddress(Sk.lazyOracle, state),
    operatorGrid: getAddress(Sk.operatorGrid, state),
  };

  await updateProxyImplementation(Sk.lidoLocator, "LidoLocator", locatorAddress, proxyContractsOwner, [locatorConfig]);
}
