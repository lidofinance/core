import { expect } from "chai";
import { BytesLike, ContractTransactionReceipt, ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

import { Dashboard, Permissions, PinnedBeaconProxy, StakingVault, VaultFactory } from "typechain-types";

import { days, findEventsWithInterfaces, getCurrentBlockTimestamp, impersonate, MAX_UINT256 } from "lib";

import { ether } from "../../units";
import { ProtocolContext } from "../types";

const VAULT_NODE_OPERATOR_FEE = 3_00n; // 3% node operator fee
const DEFAULT_CONFIRM_EXPIRY = days(7n);

export type VaultRoles = {
  assetRecoverer: HardhatEthersSigner;
  funder: HardhatEthersSigner;
  withdrawer: HardhatEthersSigner;
  locker: HardhatEthersSigner;
  minter: HardhatEthersSigner;
  burner: HardhatEthersSigner;
  rebalancer: HardhatEthersSigner;
  depositPauser: HardhatEthersSigner;
  depositResumer: HardhatEthersSigner;
  pdgCompensator: HardhatEthersSigner;
  unguaranteedBeaconChainDepositor: HardhatEthersSigner;
  unknownValidatorProver: HardhatEthersSigner;
  validatorExitRequester: HardhatEthersSigner;
  validatorWithdrawalTriggerer: HardhatEthersSigner;
  disconnecter: HardhatEthersSigner;
  lidoVaultHubAuthorizer: HardhatEthersSigner;
  lidoVaultHubDeauthorizer: HardhatEthersSigner;
  ossifier: HardhatEthersSigner;
  depositorSetter: HardhatEthersSigner;
  lockedResetter: HardhatEthersSigner;
  nodeOperatorFeeClaimer: HardhatEthersSigner;
  nodeOperatorRewardAdjuster: HardhatEthersSigner;
};

export interface VaultWithDashboard {
  stakingVault: StakingVault;
  dashboard: Dashboard;
}

/**
 * Creates a new vault with dashboard contract
 *
 * This function deploys a new StakingVault contract and its associated Dashboard contract
 * using the provided VaultFactory. It sets up all necessary roles and permissions.
 *
 * @param ctx Protocol context for event handling and contract interaction
 * @param stakingVaultFactory Factory contract used to create the vault
 * @param owner Address that will be set as the owner/admin of the vault
 * @param nodeOperatorManager Address of the node operator manager contract
 * @param rolesOverrides Optional object to override default randomly generated role addresses
 * @param fee Node operator fee in basis points (default: 3% = 300 basis points)
 * @param confirmExpiry Time period for confirmation expiry (default: 7 days)
 * @returns Object containing the created StakingVault, Dashboard contract, and role addresses
 */
export async function createVaultWithDashboard(
  ctx: ProtocolContext,
  stakingVaultFactory: VaultFactory & { address: string },
  owner: HardhatEthersSigner,
  nodeOperator: HardhatEthersSigner,
  nodeOperatorManager: HardhatEthersSigner,
  roleAssignments: Permissions.RoleAssignmentStruct[],
  fee = VAULT_NODE_OPERATOR_FEE,
  confirmExpiry = DEFAULT_CONFIRM_EXPIRY,
): Promise<VaultWithDashboard> {

  const deployTx = await stakingVaultFactory.connect(owner).createVaultWithDashboard(
    owner,
    nodeOperator,
    nodeOperatorManager,
    fee,
    confirmExpiry,
    roleAssignments,
    "0x",
  );

  const createVaultTxReceipt = (await deployTx.wait()) as ContractTransactionReceipt;
  const createVaultEvents = ctx.getEvents(createVaultTxReceipt, "VaultCreated");

  expect(createVaultEvents.length).to.equal(1n, "Expected exactly one VaultCreated event");
  expect(createVaultEvents[0].args).to.not.be.undefined, "VaultCreated event args should be defined";

  const vaultAddress = createVaultEvents[0].args!.vault;
  const ownerAddress = createVaultEvents[0].args!.owner;

  const stakingVault = await ethers.getContractAt("StakingVault", vaultAddress);
  const dashboard = await ethers.getContractAt("Dashboard", ownerAddress);

  return {
    stakingVault,
    dashboard,
  };
}

/**
 * Sets up the protocol with a maximum external ratio
 */
export async function setupLido(ctx: ProtocolContext) {
  const { lido } = ctx.contracts;
  const votingSigner = await ctx.getSigner("voting");

  await lido.connect(votingSigner).setMaxExternalRatioBP(20_00n);
}

export async function disconnectFromHub(ctx: ProtocolContext, stakingVault: StakingVault) {
  const agentSigner = await ctx.getSigner("agent");

  const { vaultHub } = ctx.contracts;

  await vaultHub.connect(agentSigner).disconnect(stakingVault);
}

/**
 * Locks the connection deposit
 * @param ctx Protocol context for contract interaction
 * @param dashboard Dashboard contract instance
 * @param stakingVault Staking vault instance
 */
export async function lockConnectionDeposit(ctx: ProtocolContext, dashboard: Dashboard, stakingVault: StakingVault) {
  const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("100"));
  await stakingVault.connect(dashboardSigner).fund({ value: ether("1") });
  await stakingVault.connect(dashboardSigner).lock(ether("1"));
}

type ConnectToHubParams = {
  reserveRatio: bigint;
  rebalanceThreshold: bigint;
  treasuryFeeBP: bigint;
  shareLimit: bigint;
};

