# Total Rewards Calculation: Real Graph vs Simulator Comparison

This document provides a step-by-step comparison of how TotalReward entities are calculated in:

1. **Real Graph** (`lidofinance/lido-subgraph`)
2. **Simulator** (`test/graph/simulator/`)

---

## Overview

Both implementations follow the same high-level process:

1. Process `ETHDistributed` event to create TotalReward entity
2. Look-ahead to find `TokenRebased` event for pool state
3. Extract Transfer/TransferShares pairs for fee distribution
4. Calculate APR and basis points

---

## Step 1: Entry Point - handleETHDistributed

### Real Graph (`src/Lido.ts` lines 477-571)

```typescript
export function handleETHDistributed(event: ETHDistributedEvent): void {
  // Parse all events from tx receipt
  const parsedEvents = parseEventLogs(event, event.address)

  // TokenRebased event should exist (look-ahead)
  const tokenRebasedEvent = getParsedEventByName<TokenRebasedEvent>(
    parsedEvents,
    'TokenRebased',
    event.logIndex
  )
  if (!tokenRebasedEvent) {
    log.critical('Event TokenRebased not found when ETHDistributed!...')
    return
  }

  // Totals should be already non-null on oracle report
  const totals = _loadTotalsEntity()!

  // Update totals for correct SharesBurnt handling
  totals.totalPooledEther = tokenRebasedEvent.params.postTotalEther
  totals.save()

  // Handle SharesBurnt if present
  const sharesBurntEvent = getParsedEventByName<SharesBurntEvent>(...)
  if (sharesBurntEvent) {
    handleSharesBurnt(sharesBurntEvent)
  }

  // Update totalShares for next mint transfers
  totals.totalShares = tokenRebasedEvent.params.postTotalShares
  totals.save()

  // LIP-12: Non-profitable report check
  const postCLTotalBalance = event.params.postCLBalance.plus(
    event.params.withdrawalsWithdrawn
  )
  if (postCLTotalBalance <= event.params.preCLBalance) {
    return  // Skip non-profitable reports
  }

  // Calculate total rewards with fees
  const totalRewards = postCLTotalBalance
    .minus(event.params.preCLBalance)
    .plus(event.params.executionLayerRewardsWithdrawn)

  const totalRewardsEntity = _loadTotalRewardEntity(event, true)!
  totalRewardsEntity.totalRewards = totalRewards
  totalRewardsEntity.totalRewardsWithFees = totalRewardsEntity.totalRewards
  totalRewardsEntity.mevFee = event.params.executionLayerRewardsWithdrawn

  _processTokenRebase(totalRewardsEntity, event, tokenRebasedEvent, parsedEvents)
  totalRewardsEntity.save()
}
```

### Simulator (`handlers/lido.ts` lines 67-129)

```typescript
export function handleETHDistributed(
  event: LogDescriptionWithMeta,
  allLogs: LogDescriptionWithMeta[],
  store: EntityStore,
  ctx: HandlerContext,
): ETHDistributedResult {
  // Extract ETHDistributed event params
  const preCLBalance = getEventArg<bigint>(event, "preCLBalance");
  const postCLBalance = getEventArg<bigint>(event, "postCLBalance");
  const withdrawalsWithdrawn = getEventArg<bigint>(event, "withdrawalsWithdrawn");
  const executionLayerRewardsWithdrawn = getEventArg<bigint>(event, "executionLayerRewardsWithdrawn");

  // Find TokenRebased event (look-ahead)
  const tokenRebasedEvent = findEventByName(allLogs, "TokenRebased", event.logIndex);
  if (!tokenRebasedEvent) {
    throw new Error(`TokenRebased event not found after ETHDistributed...`);
  }

  // LIP-12: Non-profitable report check
  const postCLTotalBalance = postCLBalance + withdrawalsWithdrawn;
  if (postCLTotalBalance <= preCLBalance) {
    return { totalReward: null, isProfitable: false };
  }

  // Calculate total rewards with fees
  const totalRewardsWithFees = postCLTotalBalance - preCLBalance + executionLayerRewardsWithdrawn;

  // Create TotalReward entity
  const entity = createTotalRewardEntity(ctx.transactionHash);
  entity.block = ctx.blockNumber;
  entity.blockTime = ctx.blockTimestamp;
  entity.transactionHash = ctx.transactionHash;
  entity.transactionIndex = BigInt(ctx.transactionIndex);
  entity.logIndex = BigInt(event.logIndex);
  entity.mevFee = executionLayerRewardsWithdrawn;
  entity.totalRewardsWithFees = totalRewardsWithFees;

  _processTokenRebase(entity, tokenRebasedEvent, allLogs, event.logIndex, ctx.treasuryAddress);
  saveTotalReward(store, entity);

  return { totalReward: entity, isProfitable: true };
}
```

