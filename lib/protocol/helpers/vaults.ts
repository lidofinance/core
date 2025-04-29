import { expect } from "chai";
import { BytesLike, ContractTransactionReceipt, ContractTransactionResponse, hexlify } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

import {
  Dashboard,
  Permissions,
  PinnedBeaconProxy,
  PredepositGuarantee,
  StakingVault,
  VaultFactory,
} from "typechain-types";

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

import { BLS12_381 } from "../../../typechain-types/contracts/0.8.25/vaults/predeposit_guarantee/PredepositGuarantee";
import { StakingVaultDepositStruct } from "../../../typechain-types/contracts/0.8.25/vaults/StakingVault";
import { ether } from "../../units";
import { LoadedContract, ProtocolContext } from "../types";

const VAULT_NODE_OPERATOR_FEE = 3_00n; // 3% node operator fee
const DEFAULT_CONFIRM_EXPIRY = days(7n);
export const VAULT_CONNECTION_DEPOSIT = ether("1");

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
  tierChanger: HardhatEthersSigner;
  nodeOperatorFeeClaimer: HardhatEthersSigner;
  nodeOperatorRewardAdjuster: HardhatEthersSigner;
};

export interface VaultWithDashboard {
  stakingVault: StakingVault;
  dashboard: Dashboard;
  roles: VaultRoles;
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
  roleAssignments: Permissions.RoleAssignmentStruct[],
  fee = VAULT_NODE_OPERATOR_FEE,
  confirmExpiry = DEFAULT_CONFIRM_EXPIRY,
): Promise<VaultWithDashboard> {
  const deployTx = await stakingVaultFactory
    .connect(owner)
    .createVaultWithDashboard(owner, nodeOperator, nodeOperatorManager, fee, confirmExpiry, roleAssignments, "0x", {
      value: VAULT_CONNECTION_DEPOSIT,
    });

  const createVaultTxReceipt = (await deployTx.wait()) as ContractTransactionReceipt;
  const createVaultEvents = ctx.getEvents(createVaultTxReceipt, "VaultCreated");

  expect(createVaultEvents.length).to.equal(1n, "Expected exactly one VaultCreated event");
  expect(createVaultEvents[0].args).to.not.be.undefined, "VaultCreated event args should be defined";

  const vaultAddress = createVaultEvents[0].args!.vault;
  const ownerAddress = createVaultEvents[0].args!.owner;

  const stakingVault = await ethers.getContractAt("StakingVault", vaultAddress);
  const dashboard = await ethers.getContractAt("Dashboard", ownerAddress);

  const roleIds = await Promise.all([
    dashboard.RECOVER_ASSETS_ROLE(),
    dashboard.FUND_ROLE(),
    dashboard.WITHDRAW_ROLE(),
    dashboard.LOCK_ROLE(),
    dashboard.MINT_ROLE(),
    dashboard.BURN_ROLE(),
    dashboard.REBALANCE_ROLE(),
    dashboard.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(),
    dashboard.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(),
    dashboard.PDG_COMPENSATE_PREDEPOSIT_ROLE(),
    dashboard.UNGUARANTEED_BEACON_CHAIN_DEPOSIT_ROLE(),
    dashboard.PDG_PROVE_VALIDATOR_ROLE(),
    dashboard.REQUEST_VALIDATOR_EXIT_ROLE(),
    dashboard.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(),
    dashboard.VOLUNTARY_DISCONNECT_ROLE(),
    dashboard.LIDO_VAULTHUB_AUTHORIZATION_ROLE(),
    dashboard.LIDO_VAULTHUB_DEAUTHORIZATION_ROLE(),
    dashboard.OSSIFY_ROLE(),
    dashboard.SET_DEPOSITOR_ROLE(),
    dashboard.RESET_LOCKED_ROLE(),
    dashboard.REQUEST_TIER_CHANGE_ROLE(),
    dashboard.NODE_OPERATOR_FEE_CLAIM_ROLE(),
    dashboard.NODE_OPERATOR_REWARDS_ADJUST_ROLE(),
  ]);

  const signers = await ethers.getSigners();
  const roles: VaultRoles = {
    assetRecoverer: signers[0],
    funder: signers[1],
    withdrawer: signers[2],
    locker: signers[3],
    minter: signers[4],
    burner: signers[5],
    rebalancer: signers[6],
    depositPauser: signers[7],
    depositResumer: signers[8],
    pdgCompensator: signers[9],
    unguaranteedBeaconChainDepositor: signers[10],
    unknownValidatorProver: signers[11],
    validatorExitRequester: signers[12],
    validatorWithdrawalTriggerer: signers[13],
    disconnecter: signers[14],
    lidoVaultHubAuthorizer: signers[15],
    lidoVaultHubDeauthorizer: signers[16],
    ossifier: signers[17],
    depositorSetter: signers[18],
    lockedResetter: signers[19],
    tierChanger: signers[20],
    nodeOperatorFeeClaimer: signers[21],
    nodeOperatorRewardAdjuster: signers[22],
  };

  for (let i = 0; i < roleIds.length; i++) {
    const roleAdmin = await dashboard.getRoleAdmin(roleIds[i]);
    if (roleAdmin === (await dashboard.NODE_OPERATOR_MANAGER_ROLE())) {
      await dashboard.connect(nodeOperatorManager).grantRole(roleIds[i], signers[i]);
    } else {
      await dashboard.grantRole(roleIds[i], signers[i]);
    }
  }

  return {
    stakingVault,
    dashboard,
    roles,
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

export async function generateFeesToClaim(ctx: ProtocolContext, stakingVault: StakingVault) {
  const { vaultHub } = ctx.contracts;
  const hubSigner = await impersonate(await vaultHub.getAddress(), ether("100"));
  const rewards = ether("1");
  await stakingVault.connect(hubSigner).report(await getCurrentBlockTimestamp(), rewards, 0n, 0n);
}

// address, totalValue, inOutDelta, treasuryFees, liabilityShares
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
    await stakingVault.totalValue(),
    await stakingVault.inOutDelta(),
    0n,
    0n,
  ];
  const reportTree = createVaultsReportTree([vaultReport]);

  const accountingSigner = await impersonate(await locator.accounting(), ether("100"));
  await vaultHub.connect(accountingSigner).updateReportData(await getCurrentBlockTimestamp(), reportTree.root, "");
  await vaultHub.updateVaultData(
    await stakingVault.getAddress(),
    await stakingVault.totalValue(),
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
): Promise<{
  deposit: StakingVaultDepositStruct;
  depositY: BLS12_381.DepositYStruct;
}> => {
  // Pre-requisite: fund the vault to have enough balance to start a validator
  await dashboard.connect(roles.funder).fund({ value: ether("32") });

  // Step 1: Top up the node operator balance
  await predepositGuarantee.connect(nodeOperator).topUpNodeOperatorBalance(nodeOperator, {
    value: ether("1"),
  });

  // Step 2: Predeposit a validator
  const predepositData = await generatePredeposit(validator, {
    depositDomain: await predepositGuarantee.DEPOSIT_DOMAIN(),
  });
  return predepositData;
};

export const getProofAndDepositData = async (
  predepositGuarantee: LoadedContract<PredepositGuarantee>,
  validator: Validator,
  withdrawalCredentials: string,
) => {
  // Step 3: Prove and deposit the validator
  const slot = await predepositGuarantee.SLOT_CHANGE_GI_FIRST_VALIDATOR();

  const mockCLtree = await prepareLocalMerkleTree(await predepositGuarantee.GI_FIRST_VALIDATOR_AFTER_CHANGE());
  const { validatorIndex } = await mockCLtree.addValidator(validator.container);
  const { childBlockTimestamp, beaconBlockHeader } = await mockCLtree.commitChangesToBeaconRoot(Number(slot) + 100);
  const proof = await mockCLtree.buildProof(validatorIndex, beaconBlockHeader);

  const postdeposit = generatePostDeposit(validator.container);
  const pubkey = hexlify(validator.container.pubkey);
  const signature = hexlify(postdeposit.signature);

  postdeposit.depositDataRoot = computeDepositDataRoot(withdrawalCredentials, pubkey, signature, ether("31"));

  const witnesses = [{ proof, pubkey, validatorIndex, childBlockTimestamp }];
  return { witnesses, postdeposit };
};
