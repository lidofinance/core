import { ethers } from "hardhat";

export const EIP7002_ADDRESS = "0x00000961Ef480Eb55e80D19ad83579A64c007002";

async function main() {
  const codeBefore = await ethers.provider.getCode(EIP7002_ADDRESS);

  const eip7002Mock = await ethers.deployContract("EIP7002WithdrawalRequest__Mock");
  const eip7002MockAddress = await eip7002Mock.getAddress();
  await ethers.provider.send("hardhat_setCode", [EIP7002_ADDRESS, await ethers.provider.getCode(eip7002MockAddress)]);
  const codeAfter = await ethers.provider.getCode(EIP7002_ADDRESS);

  if (codeBefore === codeAfter) {
    process.exit(1);
  } // Checking that code was changed indeed

  const contract = await ethers.getContractAt("EIP7002WithdrawalRequest__Mock", EIP7002_ADDRESS);
  console.debug(3);
  console.debug({ code: await ethers.provider.getCode(EIP7002_ADDRESS) });
  await contract.mock__setFee(1n);
  // Freezes with RPC request pattern:
  // eth_blockNumber
  // eth_getStorageAt (6)
  // eth_blockNumber
  // eth_getStorageAt (6)
  // eth_blockNumber
  // eth_getStorageAt (6)
  // ...
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
