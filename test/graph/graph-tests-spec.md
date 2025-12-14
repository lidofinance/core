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
├── simulator/
│   ├── index.ts                     # Main entry point, processTransaction()
│   ├── entities.ts                  # Entity type definitions (TotalReward, etc.)
│   ├── store.ts                     # In-memory entity store
│   ├── handlers/
│   │   ├── lido.ts                  # handleETHDistributed, _processTokenRebase
│   │   ├── accountingOracle.ts      # handleProcessingStarted, handleExtraDataSubmitted
│   │   └── index.ts                 # Handler registry
│   └── helpers.ts                   # APR calculation, utilities
├── utils/
│   ├── state-capture.ts             # Capture chain state before/after tx
│   └── event-extraction.ts          # Wrapper around lib/event.ts
└── total-reward.integration.ts      # Test file for TotalReward entity
```

The simulator structure should mirror `lido-subgraph/src/` where practical.

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
  // Keyed by entity ID (transaction hash for TotalReward)
  totalRewards: Map<string, TotalRewardEntity>;
  // Future: other entities
}
```

### Transaction Processing

```typescript
interface ProcessTransactionResult {
  // Mapping of entity type to entities created/updated
  totalRewards?: Map<string, TotalRewardEntity>;
  // Future: other entity types
}

function processTransaction(
  logs: LogDescriptionExtended[],
  state: SimulatorInitialState,
  store: EntityStore,
): ProcessTransactionResult;
```

- Accepts batch of logs from a single transaction
- Logs are processed in `logIndex` order
- Handlers can "look ahead" in the logs array (matches Graph behavior)
- Returns mapping of all entities computed in the transaction

### Event Extraction

Use existing helpers from `lib/event.ts`:

- `findEventsWithInterfaces()` for parsing logs with contract interfaces
- `findEvents()` for simple event extraction

---

## Test Structure

### Scenario Tests

For Scenario tests (state persists across `it` blocks), initialize simulator at suite level:

```typescript
describe("Scenario: Graph TotalReward Validation", () => {
  let ctx: ProtocolContext;
  let simulator: GraphSimulator;
  let store: EntityStore;

  before(async () => {
    ctx = await getProtocolContext();
    const initialState = await captureChainState(ctx);
    store = createEntityStore();
    simulator = new GraphSimulator(initialState, store);
  });

  it("Should compute TotalReward correctly for first oracle report", async () => {
    // 1. Capture state before
    const stateBefore = await capturePoolState(ctx);

    // 2. Execute oracle report
    const { reportTx } = await report(ctx, reportData);
    const receipt = await reportTx!.wait();

    // 3. Feed events to simulator
    const logs = extractAllLogs(receipt, ctx);
    const result = simulator.processTransaction(logs);

    // 4. Capture state after
    const stateAfter = await capturePoolState(ctx);

    // 5. Derive expected values from chain state
    const expected = deriveExpectedTotalReward(stateBefore, stateAfter, logs);

    // 6. Compare
    const computed = result.totalRewards?.get(receipt.hash);
    expect(computed).to.deep.equal(expected);
  });

  it("Should compute TotalReward correctly for second oracle report", async () => {
    // Simulator state persists from first report
    // ... similar structure ...
  });
});
```

### Integration Tests

For Integration tests (independent `it` blocks), initialize per-test:

```typescript
describe("Integration: Graph TotalReward", () => {
  it("Should compute TotalReward correctly", async () => {
    const ctx = await getProtocolContext();
    const initialState = await captureChainState(ctx);
    const store = createEntityStore();
    const simulator = new GraphSimulator(initialState, store);

    // ... rest of test ...
  });
});
```

---

## TotalReward Entity Fields

### Implementation Tiers

#### Tier 1 - Direct Event Metadata (Iteration 1)

| Field              | Source                    | Verification        |
| ------------------ | ------------------------- | ------------------- |
| `id`               | `tx.hash`                 | Direct from receipt |
| `block`            | `event.block.number`      | Direct from receipt |
| `blockTime`        | `event.block.timestamp`   | Direct from receipt |
| `transactionHash`  | `event.transaction.hash`  | Direct from receipt |
| `transactionIndex` | `event.transaction.index` | Direct from receipt |
| `logIndex`         | `event.logIndex`          | Direct from receipt |

#### Tier 2 - Pool State (Iteration 1)

