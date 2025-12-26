/**
 * Lido event handlers for Graph Simulator
 *
 * Ports the core logic from lido-subgraph/src/Lido.ts:
 * - handleETHDistributed() - Main handler that creates TotalReward entity and updates Totals
 * - handleSharesBurnt() - Handles SharesBurnt events during withdrawal finalization
 * - _processTokenRebase() - Extracts pool state from TokenRebased event
 *
 * Reference: lido-subgraph/src/Lido.ts lines 477-690
 */

import { ProtocolContext } from "lib/protocol";

import {
  findAllEventsByName,
  findEventByName,
  findTransferSharesPairs,
  getEventArg,
  LogDescriptionWithMeta,
  ZERO_ADDRESS,
} from "../../utils/event-extraction";
import {
  createTotalRewardEntity,
  LidoSubmissionEntity,
  LidoTransferEntity,
  SharesBurnEntity,
  TotalRewardEntity,
  TotalsEntity,
} from "../entities";
import { calcAPR_v2, CALCULATION_UNIT } from "../helpers";
import {
  EntityStore,
  loadLidoSubmissionEntity,
  loadLidoTransferEntity,
  loadNodeOperatorFeesEntity,
  loadNodeOperatorsSharesEntity,
  loadSharesBurnEntity,
  loadSharesEntity,
  loadTotalsEntity,
  makeLidoSubmissionId,
  makeLidoTransferId,
  makeNodeOperatorFeesId,
  makeNodeOperatorsSharesId,
  makeSharesBurnId,
  saveLidoSubmission,
  saveLidoTransfer,
  saveNodeOperatorFees,
  saveNodeOperatorsShares,
  saveShares,
  saveSharesBurn,
  saveTotalReward,
  saveTotals,
} from "../store";

/**
 * Context passed to handlers containing transaction metadata
 */
export interface HandlerContext {
  /** Block number */
  blockNumber: bigint;

  /** Block timestamp */
  blockTimestamp: bigint;

  /** Transaction hash */
  transactionHash: string;

  /** Transaction index */
  transactionIndex: number;

  /** Treasury address for fee categorization */
  treasuryAddress: string;
}

/**
 * Result of processing an ETHDistributed event
 */
export interface ETHDistributedResult {
  /** The created TotalReward entity, or null if report was non-profitable */
  totalReward: TotalRewardEntity | null;

  /** Whether the report was profitable (entity was created) */
  isProfitable: boolean;

  /** The updated Totals entity (always updated, even for non-profitable reports) */
  totals: TotalsEntity;

  /** Any validation warnings encountered during processing */
  warnings: ValidationWarning[];
}

/**
 * Result of processing a SharesBurnt event
 */
export interface SharesBurntResult {
  /** Amount of shares burnt */
  sharesBurnt: bigint;

  /** Account whose shares were burnt */
  account: string;

  /** Pre-rebase token amount */
  preRebaseTokenAmount: bigint;

  /** Post-rebase token amount */
  postRebaseTokenAmount: bigint;

  /** The updated Totals entity */
  totals: TotalsEntity;
}

/**
 * Validation warning types for sanity checks
 */
export type ValidationWarningType = "shares2mint_mismatch" | "totals_state_mismatch";

/**
 * Validation warning issued during event processing
 */
export interface ValidationWarning {
  type: ValidationWarningType;
  message: string;
  expected?: bigint;
  actual?: bigint;
}

/**
 * Handle ETHDistributed event - creates TotalReward entity for profitable reports
 *
 * This is the main entry point for processing oracle reports.
 * It looks ahead to find the TokenRebased event and extracts pool state.
 *
 * IMPORTANT: This handler also updates the Totals entity to match the real graph behavior:
 * 1. Update totalPooledEther to postTotalEther (before SharesBurnt handling)
 * 2. Handle SharesBurnt if present (decreases totalShares) during withdrawal finalization
 * 3. Update totalShares to postTotalShares (after SharesBurnt handling)
 *
 * Reference: lido-subgraph/src/Lido.ts handleETHDistributed() lines 477-571
 *
 * @param event - The ETHDistributed event
 * @param allLogs - All parsed logs from the transaction (for look-ahead)
 * @param store - Entity store
 * @param ctx - Handler context with transaction metadata
 * @returns Result containing the created entity or null for non-profitable reports
 */
