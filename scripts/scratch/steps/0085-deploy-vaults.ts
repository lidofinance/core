import { ethers } from "hardhat";

import { VaultHub } from "typechain-types";

import { ether, loadContract, makeTx } from "lib";
import { deployBehindOssifiableProxy, deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk, updateObjectInState } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const stethAddress = state[Sk.appLido].proxy.address;
  const wstethAddress = state[Sk.wstETH].address;
  const locatorAddress = state[Sk.lidoLocator].proxy.address;
  const lidoAddress = state[Sk.appLido].proxy.address;
  const hashConsensusAddress = state[Sk.hashConsensusForAccountingOracle].address;

  const vaultHubParams = state[Sk.vaultHub].deployParameters;
  const operatorGridParams = state[Sk.operatorGrid].deployParameters;
  const pdgDeployParams = state[Sk.predepositGuarantee].deployParameters;
  const lazyOracleParams = state[Sk.lazyOracle].deployParameters;

  const depositContract = state.chainSpec.depositContract;
  const proxyContractsOwner = deployer;

  // Deploy OperatorGrid
  const operatorGrid_ = await deployBehindOssifiableProxy(
    Sk.operatorGrid,
    "OperatorGrid",
    proxyContractsOwner,
    deployer,
    [locatorAddress],
  );
  const operatorGridAddress = operatorGrid_.address;
  const defaultTierParams = {
    shareLimit: ether(operatorGridParams.defaultTierParams.shareLimitInEther),
    reserveRatioBP: operatorGridParams.defaultTierParams.reserveRatioBP,
    forcedRebalanceThresholdBP: operatorGridParams.defaultTierParams.forcedRebalanceThresholdBP,
    infraFeeBP: operatorGridParams.defaultTierParams.infraFeeBP,
    liquidityFeeBP: operatorGridParams.defaultTierParams.liquidityFeeBP,
    reservationFeeBP: operatorGridParams.defaultTierParams.reservationFeeBP,
  };

  const operatorGrid = await loadContract("OperatorGrid", operatorGridAddress);
  const operatorGridAdmin = deployer;
  await makeTx(operatorGrid, "initialize", [operatorGridAdmin, defaultTierParams], { from: deployer });

  // Deploy StakingVault implementation contract
  const vaultImplementation = await deployWithoutProxy(Sk.stakingVaultImplementation, "StakingVault", deployer, [
    depositContract,
  ]);
  const vaultImplementationAddress = await vaultImplementation.getAddress();

  const beacon = await deployWithoutProxy(Sk.stakingVaultBeacon, "UpgradeableBeacon", deployer, [
    vaultImplementationAddress,
    deployer,
  ]);
  const beaconAddress = await beacon.getAddress();

  // Deploy VaultHub
  const vaultHub_ = await deployBehindOssifiableProxy(Sk.vaultHub, "VaultHub", proxyContractsOwner, deployer, [
    locatorAddress,
    lidoAddress,
    hashConsensusAddress,
    vaultHubParams.maxRelativeShareLimitBP,
  ]);
  const vaultHubAddress = vaultHub_.address;

  const vaultHubAdmin = deployer;
  const vaultHub = await loadContract<VaultHub>("VaultHub", vaultHubAddress);
  await makeTx(vaultHub, "initialize", [vaultHubAdmin], { from: deployer });

  // Grant VaultHub roles
  const vaultMasterRole = await vaultHub.VAULT_MASTER_ROLE();

  await makeTx(vaultHub, "grantRole", [vaultMasterRole, deployer], { from: deployer });

  await makeTx(vaultHub, "renounceRole", [vaultMasterRole, deployer], { from: deployer });

  // Deploy LazyOracle
  const lazyOracle_ = await deployBehindOssifiableProxy(Sk.lazyOracle, "LazyOracle", proxyContractsOwner, deployer, [
    locatorAddress,
  ]);

  const lazyOracleAdmin = deployer;
  const lazyOracle = await loadContract("LazyOracle", lazyOracle_.address);
  await makeTx(
    lazyOracle,
    "initialize",
    [
      lazyOracleAdmin,
      lazyOracleParams.quarantinePeriod,
      lazyOracleParams.maxRewardRatioBP,
      lazyOracleParams.maxLidoFeeRatePerSecond,
    ],
    { from: deployer },
  );

  // Deploy Dashboard implementation contract
  const dashboard = await deployWithoutProxy(Sk.dashboardImpl, "Dashboard", deployer, [
    stethAddress,
    wstethAddress,
    vaultHubAddress,
    locatorAddress,
  ]);
  const dashboardAddress = await dashboard.getAddress();

  // Deploy VaultFactory contract
  await deployWithoutProxy(Sk.stakingVaultFactory, "VaultFactory", deployer, [
    locatorAddress,
    beaconAddress,
    dashboardAddress,
    ethers.ZeroAddress, // previous factory
  ]);

  // Deploy PredepositGuarantee
  const pdg_ = await deployBehindOssifiableProxy(
    Sk.predepositGuarantee,
    "PredepositGuarantee",
    proxyContractsOwner,
    deployer,
    [
      state.chainSpec.genesisForkVersion,
      pdgDeployParams.gIndex,
      pdgDeployParams.gIndexAfterChange,
      pdgDeployParams.changeSlot,
    ],
  );
  const pdgAddress = pdg_.address;

  // Initialize PDG
  const pdg = await loadContract("PredepositGuarantee", pdgAddress);
  const pdgAdmin = deployer;
  await makeTx(pdg, "initialize", [pdgAdmin], { from: deployer });

  // Deploy ValidatorConsolidationRequests
  const validatorConsolidationRequests_ = await deployWithoutProxy(
    Sk.validatorConsolidationRequests,
    "ValidatorConsolidationRequests",
    deployer,
    [locatorAddress],
  );
  const validatorConsolidationRequestsAddress = await validatorConsolidationRequests_.getAddress();
  updateObjectInState(Sk.validatorConsolidationRequests, {
    validatorConsolidationRequests: validatorConsolidationRequestsAddress,
  });
}
