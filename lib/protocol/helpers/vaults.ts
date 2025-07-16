import { expect } from "chai";
import { ContractTransactionReceipt, ContractTransactionResponse, hexlify } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

import {
  Dashboard,
  IStakingVault,
  Permissions,
  PinnedBeaconProxy,
  PredepositGuarantee,
  StakingVault,
  VaultFactory,
} from "typechain-types";
import { BLS12_381 } from "typechain-types/contracts/0.8.25/vaults/predeposit_guarantee/PredepositGuarantee";

import {
  computeDepositDataRoot,
  days,
  de0x,
  findEventsWithInterfaces,
  generatePostDeposit,
  generatePredeposit,
  getCurrentBlockTimestamp,
  impersonate,
  prepareLocalMerkleTree,
  Validator,
} from "lib";

import { ether } from "../../units";
import { LoadedContract, ProtocolContext } from "../types";

const VAULT_NODE_OPERATOR_FEE = 3_00n; // 3% node operator fee
const DEFAULT_CONFIRM_EXPIRY = days(7n);
export const VAULT_CONNECTION_DEPOSIT = ether("1");

// 1. Define the role keys as a const array
export const vaultRoleKeys = [
  "funder",
  "withdrawer",
  "minter",
  "burner",
  "rebalancer",
  "depositPauser",
  "depositResumer",
  "validatorExitRequester",
  "validatorWithdrawalTriggerer",
  "disconnecter",
  "pdgCompensator",
  "unknownValidatorProver",
  "unguaranteedBeaconChainDepositor",
  "tierChanger",
  "nodeOperatorRewardAdjuster",
  "assetRecoverer",
] as const;

export type VaultRoles = {
  [K in (typeof vaultRoleKeys)[number]]: HardhatEthersSigner;
};

export interface VaultWithDashboard {
  stakingVault: StakingVault;
  dashboard: Dashboard;
  proxy: PinnedBeaconProxy;
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
 * @param nodeOperator Address of the node operator
 * @param nodeOperatorManager Address of the node operator manager contract
 * @param roleAssignments Optional object to override default randomly generated role addresses
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
  roleAssignments: Permissions.RoleAssignmentStruct[] = [],
  fee = VAULT_NODE_OPERATOR_FEE,
  confirmExpiry = DEFAULT_CONFIRM_EXPIRY,
): Promise<VaultWithDashboard> {
  const deployTx = await stakingVaultFactory
    .connect(owner)
    .createVaultWithDashboard(owner, nodeOperator, nodeOperatorManager, fee, confirmExpiry, roleAssignments, {
      value: VAULT_CONNECTION_DEPOSIT,
    });

  const createVaultTxReceipt = (await deployTx.wait()) as ContractTransactionReceipt;
  const createVaultEvents = ctx.getEvents(createVaultTxReceipt, "VaultCreated");

  expect(createVaultEvents.length).to.equal(1n, "Expected exactly one VaultCreated event");
  expect(createVaultEvents[0].args).to.not.be.undefined, "VaultCreated event args should be defined";

  const vaultAddress = createVaultEvents[0].args!.vault;

  const createDashboardEvents = ctx.getEvents(createVaultTxReceipt, "DashboardCreated");
  expect(createDashboardEvents.length).to.equal(1n, "Expected exactly one DashboardCreated event");
  expect(createDashboardEvents[0].args).to.not.be.undefined, "DashboardCreated event args should be defined";

  const dashboardAddress = createDashboardEvents[0].args!.dashboard;
  expect(createDashboardEvents[0].args!.vault).to.equal(vaultAddress);
  const adminAddress = createDashboardEvents[0].args!.admin;
  expect(adminAddress).to.equal(owner.address);

  const stakingVault = await ethers.getContractAt("StakingVault", vaultAddress);
  const dashboard = await ethers.getContractAt("Dashboard", dashboardAddress);
  const proxy = (await ethers.getContractAt("PinnedBeaconProxy", vaultAddress)) as PinnedBeaconProxy;

  return {
    stakingVault,
    dashboard,
    proxy,
  };
}