export function handleETHDistributed(
  event: LogDescriptionWithMeta,
  allLogs: LogDescriptionWithMeta[],
  store: EntityStore,
  ctx: HandlerContext,
): ETHDistributedResult {
  const warnings: ValidationWarning[] = [];

  // Extract ETHDistributed event params
  const preCLBalance = getEventArg<bigint>(event, "preCLBalance");
  const postCLBalance = getEventArg<bigint>(event, "postCLBalance");
  const withdrawalsWithdrawn = getEventArg<bigint>(event, "withdrawalsWithdrawn");
  const executionLayerRewardsWithdrawn = getEventArg<bigint>(event, "executionLayerRewardsWithdrawn");

  // Find TokenRebased event (look-ahead)
  // Reference: lido-subgraph/src/Lido.ts lines 487-502
  const tokenRebasedEvent = findEventByName(allLogs, "TokenRebased", event.logIndex);

  if (!tokenRebasedEvent) {
    throw new Error(
      `TokenRebased event not found after ETHDistributed in tx ${ctx.transactionHash} at logIndex ${event.logIndex}`,
    );
  }

  // Extract TokenRebased params for Totals update
  const preTotalEther = getEventArg<bigint>(tokenRebasedEvent, "preTotalEther");
  const postTotalEther = getEventArg<bigint>(tokenRebasedEvent, "postTotalEther");
  const preTotalShares = getEventArg<bigint>(tokenRebasedEvent, "preTotalShares");
  const postTotalShares = getEventArg<bigint>(tokenRebasedEvent, "postTotalShares");
  const sharesMintedAsFees = getEventArg<bigint>(tokenRebasedEvent, "sharesMintedAsFees");

  // ========== Update Totals Entity ==========
  // Reference: lido-subgraph/src/Lido.ts lines 504-540

  // Load Totals entity (should already exist on oracle report)
  const totals = loadTotalsEntity(store, true)!;

  // ========== Totals State Validation (Sanity Check) ==========
  // In real graph, there are assertions here - we convert to warnings
  // Reference: lido-subgraph/src/Lido.ts lines 509-513
  if (totals.totalPooledEther !== 0n && totals.totalPooledEther !== preTotalEther) {
    warnings.push({
      type: "totals_state_mismatch",
      message: `Totals.totalPooledEther mismatch: expected ${preTotalEther}, got ${totals.totalPooledEther}`,
      expected: preTotalEther,
      actual: totals.totalPooledEther,
    });
  }
  if (totals.totalShares !== 0n && totals.totalShares !== preTotalShares) {
    warnings.push({
      type: "totals_state_mismatch",
      message: `Totals.totalShares mismatch: expected ${preTotalShares}, got ${totals.totalShares}`,
      expected: preTotalShares,
      actual: totals.totalShares,
    });
  }

  // Step 1: Update totalPooledEther for correct SharesBurnt handling
  // Reference: lido-subgraph/src/Lido.ts lines 515-517
  totals.totalPooledEther = postTotalEther;
  saveTotals(store, totals);

  // Step 2: Handle SharesBurnt if present (for withdrawal finalization)
  // Reference: lido-subgraph/src/Lido.ts lines 521-535
  // Find all SharesBurnt events between ETHDistributed and TokenRebased
  const sharesBurntEvents = findAllEventsByName(allLogs, "SharesBurnt", event.logIndex, tokenRebasedEvent.logIndex);

  for (const sharesBurntEvent of sharesBurntEvents) {
    handleSharesBurnt(sharesBurntEvent, store);
  }

  // Step 3: Update totalShares for next mint transfers
  // Reference: lido-subgraph/src/Lido.ts lines 537-540
  totals.totalShares = postTotalShares;
  saveTotals(store, totals);

  // ========== Non-Profitable Report Check (LIP-12) ==========
  // Reference: lido-subgraph/src/Lido.ts lines 542-551
  // Don't mint/distribute any protocol fee on non-profitable oracle report
  // when consensus layer balance delta is zero or negative
  const postCLTotalBalance = postCLBalance + withdrawalsWithdrawn;
  if (postCLTotalBalance <= preCLBalance) {
    // Note: Totals are still updated even for non-profitable reports!
    return {
      totalReward: null,
      isProfitable: false,
      totals,
      warnings,
    };
  }

  // ========== Create TotalReward Entity ==========
  // Reference: lido-subgraph/src/Lido.ts lines 553-570

  // Calculate total rewards with fees (same as real graph lines 553-556)
  // totalRewardsWithFees = (postCLBalance + withdrawalsWithdrawn - preCLBalance) + executionLayerRewardsWithdrawn
  const totalRewardsWithFees = postCLTotalBalance - preCLBalance + executionLayerRewardsWithdrawn;

  // Create TotalReward entity
  // Reference: lido-subgraph/src/helpers.ts _loadTotalRewardEntity()
  const entity = createTotalRewardEntity(ctx.transactionHash);

  // Tier 1 - Direct Event Metadata
  entity.block = ctx.blockNumber;
  entity.blockTime = ctx.blockTimestamp;
  entity.transactionHash = ctx.transactionHash;
  entity.transactionIndex = BigInt(ctx.transactionIndex);
  entity.logIndex = BigInt(event.logIndex);

  // Tier 2 - MEV fee from ETHDistributed
  entity.mevFee = executionLayerRewardsWithdrawn;

  // Tier 2 - Total rewards with fees
  // Reference: lido-subgraph/src/Lido.ts lines 559-561
  // In real graph: totalRewardsEntity.totalRewards = totalRewards (initially same as totalRewardsWithFees)
  //               totalRewardsEntity.totalRewardsWithFees = totalRewardsEntity.totalRewards
  entity.totalRewardsWithFees = totalRewardsWithFees;

  // Process TokenRebased to fill in pool state and fee distribution
  // This will also set entity.totalRewards = totalRewardsWithFees - totalFee
  // Also creates NodeOperatorFees and NodeOperatorsShares entities for each staking module
  const rebaseWarnings = _processTokenRebase(
    entity,
    tokenRebasedEvent,
    allLogs,
    event.logIndex,
    ctx.treasuryAddress,
    store,
    sharesMintedAsFees,
  );
  warnings.push(...rebaseWarnings);

  // Save entity
  saveTotalReward(store, entity);

  return {
    totalReward: entity,
    isProfitable: true,
    totals,
    warnings,
  };
}

