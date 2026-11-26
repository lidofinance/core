import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mine } from "@nomicfoundation/hardhat-network-helpers";

import { certainAddress, ether, impersonate, log } from "lib";
import { MAX_EFFECTIVE_BALANCE_WC_TYPE_01 } from "lib/constants";

import { ProtocolContext } from "../types";

import { ensureSubmitFitsStakeLimit, getStakingModuleManagerSigner, setModuleStakeShareLimit } from "./staking";

/**
 * Helpers for driving the real top-up path in integration tests:
 * DepositSecurityModule.topUpBufferedEther -> StakingRouter.topUp -> module.allocateDeposits -> DepositContract.
 */

const TOTAL_BASIS_POINTS = 100_00n;

/**
 * Return a signer for the DSM top-up depositor.
 *
 * Production deploys pass the depositor to the DSM constructor, so impersonate it.
 * Only when it is not set (fresh scratch state) the DSM owner (agent) sets a dedicated test address.
 */
export const getTopUpDepositorSigner = async (ctx: ProtocolContext): Promise<HardhatEthersSigner> => {
  const { depositSecurityModule: dsm } = ctx.contracts;

  const current = await dsm.getTopUpDepositor();
  if (current !== ZeroAddress) {
    log.debug("Impersonating the DSM top-up depositor", { Depositor: current });
    return impersonate(current, ether("100"));
  }

  const depositor = await impersonate(certainAddress("topup:depositor"), ether("100"));
  const owner = await impersonate(await dsm.getOwner(), ether("1"));
  await dsm.connect(owner).setTopUpDepositor(depositor.address);
  return depositor;
};

/**
 * Make sure one top-up call to the module can move `minWei`.
 *
 * StakingRouter caps a top-up call at `maxDepositsPerBlock * 32 ETH` of the module. Deposit helpers set
 * `maxDepositsPerBlock` to the number of keys they deposit, so raise it back through the manager role.
 */
export const topUpEnsureBatchCap = async (ctx: ProtocolContext, moduleId: bigint, minWei: bigint) => {
  const { stakingRouter } = ctx.contracts;

  const module = await stakingRouter.getStakingModule(moduleId);
  const minDepositsPerBlock = (minWei + MAX_EFFECTIVE_BALANCE_WC_TYPE_01 - 1n) / MAX_EFFECTIVE_BALANCE_WC_TYPE_01;
  if (module.maxDepositsPerBlock >= minDepositsPerBlock) return;

  const managerSigner = await getStakingModuleManagerSigner(ctx);
  await stakingRouter
    .connect(managerSigner)
    .updateStakingModule(
      moduleId,
      module.stakeShareLimit,
      module.priorityExitShareThreshold,
      module.stakingModuleFee,
      module.treasuryFee,
      minDepositsPerBlock,
      module.minDepositBlockDistance,
    );
};

/** Mine blocks until the DSM min deposit distance has passed for the module. */
export const topUpEnsureDistancePassed = async (ctx: ProtocolContext, moduleId: bigint) => {
  const { depositSecurityModule: dsm, stakingRouter } = ctx.contracts;

  if (await dsm.isMinDepositDistancePassed(moduleId)) return;

  await mine(await stakingRouter.getStakingModuleMinDepositBlockDistance(moduleId));
  if (!(await dsm.isMinDepositDistancePassed(moduleId))) {
    throw new Error(`DSM min deposit distance has not passed for module ${moduleId}`);
  }
};

/**
 * Make sure Lido has at least `minWei` of depositable ether, submitting the shortfall
 * from a test whale if needed.
 *
 * Depositable ether is max(depositsReserve, buffered - unfinalizedStETH): a submit does
 * not grow the deposits reserve, so the submitted ether covers unfinalized withdrawals
 * first and only the buffer above them becomes depositable.
 */
export const topUpEnsureDepositableEther = async (ctx: ProtocolContext, minWei: bigint) => {
  const { lido, withdrawalQueue } = ctx.contracts;

  let depositable = await lido.getDepositableEther();
  if (depositable >= minWei) return;

  const buffered = await lido.getBufferedEther();
  const unfinalized = await withdrawalQueue.unfinalizedStETH();
  // depositable >= buffered - unfinalized, so this is positive whenever depositable < minWei
  const submitValue = minWei + unfinalized - buffered + ether("1");

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
 * through the manager role when the current allocation is not enough. Other 0x02 modules
 * with free top-up capacity share the depositable ether, so submit the shortfall until the
 * module gets enough. Reverts if the allocation is still short afterwards (e.g. module
 * capacity itself is the limit). Also raises the module batch cap (see `topUpEnsureBatchCap`).
 */
export const topUpEnsureModuleAllocation = async (ctx: ProtocolContext, moduleId: bigint, minWei: bigint) => {
  const { lido, stakingRouter } = ctx.contracts;

  await topUpEnsureBatchCap(ctx, moduleId, minWei);

  const moduleIds = await stakingRouter.getStakingModuleIds();
  const moduleIndex = moduleIds.findIndex((id) => id === moduleId);
  if (moduleIndex === -1) throw new Error(`Staking module ${moduleId} is not registered`);

  const allocationOf = async () => {
    const { allocated } = await stakingRouter.getDepositAllocations(await lido.getDepositableEther(), true);
    return allocated[moduleIndex] ?? 0n;
  };

  if ((await allocationOf()) >= minWei) return;

  await setModuleStakeShareLimit(ctx, moduleId, TOTAL_BASIS_POINTS);

  let allocation = await allocationOf();
  for (let attempt = 0; attempt < 5 && allocation < minWei; attempt++) {
    // The router allocates in 32 ETH units: add one unit on top of the shortfall
    const shortfall = minWei - allocation + MAX_EFFECTIVE_BALANCE_WC_TYPE_01;
    await topUpEnsureDepositableEther(ctx, (await lido.getDepositableEther()) + shortfall);
    const increased = await allocationOf();
    if (increased === allocation) break;
    allocation = increased;
  }

  if (allocation < minWei) {
    throw new Error(`Top-up allocation for module ${moduleId} is ${allocation}, expected at least ${minWei}`);
  }
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
