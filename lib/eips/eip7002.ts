import { ethers } from "hardhat";

import { EIP7002WithdrawalRequest__Mock } from "typechain-types";

import { log } from "lib";

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

export const ensureEIP7002WithdrawalRequestContractPresent = async (): Promise<void> => {
  const code = await ethers.provider.getCode(EIP7002_ADDRESS);

  if (code === "0x") {
    log.warning(`EIP7002 withdrawal request contract not found at ${EIP7002_ADDRESS}`);

    await deployEIP7002WithdrawalRequestContract(EIP7002_MIN_WITHDRAWAL_REQUEST_FEE);
    log.success("EIP7002 withdrawal request contract is present");
  }
};
