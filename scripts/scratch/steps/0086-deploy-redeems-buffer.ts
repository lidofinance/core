import { ethers } from "hardhat";

import { deployBehindOssifiableProxy, deployWithoutProxy } from "lib/deploy";
import { getAddress, readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const lidoAddress = getAddress(Sk.appLido, state);
  const burnerAddress = getAddress(Sk.burner, state);
  const withdrawalQueueAddress = getAddress(Sk.withdrawalQueueERC721, state);
  const hashConsensusAddress = getAddress(Sk.hashConsensusForAccountingOracle, state);

  const refSlotStore = await deployWithoutProxy(Sk.refSlotStore, "RefSlotStore", deployer, [
    hashConsensusAddress,
    deployer,
  ]);

  const redeemsBuffer_ = await deployBehindOssifiableProxy(Sk.redeemsBuffer, "RedeemsBuffer", deployer, deployer, [
    lidoAddress,
    burnerAddress,
    withdrawalQueueAddress,
    refSlotStore.address,
  ]);

  const redeemsBuffer = await ethers.getContractAt("RedeemsBuffer", redeemsBuffer_.address);
  await (await redeemsBuffer.initialize(deployer)).wait();

  const store = await ethers.getContractAt("RefSlotStore", refSlotStore.address);
  const writerRole = await store.WRITER_ROLE();
  await (await store.grantRole(writerRole, redeemsBuffer_.address)).wait();
}