/**
 * Handle SharesBurnt event - updates Totals when shares are burnt during withdrawal finalization
 *
 * This is called from handleETHDistributed when SharesBurnt events are found
 * between ETHDistributed and TokenRebased events.
 *
 * Reference: lido-subgraph/src/Lido.ts handleSharesBurnt() lines 444-476
 *
 * @param event - The SharesBurnt event
 * @param store - Entity store
 * @returns Result containing the burnt shares details and updated Totals
 */
export function handleSharesBurnt(event: LogDescriptionWithMeta, store: EntityStore): SharesBurntResult {
  // Extract SharesBurnt event params
  // event SharesBurnt(address indexed account, uint256 preRebaseTokenAmount, uint256 postRebaseTokenAmount, uint256 sharesAmount)
  const account = getEventArg<string>(event, "account");
  const preRebaseTokenAmount = getEventArg<bigint>(event, "preRebaseTokenAmount");
  const postRebaseTokenAmount = getEventArg<bigint>(event, "postRebaseTokenAmount");
  const sharesAmount = getEventArg<bigint>(event, "sharesAmount");

  // Load Totals entity
  const totals = loadTotalsEntity(store, true)!;

  // Update totalShares by subtracting burnt shares
  // Reference: lido-subgraph/src/Lido.ts lines 460-463
  totals.totalShares = totals.totalShares - sharesAmount;
  saveTotals(store, totals);

  return {
    sharesBurnt: sharesAmount,
    account,
    preRebaseTokenAmount,
    postRebaseTokenAmount,
    totals,
  };
}

/**
 * Check if an event is a SharesBurnt event
 *
 * @param event - The event to check
 * @returns true if this is a SharesBurnt event
 */
export function isSharesBurntEvent(event: LogDescriptionWithMeta): boolean {
  return event.name === "SharesBurnt";
}

/**
 * Process TokenRebased event to extract pool state fields, fee distribution, and calculate APR
 *
 * This is called from handleETHDistributed after look-ahead finds the event.
 *
 * Reference: lido-subgraph/src/Lido.ts _processTokenRebase() lines 573-690
 *
 * @param entity - TotalReward entity to populate
 * @param tokenRebasedEvent - The TokenRebased event
 * @param allLogs - All parsed logs from the transaction (for Transfer/TransferShares extraction)
 * @param ethDistributedLogIndex - Log index of the ETHDistributed event
 * @param treasuryAddress - Treasury address for fee categorization
 * @param store - Entity store for creating per-module fee entities
 * @param sharesMintedAsFees - Expected shares minted as fees from TokenRebased (for validation)
 * @returns Array of validation warnings encountered during processing
 */
