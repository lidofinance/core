import { ethers } from "hardhat";

import { deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState();

  await deployWithoutProxy(Sk.upgradeTemplateV3, "UpgradeTemplateV3", deployer, [
    [
      // New proxy contracts
      state[Sk.accounting].proxy.address,
      state[Sk.vaultHub].proxy.address,
      state[Sk.predepositGuarantee].proxy.address,

      // New non-proxy contracts
      state[Sk.burner].address,
      state[Sk.oracleReportSanityChecker].address,

      // Existing proxies and contracts
      state[Sk.lidoLocator].proxy.address,
      state[Sk.appAgent].proxy.address,
      state[Sk.aragonLidoAppRepo].proxy.address,
      state[Sk.appVoting].proxy.address,
      state[Sk.appNodeOperatorsRegistry].proxy.address,
      state[Sk.appSimpleDvt].proxy.address,
      state[Sk.wstETH].address,

      // Aragon Apps new implementations
      state[Sk.appLido].implementation.address,

      // New non-aragon implementations
      state[Sk.accountingOracle].implementation.address,
      state[Sk.lidoLocator].implementation.address,
      state[Sk.withdrawalVault].implementation.address,
    ],
  ]);
}
