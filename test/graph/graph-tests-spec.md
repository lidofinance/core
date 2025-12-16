# Graph Indexer Integration Tests Specification

## Purpose

Develop integration tests in the lido-core repository that verify correctness of the Graph indexer logic when processing events from various operations after the V3 upgrade.

The Graph indexer reconstructs on-chain state and computes derived values (entities) based solely on events emitted within transactions. These tests validate that a TypeScript simulator produces identical results to the actual Graph indexer.

## Limitations

### Historical Data

The actual Graph works since the Lido contracts genesis, but this requires long indexing of prior state. For these tests, we:

- Skip historical sync
- Initialize simulator state from current chain state at test start
- Only test V3 (post-V2) code paths

### OracleCompleted History

The legacy `OracleCompleted` entity tracking is skipped since V3 uses `TokenRebased.timeElapsed` directly.

### Legacy V1 Fields

The following fields exist in the real Graph schema but are **intentionally omitted** from the simulator as they are legacy V1 fields not used in V2+ oracle reports:

| Field                     | Purpose                          | Why Omitted                 |
| ------------------------- | -------------------------------- | --------------------------- |
| `insuranceFee`            | ETH minted to insurance fund     | No insurance fund since V2  |
| `insuranceFeeBasisPoints` | Insurance fee as basis points    | No insurance fund since V2  |
| `sharesToInsuranceFund`   | Shares minted to insurance fund  | No insurance fund since V2  |
| `dust`                    | Rounding dust ETH to treasury    | V2 handles dust differently |
| `dustSharesToTreasury`    | Rounding dust shares to treasury | V2 handles dust differently |

These fields are initialized to zero in the real Graph but never populated for V2+ reports.

**Note:** The `TotalRewardEntity` interface in `entities.ts` documents these omissions inline for developer reference.

---

## Architecture

### Location

Standalone module in `test/graph/` importable by integration tests.

### Language & Types

- TypeScript implementation mimicking Graph handler logic
- Native `bigint` for all numeric values (no precision loss, exact matching)
- Custom entity type definitions matching Graph schema

### File Structure

```
test/graph/
├── graph-tests-spec.md              # This specification
├── index.ts                         # Re-exports for external use
├── simulator/
│   ├── index.ts                     # Main entry point, GraphSimulator class, processTransaction()
│   ├── entities.ts                  # Entity type definitions (TotalRewardEntity, TotalsEntity)
│   ├── store.ts                     # In-memory entity store with Totals tracking
│   ├── query.ts                     # Query methods (filtering, pagination, ordering)
│   ├── handlers/
│   │   ├── lido.ts                  # handleETHDistributed, handleSharesBurnt, _processTokenRebase
│   │   └── index.ts                 # Handler registry, processTransactionEvents()
│   └── helpers.ts                   # APR calculation (calcAPR_v2), basis point utilities
├── utils/
│   ├── index.ts                     # Re-exports
│   ├── state-capture.ts             # captureChainState(), capturePoolState()
│   └── event-extraction.ts          # extractAllLogs(), findTransferSharesPairs()
├── total-reward.integration.ts      # Integration test for TotalReward entity
└── edge-cases.integration.ts        # Edge case tests (zero rewards, division by zero, etc.)
```

The simulator structure mirrors `lido-subgraph/src/` where practical.

---

## Simulator Design

### Initial State

The simulator requires initial state captured from on-chain before processing events:

```typescript
interface SimulatorInitialState {
  // Pool state (from Totals entity equivalent)
  totalPooledEther: bigint;
  totalShares: bigint;

  // Address configuration for fee categorization
  treasuryAddress: string;
  stakingModuleAddresses: string[]; // From StakingRouter.getStakingModules()
}
```

State is captured via contract calls at test start (or test suite start for Scenario tests).

### Entity Store

In-memory store mimicking Graph's database:

```typescript
interface EntityStore {
  /** Totals singleton entity (pool state) */
  totals: TotalsEntity | null;

  /** TotalReward entities keyed by transaction hash */
  totalRewards: Map<string, TotalRewardEntity>;

  // Future: other entities (NodeOperatorFees, OracleReport, etc.)
}
```

### Totals State Tracking

The `TotalsEntity` tracks cumulative pool state across transactions:

```typescript
interface TotalsEntity {
  id: string; // Singleton ID (always "")
  totalPooledEther: bigint;
  totalShares: bigint;
}
```

**Key Behaviors:**

- Updated during every `handleETHDistributed` call (even for non-profitable reports)
- Updated when `SharesBurnt` events are processed (withdrawal finalization)
- Validated against event params to detect state inconsistencies