export function _processTokenRebase(
  entity: TotalRewardEntity,
  tokenRebasedEvent: LogDescriptionWithMeta,
  allLogs: LogDescriptionWithMeta[],
  ethDistributedLogIndex: number,
  treasuryAddress: string,
  store: EntityStore,
  sharesMintedAsFees?: bigint,
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  // Extract TokenRebased event params
  // event TokenRebased(
  //   uint256 indexed reportTimestamp,
  //   uint256 timeElapsed,
  //   uint256 preTotalShares,
  //   uint256 preTotalEther,
  //   uint256 postTotalShares,
  //   uint256 postTotalEther,
  //   uint256 sharesMintedAsFees
  // )

  const preTotalEther = getEventArg<bigint>(tokenRebasedEvent, "preTotalEther");
  const postTotalEther = getEventArg<bigint>(tokenRebasedEvent, "postTotalEther");
  const preTotalShares = getEventArg<bigint>(tokenRebasedEvent, "preTotalShares");
  const postTotalShares = getEventArg<bigint>(tokenRebasedEvent, "postTotalShares");
  const sharesMintedAsFeesFromEvent = getEventArg<bigint>(tokenRebasedEvent, "sharesMintedAsFees");
  const timeElapsed = getEventArg<bigint>(tokenRebasedEvent, "timeElapsed");

  // Tier 2 - Pool State
  entity.totalPooledEtherBefore = preTotalEther;
  entity.totalPooledEtherAfter = postTotalEther;
  entity.totalSharesBefore = preTotalShares;
  entity.totalSharesAfter = postTotalShares;
  entity.shares2mint = sharesMintedAsFeesFromEvent;
  entity.timeElapsed = timeElapsed;

  // ========== Fee Distribution Tracking ==========
  // Reference: lido-subgraph/src/Lido.ts lines 586-662

  // Extract Transfer/TransferShares pairs between ETHDistributed and TokenRebased
  const transferPairs = findTransferSharesPairs(allLogs, ethDistributedLogIndex, tokenRebasedEvent.logIndex);

  // Process mint events and categorize by destination
  let sharesToTreasury = 0n;
  let sharesToOperators = 0n;
  let treasuryFee = 0n;
  let operatorsFee = 0n;

  const treasuryAddressLower = treasuryAddress.toLowerCase();

  // Track per-module fee distribution entities
  const nodeOperatorFeesIds: string[] = [];
  const nodeOperatorsSharesIds: string[] = [];

  for (const pair of transferPairs) {
    // Only process mint events (from = ZERO_ADDRESS)
    if (pair.transfer.from.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      if (pair.transfer.to.toLowerCase() === treasuryAddressLower) {
        // Mint to treasury
        sharesToTreasury += pair.transferShares.sharesValue;
        treasuryFee += pair.transfer.value;
      } else {
        // Mint to staking router module (operators)
        sharesToOperators += pair.transferShares.sharesValue;
        operatorsFee += pair.transfer.value;

        // Create NodeOperatorFees entity for this module
        const nodeOpFeesId = makeNodeOperatorFeesId(entity.transactionHash, pair.transfer.logIndex);
        const nodeOpFeesEntity = loadNodeOperatorFeesEntity(store, nodeOpFeesId, true)!;
        nodeOpFeesEntity.totalRewardId = entity.id;
        nodeOpFeesEntity.address = pair.transfer.to.toLowerCase();
        nodeOpFeesEntity.fee = pair.transfer.value;
        saveNodeOperatorFees(store, nodeOpFeesEntity);
        nodeOperatorFeesIds.push(nodeOpFeesId);

        // Create NodeOperatorsShares entity for this module
        const nodeOpSharesId = makeNodeOperatorsSharesId(entity.transactionHash, pair.transfer.to);
        const nodeOpSharesEntity = loadNodeOperatorsSharesEntity(store, nodeOpSharesId, true)!;
        nodeOpSharesEntity.totalRewardId = entity.id;
        nodeOpSharesEntity.address = pair.transfer.to.toLowerCase();
        nodeOpSharesEntity.shares = pair.transferShares.sharesValue;
        saveNodeOperatorsShares(store, nodeOpSharesEntity);
        nodeOperatorsSharesIds.push(nodeOpSharesId);
      }
    }
  }

  // Set fee distribution fields
  entity.sharesToTreasury = sharesToTreasury;
  entity.sharesToOperators = sharesToOperators;
  entity.treasuryFee = treasuryFee;
  entity.operatorsFee = operatorsFee;
  entity.totalFee = treasuryFee + operatorsFee;
  entity.totalRewards = entity.totalRewardsWithFees - entity.totalFee;

  // Set per-module fee distribution references
  entity.nodeOperatorFeesIds = nodeOperatorFeesIds;
  entity.nodeOperatorsSharesIds = nodeOperatorsSharesIds;

  // ========== shares2mint Validation (Sanity Check) ==========
  // Reference: lido-subgraph/src/Lido.ts lines 664-667
  // In the real graph, there's a critical log if shares2mint != sharesToTreasury + sharesToOperators
  const totalSharesMinted = sharesToTreasury + sharesToOperators;
  if (sharesMintedAsFeesFromEvent !== totalSharesMinted) {
    warnings.push({
      type: "shares2mint_mismatch",
      message:
        `shares2mint mismatch: TokenRebased.sharesMintedAsFees (${sharesMintedAsFeesFromEvent}) != ` +
        `sharesToTreasury + sharesToOperators (${totalSharesMinted})`,
      expected: sharesMintedAsFeesFromEvent,
      actual: totalSharesMinted,
    });
  }

  // Also validate against the passed sharesMintedAsFees if provided
  if (sharesMintedAsFees !== undefined && sharesMintedAsFees !== sharesMintedAsFeesFromEvent) {
    warnings.push({
      type: "shares2mint_mismatch",
      message: `shares2mint event param inconsistency: passed ${sharesMintedAsFees} vs event ${sharesMintedAsFeesFromEvent}`,
      expected: sharesMintedAsFees,
      actual: sharesMintedAsFeesFromEvent,
    });
  }

  // ========== Calculate Basis Points ==========
  // Reference: lido-subgraph/src/Lido.ts lines 669-677

  // feeBasis = totalFee * 10000 / totalRewardsWithFees
  entity.feeBasis =
    entity.totalRewardsWithFees > 0n ? (entity.totalFee * CALCULATION_UNIT) / entity.totalRewardsWithFees : 0n;

  // treasuryFeeBasisPoints = treasuryFee * 10000 / totalFee
  entity.treasuryFeeBasisPoints = entity.totalFee > 0n ? (treasuryFee * CALCULATION_UNIT) / entity.totalFee : 0n;

  // operatorsFeeBasisPoints = operatorsFee * 10000 / totalFee
  entity.operatorsFeeBasisPoints = entity.totalFee > 0n ? (operatorsFee * CALCULATION_UNIT) / entity.totalFee : 0n;

  // ========== Calculate APR ==========
  // Reference: lido-subgraph/src/helpers.ts _calcAPR_v2()
  entity.apr = calcAPR_v2(preTotalEther, postTotalEther, preTotalShares, postTotalShares, timeElapsed);

  // In v2, aprRaw and aprBeforeFees are the same as apr
  entity.aprRaw = entity.apr;
  entity.aprBeforeFees = entity.apr;

  return warnings;
}

/**
 * Check if an event is an ETHDistributed event
 *
 * @param event - The event to check
 * @returns true if this is an ETHDistributed event
 */
