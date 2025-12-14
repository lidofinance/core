/**
 * State capture utilities for Graph Simulator
 *
 * Provides functions to capture on-chain state before and after transactions
 * for verification against simulator-computed values.
 *
 * Reference: graph-tests-spec.md - SimulatorInitialState interface
 */

import { ProtocolContext } from "lib/protocol";

/**
 * Initial state required to initialize the simulator
 *
 * This state is captured from the chain at test start and used
 * to initialize the simulator's internal state.
 */
export interface SimulatorInitialState {
  /** Total pooled ether in the protocol */
  totalPooledEther: bigint;

  /** Total shares in the protocol */
  totalShares: bigint;

  /** Treasury address for fee categorization */
  treasuryAddress: string;

  /** Staking module addresses from StakingRouter */
  stakingModuleAddresses: string[];
}

/**
 * Pool state snapshot for before/after comparison
 */
export interface PoolState {
  /** Total pooled ether */
  totalPooledEther: bigint;

  /** Total shares */
  totalShares: bigint;
}

/**
 * Capture the full chain state needed to initialize the simulator
 *
 * This should be called once at test suite start (for Scenario tests)
 * or at the beginning of each test (for Integration tests).
 *
 * @param ctx - Protocol context with contracts
 * @returns SimulatorInitialState with all required fields
 */
export async function captureChainState(ctx: ProtocolContext): Promise<SimulatorInitialState> {
  const { lido, locator, stakingRouter } = ctx.contracts;

  // Get pool state
  const [totalPooledEther, totalShares] = await Promise.all([lido.getTotalPooledEther(), lido.getTotalShares()]);

  // Get treasury address from locator
  const treasuryAddress = await locator.treasury();

  // Get staking module addresses
  const stakingModuleAddresses: string[] = [];
  const modules = await stakingRouter.getStakingModules();

  for (const module of modules) {
    stakingModuleAddresses.push(module.stakingModuleAddress);
  }

  return {
    totalPooledEther,
    totalShares,
    treasuryAddress,
    stakingModuleAddresses,
  };
}

/**
 * Capture just the pool state (lighter weight than full state)
 *
 * Use this for before/after snapshots around transactions.
 *
 * @param ctx - Protocol context with contracts
 * @returns PoolState with totalPooledEther and totalShares
 */
export async function capturePoolState(ctx: ProtocolContext): Promise<PoolState> {
  const { lido } = ctx.contracts;

  const [totalPooledEther, totalShares] = await Promise.all([lido.getTotalPooledEther(), lido.getTotalShares()]);

  return {
    totalPooledEther,
    totalShares,
  };
}

/**
 * Capture treasury balance (shares)
 *
 * @param ctx - Protocol context with contracts
 * @returns Treasury shares balance
 */
export async function captureTreasuryShares(ctx: ProtocolContext): Promise<bigint> {
  const { lido, locator } = ctx.contracts;

  const treasuryAddress = await locator.treasury();
  return lido.sharesOf(treasuryAddress);
}

/**
 * Capture staking module balances
 *
 * @param ctx - Protocol context with contracts
 * @returns Map of module address to shares balance
 */
export async function captureModuleBalances(ctx: ProtocolContext): Promise<Map<string, bigint>> {
  const { lido, stakingRouter } = ctx.contracts;

  const balances = new Map<string, bigint>();
  const modules = await stakingRouter.getStakingModules();

  const balancePromises = modules.map(async (module) => {
    const shares = await lido.sharesOf(module.stakingModuleAddress);
    return { address: module.stakingModuleAddress, shares };
  });

  const results = await Promise.all(balancePromises);

  for (const result of results) {
    balances.set(result.address.toLowerCase(), result.shares);
  }

  return balances;
}