### Transaction Processing

```typescript
interface ProcessTransactionResult {
  /** TotalReward entities created/updated (keyed by tx hash) */
  totalRewards: Map<string, TotalRewardEntity>;
  /** Number of events processed */
  eventsProcessed: number;
  /** Whether any profitable oracle report was found */
  hadProfitableReport: boolean;
  /** Whether Totals entity was updated */
  totalsUpdated: boolean;
  /** The current state of the Totals entity after processing */
  totals: TotalsEntity | null;
  /** SharesBurnt events processed during withdrawal finalization */
  sharesBurnt: SharesBurntResult[];
  /** Validation warnings from sanity checks */
  warnings: ValidationWarning[];
}

function processTransaction(
  receipt: ContractTransactionReceipt,
  ctx: ProtocolContext,
  store: EntityStore,
  blockTimestamp?: bigint,
  treasuryAddress?: string,
): ProcessTransactionResult;
```

- Extracts and parses all logs from the transaction receipt
- Logs are processed in `logIndex` order
- Handlers can "look ahead" in the logs array (matches Graph behavior)
- Returns result with created entities, processing metadata, and validation warnings

### Event Extraction

Custom utilities in `utils/event-extraction.ts`:

- `extractAllLogs()` - Parse all logs from receipt using protocol interfaces
- `findEventByName()` - Find event by name with optional start index (for look-ahead)
- `findAllEventsByName()` - Find all events by name within a range
- `findTransferSharesPairs()` - Extract paired Transfer/TransferShares events in range
- `getEventArg<T>()` - Type-safe event argument extraction

---

## Validation and Sanity Checks

### shares2mint Validation

The simulator validates that `TokenRebased.sharesMintedAsFees` equals the sum of shares actually minted to treasury and operators:

```typescript
const totalSharesMinted = sharesToTreasury + sharesToOperators;
if (sharesMintedAsFees !== totalSharesMinted) {
  warnings.push({
    type: "shares2mint_mismatch",
    message: `shares2mint mismatch: expected ${sharesMintedAsFees}, got ${totalSharesMinted}`,
    expected: sharesMintedAsFees,
    actual: totalSharesMinted,
  });
}
```

**Reference:** lido-subgraph/src/Lido.ts lines 664-667

### Totals State Validation

When processing `ETHDistributed`, the simulator validates that the current `Totals` state matches the event's `preTotalEther` and `preTotalShares`:

```typescript
if (totals.totalPooledEther !== 0n && totals.totalPooledEther !== preTotalEther) {
  warnings.push({
    type: "totals_state_mismatch",
    message: `Totals.totalPooledEther mismatch`,
    expected: preTotalEther,
    actual: totals.totalPooledEther,
  });
}
```

This catches cases where the simulator state gets out of sync with the actual chain state.

### Validation Warning Types

```typescript
type ValidationWarningType =
  | "shares2mint_mismatch" // TokenRebased.sharesMintedAsFees != actual minted
  | "totals_state_mismatch"; // Totals state doesn't match event params
```

---

## SharesBurnt Handling

### Overview

When withdrawal finalization occurs during an oracle report, `SharesBurnt` events are emitted that reduce `totalShares`. The simulator now handles these events.

### Event Processing Order

```
1. ETHDistributed            ← Creates TotalReward, updates totalPooledEther
2. SharesBurnt (optional)    ← Burns shares during withdrawal finalization
3. Transfer (fee mints)      ← Mint shares to treasury/operators
4. TransferShares            ← Paired with Transfer
5. TokenRebased              ← Final pool state
```

### Handler Implementation

```typescript
function handleSharesBurnt(
  event: LogDescriptionWithMeta,
  store: EntityStore
): SharesBurntResult {
  const sharesAmount = getEventArg<bigint>(event, "sharesAmount");

  // Decrease totalShares
  totals.totalShares = totals.totalShares - sharesAmount;
  saveTotals(store, totals);

  return { sharesBurnt: sharesAmount, ... };
}
```

**Reference:** lido-subgraph/src/Lido.ts handleSharesBurnt() lines 444-476

### Integration with handleETHDistributed

`SharesBurnt` events between `ETHDistributed` and `TokenRebased` are automatically processed:

```typescript
// Step 2: Handle SharesBurnt if present (for withdrawal finalization)
const sharesBurntEvents = findAllEventsByName(allLogs, "SharesBurnt", event.logIndex, tokenRebasedEvent.logIndex);

for (const sharesBurntEvent of sharesBurntEvents) {
  handleSharesBurnt(sharesBurntEvent, store);
}
```

---

## Test Structure

### Scenario Tests