### ✅ Differences in Step 1 (Now Aligned)

| Aspect                          | Real Graph                                      | Simulator                           | Status        |
| ------------------------------- | ----------------------------------------------- | ----------------------------------- | ------------- |
| Totals state management         | Updates shared `Totals` entity before/after     | ✅ Now updates `Totals` entity      | ✅ Equivalent |
| SharesBurnt handling            | Manually calls `handleSharesBurnt()` if present | **NOT IMPLEMENTED** (noted in code) | ⚠️ Missing    |
| Error handling                  | Uses `log.critical()`                           | Throws Error                        | ✅ Equivalent |
| Non-profitable check            | Returns silently                                | Returns with `isProfitable: false`  | ✅ Equivalent |
| Totals update on non-profitable | Totals still updated                            | ✅ Totals still updated             | ✅ Equivalent |

---

## Step 2: Process TokenRebased - Pool State Extraction

### Real Graph (`src/Lido.ts` lines 573-590)

```typescript
export function _processTokenRebase(
  entity: TotalReward,
  ethDistributedEvent: ETHDistributedEvent,
  tokenRebasedEvent: TokenRebasedEvent,
  parsedEvents: ParsedEvent[],
): void {
  entity.totalPooledEtherBefore = tokenRebasedEvent.params.preTotalEther;
  entity.totalSharesBefore = tokenRebasedEvent.params.preTotalShares;
  entity.totalPooledEtherAfter = tokenRebasedEvent.params.postTotalEther;
  entity.totalSharesAfter = tokenRebasedEvent.params.postTotalShares;
  entity.shares2mint = tokenRebasedEvent.params.sharesMintedAsFees;
  entity.timeElapsed = tokenRebasedEvent.params.timeElapsed;
  // ...continues with fee distribution
}
```

### Simulator (`handlers/lido.ts` lines 144-175)

```typescript
export function _processTokenRebase(
  entity: TotalRewardEntity,
  tokenRebasedEvent: LogDescriptionWithMeta,
  allLogs: LogDescriptionWithMeta[],
  ethDistributedLogIndex: number,
  treasuryAddress: string,
): void {
  const preTotalEther = getEventArg<bigint>(tokenRebasedEvent, "preTotalEther");
  const postTotalEther = getEventArg<bigint>(tokenRebasedEvent, "postTotalEther");
  const preTotalShares = getEventArg<bigint>(tokenRebasedEvent, "preTotalShares");
  const postTotalShares = getEventArg<bigint>(tokenRebasedEvent, "postTotalShares");
  const sharesMintedAsFees = getEventArg<bigint>(tokenRebasedEvent, "sharesMintedAsFees");
  const timeElapsed = getEventArg<bigint>(tokenRebasedEvent, "timeElapsed");

  entity.totalPooledEtherBefore = preTotalEther;
  entity.totalPooledEtherAfter = postTotalEther;
  entity.totalSharesBefore = preTotalShares;
  entity.totalSharesAfter = postTotalShares;
  entity.shares2mint = sharesMintedAsFees;
  entity.timeElapsed = timeElapsed;
  // ...continues with fee distribution
}
```

### ✅ Pool State Fields - Equivalent

Both implementations extract the same fields from TokenRebased event:

