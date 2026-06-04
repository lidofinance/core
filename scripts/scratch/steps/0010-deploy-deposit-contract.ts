import { ethers } from "hardhat";

import { deployBehindOssifiableProxy, deployWithoutProxy } from "lib/deploy";
import { cy, log } from "lib/log";
import { SEPOLIA_CHAIN_ID, SEPOLIA_ORIGINAL_DEPOSIT_CONTRACT } from "lib/protocol/sepolia";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const preset = state.chainSpec.depositContract;
  if (preset) {
    log(`Using DepositContract at: ${cy(preset)}`);
    return;
  }

  const depositContractAddress =
    state.chainId === SEPOLIA_CHAIN_ID
      ? await deploySepoliaDepositAdapter(deployer)
      : (await deployWithoutProxy(Sk.depositContract, "DepositContract", deployer)).address;

  updateObjectInState(Sk.chainSpec, { depositContract: depositContractAddress });
}

async function deploySepoliaDepositAdapter(deployer: string): Promise<string> {
  const code = await ethers.provider.getCode(SEPOLIA_ORIGINAL_DEPOSIT_CONTRACT);
  if (code === "0x") {
    throw new Error(
      `chainId ${SEPOLIA_CHAIN_ID} (Sepolia) but no code at ${SEPOLIA_ORIGINAL_DEPOSIT_CONTRACT}. ` +
        `Is the RPC actually Sepolia / a Sepolia fork?`,
    );
  }

  const adapterIface = (await ethers.getContractFactory("SepoliaDepositAdapter")).interface;
  const initData = adapterIface.encodeFunctionData("initialize", [deployer]);

  // Deployer holds proxy admin initially so deployment can proceed; ownership later handed to
  // Agent (governance) for decentralized upgrade control.
  const proxy = await deployBehindOssifiableProxy(
    Sk.sepoliaDepositAdapter,
    "SepoliaDepositAdapter",
    deployer, // proxy admin - supposed to be transferred to Agent later
    deployer,
    [SEPOLIA_ORIGINAL_DEPOSIT_CONTRACT],
    null, // implementation
    true, // withStateFile
    undefined, // signerOrOptions
    initData,
  );

  log(`SepoliaDepositAdapter at ${cy(proxy.address)}. Fund it with BEPOLIA before any deposits.`);

  return proxy.address;
}