export async function autofillRoles(
  dashboard: Dashboard,
  nodeOperatorManager: HardhatEthersSigner,
): Promise<VaultRoles> {
  const roleMethodMap: { [K in (typeof vaultRoleKeys)[number]]: Promise<string> } = {
    funder: dashboard.FUND_ROLE(),
    withdrawer: dashboard.WITHDRAW_ROLE(),
    minter: dashboard.MINT_ROLE(),
    burner: dashboard.BURN_ROLE(),
    rebalancer: dashboard.REBALANCE_ROLE(),
    depositPauser: dashboard.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(),
    depositResumer: dashboard.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(),
    validatorExitRequester: dashboard.REQUEST_VALIDATOR_EXIT_ROLE(),
    validatorWithdrawalTriggerer: dashboard.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(),
    disconnecter: dashboard.VOLUNTARY_DISCONNECT_ROLE(),
    pdgCompensator: dashboard.PDG_COMPENSATE_PREDEPOSIT_ROLE(),
    unknownValidatorProver: dashboard.PDG_PROVE_VALIDATOR_ROLE(),
    unguaranteedBeaconChainDepositor: dashboard.UNGUARANTEED_BEACON_CHAIN_DEPOSIT_ROLE(),
    tierChanger: dashboard.CHANGE_TIER_ROLE(),
    nodeOperatorRewardAdjuster: dashboard.NODE_OPERATOR_REWARDS_ADJUST_ROLE(),
    assetRecoverer: dashboard.RECOVER_ASSETS_ROLE(),
  };

  const roleIds = await Promise.all(Object.values(roleMethodMap));
  const signers = await ethers.getSigners();

  const roleAssignments: Permissions.RoleAssignmentStruct[] = roleIds.map((roleId, i) => {
    return {
      role: roleId,
      account: signers[i],
    };
  });

  const nodeOperatorManagerRole = await dashboard.NODE_OPERATOR_MANAGER_ROLE();

  const NORoleAssignments: Permissions.RoleAssignmentStruct[] = [];
  const otherRoleAssignments: Permissions.RoleAssignmentStruct[] = [];

  for (const roleAssignment of roleAssignments) {
    if ((await dashboard.getRoleAdmin(roleAssignment.role)) !== nodeOperatorManagerRole) {
      otherRoleAssignments.push(roleAssignment);
    } else {
      NORoleAssignments.push(roleAssignment);
    }
  }

  await dashboard.connect(nodeOperatorManager).grantRoles(NORoleAssignments);
  await dashboard.grantRoles(otherRoleAssignments);

  // Build the result using the keys
  const result = {} as VaultRoles;
  vaultRoleKeys.forEach((key, i) => {
    result[key] = signers[i];
  });

  return result;
}

/**
 * Sets up the protocol with a maximum external ratio
 */
export async function setupLidoForVaults(ctx: ProtocolContext) {
  const { lido, acl } = ctx.contracts;
  const agentSigner = await ctx.getSigner("agent");
  const role = await lido.STAKING_CONTROL_ROLE();
  const agentAddress = await agentSigner.getAddress();

  await acl.connect(agentSigner).grantPermission(agentAddress, lido.address, role);
  await lido.connect(agentSigner).setMaxExternalRatioBP(20_00n);
  await acl.connect(agentSigner).revokePermission(agentAddress, lido.address, role);
}

// address, totalValue, treasuryFees, liabilityShares, slashingReserve
export type VaultReportItem = [string, bigint, bigint, bigint, bigint];

export function createVaultsReportTree(vaults: VaultReportItem[]) {
  return StandardMerkleTree.of(vaults, ["address", "uint256", "uint256", "uint256", "uint256"]);
}