export function isETHDistributedEvent(event: LogDescriptionWithMeta): boolean {
  return event.name === "ETHDistributed";
}

// ============================================================================
// Submitted Event Handler
// ============================================================================

/**
 * Result of processing a Submitted event
 */
export interface SubmittedResult {
  /** The created LidoSubmission entity */
  submission: LidoSubmissionEntity;

  /** The created LidoTransfer entity (mint transfer) */
  transfer: LidoTransferEntity;

  /** The updated Totals entity */
  totals: TotalsEntity;
}

/**
 * Handle Submitted event - creates LidoSubmission entity and updates Totals/Shares
 *
 * Reference: lido-subgraph/src/Lido.ts handleSubmitted() lines 72-164
 *
 * @param event - The Submitted event
 * @param allLogs - All parsed logs from the transaction (for TransferShares look-ahead)
 * @param store - Entity store
 * @param ctx - Handler context with transaction metadata
 * @returns Result containing the created entities and updated state
 */
export function handleSubmitted(
  event: LogDescriptionWithMeta,
  allLogs: LogDescriptionWithMeta[],
  store: EntityStore,
  ctx: HandlerContext,
): SubmittedResult {
  // Extract Submitted event params
  // event Submitted(address indexed sender, uint256 amount, address referral)
  const sender = getEventArg<string>(event, "sender");
  const amount = getEventArg<bigint>(event, "amount");
  const referral = getEventArg<string>(event, "referral");

  // Find the paired TransferShares event to get the shares value (V2+: always present)
  // The TransferShares event comes right after the Transfer event which follows Submitted
  const transferSharesEvent = findEventByName(allLogs, "TransferShares", event.logIndex);
  if (!transferSharesEvent) {
    throw new Error(`TransferShares event not found after Submitted in tx ${ctx.transactionHash}`);
  }
  const shares = getEventArg<bigint>(transferSharesEvent, "sharesValue");

  // Load Totals entity and capture state before update
  const totals = loadTotalsEntity(store, true)!;
  const totalPooledEtherBefore = totals.totalPooledEther;
  const totalSharesBefore = totals.totalShares;

  // Update Totals with the new submission
  totals.totalPooledEther = totals.totalPooledEther + amount;
  totals.totalShares = totals.totalShares + shares;
  saveTotals(store, totals);

  // Load/create Shares entity for sender
  const sharesEntity = loadSharesEntity(store, sender, true)!;
  const sharesBefore = sharesEntity.shares;
  sharesEntity.shares = sharesEntity.shares + shares;
  const sharesAfter = sharesEntity.shares;
  saveShares(store, sharesEntity);

  // Calculate balance after submission
  const balanceAfter = totals.totalShares > 0n ? (sharesAfter * totals.totalPooledEther) / totals.totalShares : 0n;

  // Create LidoSubmission entity
  const submissionId = makeLidoSubmissionId(ctx.transactionHash, event.logIndex);
  const submission = loadLidoSubmissionEntity(store, submissionId, true)!;

  submission.sender = sender.toLowerCase();
  submission.amount = amount;
  submission.referral = referral.toLowerCase();
  submission.shares = shares;
  submission.sharesBefore = sharesBefore;
  submission.sharesAfter = sharesAfter;
  submission.totalPooledEtherBefore = totalPooledEtherBefore;
  submission.totalPooledEtherAfter = totals.totalPooledEther;
  submission.totalSharesBefore = totalSharesBefore;
  submission.totalSharesAfter = totals.totalShares;
  submission.balanceAfter = balanceAfter;
  submission.block = ctx.blockNumber;
  submission.blockTime = ctx.blockTimestamp;
  submission.transactionHash = ctx.transactionHash;
  submission.transactionIndex = BigInt(ctx.transactionIndex);
  submission.logIndex = BigInt(event.logIndex);

  saveLidoSubmission(store, submission);

  // Create the mint transfer entity (handled by handleTransfer, but we create it here for completeness)
  // Find the Transfer event that comes after Submitted
  const transferEvent = findEventByName(allLogs, "Transfer", event.logIndex);
  let transfer: LidoTransferEntity;

  if (transferEvent) {
    transfer = _createTransferEntity(
      transferEvent,
      allLogs,
      store,
      ctx,
      totals.totalPooledEther,
      totals.totalShares,
      true, // Skip shares update since we already did it above
    );
  } else {
    // Fallback: create a minimal transfer entity
    const transferId = makeLidoTransferId(ctx.transactionHash, event.logIndex);
    transfer = loadLidoTransferEntity(store, transferId, true)!;
    transfer.from = ZERO_ADDRESS;
    transfer.to = sender.toLowerCase();
    transfer.value = amount;
    transfer.shares = shares;
    transfer.totalPooledEther = totals.totalPooledEther;
    transfer.totalShares = totals.totalShares;
    transfer.block = ctx.blockNumber;
    transfer.blockTime = ctx.blockTimestamp;
    transfer.transactionHash = ctx.transactionHash;
    transfer.transactionIndex = BigInt(ctx.transactionIndex);
    transfer.logIndex = BigInt(event.logIndex);
    saveLidoTransfer(store, transfer);
  }

  return {
    submission,
    transfer,
    totals,
  };
}