For Scenario tests (state persists across `it` blocks), initialize simulator at suite level:

```typescript
describe("Scenario: Graph TotalReward Validation", () => {
  let ctx: ProtocolContext;
  let simulator: GraphSimulator;
  let initialState: SimulatorInitialState;

  before(async () => {
    ctx = await getProtocolContext();
    initialState = await captureChainState(ctx);
    simulator = new GraphSimulator(initialState.treasuryAddress);

    // Initialize Totals with current chain state
    simulator.initializeTotals(initialState.totalPooledEther, initialState.totalShares);
  });

  it("Should compute TotalReward correctly for first oracle report", async () => {
    // 1. Capture state before
    const stateBefore = await capturePoolState(ctx);

    // 2. Execute oracle report
    const { reportTx } = await report(ctx, reportData);
    const receipt = await reportTx!.wait();
    const blockTimestamp = BigInt((await ethers.provider.getBlock(receipt.blockNumber))!.timestamp);

    // 3. Process through simulator
    const result = simulator.processTransaction(receipt, ctx, blockTimestamp);

    // 4. Check for validation warnings
    expect(result.warnings.length).to.equal(0);

    // 5. Verify entity fields
    const computed = result.totalRewards.get(receipt.hash);
    // ... verify all fields ...
  });
});
```

### Single Transaction Tests

For one-off tests, use `processTransaction()` with a fresh store:

```typescript
it("Should compute TotalReward correctly", async () => {
  const ctx = await getProtocolContext();
  const initialState = await captureChainState(ctx);
  const store = createEntityStore();

  // Execute transaction...
  const result = processTransaction(receipt, ctx, store, blockTimestamp, initialState.treasuryAddress);

  // Verify...
});
```

### Edge Case Tests

The `edge-cases.integration.ts` file tests:

1. **APR Calculation Edge Cases** (unit tests)

   - Zero time elapsed
   - Zero shares (pre/post)
   - Zero ether
   - Zero rate change
   - Very small values
   - Very large values (overflow protection)
   - Negative rate change (slashing)

2. **Non-Profitable Reports** (integration)

   - Zero CL rewards
   - Negative CL diff (slashing)

3. **Totals State Validation** (integration)

   - Multi-transaction consistency
   - Mismatch detection

4. **shares2mint Validation** (integration)

   - Verify minted shares match event param

5. **Very Small Rewards** (integration)
   - 1 wei rewards
   - APR precision with tiny amounts

---

## TotalReward Entity Fields

### Implemented Fields

#### Tier 1 - Direct Event Metadata ✅

| Field              | Source                    | Verification        | Status |
| ------------------ | ------------------------- | ------------------- | ------ |
| `id`               | `tx.hash`                 | Direct from receipt | ✅     |
| `block`            | `event.block.number`      | Direct from receipt | ✅     |
| `blockTime`        | `event.block.timestamp`   | Direct from receipt | ✅     |
| `transactionHash`  | `event.transaction.hash`  | Direct from receipt | ✅     |
| `transactionIndex` | `event.transaction.index` | Direct from receipt | ✅     |
| `logIndex`         | `event.logIndex`          | Direct from receipt | ✅     |

#### Tier 2 - Pool State ✅

| Field                    | Source                                          | Verification                           | Status |
| ------------------------ | ----------------------------------------------- | -------------------------------------- | ------ |
| `totalPooledEtherBefore` | `TokenRebased.preTotalEther`                    | `lido.getTotalPooledEther()` before tx | ✅     |
| `totalPooledEtherAfter`  | `TokenRebased.postTotalEther`                   | `lido.getTotalPooledEther()` after tx  | ✅     |
| `totalSharesBefore`      | `TokenRebased.preTotalShares`                   | `lido.getTotalShares()` before tx      | ✅     |
| `totalSharesAfter`       | `TokenRebased.postTotalShares`                  | `lido.getTotalShares()` after tx       | ✅     |
| `shares2mint`            | `TokenRebased.sharesMintedAsFees`               | Event param + validation               | ✅     |
| `timeElapsed`            | `TokenRebased.timeElapsed`                      | Event param                            | ✅     |
| `mevFee`                 | `ETHDistributed.executionLayerRewardsWithdrawn` | Event param                            | ✅     |

#### Tier 2 - Fee Distribution ✅

