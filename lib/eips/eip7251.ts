import { ethers } from "hardhat";

import { EIP7251MaxEffectiveBalanceRequest__Mock } from "typechain-types";

import { log } from "lib";

// https://github.com/ethereum/EIPs/blob/master/EIPS/eip-7251.md#execution-layer
export const EIP7251_ADDRESS = "0x0000BBdDc7CE488642fb579F8B00f3a590007251";
export const EIP7251_MIN_CONSOLIDATION_FEE = 1n;

export const deployEIP7251MaxEffectiveBalanceRequestContract = async (
  fee: bigint,
): Promise<EIP7251MaxEffectiveBalanceRequest__Mock> => {
  const eip7251Mock = await ethers.deployContract("EIP7251MaxEffectiveBalanceRequest__Mock");
  const eip7251MockAddress = await eip7251Mock.getAddress();

  await ethers.provider.send("hardhat_setCode", [EIP7251_ADDRESS, await ethers.provider.getCode(eip7251MockAddress)]);

  const contract = await ethers.getContractAt("EIP7251MaxEffectiveBalanceRequest__Mock", EIP7251_ADDRESS);
  await contract.mock__setFee(fee);

  return contract;
};

export const ensureEIP7251MaxEffectiveBalanceRequestContractPresent = async (): Promise<void> => {
  const code = await ethers.provider.getCode(EIP7251_ADDRESS);

  if (code === "0x") {
    log.warning(`EIP7251 max effective balance request contract not found at ${EIP7251_ADDRESS}`);

    await deployEIP7251MaxEffectiveBalanceRequestContract(EIP7251_MIN_CONSOLIDATION_FEE);
    log.success("EIP7251 max effective balance request contract is present");
  }
};
