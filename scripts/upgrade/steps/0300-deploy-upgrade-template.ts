import { ethers } from "hardhat";

import { deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

import { readUpgradeParameters } from "../upgrade-utils";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState();
  const parameters = readUpgradeParameters();

  const allowNonSingleBlockUpgrade = true;
  await deployWithoutProxy(Sk.upgradeTemplateV3, "UpgradeTemplateV3", deployer, [
    [
      // New proxy contracts
      state[Sk.accounting].proxy.address,
      state[Sk.vaultHub].proxy.address,
      state[Sk.predepositGuarantee].proxy.address,

      // New non-proxy contracts
      state[Sk.burner].address,
      state[Sk.oracleReportSanityChecker].address,
      state[Sk.stakingVaultFactory].address,

      // New fancy proxy contracts
      state[Sk.stakingVaultBeacon].address,
      state[Sk.stakingVaultImplementation].address,
      state[Sk.delegationImplementation].address,

      // Aragon Apps new implementations
      state[Sk.appLido].implementation.address,

      // New non-aragon implementations
      state[Sk.accountingOracle].implementation.address,
      state[Sk.lidoLocator].implementation.address,
      state[Sk.withdrawalVault].implementation.address,

      // Existing proxies and contracts
      state[Sk.appAgent].proxy.address,
      state[Sk.aragonLidoAppRepo].proxy.address,
      parameters["csm"].accounting,
      state[Sk.lidoLocator].proxy.address,
      state[Sk.appNodeOperatorsRegistry].proxy.address,
      state[Sk.appSimpleDvt].proxy.address,
      state[Sk.appVoting].proxy.address,
      state[Sk.wstETH].address,
    ],
    allowNonSingleBlockUpgrade,
  ]);
}