export async function reportVaultDataWithProof(
  ctx: ProtocolContext,
  stakingVault: StakingVault,
  params: {
    totalValue?: bigint;
    accruedLidoFees?: bigint;
    liabilityShares?: bigint;
  } = {},
) {
  const { vaultHub, locator, lazyOracle } = ctx.contracts;

  const totalValueArg = params.totalValue ?? (await vaultHub.totalValue(stakingVault));
  const liabilitySharesArg = params.liabilityShares ?? (await vaultHub.liabilityShares(stakingVault));

  const vaultReport: VaultReportItem = [
    await stakingVault.getAddress(),
    totalValueArg,
    params.accruedLidoFees ?? 0n,
    liabilitySharesArg,
    0n,
  ];
  const reportTree = createVaultsReportTree([vaultReport]);

  const accountingSigner = await impersonate(await locator.accountingOracle(), ether("100"));
  await lazyOracle.connect(accountingSigner).updateReportData(await getCurrentBlockTimestamp(), reportTree.root, "");

  return await lazyOracle.updateVaultData(
    await stakingVault.getAddress(),
    totalValueArg,
    params.accruedLidoFees ?? 0n,
    liabilitySharesArg,
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
      { value: VAULT_CONNECTION_DEPOSIT },
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

  return {
    tx,
    proxy,
    vault: stakingVault,
    dashboard,
  };
}

export async function createVaultProxyWithoutConnectingToVaultHub(
  caller: HardhatEthersSigner,
  vaultFactory: VaultFactory,
  vaultOwner: HardhatEthersSigner,
  nodeOperator: HardhatEthersSigner,
  nodeOperatorManager: HardhatEthersSigner,
  nodeOperatorFeeBP: bigint,
  confirmExpiry: bigint,
  roleAssignments: Permissions.RoleAssignmentStruct[],
): Promise<CreateVaultResponse> {
  const tx = await vaultFactory
    .connect(caller)
    .createVaultWithDashboardWithoutConnectingToVaultHub(
      vaultOwner,
      nodeOperator,
      nodeOperatorManager,
      nodeOperatorFeeBP,
      confirmExpiry,
      roleAssignments,
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

  return {
    tx,
    proxy,
    vault: stakingVault,
    dashboard,
  };
}

export const getPubkeys = (num: number): { pubkeys: string[]; stringified: string } => {
  const pubkeys = Array.from({ length: num }, (_, i) => {
    const paddedIndex = (i + 1).toString().padStart(8, "0");
    return `0x${paddedIndex.repeat(12)}`;
  });

  return {
    pubkeys,
    stringified: `0x${pubkeys.map(de0x).join("")}`,
  };
};

export const generatePredepositData = async (
  predepositGuarantee: LoadedContract<PredepositGuarantee>,
  dashboard: Dashboard,
  roles: VaultRoles,
  nodeOperator: HardhatEthersSigner,
  validator: Validator,
  guarantor?: HardhatEthersSigner,
): Promise<{
  deposit: IStakingVault.DepositStruct;
  depositY: BLS12_381.DepositYStruct;
}> => {
  guarantor = guarantor ?? nodeOperator;

  // Pre-requisite: fund the vault to have enough balance to start a validator
  await dashboard.connect(roles.funder).fund({ value: ether("32") });

  // Step 1: Top up the node operator balance
  await predepositGuarantee.connect(guarantor).topUpNodeOperatorBalance(nodeOperator, {
    value: ether("1"),
  });

  // Step 2: Predeposit a validator
  return await generatePredeposit(validator, {
    depositDomain: await predepositGuarantee.DEPOSIT_DOMAIN(),
  });
};

export const getProofAndDepositData = async (
  ctx: ProtocolContext,
  validator: Validator,
  withdrawalCredentials: string,
  amount: bigint = ether("31"),
) => {
  const { predepositGuarantee } = ctx.contracts;

  // Step 3: Prove and deposit the validator
  const pivot_slot = await predepositGuarantee.PIVOT_SLOT();

  const mockCLtree = await prepareLocalMerkleTree(await predepositGuarantee.GI_FIRST_VALIDATOR_PREV());
  const { validatorIndex } = await mockCLtree.addValidator(validator.container);
  const { childBlockTimestamp, beaconBlockHeader } = await mockCLtree.commitChangesToBeaconRoot(
    Number(pivot_slot) + 100,
  );
  const proof = await mockCLtree.buildProof(validatorIndex, beaconBlockHeader);

  const postdeposit = generatePostDeposit(validator.container, amount);
  const pubkey = hexlify(validator.container.pubkey);
  const signature = hexlify(postdeposit.signature);

  postdeposit.depositDataRoot = computeDepositDataRoot(withdrawalCredentials, pubkey, signature, amount);

  const witnesses = [
    {
      proof,
      pubkey,
      validatorIndex,
      childBlockTimestamp,
      slot: beaconBlockHeader.slot,
      proposerIndex: beaconBlockHeader.proposerIndex,
    },
  ];
  return { witnesses, postdeposit };
};
