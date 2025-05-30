import { ethers } from "hardhat";

import { EIP7002WithdrawalRequest__Mock } from "typechain-types";

// https://github.com/ethereum/EIPs/blob/master/EIPS/eip-7002.md#configuration
export const EIP7002_ADDRESS = "0x00000961Ef480Eb55e80D19ad83579A64c007002";
export const EIP7002_MIN_WITHDRAWAL_REQUEST_FEE = 1n;

export const deployEIP7002WithdrawalRequestContract = async (fee: bigint): Promise<EIP7002WithdrawalRequest__Mock> => {
  const eip7002Mock = await ethers.deployContract("EIP7002WithdrawalRequest__Mock");
  const eip7002MockAddress = await eip7002Mock.getAddress();

  await ethers.provider.send("hardhat_setCode", [EIP7002_ADDRESS, await ethers.provider.getCode(eip7002MockAddress)]);

  const contract = await ethers.getContractAt("EIP7002WithdrawalRequest__Mock", EIP7002_ADDRESS);
  await contract.mock__setFee(fee);

  return contract;
};