/**
 * Connects a staking vault to the hub
 *
 * This function locks the connection deposit, connects the vault to the hub
 * using the provided parameters and then does the first report
 *
 * @param ctx Protocol context for contract interaction
 * @param dashboard Dashboard contract instance
 * @param stakingVault Staking vault instance
 * @param params Connect to hub parameters
 */
export async function connectToHub(
  ctx: ProtocolContext,
  dashboard: Dashboard,
  stakingVault: StakingVault,
  { reserveRatio, rebalanceThreshold, treasuryFeeBP, shareLimit }: ConnectToHubParams = {
    reserveRatio: 10_00n, // 10% of ETH allocation as reserve,
    rebalanceThreshold: 8_00n, // 8% is a threshold to force rebalance on the vault
    treasuryFeeBP: 5_00n, // 5% of the treasury fee
    shareLimit: MAX_UINT256, // stub for getting real share limit from protocol
  },
) {
  await lockConnectionDeposit(ctx, dashboard, stakingVault);

  const { vaultHub } = ctx.contracts;
  const agentSigner = await ctx.getSigner("agent");

  if (shareLimit === MAX_UINT256) {
    shareLimit = (await ctx.contracts.lido.getTotalShares()) / 10n; // 10% of total shares
  }

  await vaultHub
    .connect(agentSigner)
    .connectVault(stakingVault, shareLimit, reserveRatio, rebalanceThreshold, treasuryFeeBP);
}

export async function generateFeesToClaim(ctx: ProtocolContext, stakingVault: StakingVault) {
  const { vaultHub } = ctx.contracts;
  const hubSigner = await impersonate(await vaultHub.getAddress(), ether("100"));
  const rewards = ether("1");
  await stakingVault.connect(hubSigner).report(await getCurrentBlockTimestamp(), rewards, 0n, 0n);
}

// Address, valuation, inOutDelta, treasuryFees, sharesMinted
export type VaultReportItem = [string, bigint, bigint, bigint, bigint];

export function createVaultsReportTree(vaults: VaultReportItem[]) {
  const tree = StandardMerkleTree.of(vaults, ["address", "uint256", "uint256", "uint256", "uint256"]);
  return tree;
}

export async function reportVaultDataWithProof(stakingVault: StakingVault) {
  const vaultHub = await ethers.getContractAt("VaultHub", await stakingVault.vaultHub());
  const locator = await ethers.getContractAt("LidoLocator", await vaultHub.LIDO_LOCATOR());
  const vaultReport: VaultReportItem = [
    await stakingVault.getAddress(),
    await stakingVault.valuation(),
    await stakingVault.inOutDelta(),
    0n,
    0n,
  ];
  const reportTree = createVaultsReportTree([vaultReport]);

  const accountingSigner = await impersonate(await locator.accounting(), ether("100"));
  await vaultHub.connect(accountingSigner).updateReportData(await getCurrentBlockTimestamp(), reportTree.root, "");
  await vaultHub.updateVaultData(
    await stakingVault.getAddress(),
    await stakingVault.valuation(),
    await stakingVault.inOutDelta(),
    0n,
    0n,
    reportTree.getProof(0),
  );
}

interface CreateVaultResponse {
  tx: ContractTransactionResponse;
  proxy: PinnedBeaconProxy;
  vault: StakingVault;
  dashboard: Dashboard;
}

export async function createVaultProxy(
  caller: HardhatEthersSigner,
  vaultFactory: VaultFactory,
  vaultOwner: HardhatEthersSigner,
  nodeOperator: HardhatEthersSigner,
  nodeOperatorManager: HardhatEthersSigner,
  nodeOperatorFeeBP: bigint,
  confirmExpiry: bigint,
  roleAssignments: Permissions.RoleAssignmentStruct[],
  stakingVaultInitializerExtraParams: BytesLike = "0x",
): Promise<CreateVaultResponse> {
  const tx = await vaultFactory
    .connect(caller)
    .createVaultWithDashboard(
      vaultOwner,
      nodeOperator,
      nodeOperatorManager,
      nodeOperatorFeeBP,
      confirmExpiry,
      roleAssignments,
      stakingVaultInitializerExtraParams,
    );

  // Get the receipt manually
  const receipt = (await tx.wait())!;
  const events = findEventsWithInterfaces(receipt, "VaultCreated", [vaultFactory.interface]);

  if (events.length === 0) throw new Error("Vault creation event not found");

  const event = events[0];
  const { vault } = event.args;

  const dashboardEvents = findEventsWithInterfaces(receipt, "DashboardCreated", [vaultFactory.interface]);

  if (dashboardEvents.length === 0) throw new Error("Dashboard creation event not found");

  const { dashboard: dashboardAddress } = dashboardEvents[0].args;

  const proxy = (await ethers.getContractAt("PinnedBeaconProxy", vault, caller)) as PinnedBeaconProxy;
  const stakingVault = (await ethers.getContractAt("StakingVault", vault, caller)) as StakingVault;
  const dashboard = (await ethers.getContractAt("Dashboard", dashboardAddress, caller)) as Dashboard;

  //fund and lock
  const dashboardSigner = await impersonate(await dashboard.getAddress(), ether("100"));
  await stakingVault.connect(dashboardSigner).fund({ value: ether("1") });
  await stakingVault.connect(dashboardSigner).lock(ether("1"));

  return {
    tx,
    proxy,
    vault: stakingVault,
    dashboard,
  };
}