/**
 * Check if an event is a Submitted event
 *
 * @param event - The event to check
 * @returns true if this is a Submitted event
 */
export function isSubmittedEvent(event: LogDescriptionWithMeta): boolean {
  return event.name === "Submitted";
}

// ============================================================================
// Transfer Event Handler
// ============================================================================

/**
 * Result of processing a Transfer event
 */
export interface TransferResult {
  /** The created LidoTransfer entity */
  transfer: LidoTransferEntity;

  /** Whether this was a mint transfer (from = 0x0) */
  isMint: boolean;

  /** Whether this was a burn transfer (to = 0x0) */
  isBurn: boolean;
}

/**
 * Handle Transfer event - creates LidoTransfer entity and updates Shares
 *
 * Reference: lido-subgraph/src/Lido.ts handleTransfer() lines 166-373
 *
 * @param event - The Transfer event
 * @param allLogs - All parsed logs from the transaction (for TransferShares look-ahead)
 * @param store - Entity store
 * @param ctx - Handler context with transaction metadata
 * @param skipSharesUpdate - Skip shares update if already handled by caller (e.g., Submitted handler)
 * @returns Result containing the created entity
 */
export function handleTransfer(
  event: LogDescriptionWithMeta,
  allLogs: LogDescriptionWithMeta[],
  store: EntityStore,
  ctx: HandlerContext,
  skipSharesUpdate: boolean = false,
): TransferResult {
  // Load current Totals state
  const totals = loadTotalsEntity(store, true)!;

  const transfer = _createTransferEntity(
    event,
    allLogs,
    store,
    ctx,
    totals.totalPooledEther,
    totals.totalShares,
    skipSharesUpdate,
  );

  const from = transfer.from.toLowerCase();
  const to = transfer.to.toLowerCase();

  return {
    transfer,
    isMint: from === ZERO_ADDRESS.toLowerCase(),
    isBurn: to === ZERO_ADDRESS.toLowerCase(),
  };
}

/**
 * Internal helper to create a LidoTransfer entity
 *
 * @param event - The Transfer event
 * @param allLogs - All parsed logs from the transaction
 * @param store - Entity store
 * @param ctx - Handler context
 * @param totalPooledEther - Current total pooled ether
 * @param totalShares - Current total shares
 * @param skipSharesUpdate - Skip shares update if already handled
 * @returns The created LidoTransfer entity
 */
function _createTransferEntity(
  event: LogDescriptionWithMeta,
  allLogs: LogDescriptionWithMeta[],
  store: EntityStore,
  ctx: HandlerContext,
  totalPooledEther: bigint,
  totalShares: bigint,
  skipSharesUpdate: boolean,
): LidoTransferEntity {
  // Extract Transfer event params
  // event Transfer(address indexed from, address indexed to, uint256 value)
  const from = getEventArg<string>(event, "from");
  const to = getEventArg<string>(event, "to");
  const value = getEventArg<bigint>(event, "value");

  // Find the paired TransferShares event (V2+: always present, comes right after Transfer)
  // Reference: lido-subgraph/src/Lido.ts lines 178-196
  const transferSharesEvent = findEventByName(allLogs, "TransferShares", event.logIndex);
  const shares = transferSharesEvent ? getEventArg<bigint>(transferSharesEvent, "sharesValue") : 0n;

  // Create LidoTransfer entity
  const transferId = makeLidoTransferId(ctx.transactionHash, event.logIndex);
  const transfer = loadLidoTransferEntity(store, transferId, true)!;

  transfer.from = from.toLowerCase();
  transfer.to = to.toLowerCase();
  transfer.value = value;
  transfer.shares = shares;
  transfer.totalPooledEther = totalPooledEther;
  transfer.totalShares = totalShares;
  transfer.block = ctx.blockNumber;
  transfer.blockTime = ctx.blockTimestamp;
  transfer.transactionHash = ctx.transactionHash;
  transfer.transactionIndex = BigInt(ctx.transactionIndex);
  transfer.logIndex = BigInt(event.logIndex);

  // Update shares and track before/after balances
  // Reference: lido-subgraph/src/helpers.ts _updateTransferShares() lines 197-238
  if (!skipSharesUpdate) {
    _updateTransferShares(transfer, store);
  } else {
    // Just capture current state without updating
    const fromShares = loadSharesEntity(store, from, false);
    const toShares = loadSharesEntity(store, to, false);
    if (fromShares) {
      transfer.sharesBeforeDecrease = fromShares.shares;
      transfer.sharesAfterDecrease = fromShares.shares;
    }
    if (toShares) {
      transfer.sharesBeforeIncrease = toShares.shares;
      transfer.sharesAfterIncrease = toShares.shares;
    }
  }

  // Calculate balances after transfer
  // Reference: lido-subgraph/src/helpers.ts _updateTransferBalances() lines 183-195
  _updateTransferBalances(transfer);

  saveLidoTransfer(store, transfer);

  return transfer;
}

/**
 * Update shares for from/to addresses based on transfer
 *
 * Reference: lido-subgraph/src/helpers.ts _updateTransferShares() lines 197-238
 *
 * @param entity - The LidoTransfer entity to update
 * @param store - Entity store
 */