| Field                  | Source                                    | Verification          | Status |
| ---------------------- | ----------------------------------------- | --------------------- | ------ |
| `totalRewardsWithFees` | `(postCL - preCL + withdrawals) + mevFee` | Derived from events   | ✅     |
| `totalRewards`         | `totalRewardsWithFees - totalFee`         | Calculated            | ✅     |
| `totalFee`             | `treasuryFee + operatorsFee`              | Sum of fee transfers  | ✅     |
| `treasuryFee`          | Sum of mints to treasury                  | Transfer events       | ✅     |
| `operatorsFee`         | Sum of mints to staking modules           | Transfer events       | ✅     |
| `sharesToTreasury`     | From TransferShares to treasury           | TransferShares events | ✅     |
| `sharesToOperators`    | From TransferShares to modules            | TransferShares events | ✅     |

#### Tier 3 - Calculated Fields ✅

| Field                     | Calculation                               | Verification            | Status |
| ------------------------- | ----------------------------------------- | ----------------------- | ------ |
| `feeBasis`                | `totalFee × 10000 / totalRewardsWithFees` | Calculated              | ✅     |
| `treasuryFeeBasisPoints`  | `treasuryFee × 10000 / totalFee`          | Calculated              | ✅     |
| `operatorsFeeBasisPoints` | `operatorsFee × 10000 / totalFee`         | Calculated              | ✅     |
| `apr`                     | Share rate annualized change              | Recalculated from state | ✅     |
| `aprRaw`                  | Same as `apr` in V2+                      | Calculated              | ✅     |
| `aprBeforeFees`           | Same as `apr` in V2+                      | Calculated              | ✅     |

### Omitted Legacy Fields (V1 only)

These fields exist in the real Graph schema but are **not implemented** in the simulator:

| Field                     | Reason for Omission                            |
| ------------------------- | ---------------------------------------------- |
| `insuranceFee`            | No insurance fund since V2                     |
| `insuranceFeeBasisPoints` | No insurance fund since V2                     |
| `sharesToInsuranceFund`   | No insurance fund since V2                     |
| `dust`                    | Legacy rounding dust handling, not used in V2+ |
| `dustSharesToTreasury`    | Legacy rounding dust handling, not used in V2+ |

---

## APR Calculation

### Formula

```typescript
// Share rate calculation
preShareRate = (preTotalEther * E27) / preTotalShares;
postShareRate = (postTotalEther * E27) / postTotalShares;

// APR = annualized percentage change in share rate
apr = (secondsPerYear * (postShareRate - preShareRate) * 100) / preShareRate / timeElapsed;
```

### Edge Case Handling

The `calcAPR_v2` function handles these edge cases:

| Edge Case                       | Behavior                        |
| ------------------------------- | ------------------------------- |
| `timeElapsed = 0`               | Returns 0                       |
| `preTotalShares = 0`            | Returns 0                       |
| `postTotalShares = 0`           | Returns 0                       |
| `preTotalEther = 0`             | Returns 0                       |
| `preShareRate < MIN_SHARE_RATE` | Returns 0                       |
| `rateChange = 0`                | Returns 0                       |
| `apr > MAX_APR_SCALED`          | Capped to prevent overflow      |
| `apr < -MAX_APR_SCALED`         | Capped to prevent underflow     |
| Negative rate change            | Returns negative APR (slashing) |

### Extended APR Function

For debugging, use `calcAPR_v2Extended` which returns edge case information:

```typescript
interface APRResult {
  apr: number;
  edgeCase: APREdgeCase | null;
}

type APREdgeCase =
  | "zero_time_elapsed"
  | "zero_pre_shares"
  | "zero_post_shares"
  | "zero_pre_ether"
  | "share_rate_too_small"
  | "zero_rate_change"
  | "apr_overflow_positive"
  | "apr_overflow_negative";
```

---

## Event Processing Order

The Graph indexer processes events in the order they appear in the transaction receipt:

```
1. ProcessingStarted         ← AccountingOracle (creates OracleReport link)
2. ETHDistributed            ← Lido contract (main handler, creates TotalReward)
3. SharesBurnt (optional)    ← Lido contract (withdrawal finalization)
4. Transfer (fee mints)      ← Lido contract (multiple, from 0x0)
5. TransferShares            ← Lido contract (multiple, paired with Transfer)
6. TokenRebased              ← Lido contract (pool state, accessed via look-ahead)
7. ExtraDataSubmitted        ← AccountingOracle (links NodeOperator entities)
```

The `handleETHDistributed` handler uses "look-ahead" to access `TokenRebased` event data before it's formally processed.

---

## Test Environment

### Network

Tests run on **Hoodi testnet** via forking (see `.github/workflows/tests-integration-hoodi.yml`).

Configuration:

```bash
RPC_URL: ${{ secrets.HOODI_RPC_URL }}
NETWORK_STATE_FILE: deployed-hoodi.json
```

### Test Command

```bash
yarn test:integration  # Runs on Hoodi fork
```

