import { expect } from "chai";
import { BytesLike, ContractTransactionReceipt, ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

import { Delegation, PinnedBeaconProxy, StakingVault, VaultFactory } from "typechain-types";
import { DelegationConfigStruct } from "typechain-types/contracts/0.8.25/vaults/VaultFactory";

import { days, findEventsWithInterfaces, getCurrentBlockTimestamp, impersonate } from "lib";

import { ether } from "../../units";
import { ProtocolContext } from "../types";

const VAULT_NODE_OPERATOR_FEE = 3_00n; // 3% node operator fee
const DEFAULT_CONFIRM_EXPIRY = days(7n);
const VAULT_CONNECTION_DEPOSIT = ether("1");

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

export interface VaultWithDelegation {
  stakingVault: StakingVault;
  delegation: Delegation;
  roles: VaultRoles;
}

/**
 * Creates a new vault with delegation contract
 *
 * This function deploys a new StakingVault contract and its associated Delegation contract
 * using the provided VaultFactory. It sets up all necessary roles and permissions.
 *
 * @param ctx Protocol context for event handling and contract interaction
 * @param stakingVaultFactory Factory contract used to create the vault
 * @param owner Address that will be set as the owner/admin of the vault
 * @param nodeOperatorManager Address of the node operator manager contract
 * @param rolesOverrides Optional object to override default randomly generated role addresses
 * @param fee Node operator fee in basis points (default: 3% = 300 basis points)
 * @param confirmExpiry Time period for confirmation expiry (default: 7 days)
 * @returns Object containing the created StakingVault, Delegation contract, and role addresses
 */
export async function createVaultWithDelegation(
  ctx: ProtocolContext,
  stakingVaultFactory: VaultFactory & { address: string },
  owner: HardhatEthersSigner,
  nodeOperatorManager: HardhatEthersSigner,
  rolesOverrides: Partial<VaultRoles> = {},
  fee = VAULT_NODE_OPERATOR_FEE,
  confirmExpiry = DEFAULT_CONFIRM_EXPIRY,
): Promise<VaultWithDelegation> {
  const defaultRoles = await ethers.getSigners();

  const [
    assetRecoverer,
    funder,
    withdrawer,
    locker,
    minter,
    burner,
    rebalancer,
    depositPauser,
    depositResumer,
    pdgCompensator,
    unguaranteedBeaconChainDepositor,
    unknownValidatorProver,
    validatorExitRequester,
    validatorWithdrawalTriggerer,
    disconnecter,
    lidoVaultHubAuthorizer,
    lidoVaultHubDeauthorizer,
    ossifier,
    depositorSetter,
    lockedResetter,
    nodeOperatorFeeClaimer,
    nodeOperatorRewardAdjuster,
  ] = defaultRoles;

  const roles: VaultRoles = {
    assetRecoverer: rolesOverrides.assetRecoverer ?? assetRecoverer,
    funder: rolesOverrides.funder ?? funder,
    withdrawer: rolesOverrides.withdrawer ?? withdrawer,
    locker: rolesOverrides.locker ?? locker,
    minter: rolesOverrides.minter ?? minter,
    burner: rolesOverrides.burner ?? burner,
    rebalancer: rolesOverrides.rebalancer ?? rebalancer,
    depositPauser: rolesOverrides.depositPauser ?? depositPauser,
    depositResumer: rolesOverrides.depositResumer ?? depositResumer,
    pdgCompensator: rolesOverrides.pdgCompensator ?? pdgCompensator,
    unguaranteedBeaconChainDepositor:
      rolesOverrides.unguaranteedBeaconChainDepositor ?? unguaranteedBeaconChainDepositor,
    unknownValidatorProver: rolesOverrides.unknownValidatorProver ?? unknownValidatorProver,
    validatorExitRequester: rolesOverrides.validatorExitRequester ?? validatorExitRequester,
    validatorWithdrawalTriggerer: rolesOverrides.validatorWithdrawalTriggerer ?? validatorWithdrawalTriggerer,
    disconnecter: rolesOverrides.disconnecter ?? disconnecter,
    lidoVaultHubAuthorizer: rolesOverrides.lidoVaultHubAuthorizer ?? lidoVaultHubAuthorizer,
    lidoVaultHubDeauthorizer: rolesOverrides.lidoVaultHubDeauthorizer ?? lidoVaultHubDeauthorizer,
    ossifier: rolesOverrides.ossifier ?? ossifier,
    depositorSetter: rolesOverrides.depositorSetter ?? depositorSetter,
    lockedResetter: rolesOverrides.lockedResetter ?? lockedResetter,
    nodeOperatorFeeClaimer: rolesOverrides.nodeOperatorFeeClaimer ?? nodeOperatorFeeClaimer,
    nodeOperatorRewardAdjuster: rolesOverrides.nodeOperatorRewardAdjuster ?? nodeOperatorRewardAdjuster,
  };

  const deployTx = await stakingVaultFactory.connect(owner).createVaultWithDelegation(
    {
      defaultAdmin: owner,
      nodeOperatorManager: nodeOperatorManager,
      nodeOperatorFeeBP: fee,
      confirmExpiry: confirmExpiry,
      assetRecoverer: roles.assetRecoverer,
      funders: [roles.funder],
      withdrawers: [roles.withdrawer],
      lockers: [roles.locker],
      minters: [roles.minter],
      burners: [roles.burner],
      rebalancers: [roles.rebalancer],
      depositPausers: [roles.depositPauser],
      depositResumers: [roles.depositResumer],
      pdgCompensators: [roles.pdgCompensator],
      unguaranteedBeaconChainDepositors: [roles.unguaranteedBeaconChainDepositor],
      unknownValidatorProvers: [roles.unknownValidatorProver],
      validatorExitRequesters: [roles.validatorExitRequester],
      validatorWithdrawalTriggerers: [roles.validatorWithdrawalTriggerer],
      disconnecters: [roles.disconnecter],
      lidoVaultHubAuthorizers: [roles.lidoVaultHubAuthorizer],
      lidoVaultHubDeauthorizers: [roles.lidoVaultHubDeauthorizer],
      nodeOperatorFeeClaimers: [roles.nodeOperatorFeeClaimer],
      nodeOperatorRewardAdjusters: [roles.nodeOperatorRewardAdjuster],
      ossifiers: [roles.ossifier],
      depositorSetters: [roles.depositorSetter],
      lockedResetters: [roles.lockedResetter],
    },
    "0x",
    { value: VAULT_CONNECTION_DEPOSIT },
  );

  const createVaultTxReceipt = (await deployTx.wait()) as ContractTransactionReceipt;
  const createVaultEvents = ctx.getEvents(createVaultTxReceipt, "VaultCreated");

  expect(createVaultEvents.length).to.equal(1n, "Expected exactly one VaultCreated event");
  expect(createVaultEvents[0].args).to.not.be.undefined, "VaultCreated event args should be defined";

  const vaultAddress = createVaultEvents[0].args!.vault;
  const ownerAddress = createVaultEvents[0].args!.owner;

  const stakingVault = await ethers.getContractAt("StakingVault", vaultAddress);
  const delegation = await ethers.getContractAt("Delegation", ownerAddress);

  return {
    stakingVault,
    delegation,
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
 * @param delegation Delegation contract instance
 * @param stakingVault Staking vault instance
 */
export async function lockConnectionDeposit(ctx: ProtocolContext, delegation: Delegation, stakingVault: StakingVault) {
  const delegationSigner = await impersonate(await delegation.getAddress(), ether("100"));
  await stakingVault.connect(delegationSigner).fund({ value: ether("1") });
  await stakingVault.connect(delegationSigner).lock(ether("1"));
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
  delegation: Delegation;
}

export async function createVaultProxy(
  caller: HardhatEthersSigner,
  vaultFactory: VaultFactory,
  delegationParams: DelegationConfigStruct,
  stakingVaultInitializerExtraParams: BytesLike = "0x",
): Promise<CreateVaultResponse> {
  const tx = await vaultFactory
    .connect(caller)
    .createVaultWithDelegation(delegationParams, stakingVaultInitializerExtraParams, { value: ether("1") });

  // Get the receipt manually
  const receipt = (await tx.wait())!;
  const events = findEventsWithInterfaces(receipt, "VaultCreated", [vaultFactory.interface]);

  if (events.length === 0) throw new Error("Vault creation event not found");

  const event = events[0];
  const { vault } = event.args;

  const delegationEvents = findEventsWithInterfaces(receipt, "DelegationCreated", [vaultFactory.interface]);

  if (delegationEvents.length === 0) throw new Error("Delegation creation event not found");

  const { delegation: delegationAddress } = delegationEvents[0].args;

  const proxy = (await ethers.getContractAt("PinnedBeaconProxy", vault, caller)) as PinnedBeaconProxy;
  const stakingVault = (await ethers.getContractAt("StakingVault", vault, caller)) as StakingVault;
  const delegation = (await ethers.getContractAt("Delegation", delegationAddress, caller)) as Delegation;

  return {
    tx,
    proxy,
    vault: stakingVault,
    delegation,
  };
}