function _updateTransferShares(entity: LidoTransferEntity, store: EntityStore): void {
  const fromLower = entity.from.toLowerCase();
  const toLower = entity.to.toLowerCase();
  const zeroLower = ZERO_ADDRESS.toLowerCase();

  // Decreasing from address shares (skip if from is zero address - mint)
  if (fromLower !== zeroLower) {
    const sharesFromEntity = loadSharesEntity(store, entity.from, true)!;
    entity.sharesBeforeDecrease = sharesFromEntity.shares;

    if (fromLower !== toLower && entity.shares > 0n) {
      sharesFromEntity.shares = sharesFromEntity.shares - entity.shares;
      saveShares(store, sharesFromEntity);
    }
    entity.sharesAfterDecrease = sharesFromEntity.shares;
  }

  // Increasing to address shares (skip if to is zero address - burn)
  if (toLower !== zeroLower) {
    const sharesToEntity = loadSharesEntity(store, entity.to, true)!;
    entity.sharesBeforeIncrease = sharesToEntity.shares;

    if (toLower !== fromLower && entity.shares > 0n) {
      sharesToEntity.shares = sharesToEntity.shares + entity.shares;
      saveShares(store, sharesToEntity);
    }
    entity.sharesAfterIncrease = sharesToEntity.shares;
  }
}

/**
 * Calculate balances after transfer based on current totals
 *
 * Reference: lido-subgraph/src/helpers.ts _updateTransferBalances() lines 183-195
 *
 * @param entity - The LidoTransfer entity to update
 */
function _updateTransferBalances(entity: LidoTransferEntity): void {
  if (entity.totalShares === 0n) {
    entity.balanceAfterIncrease = entity.value;
    entity.balanceAfterDecrease = 0n;
  } else {
    entity.balanceAfterIncrease = (entity.sharesAfterIncrease * entity.totalPooledEther) / entity.totalShares;
    entity.balanceAfterDecrease = (entity.sharesAfterDecrease * entity.totalPooledEther) / entity.totalShares;
  }
}

/**
 * Check if an event is a Transfer event
 *
 * @param event - The event to check
 * @returns true if this is a Transfer event
 */
export function isTransferEvent(event: LogDescriptionWithMeta): boolean {
  return event.name === "Transfer";
}

// ============================================================================
// SharesBurn Entity Creation (Enhanced)
// ============================================================================

/**
 * Enhanced result of processing a SharesBurnt event with entity
 */
export interface SharesBurntWithEntityResult extends SharesBurntResult {
  /** The created SharesBurn entity */
  entity: SharesBurnEntity;

  /** The created burn transfer entity */
  transfer: LidoTransferEntity;
}

/**
 * Handle SharesBurnt event with entity creation
 *
 * This extends handleSharesBurnt to also create the SharesBurn entity.
 *
 * Reference: lido-subgraph/src/Lido.ts handleSharesBurnt() lines 375-471
 *
 * @param event - The SharesBurnt event
 * @param allLogs - All logs (for potential paired events)
 * @param store - Entity store
 * @param ctx - Handler context
 * @returns Result containing the entity and updated state
 */
export function handleSharesBurntWithEntity(
  event: LogDescriptionWithMeta,
  allLogs: LogDescriptionWithMeta[],
  store: EntityStore,
  ctx: HandlerContext,
): SharesBurntWithEntityResult {
  // Extract SharesBurnt event params
  const account = getEventArg<string>(event, "account");
  const preRebaseTokenAmount = getEventArg<bigint>(event, "preRebaseTokenAmount");
  const postRebaseTokenAmount = getEventArg<bigint>(event, "postRebaseTokenAmount");
  const sharesAmount = getEventArg<bigint>(event, "sharesAmount");

  // Create SharesBurn entity
  const entityId = makeSharesBurnId(ctx.transactionHash, event.logIndex);
  const entity = loadSharesBurnEntity(store, entityId, true)!;

  entity.account = account.toLowerCase();
  entity.preRebaseTokenAmount = preRebaseTokenAmount;
  entity.postRebaseTokenAmount = postRebaseTokenAmount;
  entity.sharesAmount = sharesAmount;

  saveSharesBurn(store, entity);

  // Update Totals
  const totals = loadTotalsEntity(store, true)!;
  totals.totalShares = totals.totalShares - sharesAmount;
  saveTotals(store, totals);

  // Update account shares
  const accountShares = loadSharesEntity(store, account, true)!;
  const sharesBeforeDecrease = accountShares.shares;
  accountShares.shares = accountShares.shares - sharesAmount;
  saveShares(store, accountShares);

  // Create burn transfer entity (from account to 0x0)
  const transferId = makeLidoTransferId(ctx.transactionHash, event.logIndex);
  const transfer = loadLidoTransferEntity(store, transferId, true)!;

  transfer.from = account.toLowerCase();
  transfer.to = ZERO_ADDRESS;
  transfer.value = postRebaseTokenAmount;
  transfer.shares = sharesAmount;
  transfer.sharesBeforeDecrease = sharesBeforeDecrease;
  transfer.sharesAfterDecrease = accountShares.shares;
  transfer.sharesBeforeIncrease = 0n;
  transfer.sharesAfterIncrease = 0n;
  transfer.totalPooledEther = totals.totalPooledEther;
  transfer.totalShares = totals.totalShares;
  transfer.block = ctx.blockNumber;
  transfer.blockTime = ctx.blockTimestamp;
  transfer.transactionHash = ctx.transactionHash;
  transfer.transactionIndex = BigInt(ctx.transactionIndex);
  transfer.logIndex = BigInt(event.logIndex);

  _updateTransferBalances(transfer);
  saveLidoTransfer(store, transfer);

  return {
    sharesBurnt: sharesAmount,
    account: account.toLowerCase(),
    preRebaseTokenAmount,
    postRebaseTokenAmount,
    totals,
    entity,
    transfer,
  };
}

