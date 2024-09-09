import { assert } from "chai";
import { ethers, network } from "hardhat";

import { deployWithoutProxy, ether, findEvents } from "lib";

export async function main(): Promise<void> {
  const deployer = (await ethers.provider.getSigner()).address;
  assert.equal(process.env.DEPLOYER, deployer);

  // const state = readNetworkState();
  const sepoliaDepositContract = "0x7f02C3E3c98b133055B8B348B2Ac625669Ed295D";
  const sepoliaDepositAdapterProxyAddr = "0x80b5DC88C98E528bF9cb4B7F0f076aC41da24651";

  const depositAdapter = await deployWithoutProxy(null, "SepoliaDepositAdapter", deployer, [sepoliaDepositContract]);

  const depositAdapterAddr = await depositAdapter.getAddress();
  console.log("depositAdapterAddr", depositAdapterAddr);

  const PROXY_CONTRACT_NAME = "OssifiableProxy";
  const proxy = await ethers.getContractAt(PROXY_CONTRACT_NAME, sepoliaDepositAdapterProxyAddr);
  const proxyAdmin = await proxy.proxy__getAdmin();

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
  await proxy.connect(proxyAdminSigner).proxy__upgradeTo(depositAdapterAddr);

  console.log("SepoliaDepositAdapter upgraded");
  const impl = await proxy.proxy__getImplementation();
  console.log("Implementation", impl);

  const proxiedAdapter = await ethers.getContractAt("SepoliaDepositAdapter", sepoliaDepositAdapterProxyAddr);
  const tx = await proxiedAdapter.initialize(deployer);

  const receipt = await tx.wait();
  const events = findEvents(receipt!, "OwnershipTransferred");
  console.log("OwnershipTransferred", events);
}
