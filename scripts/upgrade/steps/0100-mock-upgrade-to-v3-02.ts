import { ethers } from "hardhat";

import { deployImplementation, loadContract, makeTx, readNetworkState, Sk } from "lib";
import { impersonate } from "lib/account";

export async function main(): Promise<void> {
  const deployer = (await ethers.provider.getSigner()).address;

  const state = readNetworkState();

  const lazyOracle = await deployImplementation(Sk.lazyOracle, "LazyOracle", deployer, [
    state[Sk.lidoLocator].proxy.address,
  ]);

  const agentAddress = state[Sk.appAgent].proxy.address;
  const agent = await impersonate(agentAddress, ethers.parseEther("1"));

  const proxy = await loadContract("OssifiableProxy", state[Sk.lazyOracle].proxy.address, agent);
  await makeTx(proxy, "proxy__upgradeTo", [lazyOracle.address], { from: agentAddress });
}