| Field                    | Source                                          | Verification                           |
| ------------------------ | ----------------------------------------------- | -------------------------------------- |
| `totalPooledEtherBefore` | `TokenRebased.preTotalEther`                    | `lido.getTotalPooledEther()` before tx |
| `totalPooledEtherAfter`  | `TokenRebased.postTotalEther`                   | `lido.getTotalPooledEther()` after tx  |
| `totalSharesBefore`      | `TokenRebased.preTotalShares`                   | `lido.getTotalShares()` before tx      |
| `totalSharesAfter`       | `TokenRebased.postTotalShares`                  | `lido.getTotalShares()` after tx       |
| `shares2mint`            | `TokenRebased.sharesMintedAsFees`               | Event param                            |
| `timeElapsed`            | `TokenRebased.timeElapsed`                      | Event param                            |
| `mevFee`                 | `ETHDistributed.executionLayerRewardsWithdrawn` | Event param                            |

#### Tier 3 - Calculated Fields (Iteration 2+)

| Field                     | Calculation                               | Verification                     |
| ------------------------- | ----------------------------------------- | -------------------------------- |
| `totalRewardsWithFees`    | `(postCL - preCL + withdrawals) + mevFee` | Derived from events              |
| `totalRewards`            | `totalRewardsWithFees - totalFee`         | Calculated                       |
| `totalFee`                | `treasuryFee + operatorsFee`              | Sum of fee transfers             |
| `treasuryFee`             | Sum of mints to treasury                  | `lido.balanceOf(treasury)` delta |
| `operatorsFee`            | Sum of mints to staking modules           | Module balance deltas            |
| `sharesToTreasury`        | From TransferShares to treasury           | Event params                     |
| `sharesToOperators`       | From TransferShares to modules            | Event params                     |
| `feeBasis`                | `totalFee × 10000 / totalRewardsWithFees` | Calculated                       |
| `treasuryFeeBasisPoints`  | `treasuryFee × 10000 / totalFee`          | Calculated                       |
| `operatorsFeeBasisPoints` | `operatorsFee × 10000 / totalFee`         | Calculated                       |
| `apr`                     | Share rate annualized change              | Recalculated from state          |
| `aprRaw`                  | Same as `apr` in V2+                      | Calculated                       |
| `aprBeforeFees`           | Same as `apr` in V2+                      | Calculated                       |

---

## Event Processing Order

The Graph indexer processes events in the order they appear in the transaction receipt:

```
1. ProcessingStarted         ← AccountingOracle (creates OracleReport link)
2. ETHDistributed            ← Lido contract (main handler, creates TotalReward)
3. Transfer (fee mints)      ← Lido contract (multiple, from 0x0)
4. TransferShares            ← Lido contract (multiple, paired with Transfer)
5. TokenRebased              ← Lido contract (pool state, accessed via look-ahead)
6. ExtraDataSubmitted        ← AccountingOracle (links NodeOperator entities)
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

No tolerance for rounding differences (all values are `bigint`).

---

## Iteration Plan

### Iteration 1 (Current)

**Scope:**

- `TotalReward` entity only
- Tier 1 + Tier 2 fields
- Two consecutive oracle reports scenario
- State persistence validation across reports

**Deliverables:**

- Simulator module with basic handlers
- Entity store implementation
- State capture utilities
- Integration test with two oracle reports

### Iteration 2

**Scope:**

- Tier 3 fields (fee calculations, APR)
- Fee distribution to treasury and staking modules

### Iteration 3

**Scope:**

- Related entities: `NodeOperatorFees`, `NodeOperatorsShares`, `OracleReport`

---

## Future Iterations - Edge Cases

The following edge cases should be addressed in future iterations:

### Non-Profitable Oracle Report

- When `postCLBalance + withdrawalsWithdrawn <= preCLBalance`
- No `TotalReward` entity should be created
- Test that simulator correctly skips entity creation

### Report with Withdrawal Finalization

- `WithdrawalsFinalized` event in same transaction
- Shares burnt via `SharesBurnt` event
- Affects `totalSharesAfter` calculation

### Report with Slashing Penalties

- Negative rewards scenario
- Validator exit edge cases

### Multiple Staking Modules

- CSM (Community Staking Module) integration
- Fee distribution across NOR, SDVT, CSM

### Dust and Rounding

- `dustSharesToTreasury` field
- Rounding in fee distribution

---

## Relationship to Actual Graph Code

### Current Approach

- Manual TypeScript port of relevant handler logic
- Comments referencing original `lido-subgraph/src/` file locations
- Focus on correctness over exact code mirroring

### Maintenance

- When Graph code changes, tests serve as validation
- Discrepancies indicate either bug in Graph or test update needed
- Consider shared test vectors in future

### Reference Files

Key Graph source files to mirror:

- `lido-subgraph/src/Lido.ts` - `handleETHDistributed`, `_processTokenRebase`
- `lido-subgraph/src/helpers.ts` - `_calcAPR_v2`, entity loaders
- `lido-subgraph/src/AccountingOracle.ts` - `handleProcessingStarted`
- `lido-subgraph/src/constants.ts` - Calculation units, addresses
