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
  days,
  de0x,
  findEventsWithInterfaces,
  generatePredeposit,
  generateTopUp,
  getCurrentBlockTimestamp,
  impersonate,
  prepareLocalMerkleTree,
  TOTAL_BASIS_POINTS,
  Validator,
} from "lib";

import { ether } from "../../units";
import { LoadedContract, ProtocolContext } from "../types";

import { report, waitNextAvailableReportTime } from "./accounting";

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
  "unguaranteedDepositor",
  "unknownValidatorProver",
  "tierChanger",
  "nodeOperatorFeeExemptor",
  "assetCollector",
] as const;

export type VaultRoles = {
  [K in (typeof vaultRoleKeys)[number]]: HardhatEthersSigner;
};

export type VaultRoleMethods = {
  [K in (typeof vaultRoleKeys)[number]]: Promise<string>;
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
  nodeOperatorManager: HardhatEthersSigner = nodeOperator,
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

export const getRoleMethods = (dashboard: Dashboard): VaultRoleMethods => {
  return {
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
    unguaranteedDepositor: dashboard.NODE_OPERATOR_UNGUARANTEED_DEPOSIT_ROLE(),
    unknownValidatorProver: dashboard.NODE_OPERATOR_PROVE_UNKNOWN_VALIDATOR_ROLE(),
    tierChanger: dashboard.VAULT_CONFIGURATION_ROLE(),
    nodeOperatorFeeExemptor: dashboard.NODE_OPERATOR_FEE_EXEMPT_ROLE(),
    assetCollector: dashboard.COLLECT_VAULT_ERC20_ROLE(),
  };
};

export async function autofillRoles(
  dashboard: Dashboard,
  nodeOperatorManager: HardhatEthersSigner,
): Promise<VaultRoles> {
  const roleMethodMap: VaultRoleMethods = getRoleMethods(dashboard);

  const roleIds = await Promise.all(Object.values(roleMethodMap));
  const signers = await ethers.getSigners();

  const OFFSET = 10;

  const roleAssignments: Permissions.RoleAssignmentStruct[] = roleIds.map((roleId, i) => {
    return {
      role: roleId,
      account: signers[i + OFFSET],
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
    result[key] = signers[i + OFFSET];
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

  if (!ctx.isScratch) {
    // we need a report to initialize LazyOracle timestamp after the upgrade
    // if we are running tests in the mainnet fork environment
    await report(ctx);
  }
}

export type VaultReportItem = {
  vault: string;
  totalValue: bigint;
  cumulativeLidoFees: bigint;
  liabilityShares: bigint;
  maxLiabilityShares: bigint;
  slashingReserve: bigint;
};

// Utility type to extract all value types from an object type
export type ValuesOf<T> = T[keyof T];

// Auto-extract value types from VaultReportItem
export type VaultReportValues = ValuesOf<VaultReportItem>[];

export function createVaultsReportTree(vaultReports: VaultReportItem[]): StandardMerkleTree<VaultReportValues> {
  return StandardMerkleTree.of(
    vaultReports.map((vaultReport) => [
      vaultReport.vault,
      vaultReport.totalValue,
      vaultReport.cumulativeLidoFees,
      vaultReport.liabilityShares,
      vaultReport.maxLiabilityShares,
      vaultReport.slashingReserve,
    ]),
    ["address", "uint256", "uint256", "uint256", "uint256", "uint256"],
  );
}

export async function reportVaultDataWithProof(
  ctx: ProtocolContext,
  stakingVault: StakingVault,
  params: Partial<Omit<VaultReportItem, "vault">> & {
    reportTimestamp?: bigint;
    reportRefSlot?: bigint;
    updateReportData?: boolean;
    waitForNextRefSlot?: boolean;
  } = {},
) {
  const { vaultHub, locator, lazyOracle, hashConsensus } = ctx.contracts;

  const vaultReport: VaultReportItem = {
    vault: await stakingVault.getAddress(),
    totalValue: params.totalValue ?? (await vaultHub.totalValue(stakingVault)),
    cumulativeLidoFees: params.cumulativeLidoFees ?? 0n,
    liabilityShares: params.liabilityShares ?? (await vaultHub.liabilityShares(stakingVault)),
    maxLiabilityShares: params.maxLiabilityShares ?? (await vaultHub.vaultRecord(stakingVault)).maxLiabilityShares,
    slashingReserve: params.slashingReserve ?? 0n,
  };

  const reportTree = createVaultsReportTree([vaultReport]);

  if (params.waitForNextRefSlot) {
    await waitNextAvailableReportTime(ctx);
  }

  if (params.updateReportData ?? true) {
    const reportTimestampArg = params.reportTimestamp ?? (await getCurrentBlockTimestamp());
    const reportRefSlotArg = params.reportRefSlot ?? (await hashConsensus.getCurrentFrame()).refSlot;

    const accountingSigner = await impersonate(await locator.accountingOracle(), ether("100"));
    await lazyOracle
      .connect(accountingSigner)
      .updateReportData(reportTimestampArg, reportRefSlotArg, reportTree.root, "");
  }

  return await lazyOracle.updateVaultData(
    await stakingVault.getAddress(),
    vaultReport.totalValue,
    vaultReport.cumulativeLidoFees,
    vaultReport.liabilityShares,
    vaultReport.maxLiabilityShares,
    vaultReport.slashingReserve,
    reportTree.getProof(0),
  );
}

/**
 * Report data for multiple vaults in a single Merkle tree
 * This is useful when you need to ensure all vaults have fresh reports at the same time
 *
 * @param ctx Protocol context
 * @param stakingVaults Array of StakingVault contracts to report
 * @param params Parameters for the report. If arrays are provided, they must match the length of stakingVaults
 */
export async function reportVaultsDataWithProof(
  ctx: ProtocolContext,
  stakingVaults: StakingVault[],
  params: {
    totalValue?: bigint | bigint[];
    cumulativeLidoFees?: bigint | bigint[];
    liabilityShares?: bigint | bigint[];
    maxLiabilityShares?: bigint | bigint[];
    slashingReserve?: bigint | bigint[];
    reportTimestamp?: bigint;
    reportRefSlot?: bigint;
    updateReportData?: boolean;
    waitForNextRefSlot?: boolean;
  } = {},
) {
  const { vaultHub, locator, lazyOracle, hashConsensus } = ctx.contracts;

  if (params.waitForNextRefSlot) {
    await waitNextAvailableReportTime(ctx);
  }

  // Helper to get value from array or single value
  const getValue = <T>(param: T | T[] | undefined, index: number, defaultValue: T): T => {
    if (param === undefined) return defaultValue;
    return Array.isArray(param) ? param[index] : param;
  };

  // Build vault reports for all vaults
  const vaultReports: VaultReportItem[] = await Promise.all(
    stakingVaults.map(async (vault, index) => ({
      vault: await vault.getAddress(),
      totalValue: getValue(params.totalValue, index, await vaultHub.totalValue(vault)),
      cumulativeLidoFees: getValue(params.cumulativeLidoFees, index, 0n),
      liabilityShares: getValue(params.liabilityShares, index, await vaultHub.liabilityShares(vault)),
      maxLiabilityShares: getValue(
        params.maxLiabilityShares,
        index,
        (await vaultHub.vaultRecord(vault)).maxLiabilityShares,
      ),
      slashingReserve: getValue(params.slashingReserve, index, 0n),
    })),
  );

  // Create single Merkle tree for all vaults
  const reportTree = createVaultsReportTree(vaultReports);

  // Update report data once for all vaults
  if (params.updateReportData ?? true) {
    const reportTimestampArg = params.reportTimestamp ?? (await getCurrentBlockTimestamp());
    const reportRefSlotArg = params.reportRefSlot ?? (await hashConsensus.getCurrentFrame()).refSlot;

    const accountingSigner = await impersonate(await locator.accountingOracle(), ether("100"));
    await lazyOracle
      .connect(accountingSigner)
      .updateReportData(reportTimestampArg, reportRefSlotArg, reportTree.root, "");
  }

  // Update each vault data with its proof from the common tree
  const txs = [];
  for (let i = 0; i < stakingVaults.length; i++) {
    const vaultReport = vaultReports[i];
    const tx = await lazyOracle.updateVaultData(
      vaultReport.vault,
      vaultReport.totalValue,
      vaultReport.cumulativeLidoFees,
      vaultReport.liabilityShares,
      vaultReport.maxLiabilityShares,
      vaultReport.slashingReserve,
      reportTree.getProof(i),
    );
    txs.push(tx);
  }

  return txs;
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
  nodeOperatorManager: HardhatEthersSigner = nodeOperator,
  nodeOperatorFeeBP: bigint = 200n,
  confirmExpiry: bigint = days(7n),
  roleAssignments: Permissions.RoleAssignmentStruct[] = [],
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
  nodeOperatorManager: HardhatEthersSigner = nodeOperator,
  nodeOperatorFeeBP: bigint = 200n,
  confirmExpiry: bigint = days(7n),
  roleAssignments: Permissions.RoleAssignmentStruct[] = [],
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
  owner: HardhatEthersSigner,
  nodeOperator: HardhatEthersSigner,
  validator: Validator,
  guarantor?: HardhatEthersSigner,
): Promise<{
  deposit: IStakingVault.DepositStruct;
  depositY: BLS12_381.DepositYStruct;
}> => {
  guarantor = guarantor ?? nodeOperator;

  // Pre-requisite: fund the vault to have enough balance to start a validator
  await dashboard.connect(owner).fund({ value: ether("32") });

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

  const postdeposit = generateTopUp(validator.container, amount);
  const pubkey = hexlify(validator.container.pubkey);

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

export async function calculateLockedValue(
  ctx: ProtocolContext,
  stakingVault: StakingVault,
  params: {
    liabilityShares?: bigint;
    liabilitySharesIncrease?: bigint;
    minimalReserve?: bigint;
    reserveRatioBP?: bigint;
  } = {},
) {
  const { vaultHub, lido } = ctx.contracts;

  const liabilitySharesIncrease = params.liabilitySharesIncrease ?? 0n;

  const liabilityShares =
    (params.liabilityShares ?? (await vaultHub.liabilityShares(stakingVault))) + liabilitySharesIncrease;
  const minimalReserve = params.minimalReserve ?? (await vaultHub.vaultRecord(stakingVault)).minimalReserve;
  const reserveRatioBP = params.reserveRatioBP ?? (await vaultHub.vaultConnection(stakingVault)).reserveRatioBP;

  const liability = await lido.getPooledEthBySharesRoundUp(liabilityShares);
  const reserve = ceilDiv(liability * reserveRatioBP, TOTAL_BASIS_POINTS - reserveRatioBP);

  return liability + (reserve > minimalReserve ? reserve : minimalReserve);
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
