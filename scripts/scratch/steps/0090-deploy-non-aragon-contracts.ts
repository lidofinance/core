import { ethers } from "hardhat";

import { certainAddress } from "lib";
import { getContractPath } from "lib/contract";
import {
  deployBehindOssifiableProxy,
  deployContract,
  deployImplementation,
  deployWithoutProxy,
  updateProxyImplementation,
} from "lib/deploy";
import { log } from "lib/log";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  // Extract necessary addresses and parameters from the state
  const lidoAddress = state[Sk.appLido].proxy.address;
  const legacyOracleAddress = state[Sk.appOracle].proxy.address;
  const votingAddress = state[Sk.appVoting].proxy.address;
  const treasuryAddress = state[Sk.appAgent].proxy.address;
  const chainSpec = state[Sk.chainSpec];
  const depositSecurityModuleParams = state[Sk.depositSecurityModule].deployParameters;
  const burnerParams = state[Sk.burner].deployParameters;
  const hashConsensusForAccountingParams = state[Sk.hashConsensusForAccountingOracle].deployParameters;
  const hashConsensusForExitBusParams = state[Sk.hashConsensusForValidatorsExitBusOracle].deployParameters;
  const withdrawalQueueERC721Params = state[Sk.withdrawalQueueERC721].deployParameters;
  const minFirstAllocationStrategyAddress = state[Sk.minFirstAllocationStrategy].address;

  const proxyContractsOwner = deployer;
  const admin = deployer;

  if (!chainSpec.depositContract) {
    throw new Error(`please specify deposit contract address in state file at /chainSpec/depositContract`);
  }

  const depositContract = state.chainSpec.depositContract;

  // Deploy OracleDaemonConfig
  const oracleDaemonConfig = await deployWithoutProxy(Sk.oracleDaemonConfig, "OracleDaemonConfig", deployer, [
    admin,
    [],
  ]);

  // Deploy DummyEmptyContract
  const dummyContract = await deployWithoutProxy(Sk.dummyEmptyContract, "DummyEmptyContract", deployer);

  // Deploy LidoLocator with dummy implementation
  const locator = await deployBehindOssifiableProxy(
    Sk.lidoLocator,
    "DummyEmptyContract",
    proxyContractsOwner,
    deployer,
    [],
    dummyContract.address,
  );

  // Deploy EIP712StETH
  await deployWithoutProxy(Sk.eip712StETH, "EIP712StETH", deployer, [lidoAddress]);

  // Deploy WstETH
  const wstETH = await deployWithoutProxy(Sk.wstETH, "WstETH", deployer, [lidoAddress]);

  // Deploy WithdrawalQueueERC721
  const withdrawalQueueERC721 = await deployBehindOssifiableProxy(
    Sk.withdrawalQueueERC721,
    "WithdrawalQueueERC721",
    proxyContractsOwner,
    deployer,
    [wstETH.address, withdrawalQueueERC721Params.name, withdrawalQueueERC721Params.symbol],
  );

  // Deploy WithdrawalVault
  const withdrawalVaultImpl = await deployImplementation(Sk.withdrawalVault, "WithdrawalVault", deployer, [
    lidoAddress,
    treasuryAddress,
  ]);

  const withdrawalsManagerProxyConstructorArgs = [votingAddress, withdrawalVaultImpl.address];
  const withdrawalsManagerProxy = await deployContract(
    "WithdrawalsManagerProxy",
    withdrawalsManagerProxyConstructorArgs,
    deployer,
  );

  const withdrawalVaultAddress = withdrawalsManagerProxy.address;

  updateObjectInState(Sk.withdrawalVault, {
    proxy: {
      contract: await getContractPath("WithdrawalsManagerProxy"),
      address: withdrawalsManagerProxy.address,
      constructorArgs: withdrawalsManagerProxyConstructorArgs,
    },
    address: withdrawalsManagerProxy.address,
  });

  // Deploy LidoExecutionLayerRewardsVault
  const elRewardsVault = await deployWithoutProxy(
    Sk.executionLayerRewardsVault,
    "LidoExecutionLayerRewardsVault",
    deployer,
    [lidoAddress, treasuryAddress],
  );

  // Deploy StakingRouter
  const stakingRouter = await deployBehindOssifiableProxy(
    Sk.stakingRouter,
    "StakingRouter",
    proxyContractsOwner,
    deployer,
    [depositContract],
    null,
    true,
    {
      libraries: { MinFirstAllocationStrategy: minFirstAllocationStrategyAddress },
    },
  );

  // Deploy or use predefined DepositSecurityModule
  let depositSecurityModuleAddress = depositSecurityModuleParams.usePredefinedAddressInstead;
  if (depositSecurityModuleAddress === null) {
    depositSecurityModuleAddress = (
      await deployWithoutProxy(Sk.depositSecurityModule, "DepositSecurityModule", deployer, [
        lidoAddress,
        depositContract,
        stakingRouter.address,
        depositSecurityModuleParams.pauseIntentValidityPeriodBlocks,
        depositSecurityModuleParams.maxOperatorsPerUnvetting,
      ])
    ).address;
  } else {
    log(
      `NB: skipping deployment of DepositSecurityModule - using the predefined address ${depositSecurityModuleAddress} instead`,
    );
  }

  // Deploy AccountingOracle
  const accountingOracle = await deployBehindOssifiableProxy(
    Sk.accountingOracle,
    "AccountingOracle",
    proxyContractsOwner,
    deployer,
    [
      locator.address,
      lidoAddress,
      legacyOracleAddress,
      Number(chainSpec.secondsPerSlot),
      Number(chainSpec.genesisTime),
    ],
  );

  // Deploy HashConsensus for AccountingOracle
  await deployWithoutProxy(Sk.hashConsensusForAccountingOracle, "HashConsensus", deployer, [
    chainSpec.slotsPerEpoch,
    chainSpec.secondsPerSlot,
    chainSpec.genesisTime,
    hashConsensusForAccountingParams.epochsPerFrame,
    hashConsensusForAccountingParams.fastLaneLengthSlots,
    admin, // admin
    accountingOracle.address, // reportProcessor
  ]);

  // Deploy ValidatorsExitBusOracle
  const validatorsExitBusOracle = await deployBehindOssifiableProxy(
    Sk.validatorsExitBusOracle,
    "ValidatorsExitBusOracle",
    proxyContractsOwner,
    deployer,
    [chainSpec.secondsPerSlot, chainSpec.genesisTime, locator.address],
  );

  // Deploy HashConsensus for ValidatorsExitBusOracle
  await deployWithoutProxy(Sk.hashConsensusForValidatorsExitBusOracle, "HashConsensus", deployer, [
    chainSpec.slotsPerEpoch,
    chainSpec.secondsPerSlot,
    chainSpec.genesisTime,
    hashConsensusForExitBusParams.epochsPerFrame,
    hashConsensusForExitBusParams.fastLaneLengthSlots,
    admin, // admin
    validatorsExitBusOracle.address, // reportProcessor
  ]);

  // Deploy Burner
  const burner = await deployWithoutProxy(Sk.burner, "Burner", deployer, [
    admin,
    treasuryAddress,
    lidoAddress,
    burnerParams.totalCoverSharesBurnt,
    burnerParams.totalNonCoverSharesBurnt,
  ]);

  // Update LidoLocator with valid implementation
  const locatorConfig: string[] = [
    accountingOracle.address,
    depositSecurityModuleAddress,
    elRewardsVault.address,
    legacyOracleAddress,
    lidoAddress,
    certainAddress("dummy-locator:oracleReportSanityChecker"), // requires LidoLocator in the constructor, so deployed after it
    legacyOracleAddress, // postTokenRebaseReceiver
    burner.address,
    stakingRouter.address,
    treasuryAddress,
    validatorsExitBusOracle.address,
    withdrawalQueueERC721.address,
    withdrawalVaultAddress,
    oracleDaemonConfig.address,
  ];
  await updateProxyImplementation(Sk.lidoLocator, "LidoLocator", locator.address, proxyContractsOwner, [locatorConfig]);
}