- `totalPooledEtherBefore` ← `preTotalEther`
- `totalPooledEtherAfter` ← `postTotalEther`
- `totalSharesBefore` ← `preTotalShares`
- `totalSharesAfter` ← `postTotalShares`
- `shares2mint` ← `sharesMintedAsFees`
- `timeElapsed` ← `timeElapsed`

---

## Step 3: Fee Distribution - Transfer/TransferShares Extraction

### Real Graph (`src/Lido.ts` lines 586-651)

```typescript
// Extract Transfer/TransferShares pairs between ETHDistributed and TokenRebased
const transferEventPairs = extractPairedEvent(
  parsedEvents,
  "Transfer",
  "TransferShares",
  ethDistributedEvent.logIndex, // start from ETHDistributed
  tokenRebasedEvent.logIndex, // to TokenRebased
);

let sharesToTreasury = ZERO;
let sharesToOperators = ZERO;
let treasuryFee = ZERO;
let operatorsFee = ZERO;

for (let i = 0; i < transferEventPairs.length; i++) {
  const eventTransfer = getParsedEvent<TransferEvent>(transferEventPairs[i], 0);
  const eventTransferShares = getParsedEvent<TransferSharesEvent>(transferEventPairs[i], 1);

  const treasuryAddress = getAddress("TREASURY");

  // Process only mint events (from = 0x0)
  if (eventTransfer.params.from == ZERO_ADDRESS) {
    if (eventTransfer.params.to == treasuryAddress) {
      // Mint to treasury
      sharesToTreasury = sharesToTreasury.plus(eventTransferShares.params.sharesValue);
      treasuryFee = treasuryFee.plus(eventTransfer.params.value);
    } else {
      // Mint to SR module (operators)
      sharesToOperators = sharesToOperators.plus(eventTransferShares.params.sharesValue);
      operatorsFee = operatorsFee.plus(eventTransfer.params.value);
    }
  }
}

entity.sharesToTreasury = sharesToTreasury;
entity.treasuryFee = treasuryFee;
entity.sharesToOperators = sharesToOperators;
entity.operatorsFee = operatorsFee;
entity.totalFee = treasuryFee.plus(operatorsFee);
entity.totalRewards = entity.totalRewardsWithFees.minus(entity.totalFee);
```

### Simulator (`handlers/lido.ts` lines 177-212)

```typescript
// Extract Transfer/TransferShares pairs between ETHDistributed and TokenRebased
const transferPairs = findTransferSharesPairs(allLogs, ethDistributedLogIndex, tokenRebasedEvent.logIndex);

let sharesToTreasury = 0n;
let sharesToOperators = 0n;
let treasuryFee = 0n;
let operatorsFee = 0n;

const treasuryAddressLower = treasuryAddress.toLowerCase();

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
    }
  }
}

entity.sharesToTreasury = sharesToTreasury;
entity.sharesToOperators = sharesToOperators;
entity.treasuryFee = treasuryFee;
entity.operatorsFee = operatorsFee;
entity.totalFee = treasuryFee + operatorsFee;
entity.totalRewards = entity.totalRewardsWithFees - entity.totalFee;
```

### Transfer Pairing Logic Comparison

**Real Graph (`src/parser.ts`):**

```typescript
// Uses extractPairedEvent which matches Transfer/TransferShares pairs
// within the specified logIndex range
```

**Simulator (`utils/event-extraction.ts` lines 209-249):**

```typescript
export function findTransferSharesPairs(
  logs: LogDescriptionWithMeta[],
  startLogIndex: number,
  endLogIndex: number,
): TransferPair[] {
  // Get all Transfer and TransferShares events in range
  const transferEvents = logs.filter(
    (log) => log.name === "Transfer" && log.logIndex > startLogIndex && log.logIndex < endLogIndex,
  );
  const transferSharesEvents = logs.filter(
    (log) => log.name === "TransferShares" && log.logIndex > startLogIndex && log.logIndex < endLogIndex,
  );

  // Pair Transfer events with their corresponding TransferShares events
  // They are emitted consecutively, so TransferShares follows Transfer with logIndex + 1
  for (const transfer of transferEvents) {
    const matchingTransferShares = transferSharesEvents.find((ts) => ts.logIndex === transfer.logIndex + 1);
    // ...
  }
}
```

