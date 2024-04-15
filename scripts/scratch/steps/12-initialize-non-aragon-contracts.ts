import { ethers } from "hardhat";

import { getContractAt } from "lib/contract";
import { makeTx } from "lib/deploy";
import { log, logWideSplitter } from "lib/log";
import { readNetworkState, Sk } from "lib/state-file";
import { en0x } from "lib/string";

async function main() {
  log.scriptStart(__filename);
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const lidoAddress = state[Sk.appLido].proxy.address;
  const legacyOracleAddress = state[Sk.appOracle].proxy.address;
  const nodeOperatorsRegistryAddress = state[Sk.appNodeOperatorsRegistry].proxy.address;
  const nodeOperatorsRegistryParams = state["nodeOperatorsRegistry"].deployParameters;

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

  const testnetAdmin = deployer;
  const accountingOracleAdmin = testnetAdmin;
  const exitBusOracleAdmin = testnetAdmin;
  const stakingRouterAdmin = testnetAdmin;
  const withdrawalQueueAdmin = testnetAdmin;

  //
  // === NodeOperatorsRegistry: initialize ===
  //
  // https://github.com/ethereum/solidity-examples/blob/master/docs/bytes/Bytes.md#description
  const stakingModuleTypeId =
    "0x" +
    ethers.AbiCoder.defaultAbiCoder().encode(["string"], [nodeOperatorsRegistryParams.stakingModuleTypeId]).slice(-64);

  const nodeOperatorsRegistryArgs = [
    lidoLocatorAddress,
    stakingModuleTypeId,
    nodeOperatorsRegistryParams.stuckPenaltyDelay,
  ];
  const nodeOperatorsRegistry = await getContractAt("NodeOperatorsRegistry", nodeOperatorsRegistryAddress);
  await makeTx(nodeOperatorsRegistry, "initialize", nodeOperatorsRegistryArgs, { from: deployer });

  //
  // === Lido: initialize ===
  //
  const lidoInitArgs = [lidoLocatorAddress, eip712StETHAddress];
  const bootstrapInitBalance = 10n; // wei
  const lido = await getContractAt("Lido", lidoAddress);
  await makeTx(lido, "initialize", lidoInitArgs, { value: bootstrapInitBalance, from: deployer });
  logWideSplitter();

  //
  // === LegacyOracle: initialize ===
  //
  const legacyOracleArgs = [lidoLocatorAddress, hashConsensusForAccountingAddress];
  const legacyOracle = await getContractAt("LegacyOracle", legacyOracleAddress);
  await makeTx(legacyOracle, "initialize", legacyOracleArgs, { from: deployer });

  const zeroLastProcessingRefSlot = 0;

  //
  // === AccountingOracle: initialize ===
  //
  //! NB: LegacyOracle must be initialized before
  const accountingOracle = await getContractAt("AccountingOracle", accountingOracleAddress);
  const accountingOracleArgs = [
    accountingOracleAdmin,
    hashConsensusForAccountingAddress,
    accountingOracleParams.consensusVersion,
    zeroLastProcessingRefSlot,
  ];
  await makeTx(accountingOracle, "initializeWithoutMigration", accountingOracleArgs, { from: deployer });

  //
  // === ValidatorsExitBusOracle: initialize ===
  //
  const validatorsExitBusOracle = await getContractAt("ValidatorsExitBusOracle", ValidatorsExitBusOracleAddress);
  const validatorsExitBusOracleArgs = [
    exitBusOracleAdmin, // admin
    hashConsensusForValidatorsExitBusOracleAddress,
    validatorsExitBusOracleParams.consensusVersion,
    zeroLastProcessingRefSlot,
  ];
  await makeTx(validatorsExitBusOracle, "initialize", validatorsExitBusOracleArgs, { from: deployer });

  //
  // === WithdrawalQueue: initialize ===
  //
  const withdrawalQueue = await getContractAt("WithdrawalQueueERC721", withdrawalQueueAddress);
  const withdrawalQueueArgs = [
    withdrawalQueueAdmin, // _admin
  ];
  await makeTx(withdrawalQueue, "initialize", withdrawalQueueArgs, { from: deployer });

  //
  // === WithdrawalQueue: setBaseURI ===
  //
  const withdrawalQueueBaseUri = state["withdrawalQueueERC721"].deployParameters.baseUri;
  if (withdrawalQueueBaseUri !== null && withdrawalQueueBaseUri !== "") {
    const MANAGE_TOKEN_URI_ROLE = await withdrawalQueue.getFunction("MANAGE_TOKEN_URI_ROLE")();
    await makeTx(withdrawalQueue, "grantRole", [MANAGE_TOKEN_URI_ROLE, deployer], { from: deployer });
    await makeTx(withdrawalQueue, "setBaseURI", [withdrawalQueueBaseUri], { from: deployer });
    await makeTx(withdrawalQueue, "renounceRole", [MANAGE_TOKEN_URI_ROLE, deployer], { from: deployer });
  }

  //
  // === StakingRouter: initialize ===
  //
  const withdrawalCredentials = `0x010000000000000000000000${withdrawalVaultAddress.slice(2)}`;
  const stakingRouterArgs = [
    stakingRouterAdmin, // _admin
    lidoAddress, // _lido
    withdrawalCredentials, // _withdrawalCredentials
  ];
  const stakingRouter = await getContractAt("StakingRouter", stakingRouterAddress);
  await makeTx(stakingRouter, "initialize", stakingRouterArgs, { from: deployer });
  logWideSplitter();

  //
  // === OracleDaemonConfig: set parameters ===
  //
  const oracleDaemonConfig = await getContractAt("OracleDaemonConfig", oracleDaemonConfigAddress);
  const CONFIG_MANAGER_ROLE = await oracleDaemonConfig.getFunction("CONFIG_MANAGER_ROLE")();
  await makeTx(oracleDaemonConfig, "grantRole", [CONFIG_MANAGER_ROLE, testnetAdmin], { from: testnetAdmin });
  for (const [key, value] of Object.entries(state.oracleDaemonConfig.deployParameters)) {
    await makeTx(oracleDaemonConfig, "set", [key, en0x(value as number)], { from: deployer });
  }
  await makeTx(oracleDaemonConfig, "renounceRole", [CONFIG_MANAGER_ROLE, testnetAdmin], { from: testnetAdmin });

  log.scriptFinish(__filename);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