// ============================================================================
// V3 VaultHub Event Handlers
// ============================================================================

/**
 * Result of processing an ExternalSharesMinted event
 */
export interface ExternalSharesMintedResult {
  /** Amount of shares minted */
  amountOfShares: bigint;

  /** Receiver address */
  receiver: string;

  /** The updated Totals entity */
  totals: TotalsEntity;
}

/**
 * Handle ExternalSharesMinted event (V3) - updates Totals when VaultHub mints external shares
 *
 * IMPORTANT: This handler only updates Totals (totalShares and totalPooledEther).
 * The per-address Shares entity is updated by the accompanying Transfer event
 * (from 0x0 to receiver) which is handled by handleTransfer. This avoids double-counting.
 *
 * Reference: lido-subgraph/src/LidoV3.ts handleExternalSharesMinted() lines 8-16
 *
 * @param event - The ExternalSharesMinted event
 * @param store - Entity store
 * @param ctx - Handler context
 * @param protocolContext - Protocol context for contract reads
 * @returns Result containing updated state
 */
export async function handleExternalSharesMinted(
  event: LogDescriptionWithMeta,
  store: EntityStore,
  ctx: HandlerContext,
  protocolContext: ProtocolContext,
): Promise<ExternalSharesMintedResult> {
  // Extract ExternalSharesMinted event params
  // event ExternalSharesMinted(address indexed receiver, uint256 amountOfShares)
  const receiver = getEventArg<string>(event, "receiver");
  const amountOfShares = getEventArg<bigint>(event, "amountOfShares");

  // Load Totals entity
  const totals = loadTotalsEntity(store, true)!;

  // Update totalShares by adding minted shares
  totals.totalShares = totals.totalShares + amountOfShares;

  // Read totalPooledEther from contract (as done in real subgraph)
  const totalPooledEther = await protocolContext.contracts.lido.getTotalPooledEther();
  totals.totalPooledEther = totalPooledEther;

  saveTotals(store, totals);

  // NOTE: Do NOT update receiver's Shares here!
  // The accompanying Transfer(0x0 -> receiver) event will be processed by handleTransfer
  // which correctly updates the per-address Shares entity. Updating here would double-count.

  return {
    amountOfShares,
    receiver: receiver.toLowerCase(),
    totals,
  };
}

/**
 * Check if an event is an ExternalSharesMinted event
 *
 * @param event - The event to check
 * @returns true if this is an ExternalSharesMinted event
 */
export function isExternalSharesMintedEvent(event: LogDescriptionWithMeta): boolean {
  return event.name === "ExternalSharesMinted";
}

/**
 * Result of processing an ExternalSharesBurnt event
 */
export interface ExternalSharesBurntResult {
  /** Amount of shares burnt */
  amountOfShares: bigint;

  /** The updated Totals entity */
  totals: TotalsEntity;
}

/**
 * Handle ExternalSharesBurnt event (V3) - updates Totals when external shares are burnt
 *
 * Note: totalShares is not directly updated here as it's handled by the SharesBurnt event.
 * This handler only updates totalPooledEther from contract.
 *
 * Reference: lido-subgraph/src/LidoV3.ts handleExternalSharesBurnt() lines 18-24
 *
 * @param event - The ExternalSharesBurnt event
 * @param store - Entity store
 * @param ctx - Handler context
 * @param protocolContext - Protocol context for contract reads
 * @returns Result containing updated state
 */
export async function handleExternalSharesBurnt(
  event: LogDescriptionWithMeta,
  store: EntityStore,
  ctx: HandlerContext,
  protocolContext: ProtocolContext,
): Promise<ExternalSharesBurntResult> {
  // Extract ExternalSharesBurnt event params
  // event ExternalSharesBurnt(uint256 amountOfShares)
  const amountOfShares = getEventArg<bigint>(event, "amountOfShares");

  // Load Totals entity
  const totals = loadTotalsEntity(store, true)!;

  // Read totalPooledEther from contract (as done in real subgraph)
  const totalPooledEther = await protocolContext.contracts.lido.getTotalPooledEther();
  totals.totalPooledEther = totalPooledEther;

  saveTotals(store, totals);

  return {
    amountOfShares,
    totals,
  };
}

/**
 * Check if an event is an ExternalSharesBurnt event
 *
 * @param event - The event to check
 * @returns true if this is an ExternalSharesBurnt event
 */
export function isExternalSharesBurntEvent(event: LogDescriptionWithMeta): boolean {
  return event.name === "ExternalSharesBurnt";
}
