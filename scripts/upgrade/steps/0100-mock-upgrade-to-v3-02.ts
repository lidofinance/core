import { ethers } from "hardhat";

import { deployImplementation, loadContract, makeTx, readNetworkState, Sk } from "lib";
import { impersonate } from "lib/account";

export async function main(): Promise<void> {
  const deployer = (await ethers.provider.getSigner()).address;

  const state = readNetworkState();

  const agentAddress = state[Sk.appAgent].proxy.address;
  const agent = await impersonate(agentAddress, ethers.parseEther("1"));

  const lazyOracle = await deployImplementation(Sk.lazyOracle, "LazyOracle", deployer, [
    state[Sk.lidoLocator].proxy.address,
  ]);
  const lazyOracleProxy = await loadContract("OssifiableProxy", state[Sk.lazyOracle].proxy.address, agent);
  await makeTx(lazyOracleProxy, "proxy__upgradeTo", [lazyOracle.address], { from: agentAddress });

  const vaultHub = await deployImplementation(
    Sk.vaultHub,
    "VaultHub",
    deployer,
    state[Sk.vaultHub].implementation.constructorArgs,
  );
  const vaultHubProxy = await loadContract("OssifiableProxy", state[Sk.vaultHub].proxy.address, agent);
  await makeTx(vaultHubProxy, "proxy__upgradeTo", [vaultHub.address], { from: agentAddress });
}
