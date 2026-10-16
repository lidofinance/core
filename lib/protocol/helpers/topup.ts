import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { certainAddress, ether, impersonate, log } from "lib";
import { addressToWC, generateBeaconHeader, setBeaconBlockRoot } from "lib/pdg";
import { buildBeaconHeaderProof, buildValidatorStateProofs } from "lib/top-ups";

import { ProtocolContext } from "../types";

import { ensureSubmitFitsStakeLimit, setModuleStakeShareLimit } from "./staking";

/**
 * Helpers for driving the real top-up path in integration tests:
 * TopUpGateway.topUp -> StakingRouter.topUp -> module.allocateDeposits -> DepositContract.
 *
 * Witnesses are built against a real Electra or Gloas BeaconState (Lodestar SSZ types) committed
 * to the EIP-4788 beacon roots contract, using a fresh header slot and the deployed fork's layout.
 */

const FAR_FUTURE_EPOCH = 2n ** 64n - 1n;
const TOTAL_BASIS_POINTS = 100_00n;

export interface TopUpValidatorState {
  pubkey: string;
  effectiveBalanceGwei: bigint;
  slashed?: boolean;
  activationEpoch?: bigint;
  exitEpoch?: bigint;
}

export interface TopUpValidatorWitness {
  proofValidator: string[];
  pubkey: string;
  effectiveBalance: bigint;
  slashed: boolean;
  activationEligibilityEpoch: bigint;
  activationEpoch: bigint;
  exitEpoch: bigint;
  withdrawableEpoch: bigint;
}

export interface TopUpWitnessBundle {
  validatorIndices: bigint[];
  validatorWitness: TopUpValidatorWitness[];
  beaconRootData: {
    childBlockTimestamp: number;
    slot: number;
    proposerIndex: number;
  };
}

/**
 * Build a local CL state tree with the given validators (real module pubkeys are fine),
 * commit its beacon root to EIP-4788 and return per-validator witnesses with proofs.
 *
 * Validator container fields not exposed in TopUpValidatorState default to an
 * activated, non-exited validator whose withdrawal credentials point to the real
 * WithdrawalVault with the 0x02 prefix.
 *
 * Build the bundle right before calling topUp: the gateway rejects roots older than
 * maxRootAge and roots that precede the last successful top-up.
 */
export const prepareTopUpWitnesses = async (
  ctx: ProtocolContext,
  validators: TopUpValidatorState[],
): Promise<TopUpWitnessBundle> => {
  const { topUpGateway, withdrawalVault } = ctx.contracts;

  // TODO(GLOAS): REMOVE THE FALLBACK AS SOON AS THE GATEWAY IS DEPLOYED WITH A REAL GLOAS SLOT.
  // Gateways deployed before GLOAS_SLOT existed only verify the Electra (pre-Gloas) layout.
  let gloasSlot = 2n ** 64n - 1n;
  try {
    gloasSlot = await topUpGateway.GLOAS_SLOT();
  } catch {
    // Legacy gateway: keep the pre-Gloas layout.
  }

  const { genesisTime, secondsPerSlot } = await ctx.contracts.hashConsensus.getChainConfig();
  const slot = (BigInt(await time.latest()) - genesisTime) / secondsPerSlot + 1n;

  const withdrawalCredentials = addressToWC(await withdrawalVault.getAddress(), 2);

  const containers = validators.map((v) => ({
    pubkey: v.pubkey,
    withdrawalCredentials,
    effectiveBalance: v.effectiveBalanceGwei,
    slashed: v.slashed ?? false,
    activationEligibilityEpoch: 1n,
    activationEpoch: v.activationEpoch ?? 2n,
    exitEpoch: v.exitEpoch ?? FAR_FUTURE_EPOCH,
    withdrawableEpoch: FAR_FUTURE_EPOCH,
  }));

  const state = await buildValidatorStateProofs(containers, { gloas: slot >= gloasSlot });
  const validatorIndices = containers.map((_, i) => BigInt(i));

  const beaconBlockHeader = generateBeaconHeader(state.root, Number(slot));
  const headerProof = await buildBeaconHeaderProof(beaconBlockHeader);
  await time.setNextBlockTimestamp(genesisTime + (slot + 1n) * secondsPerSlot);
  const childBlockTimestamp = await setBeaconBlockRoot(headerProof.root);

  const validatorWitness = containers.map((container, i) => ({
    proofValidator: [...state.proofs[i], ...headerProof.proof],
    pubkey: container.pubkey,
    effectiveBalance: container.effectiveBalance,
    slashed: container.slashed,
    activationEligibilityEpoch: container.activationEligibilityEpoch,
    activationEpoch: container.activationEpoch,
    exitEpoch: container.exitEpoch,
    withdrawableEpoch: container.withdrawableEpoch,
  }));

  return {
    validatorIndices,
    validatorWitness,
    beaconRootData: {
      childBlockTimestamp,
      slot: beaconBlockHeader.slot,
      proposerIndex: beaconBlockHeader.proposerIndex,
    },
  };
};

/**
 * Assemble the TopUpData struct for TopUpGateway.topUp from module key coordinates
 * and a witness bundle. Arrays are aligned by position.
 */