### Dependencies

Uses existing test infrastructure:

- `lib/protocol/` - Protocol context, oracle reporting helpers
- `lib/event.ts` - Event extraction utilities
- `test/suite/` - Test utilities (Snapshot, etc.)

---

## Success Criteria

**Exact match** of all implemented fields between:

1. Simulator-computed entity values
2. Expected values derived from on-chain state

No tolerance for rounding differences:

- All integer values use `bigint` for exact matching
- APR values use `number` with scaled integer arithmetic to maintain precision

**Additional validation:**

- No `shares2mint_mismatch` warnings in normal operation
- No `totals_state_mismatch` warnings when simulator is properly initialized
- Edge cases handled gracefully without errors

---

## Implementation Status

### Iteration 1 ✅ Complete

**Scope:**

- `TotalReward` entity only
- Tier 1 fields (event metadata)
- Tier 2 fields (pool state from TokenRebased)

**Deliverables:**

- Simulator module with `handleETHDistributed` handler
- Entity store implementation
- State capture utilities (`captureChainState`, `capturePoolState`)
- Event extraction utilities (`extractAllLogs`, `findTransferSharesPairs`)

### Iteration 2 ✅ Complete

**Scope:**

- Tier 2 fields (fee distribution tracking)
- Tier 3 fields (APR calculations, basis points)
- Fee distribution to treasury and staking modules
- Transfer/TransferShares pair extraction

**Deliverables:**

- `_processTokenRebase` with full fee tracking
- `calcAPR_v2` implementation
- Basis point calculations
- Query functionality (filtering, pagination, ordering)
- Integration tests with multiple oracle reports

### Iteration 2.1 ✅ Complete

**Scope:**

- SharesBurnt event handling for withdrawal finalization
- shares2mint validation sanity check
- Totals state tracking and validation
- Edge case tests
- Documentation updates

**Deliverables:**

- `handleSharesBurnt` handler implementation
- `ValidationWarning` types and reporting
- `calcAPR_v2Extended` with edge case info
- `edge-cases.integration.ts` test suite
- Updated spec documentation

### Iteration 3 (Future)

**Scope:**

- Related entities: `NodeOperatorFees`, `NodeOperatorsShares`, `OracleReport`
- `handleProcessingStarted` from AccountingOracle
- `handleExtraDataSubmitted` from AccountingOracle

---

## Future Considerations

### Edge Cases to Monitor

| Scenario                 | Current Status | Notes                         |
| ------------------------ | -------------- | ----------------------------- |
| Non-profitable report    | ✅ Tested      | Returns `isProfitable: false` |
| Withdrawal finalization  | ✅ Implemented | `handleSharesBurnt` called    |
| Slashing penalties       | ✅ APR handles | Returns negative APR          |
| Multiple staking modules | ✅ Tested      | NOR + SDVT + CSM support      |
| Zero rewards             | ✅ Tested      | No entity created             |
| Very small rewards       | ✅ Tested      | 1 wei handled                 |
| APR overflow             | ✅ Protected   | Capped at MAX_APR_SCALED      |

### Relationship to Actual Graph Code

#### Current Approach

- Manual TypeScript port of relevant handler logic
- Comments referencing original `lido-subgraph/src/` file locations
- Focus on correctness over exact code mirroring

#### Key Differences from Real Graph

| Aspect                 | Real Graph                          | Simulator                        |
| ---------------------- | ----------------------------------- | -------------------------------- |
| State management       | Persistent `Totals` entity          | ✅ Tracks `Totals` entity        |
| SharesBurnt handling   | Manual call in handleETHDistributed | ✅ Implemented                   |
| APR arithmetic         | `BigDecimal` (arbitrary precision)  | `bigint` with scaling → `number` |
| Division by zero       | Graph's implicit handling           | Explicit defensive checks        |
| shares2mint validation | Critical log on mismatch            | ✅ Validation warnings           |
| State consistency      | Assertions                          | ✅ Warning-based validation      |

#### Maintenance

- When Graph code changes, tests serve as validation
- Discrepancies indicate either bug in Graph or test update needed
- Detailed comparison available in `data/temp/total-rewards-comparison.md`

#### Reference Files

Key Graph source files to mirror:

- `lido-subgraph/src/Lido.ts` - `handleETHDistributed`, `handleSharesBurnt`, `_processTokenRebase`
- `lido-subgraph/src/helpers.ts` - `_calcAPR_v2`, entity loaders
- `lido-subgraph/src/AccountingOracle.ts` - `handleProcessingStarted`
- `lido-subgraph/src/constants.ts` - Calculation units, addresses
