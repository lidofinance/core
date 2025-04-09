import { expect } from "chai";
import { ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Delegation, StakingVault, VaultFactory } from "typechain-types";

import { days, getRandomSigners, impersonate, MAX_UINT256 } from "lib";

import { ether } from "../../units";
import { ProtocolContext } from "../types";

const VAULT_NODE_OPERATOR_FEE = 3_00n; // 3% node operator fee
const DEFAULT_CONFIRM_EXPIRY = days(7n);

export type VaultRoles = {
  assetRecoverer: HardhatEthersSigner;
  funder: HardhatEthersSigner;
  withdrawer: HardhatEthersSigner;
  minter: HardhatEthersSigner;
  locker: HardhatEthersSigner;
  burner: HardhatEthersSigner;
  rebalancer: HardhatEthersSigner;
  depositPauser: HardhatEthersSigner;
  depositResumer: HardhatEthersSigner;
  validatorExitRequester: HardhatEthersSigner;
  validatorWithdrawalTriggerer: HardhatEthersSigner;
  disconnecter: HardhatEthersSigner;
  pdgWithdrawer: HardhatEthersSigner;
  lidoVaultHubAuthorizer: HardhatEthersSigner;
  ossifier: HardhatEthersSigner;
  depositorSetter: HardhatEthersSigner;
  lockedResetter: HardhatEthersSigner;
  nodeOperatorFeeClaimer: HardhatEthersSigner;
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
  const defaultRoles = await getRandomSigners(20);

  const [
    assetRecoverer,
    funder,
    withdrawer,
    minter,
    locker,
    burner,
    rebalancer,
    depositPauser,
    depositResumer,
    validatorExitRequester,
    validatorWithdrawalTriggerer,
    disconnecter,
    nodeOperatorFeeClaimer,
    pdgWithdrawer,
    lidoVaultHubAuthorizer,
    ossifier,
    depositorSetter,
    lockedResetter,
  ] = defaultRoles;

  const roles: VaultRoles = {
    assetRecoverer: rolesOverrides.assetRecoverer ?? assetRecoverer,
    funder: rolesOverrides.funder ?? funder,
    withdrawer: rolesOverrides.withdrawer ?? withdrawer,
    minter: rolesOverrides.minter ?? minter,
    locker: rolesOverrides.locker ?? locker,
    burner: rolesOverrides.burner ?? burner,
    rebalancer: rolesOverrides.rebalancer ?? rebalancer,
    depositPauser: rolesOverrides.depositPauser ?? depositPauser,
    depositResumer: rolesOverrides.depositResumer ?? depositResumer,
    validatorExitRequester: rolesOverrides.validatorExitRequester ?? validatorExitRequester,
    validatorWithdrawalTriggerer: rolesOverrides.validatorWithdrawalTriggerer ?? validatorWithdrawalTriggerer,
    disconnecter: rolesOverrides.disconnecter ?? disconnecter,
    nodeOperatorFeeClaimer: rolesOverrides.nodeOperatorFeeClaimer ?? nodeOperatorFeeClaimer,
    pdgWithdrawer: rolesOverrides.pdgWithdrawer ?? pdgWithdrawer,
    lidoVaultHubAuthorizer: rolesOverrides.lidoVaultHubAuthorizer ?? lidoVaultHubAuthorizer,
    ossifier: rolesOverrides.ossifier ?? ossifier,
    depositorSetter: rolesOverrides.depositorSetter ?? depositorSetter,
    lockedResetter: rolesOverrides.lockedResetter ?? lockedResetter,
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
      minters: [roles.minter],
      lockers: [roles.locker],
      burners: [roles.burner],
      rebalancers: [roles.rebalancer],
      depositPausers: [roles.depositPauser],
      depositResumers: [roles.depositResumer],
      validatorExitRequesters: [roles.validatorExitRequester],
      validatorWithdrawalTriggerers: [roles.validatorWithdrawalTriggerer],
      disconnecters: [roles.disconnecter],
      pdgWithdrawers: [roles.pdgWithdrawer],
      lidoVaultHubAuthorizers: [roles.lidoVaultHubAuthorizer],
      ossifiers: [roles.ossifier],
      depositorSetters: [roles.depositorSetter],
      lockedResetters: [roles.lockedResetter],
      nodeOperatorFeeClaimers: [roles.nodeOperatorFeeClaimer],
    },
    "0x",
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

export async function initialReport(ctx: ProtocolContext, stakingVault: StakingVault) {
  const { vaultHub, locator } = ctx.contracts;

  const valuations = [await stakingVault.valuation()];
  const inOutDeltas = [await stakingVault.inOutDelta()];
  const locked = [await stakingVault.locked()];
  const treasuryFees = [0n];

  const accountingSigner = await impersonate(await locator.accounting(), ether("100"));
  await vaultHub.connect(accountingSigner).updateVaults(valuations, inOutDeltas, locked, treasuryFees);
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
 * @param delegation Delegation contract instance
 * @param stakingVault Staking vault instance
 * @param params Connect to hub parameters
 */
export async function connectToHub(
  ctx: ProtocolContext,
  delegation: Delegation,
  stakingVault: StakingVault,
  { reserveRatio, rebalanceThreshold, treasuryFeeBP, shareLimit }: ConnectToHubParams = {
    reserveRatio: 10_00n, // 10% of ETH allocation as reserve,
    rebalanceThreshold: 8_00n, // 8% is a threshold to force rebalance on the vault
    treasuryFeeBP: 5_00n, // 5% of the treasury fee
    shareLimit: MAX_UINT256, // stub for getting real share limit from protocol
  },
) {
  await lockConnectionDeposit(ctx, delegation, stakingVault);

  const { vaultHub } = ctx.contracts;
  const agentSigner = await ctx.getSigner("agent");

  if (shareLimit === MAX_UINT256) {
    shareLimit = (await ctx.contracts.lido.getTotalShares()) / 10n; // 10% of total shares
  }

  await vaultHub
    .connect(agentSigner)
    .connectVault(stakingVault, shareLimit, reserveRatio, rebalanceThreshold, treasuryFeeBP);

  await initialReport(ctx, stakingVault);
}

export async function generateFeesToClaim(ctx: ProtocolContext, stakingVault: StakingVault) {
  const { vaultHub } = ctx.contracts;
  const hubSigner = await impersonate(await vaultHub.getAddress(), ether("100"));
  const rewards = ether("1");
  await stakingVault.connect(hubSigner).report(rewards, 0n, 0n);
}