export const buildTopUpData = (
  moduleId: bigint,
  keys: { keyIndices: bigint[]; operatorIds: bigint[] },
  bundle: TopUpWitnessBundle,
  opts: { pendingBalanceGwei?: bigint[] } = {},
) => ({
  moduleId,
  keyIndices: keys.keyIndices,
  operatorIds: keys.operatorIds,
  validatorIndices: bundle.validatorIndices,
  beaconRootData: bundle.beaconRootData,
  validatorWitness: bundle.validatorWitness,
  pendingBalanceGwei: opts.pendingBalanceGwei ?? bundle.validatorIndices.map(() => 0n),
});

/**
 * Return a signer holding TOP_UP_ROLE on the TopUpGateway.
 *
 * Production deploys have exactly one holder (the depositor from the deploy params;
 * the upgrade template asserts this), so prefer impersonating it over minting a new
 * holder. Only when no holder exists (fresh scratch state) the role is granted to a
 * dedicated test address by the gateway admin (agent).
 */
export const getTopUpRoleSigner = async (ctx: ProtocolContext): Promise<HardhatEthersSigner> => {
  const { topUpGateway } = ctx.contracts;

  const role = await topUpGateway.TOP_UP_ROLE();
  if ((await topUpGateway.getRoleMemberCount(role)) > 0n) {
    const holder = await topUpGateway.getRoleMember(role, 0);
    log.debug("Impersonating existing TOP_UP_ROLE holder", { Holder: holder });
    return impersonate(holder, ether("100"));
  }

  const caller = await impersonate(certainAddress("topup:caller"), ether("100"));
  const agentSigner = await ctx.getSigner("agent");
  await topUpGateway.connect(agentSigner).grantRole(role, caller.address);
  return caller;
};

/**
 * Make sure Lido has at least `minWei` of depositable ether, submitting the shortfall
 * (plus the reserve blocked by unfinalized withdrawals) from a test whale if needed.
 */
export const topUpEnsureDepositableEther = async (ctx: ProtocolContext, minWei: bigint) => {
  const { lido, withdrawalQueue } = ctx.contracts;

  let depositable = await lido.getDepositableEther();
  if (depositable >= minWei) return;

  const buffered = await lido.getBufferedEther();
  const unfinalized = await withdrawalQueue.unfinalizedStETH();
  const reserve = unfinalized > buffered ? unfinalized - buffered : 0n;
  const submitValue = minWei - depositable + reserve + ether("1");

  await ensureSubmitFitsStakeLimit(ctx, submitValue);
  const whale = await impersonate(certainAddress("topup:eth:whale"), submitValue + ether("10"));
  await lido.connect(whale).submit(ZeroAddress, { value: submitValue });

  depositable = await lido.getDepositableEther();
  if (depositable < minWei) {
    throw new Error(`Not enough depositable ether for top-up: ${depositable}, expected at least ${minWei}`);
  }
};

/**
 * Make sure the router allocates at least `minWei` of top-up capacity to the module.
 *
 * On forks the module's stake share limit may cap the allocation; raise it to 100%
 * through the manager role when the current allocation is not enough. Reverts if the
 * allocation is still short afterwards (e.g. module capacity itself is the limit).
 */
export const topUpEnsureModuleAllocation = async (ctx: ProtocolContext, moduleId: bigint, minWei: bigint) => {
  const { lido, stakingRouter } = ctx.contracts;

  const depositable = await lido.getDepositableEther();
  const moduleIds = await stakingRouter.getStakingModuleIds();
  const moduleIndex = moduleIds.findIndex((id) => id === moduleId);
  if (moduleIndex === -1) throw new Error(`Staking module ${moduleId} is not registered`);

  const allocationOf = async () => {
    const { allocated } = await stakingRouter.getDepositAllocations(depositable, true);
    return allocated[moduleIndex] ?? 0n;
  };

  if ((await allocationOf()) >= minWei) return;

  await setModuleStakeShareLimit(ctx, moduleId, TOTAL_BASIS_POINTS);

  const allocation = await allocationOf();
  if (allocation < minWei) {
    throw new Error(`Top-up allocation for module ${moduleId} is ${allocation}, expected at least ${minWei}`);
  }
};

/** Expected gateway top-up limit for one validator, in wei. */
export const expectedTopUpLimitWei = async (
  ctx: ProtocolContext,
  effectiveBalanceGwei: bigint,
  pendingBalanceGwei: bigint = 0n,
): Promise<bigint> => {
  const { topUpGateway } = ctx.contracts;
  const targetBalanceGwei = await topUpGateway.getTargetBalanceGwei();
  const minTopUpGwei = await topUpGateway.getMinTopUpGwei();

  const currentTotal = effectiveBalanceGwei + pendingBalanceGwei;
  if (currentTotal >= targetBalanceGwei) return 0n;

  const limitGwei = targetBalanceGwei - currentTotal;
  if (limitGwei < minTopUpGwei) return 0n;

  return limitGwei * 10n ** 9n;
};

/** DepositContract DepositEvent interface for receipt parsing. */
export const depositEventInterface = new ethers.Interface([
  "event DepositEvent(bytes pubkey, bytes withdrawal_credentials, bytes amount, bytes signature, bytes index)",
]);

/** Parse little-endian gwei amount bytes from a DepositEvent into wei. */
export const depositEventAmountWei = (amountLeBytes: string): bigint => {
  const bytes = ethers.getBytes(amountLeBytes);
  let gwei = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    gwei = (gwei << 8n) | BigInt(bytes[i]);
  }
  return gwei * 10n ** 9n;
};
