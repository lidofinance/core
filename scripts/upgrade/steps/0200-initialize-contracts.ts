import { keccak256 } from "ethers";
import { ethers } from "hardhat";

import { Burner, OperatorGrid, PredepositGuarantee, VaultHub } from "typechain-types";

import { ether, log } from "lib";
import { loadContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { readNetworkState, Sk } from "lib/state-file";

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

export async function main(): Promise<void> {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState();
  const vaultHubAddress = state[Sk.vaultHub].proxy.address;
  const accountingAddress = state[Sk.accounting].proxy.address;
  const burnerAddress = state[Sk.burner].address;
  const agentAddress = state[Sk.appAgent].proxy.address;
  const stakingVaultBeaconAddress = state[Sk.stakingVaultBeacon].address;
  const nodeOperatorsRegistryAddress = state[Sk.appNodeOperatorsRegistry].proxy.address;
  const simpleDvtAddress = state[Sk.appSimpleDvt].proxy.address;
  const predepositGuaranteeAddress = state[Sk.predepositGuarantee].proxy.address;
  const operatorGridAddress = state[Sk.operatorGrid].proxy.address;

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
  const vaultRegistryRole = await vaultHub.VAULT_REGISTRY_ROLE();

  // await makeTx(vaultHub, "grantRole", [vaultMasterRole, deployer], { from: deployer });
  await makeTx(vaultHub, "grantRole", [vaultRegistryRole, deployer], { from: deployer });
  await makeTx(vaultHub, "addVaultProxyCodehash", [vaultBeaconProxyCodeHash], { from: deployer });
  // await makeTx(vaultHub, "renounceRole", [vaultMasterRole, deployer], { from: deployer });
  await makeTx(vaultHub, "renounceRole", [vaultRegistryRole, deployer], { from: deployer });

  await makeTx(vaultHub, "grantRole", [DEFAULT_ADMIN_ROLE, agentAddress], { from: deployer });
  await makeTx(vaultHub, "grantRole", [vaultMasterRole, agentAddress], { from: deployer });

  await makeTx(vaultHub, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });

  //
  // Burner
  //

  // Burner grantRole REQUEST_BURN_SHARES_ROLE
  const burner = await loadContract<Burner>("Burner", burnerAddress);
  const requestBurnSharesRole = await burner.REQUEST_BURN_SHARES_ROLE();
  await makeTx(burner, "grantRole", [requestBurnSharesRole, nodeOperatorsRegistryAddress], { from: deployer });
  await makeTx(burner, "grantRole", [requestBurnSharesRole, simpleDvtAddress], { from: deployer });
  await makeTx(burner, "grantRole", [requestBurnSharesRole, accountingAddress], { from: deployer });
  // NB: admin role is kept on deployer to transfer it to the upgrade template on the next steps

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

  const defaultTierParams = {
    shareLimit: ether("1000"),
    reserveRatioBP: 2000n,
    forcedRebalanceThresholdBP: 1800n,
    treasuryFeeBP: 500n,
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
