import { keccak256 } from "ethers";
import { ethers } from "hardhat";

import { VaultHub } from "typechain-types";

import { ether, loadContract, makeTx } from "lib";
import { deployBehindOssifiableProxy, deployWithoutProxy } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const stethAddress = state[Sk.appLido].proxy.address;
  const wstethAddress = state[Sk.wstETH].address;
  const locatorAddress = state[Sk.lidoLocator].proxy.address;
  const lidoAddress = state[Sk.appLido].proxy.address;

  const vaultHubParams = state[Sk.vaultHub].deployParameters;
  const operatorGridParams = state[Sk.operatorGrid].deployParameters;
  const pdgDeployParams = state[Sk.predepositGuarantee].deployParameters;

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

  // Deploy BeaconProxy to get bytecode and add it to whitelist
  const vaultBeaconProxy = await ethers.deployContract("PinnedBeaconProxy", [beaconAddress, "0x"]);
  await vaultBeaconProxy.waitForDeployment();

  const vaultBeaconProxyCode = await ethers.provider.getCode(await vaultBeaconProxy.getAddress());
  const vaultBeaconProxyCodeHash = keccak256(vaultBeaconProxyCode);

  console.log("BeaconProxy address", await vaultBeaconProxy.getAddress());

  // Deploy VaultHub
  const vaultHub_ = await deployBehindOssifiableProxy(Sk.vaultHub, "VaultHub", proxyContractsOwner, deployer, [
    locatorAddress,
    lidoAddress,
    vaultHubParams.maxRelativeShareLimitBP,
  ]);
  const vaultHubAddress = vaultHub_.address;

  const vaultHubAdmin = deployer;
  const vaultHub = await loadContract<VaultHub>("VaultHub", vaultHubAddress);
  await makeTx(vaultHub, "initialize", [vaultHubAdmin], { from: deployer });

  // Grant VaultHub roles
  const vaultMasterRole = await vaultHub.VAULT_MASTER_ROLE();
  const vaultCodehashRole = await vaultHub.VAULT_CODEHASH_SET_ROLE();

  await makeTx(vaultHub, "grantRole", [vaultMasterRole, deployer], { from: deployer });
  await makeTx(vaultHub, "grantRole", [vaultCodehashRole, deployer], { from: deployer });

  await makeTx(vaultHub, "setAllowedCodehash", [vaultBeaconProxyCodeHash, true], { from: deployer });

  await makeTx(vaultHub, "renounceRole", [vaultMasterRole, deployer], { from: deployer });
  await makeTx(vaultHub, "renounceRole", [vaultCodehashRole, deployer], { from: deployer });

  // Deploy LazyOracle
  await deployBehindOssifiableProxy(Sk.lazyOracle, "LazyOracle", proxyContractsOwner, deployer, [locatorAddress]);

  // Deploy Dashboard implementation contract
  const dashboard = await deployWithoutProxy(Sk.dashboardImpl, "Dashboard", deployer, [
    stethAddress,
    wstethAddress,
    vaultHubAddress,
    locatorAddress,
  ]);
  const dashboardAddress = await dashboard.getAddress();

  // Deploy VaultFactory contract
  const factory = await deployWithoutProxy(Sk.stakingVaultFactory, "VaultFactory", deployer, [
    locatorAddress,
    beaconAddress,
    dashboardAddress,
  ]);
  console.log("Factory address", await factory.getAddress());

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
}
