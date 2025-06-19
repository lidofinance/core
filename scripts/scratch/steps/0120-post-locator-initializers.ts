import { ethers } from "hardhat";

import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  // Extract addresses from state
  const lidoAddress = state[Sk.appLido].proxy.address;
  const nodeOperatorsRegistryAddress = state[Sk.appNodeOperatorsRegistry].proxy.address;
  const nodeOperatorsRegistryParams = state[Sk.nodeOperatorsRegistry].deployParameters;
  const simpleDvtRegistryAddress = state[Sk.appSimpleDvt].proxy.address;
  const simpleDvtRegistryParams = state[Sk.simpleDvt].deployParameters;
  const lidoLocatorAddress = state[Sk.lidoLocator].proxy.address;
  const eip712StETHAddress = state[Sk.eip712StETH].address;

  // Initialize NodeOperatorsRegistry

  // https://github.com/ethereum/solidity-examples/blob/master/docs/bytes/Bytes.md#description
  const encodeStakingModuleTypeId = (stakingModuleTypeId: string): string =>
    "0x" + ethers.AbiCoder.defaultAbiCoder().encode(["string"], [stakingModuleTypeId]).slice(-64);

  const nodeOperatorsRegistry = await loadContract("NodeOperatorsRegistry", nodeOperatorsRegistryAddress);
  await makeTx(
    nodeOperatorsRegistry,
    "initialize",
    [
      lidoLocatorAddress,
      encodeStakingModuleTypeId(nodeOperatorsRegistryParams.stakingModuleTypeId),
      nodeOperatorsRegistryParams.stuckPenaltyDelay,
    ],
    { from: deployer },
  );

  const simpleDvtRegistry = await loadContract("NodeOperatorsRegistry", simpleDvtRegistryAddress);
  await makeTx(
    simpleDvtRegistry,
    "initialize",
    [
      lidoLocatorAddress,
      encodeStakingModuleTypeId(simpleDvtRegistryParams.stakingModuleTypeId),
      simpleDvtRegistryParams.stuckPenaltyDelay,
    ],
    { from: deployer },
  );

  // Initialize Lido
  const bootstrapInitBalance = 10n; // wei
  const lido = await loadContract("Lido", lidoAddress);
  await makeTx(lido, "initialize", [lidoLocatorAddress, eip712StETHAddress], {
    value: bootstrapInitBalance,
    from: deployer,
  });
}
