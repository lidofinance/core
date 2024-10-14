import { ethers } from "hardhat";

import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";
import { en0x } from "lib/string";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  // Extract addresses from state
  const lidoAddress = state[Sk.appLido].proxy.address;
  const legacyOracleAddress = state[Sk.appOracle].proxy.address;
  const nodeOperatorsRegistryAddress = state[Sk.appNodeOperatorsRegistry].proxy.address;
  const nodeOperatorsRegistryParams = state[Sk.nodeOperatorsRegistry].deployParameters;
  const simpleDvtRegistryAddress = state[Sk.appSimpleDvt].proxy.address;
  const simpleDvtRegistryParams = state[Sk.simpleDvt].deployParameters;
  const validatorsExitBusOracleParams = state[Sk.validatorsExitBusOracle].deployParameters;
  const accountingOracleParams = state[Sk.accountingOracle].deployParameters;
  const stakingRouterAddress = state[Sk.stakingRouter].proxy.address;
  const withdrawalQueueAddress = state[Sk.withdrawalQueueERC721].proxy.address;
  const lidoLocatorAddress = state[Sk.lidoLocator].proxy.address;
  const accountingOracleAddress = state[Sk.accountingOracle].proxy.address;
  const hashConsensusForAccountingAddress = state[Sk.hashConsensusForAccountingOracle].address;
  const ValidatorsExitBusOracleAddress = state[Sk.validatorsExitBusOracle].proxy.address;
  const hashConsensusForValidatorsExitBusOracleAddress = state[Sk.hashConsensusForValidatorsExitBusOracle].address;
  const eip712StETHAddress = state[Sk.eip712StETH].address;
  const withdrawalVaultAddress = state[Sk.withdrawalVault].proxy.address;
  const oracleDaemonConfigAddress = state[Sk.oracleDaemonConfig].address;

  // Set admin addresses (using deployer for testnet)
  const testnetAdmin = deployer;
  const accountingOracleAdmin = testnetAdmin;
  const exitBusOracleAdmin = testnetAdmin;
  const stakingRouterAdmin = testnetAdmin;
  const withdrawalQueueAdmin = testnetAdmin;

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

  // Initialize LegacyOracle
  const legacyOracle = await loadContract("LegacyOracle", legacyOracleAddress);
  await makeTx(legacyOracle, "initialize", [lidoLocatorAddress, hashConsensusForAccountingAddress], { from: deployer });

  const zeroLastProcessingRefSlot = 0;

  // Initialize AccountingOracle
  const accountingOracle = await loadContract("AccountingOracle", accountingOracleAddress);
  await makeTx(
    accountingOracle,
    "initializeWithoutMigration",
    [
      accountingOracleAdmin,
      hashConsensusForAccountingAddress,
      accountingOracleParams.consensusVersion,
      zeroLastProcessingRefSlot,
    ],
    { from: deployer },
  );

  // Initialize ValidatorsExitBusOracle
  const validatorsExitBusOracle = await loadContract("ValidatorsExitBusOracle", ValidatorsExitBusOracleAddress);
  await makeTx(
    validatorsExitBusOracle,
    "initialize",
    [
      exitBusOracleAdmin,
      hashConsensusForValidatorsExitBusOracleAddress,
      validatorsExitBusOracleParams.consensusVersion,
      zeroLastProcessingRefSlot,
    ],
    { from: deployer },
  );

  // Initialize WithdrawalQueue
  const withdrawalQueue = await loadContract("WithdrawalQueueERC721", withdrawalQueueAddress);
  await makeTx(withdrawalQueue, "initialize", [withdrawalQueueAdmin], { from: deployer });

  // Set WithdrawalQueue base URI if provided
  const withdrawalQueueBaseUri = state["withdrawalQueueERC721"].deployParameters.baseUri;
  if (withdrawalQueueBaseUri !== null && withdrawalQueueBaseUri !== "") {
    const MANAGE_TOKEN_URI_ROLE = await withdrawalQueue.getFunction("MANAGE_TOKEN_URI_ROLE")();
    await makeTx(withdrawalQueue, "grantRole", [MANAGE_TOKEN_URI_ROLE, deployer], { from: deployer });
    await makeTx(withdrawalQueue, "setBaseURI", [withdrawalQueueBaseUri], { from: deployer });
    await makeTx(withdrawalQueue, "renounceRole", [MANAGE_TOKEN_URI_ROLE, deployer], { from: deployer });
  }

  // Initialize StakingRouter
  const withdrawalCredentials = `0x010000000000000000000000${withdrawalVaultAddress.slice(2)}`;
  const stakingRouter = await loadContract("StakingRouter", stakingRouterAddress);
  await makeTx(stakingRouter, "initialize", [stakingRouterAdmin, lidoAddress, withdrawalCredentials], {
    from: deployer,
  });

  // Set OracleDaemonConfig parameters
  const oracleDaemonConfig = await loadContract("OracleDaemonConfig", oracleDaemonConfigAddress);
  const CONFIG_MANAGER_ROLE = await oracleDaemonConfig.getFunction("CONFIG_MANAGER_ROLE")();
  await makeTx(oracleDaemonConfig, "grantRole", [CONFIG_MANAGER_ROLE, testnetAdmin], { from: testnetAdmin });

  // Set each parameter in the OracleDaemonConfig
  for (const [key, value] of Object.entries(state.oracleDaemonConfig.deployParameters)) {
    await makeTx(oracleDaemonConfig, "set", [key, en0x(value as number)], { from: deployer });
  }

  await makeTx(oracleDaemonConfig, "renounceRole", [CONFIG_MANAGER_ROLE, testnetAdmin], { from: testnetAdmin });
}