### ✅ Fee Distribution - Equivalent

Both implementations:

1. Filter Transfer/TransferShares pairs between ETHDistributed and TokenRebased
2. Only process mint events (from = 0x0)
3. Categorize by destination: treasury vs operators (SR modules)
4. Calculate totals for shares and ETH values

---

## Step 4: Sanity Check - shares2mint Validation

### Real Graph (`src/Lido.ts` lines 653-662)

```typescript
if (entity.shares2mint != sharesToTreasury.plus(sharesToOperators)) {
  log.critical(
    "totalRewardsEntity.shares2mint != sharesToTreasury + sharesToOperators: shares2mint {} sharesToTreasury {} sharesToOperators {}",
    [entity.shares2mint.toString(), sharesToTreasury.toString(), sharesToOperators.toString()],
  );
}
```

### Simulator

**NOT IMPLEMENTED** - The simulator does not include this validation check.

### ⚠️ Missing Validation

The simulator lacks the sanity check that verifies:

```
shares2mint === sharesToTreasury + sharesToOperators
```

This could potentially hide bugs in fee distribution tracking.

---

## Step 5: Basis Points Calculation

### Real Graph (`src/Lido.ts` lines 669-677)

```typescript
entity.treasuryFeeBasisPoints = treasuryFee.times(CALCULATION_UNIT).div(entity.totalFee);

entity.operatorsFeeBasisPoints = operatorsFee.times(CALCULATION_UNIT).div(entity.totalFee);

entity.feeBasis = entity.totalFee.times(CALCULATION_UNIT).div(entity.totalRewardsWithFees);
```

### Simulator (`handlers/lido.ts` lines 214-225)

```typescript
// feeBasis = totalFee * 10000 / totalRewardsWithFees
entity.feeBasis =
  entity.totalRewardsWithFees > 0n ? (entity.totalFee * CALCULATION_UNIT) / entity.totalRewardsWithFees : 0n;

// treasuryFeeBasisPoints = treasuryFee * 10000 / totalFee
entity.treasuryFeeBasisPoints = entity.totalFee > 0n ? (treasuryFee * CALCULATION_UNIT) / entity.totalFee : 0n;

// operatorsFeeBasisPoints = operatorsFee * 10000 / totalFee
entity.operatorsFeeBasisPoints = entity.totalFee > 0n ? (operatorsFee * CALCULATION_UNIT) / entity.totalFee : 0n;
```

### ⚠️ Difference in Division-by-Zero Handling

