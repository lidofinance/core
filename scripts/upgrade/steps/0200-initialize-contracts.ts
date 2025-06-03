import { keccak256 } from "ethers";
import { ethers } from "hardhat";

import { Burner, ICSModule, OperatorGrid, PredepositGuarantee, StakingRouter, VaultHub } from "typechain-types";

import { ether, log } from "lib";
import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

import { readUpgradeParameters } from "../../utils/upgrade";

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

export async function main(): Promise<void> {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState();
  const vaultHubAddress = state[Sk.vaultHub].proxy.address;
  const accountingAddress = state[Sk.accounting].proxy.address;
  const burnerAddress = state[Sk.burner].proxy.address;
  const agentAddress = state[Sk.appAgent].proxy.address;
  const stakingVaultBeaconAddress = state[Sk.stakingVaultBeacon].address;
  const nodeOperatorsRegistryAddress = state[Sk.appNodeOperatorsRegistry].proxy.address;
  const simpleDvtAddress = state[Sk.appSimpleDvt].proxy.address;
  const predepositGuaranteeAddress = state[Sk.predepositGuarantee].proxy.address;
  const operatorGridAddress = state[Sk.operatorGrid].proxy.address;
  const stakingRouterAddress = state[Sk.stakingRouter].proxy.address;

  const upgradeParameters = readUpgradeParameters();

  // Deploy BeaconProxy to get bytecode and add it to whitelist
  const vaultBeaconProxy = await ethers.deployContract("PinnedBeaconProxy", [stakingVaultBeaconAddress, "0x"]);
  const vaultBeaconProxyCode = await ethers.provider.getCode(await vaultBeaconProxy.getAddress());
  const vaultBeaconProxyCodeHash = keccak256(vaultBeaconProxyCode);
  console.log("BeaconProxy address", await vaultBeaconProxy.getAddress());

  //
  // VaultHub
  //

  const vaultHubAdmin = deployer;
  const vaultHub = await loadContract<VaultHub>("VaultHub", vaultHubAddress);
  await makeTx(vaultHub, "initialize", [vaultHubAdmin], { from: deployer });
  log("VaultHub initialized with admin", vaultHubAdmin);

  const vaultMasterRole = await vaultHub.VAULT_MASTER_ROLE();
  const vaultCodehashRole = await vaultHub.VAULT_CODEHASH_SET_ROLE();

  await makeTx(vaultHub, "grantRole", [vaultCodehashRole, deployer], { from: deployer });
  await makeTx(vaultHub, "setAllowedCodehash", [vaultBeaconProxyCodeHash], { from: deployer });
  await makeTx(vaultHub, "renounceRole", [vaultCodehashRole, deployer], { from: deployer });

  await makeTx(vaultHub, "grantRole", [DEFAULT_ADMIN_ROLE, agentAddress], { from: deployer });
  await makeTx(vaultHub, "grantRole", [vaultMasterRole, agentAddress], { from: deployer });
  await makeTx(vaultHub, "grantRole", [vaultCodehashRole, agentAddress], { from: deployer });

  await makeTx(vaultHub, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });

  //
  // Burner
  //

  const burner = await loadContract<Burner>("Burner", burnerAddress);

  const isMigrationAllowed = true;
  await burner.initialize(deployer, isMigrationAllowed);

  const requestBurnSharesRole = await burner.REQUEST_BURN_SHARES_ROLE();
  await makeTx(burner, "grantRole", [requestBurnSharesRole, accountingAddress], { from: deployer });
  // NB: REQUEST_BURN_SHARES_ROLE is granted to Lido upon Burner initialization

  const stakingRouter = await loadContract<StakingRouter>("StakingRouter", stakingRouterAddress);
  const stakingModules = await stakingRouter.getStakingModules();
  const csm = stakingModules[2];
  if (csm.name !== "Community Staking") {
    throw new Error("Community Staking module not found");
  }
  const csmModule = await loadContract<ICSModule>("ICSModule", csm.stakingModuleAddress);
  const csmAccountingAddress = await csmModule.accounting();

  const requestBurnMyStethRole = await burner.REQUEST_BURN_MY_STETH_ROLE();
  await makeTx(burner, "grantRole", [requestBurnMyStethRole, nodeOperatorsRegistryAddress], { from: deployer });
  await makeTx(burner, "grantRole", [requestBurnMyStethRole, simpleDvtAddress], { from: deployer });
  await makeTx(burner, "grantRole", [requestBurnMyStethRole, csmAccountingAddress], { from: deployer });

  await makeTx(burner, "grantRole", [DEFAULT_ADMIN_ROLE, agentAddress], { from: deployer });
  await makeTx(burner, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });

  //
  // PredepositGuarantee
  //

  const predepositGuarantee = await loadContract<PredepositGuarantee>(
    "PredepositGuarantee",
    predepositGuaranteeAddress,
  );
  await makeTx(predepositGuarantee, "initialize", [agentAddress], { from: deployer });

  //
  // OperatorGrid
  //
  const gridParams = upgradeParameters[Sk.operatorGrid].deployParameters;
  const defaultTierParams = {
    shareLimit: ether(gridParams.defaultTierParams.shareLimitInEther),
    reserveRatioBP: gridParams.defaultTierParams.reserveRatioBP,
    forcedRebalanceThresholdBP: gridParams.defaultTierParams.forcedRebalanceThresholdBP,
    infraFeeBP: gridParams.defaultTierParams.infraFeeBP,
    liquidityFeeBP: gridParams.defaultTierParams.liquidityFeeBP,
    reservationFeeBP: gridParams.defaultTierParams.reservationFeeBP,
  };
  const operatorGrid = await loadContract<OperatorGrid>("OperatorGrid", operatorGridAddress);
  const operatorGridAdmin = deployer;
  await makeTx(operatorGrid, "initialize", [operatorGridAdmin, defaultTierParams], { from: deployer });
  await makeTx(operatorGrid, "grantRole", [await operatorGrid.REGISTRY_ROLE(), agentAddress], {
    from: operatorGridAdmin,
  });
  await makeTx(operatorGrid, "grantRole", [DEFAULT_ADMIN_ROLE, agentAddress], { from: deployer });
  await makeTx(operatorGrid, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });
}