| Aspect           | Real Graph                                        | Simulator                              |
| ---------------- | ------------------------------------------------- | -------------------------------------- |
| Division by zero | No explicit check (Graph's BigInt.div handles it) | Explicit checks with ternary operators |
| Default value    | Would throw on division by zero                   | Returns 0n                             |

The simulator is **more defensive** with explicit zero checks.

---

## Step 6: APR Calculation

### Real Graph (`src/helpers.ts` lines 318-348)

```typescript
export function _calcAPR_v2(
  entity: TotalReward,
  preTotalEther: BigInt,
  postTotalEther: BigInt,
  preTotalShares: BigInt,
  postTotalShares: BigInt,
  timeElapsed: BigInt,
): void {
  // https://docs.lido.fi/integrations/api/#last-lido-apr-for-steth

  const preShareRate = preTotalEther.toBigDecimal().times(E27_PRECISION_BASE).div(preTotalShares.toBigDecimal());

  const postShareRate = postTotalEther.toBigDecimal().times(E27_PRECISION_BASE).div(postTotalShares.toBigDecimal());

  const secondsInYear = BigInt.fromI32(60 * 60 * 24 * 365).toBigDecimal();

  entity.apr = secondsInYear
    .times(postShareRate.minus(preShareRate))
    .times(ONE_HUNDRED_PERCENT) // 100 as BigDecimal
    .div(preShareRate)
    .div(timeElapsed.toBigDecimal());

  entity.aprRaw = entity.apr;
  entity.aprBeforeFees = entity.apr;
}
```

### Simulator (`helpers.ts` lines 39-69)

```typescript
export function calcAPR_v2(
  preTotalEther: bigint,
  postTotalEther: bigint,
  preTotalShares: bigint,
  postTotalShares: bigint,
  timeElapsed: bigint,
): number {
  if (timeElapsed === 0n || preTotalShares === 0n || postTotalShares === 0n) {
    return 0;
  }

  // APR formula from lido-subgraph:
  // preShareRate = preTotalEther * E27 / preTotalShares
  // postShareRate = postTotalEther * E27 / postTotalShares
  // apr = secondsInYear * (postShareRate - preShareRate) * 100 / preShareRate / timeElapsed

  const preShareRate = (preTotalEther * E27_PRECISION_BASE) / preTotalShares;
  const postShareRate = (postTotalEther * E27_PRECISION_BASE) / postTotalShares;

  if (preShareRate === 0n) {
    return 0;
  }

  // Use BigInt arithmetic then convert to number at the end
  // Multiply by 10000 for precision, then divide by 100 at the end
  const aprScaled = (SECONDS_PER_YEAR * (postShareRate - preShareRate) * 10000n * 100n) / (preShareRate * timeElapsed);

  return Number(aprScaled) / 10000;
}
```

### APR Calculation Comparison

| Aspect             | Real Graph                         | Simulator                            |
| ------------------ | ---------------------------------- | ------------------------------------ |
| Arithmetic         | `BigDecimal` (arbitrary precision) | `bigint` (integer only) + conversion |
| E27_PRECISION_BASE | `BigDecimal` constant              | `bigint` constant (10n \*\* 27n)     |
| Result type        | `BigDecimal`                       | `number`                             |
| Division by zero   | No explicit check                  | Explicit checks return 0             |
| Precision scaling  | Direct BigDecimal math             | Scaled by 10000 then divided         |

### ⚠️ Potential Precision Differences

The simulator uses integer arithmetic with scaling, while the real graph uses arbitrary-precision `BigDecimal`. This could lead to minor rounding differences, though the test results suggest they match in practice.

---

## Step 7: Entity Creation and Field Initialization

### Real Graph (`src/helpers.ts` lines 96-147)

```typescript
export function _loadTotalRewardEntity(event: ethereum.Event, create: bool = false): TotalReward | null {
  let entity = TotalReward.load(event.transaction.hash);
  if (!entity && create) {
    entity = new TotalReward(event.transaction.hash);

    entity.block = event.block.number;
    entity.blockTime = event.block.timestamp;
    entity.transactionHash = event.transaction.hash;
    entity.transactionIndex = event.transaction.index;
    entity.logIndex = event.logIndex;

    entity.feeBasis = ZERO;
    entity.treasuryFeeBasisPoints = ZERO;
    entity.insuranceFeeBasisPoints = ZERO; // ← Insurance fund (legacy)
    entity.operatorsFeeBasisPoints = ZERO;

    entity.totalRewardsWithFees = ZERO;
    entity.totalRewards = ZERO;
    entity.totalFee = ZERO;
    entity.treasuryFee = ZERO;
    entity.insuranceFee = ZERO; // ← Insurance fund (legacy)
    entity.operatorsFee = ZERO;
    entity.dust = ZERO; // ← Dust handling (legacy)
    entity.mevFee = ZERO;

    entity.apr = ZERO.toBigDecimal();
    entity.aprRaw = ZERO.toBigDecimal();
    entity.aprBeforeFees = ZERO.toBigDecimal();

    entity.timeElapsed = ZERO;
    entity.totalPooledEtherAfter = ZERO;
    entity.totalSharesAfter = ZERO;
    entity.shares2mint = ZERO;

    entity.sharesToOperators = ZERO;
    entity.sharesToTreasury = ZERO;
    entity.sharesToInsuranceFund = ZERO; // ← Insurance fund (legacy)
    entity.dustSharesToTreasury = ZERO; // ← Dust handling (legacy)
  }
  return entity;
}
```

### Simulator (`entities.ts` lines 117-153)

```typescript
export function createTotalRewardEntity(id: string): TotalRewardEntity {
  return {
    // Tier 1
    id,
    block: 0n,
    blockTime: 0n,
    transactionHash: id,
    transactionIndex: 0n,
    logIndex: 0n,

    // Tier 2 - Pool State
    totalPooledEtherBefore: 0n,
    totalPooledEtherAfter: 0n,
    totalSharesBefore: 0n,
    totalSharesAfter: 0n,
    shares2mint: 0n,
    timeElapsed: 0n,
    mevFee: 0n,

    // Tier 2 - Fee Distribution
    totalRewardsWithFees: 0n,
    totalRewards: 0n,
    totalFee: 0n,
    treasuryFee: 0n,
    operatorsFee: 0n,
    sharesToTreasury: 0n,
    sharesToOperators: 0n,

    // Tier 3
    apr: 0,
    aprRaw: 0,
    aprBeforeFees: 0,
    feeBasis: 0n,
    treasuryFeeBasisPoints: 0n,
    operatorsFeeBasisPoints: 0n,
  };
}
```

### ⚠️ Missing Fields in Simulator

| Field                     | Real Graph | Simulator | Notes                                    |
| ------------------------- | ---------- | --------- | ---------------------------------------- |
| `insuranceFeeBasisPoints` | ✅         | ❌        | Legacy field, no insurance fund since V2 |
| `insuranceFee`            | ✅         | ❌        | Legacy field                             |
| `sharesToInsuranceFund`   | ✅         | ❌        | Legacy field                             |
| `dust`                    | ✅         | ❌        | Rounding dust handling                   |
| `dustSharesToTreasury`    | ✅         | ❌        | Rounding dust handling                   |

These are **legacy fields** from Lido V1 and are not used in V2/V3 oracle reports, so omitting them is intentional for V2+ testing.

---

## Summary of Differences

### ❌ Missing in Simulator

1. **SharesBurnt handling** - Real graph manually processes SharesBurnt events within handleETHDistributed; simulator has placeholder but does not handle this yet.

2. **shares2mint validation** - Real graph has sanity check that shares2mint equals sum of distributed shares; simulator lacks this.

3. **Legacy V1 fields** - Insurance fund, dust handling fields not present in simulator entity.

4. **NodeOperatorFees/NodeOperatorsShares entities** - Real graph creates these related entities; simulator focuses only on TotalReward and Totals.

### ⚠️ Behavioral Differences

1. **APR precision** - Real graph uses BigDecimal; simulator uses scaled bigint arithmetic converted to number.

2. **Division-by-zero handling** - Simulator is more defensive with explicit zero checks.

### ✅ Now Equivalent

1. **Totals entity state management** - Simulator now tracks and updates the `Totals` entity during `handleETHDistributed`, matching the real graph's behavior:
   - Updates `totalPooledEther` to `postTotalEther` before SharesBurnt handling
   - Updates `totalShares` to `postTotalShares` after SharesBurnt handling
   - Totals are updated even for non-profitable reports

### ✅ Equivalent

1. **Non-profitable report check (LIP-12)**
2. **totalRewardsWithFees calculation**
3. **Pool state extraction from TokenRebased**
4. **Transfer/TransferShares pairing logic**
5. **Fee categorization (treasury vs operators)**
6. **Basis points calculations**
7. **APR formula (same mathematical approach)**

---

## Recommendations

1. **Add SharesBurnt handling** if testing scenarios that include withdrawal finalization (burns shares).

2. **Add shares2mint validation** as a sanity check to catch potential bugs early.

3. **Consider adding Totals state tracking** for multi-transaction scenarios that depend on cumulative state.

4. **Document that legacy fields are intentionally omitted** for V2+ testing focus.

5. **Add tests for edge cases**:
   - Zero rewards
   - Division by zero scenarios
   - Very small/large values for APR precision
