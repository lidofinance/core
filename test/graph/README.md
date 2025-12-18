# Graph tests intro

## Problem frame

Subgraph mappings are event-driven and can silently drift from on-chain truth (ordering, missing events, legacy branches, rounding, network quirks). These integration tests provide a deterministic way to replay a multi-transaction scenario, simulate the subgraph entity updates from events, and prove (or falsify) that the resulting entity state matches on-chain state at the same block.

## Objective

Detect mismatches between:

- Simulated entity state (derived from events via GraphSimulator.processTransaction()), and
- On-chain reads at the corresponding post-transaction block.

The goal is bug discovery.

## Scope and non-goals

**In scope**

- V3 (post-V2) code paths only.
- Simulation starts from **current fork state** at test start (no historical indexing).
- Entity correctness for: submissions, transfers, oracle reports, external share mints/burns, withdrawals finalization.

**Out of scope**

- EasyTrack related entities
- Voting related entities
- Config entities (`LidoConfig`, `OracleConfig`, etc.)
- Pre-V2 / legacy entities and fields (`insuranceFee`, `dust`, `sharesToInsuranceFund`, etc.).
- `OracleCompleted` legacy tracking (replaced by `TokenRebased.timeElapsed`).

## Current status

Excludes out-of-scope graph parts.

| Category         | Implemented | Total | Coverage |
| ---------------- | ----------- | ----- | -------- |
| Entities         | 8           | 30    | 27%      |
| Lido Handlers    | 7           | 19    | 37%      |
| All Handlers     | 7           | 78    | 9%       |
| Core stETH Flow  | Full        | -     | ✅       |
| Governance       | None        | -     | ❌       |
| Node Operators   | Partial     | -     | ⚠️       |
| Withdrawal Queue | None        | -     | ❌       |

## Test Environment

- Mainnet via forking
- Hoodi testnet via forking
- Uses `lib/protocol/` helpers and `test/suite/` utilities

## How to

To run graph integration tests (assuming localhost fork is running) do:

- Mainnet: `RPC_URL=http://localhost:9122  yarn test:integration:upgrade:helper test/graph/*.ts`
- Hoodi: `RPC_URL=http://localhost:9123  NETWORK_STATE_FILE=deployed-hoodi.json   yarn test:integration:helper test/graph/*.ts`

## Success Criteria

- **Totals consistency**: Simulator's `Totals` must match on-chain `lido.getTotalPooledEther()` and `lido.getTotalShares()`
- **Shares consistency**: Simulator's `Shares` entity for each address must match on-chain `lido.sharesOf(address)` (delta from initial state)
- **Exact match**: All `bigint` values must match exactly (no tolerance for rounding)
- **No validation warnings**: `shares2mint_mismatch` and `totals_state_mismatch` warnings indicate bugs

## Transactions Scenario

File `entities-scenario.integration.ts`.

**Minimum targets:** 6 deposits, 5 transfers, 7 oracle reports, 5 withdrawal requests, 4 V3 mints, 4 V3 burns.

The test performs 32 interleaved actions across 6 phases:

1. user1 deposits 100 ETH (no referral)
2. user2 deposits 50 ETH (referral=user1)
3. Oracle report #1 (profitable, clDiff=0.01 ETH)
4. user3 deposits 200 ETH
5. Transfer user1→user2 (10 ETH)
6. Vault1 report → Vault1 mints 50 stETH to user3
7. Oracle report #2 (profitable, clDiff=0.001 ETH)
8. Vault2 report → Vault2 mints 30 stETH to user3
9. user4 deposits 25 ETH
10. Vault1 report → Vault1 burns 20 stETH
11. user1 requests withdrawal (30 ETH)
12. user2 requests withdrawal (20 ETH)
13. Oracle report #3 (profitable + finalizes withdrawals)
14. user5 deposits 500 ETH
15. Transfer user3→user4 (50 ETH)
16. Oracle report #4 (zero rewards, clDiff=0)
17. Vault2 report → Vault2 mints 100 stETH
18. user1 requests withdrawal (50 ETH)
19. Oracle report #5 (negative rewards, clDiff=-0.0001 ETH)
20. Transfer user4→user1 (near full balance)
21. Vault1 report → Vault1 mints 75 stETH
22. user2 deposits 80 ETH
23. Vault2 report → Vault2 burns 50 stETH
24. user3 requests withdrawal (40 ETH)
25. Oracle report #6 (profitable + batch finalization)
26. user1 deposits 30 ETH (referral=user5)
27. Transfer user1→user3 (15 ETH)
28. Vault1 report → Vault1 burns 30 stETH
29. user5 requests withdrawal (100 ETH)
30. Oracle report #7 (profitable, clDiff=0.002 ETH)
31. Transfer user2→user5 (25 ETH)
32. Vault2 report → Vault2 burns 30 stETH

### Validation Approach

Each transaction is processed through `GraphSimulator.processTransactionWithV3()` which parses events and updates entities. Validation helpers check:

- **`validateSubmission`**: Verifies `LidoSubmission` entity fields (`sender`, `amount`, `referral`, `shares > 0`)
- **`validateTransfer`**: Verifies `LidoTransfer` entity fields and share balance arithmetic:
  - `sharesBeforeDecrease - sharesAfterDecrease == shares`
  - `sharesAfterIncrease - sharesBeforeIncrease == shares`
- **`validateOracleReport`**: For profitable reports, verifies `TotalReward` fee distribution:
  - `shares2mint == sharesToTreasury + sharesToOperators`
  - `totalFee == treasuryFee + operatorsFee`
  - Per-module fee distribution: `NodeOperatorFees` and `NodeOperatorsShares` entities are created
  - Sum of `NodeOperatorFees.fee` equals `operatorsFee`
  - Sum of `NodeOperatorsShares.shares` equals `sharesToOperators`
  - For non-profitable (zero/negative), verifies no `TotalReward` is created
- **`validateGlobalConsistency`**: Compares simulator state against on-chain state:
  - `Totals.totalPooledEther` vs `lido.getTotalPooledEther()`
  - `Totals.totalShares` vs `lido.getTotalShares()`
  - For each `Shares` entity: `simulatorDelta + initialShares` vs `lido.sharesOf(address)`

### Address Pre-capture

At test setup, initial share balances are captured for all addresses that may receive shares during the test:

- Treasury address
- Staking module addresses (from `stakingRouter.getStakingModules()`)
- Staking reward recipients (from `stakingRouter.getStakingRewardsDistribution()`)
- Fee distributor addresses (from `module.FEE_DISTRIBUTOR()` for modules that have one, e.g., CSM)
- Protocol contracts: Burner, WithdrawalQueue, Accounting, StakingRouter, VaultHub
- Test user addresses (user1-5)

This allows strict validation of Shares entities by computing: `expectedShares = simulatorDelta + initialShares`

## Specifics

- This document does not describe legacy code written for pre-V2 upgrade.
- there are specific workarounds for specific networks for cases when an event does not exist ([Voting example](https://github.com/lidofinance/lido-subgraph/blob/6334a6a28ab6978b66d45220a27c3c2dc78be918/src/Voting.ts#L67))

## Entities

Subgraph calculates and stores various data structures called entities. Some of them are iteratively modified (cumulative), e.g. total pooled ether. Some of them are immutable like stETH transfers.

### Totals (cumulative)

**Fields**: `totalPooledEther`, `totalShares`

**Update sources**

- Submission: `Lido.Submitted.amount`
- Oracle report: `Lido.TokenRebased.postTotalShares`, `postTotalEther`, plus `Lido.SharesBurnt.sharesAmount`
- VaultHub mint: `Lido.ExternalSharesMinted` (shares delta + pooled ether via contract read)
- External burn: `Lido.ExternalSharesBurnt` (pooled ether via contract read)

### Shares (cumulative)

**Fields**: `id` (holder), `shares`

**Update sources**

- Submission mint: `Lido.Transfer` (0x0→user) + `Lido.TransferShares`
- User transfer: `Lido.Transfer` + `Lido.TransferShares`
- Oracle fee mints: `Lido.Transfer` (0x0→Treasury / SR modules) + `Lido.TransferShares`
- Burn finalization: `Lido.SharesBurnt`
- V3 external mints: `Lido.Transfer` (0x0→receiver) triggered by `ExternalSharesMinted`

**Validation**: Simulator tracks share deltas from events. Final balance = `simulatorDelta + initialShares` must equal `lido.sharesOf(address)`

**Note**: `ExternalSharesMinted` only updates `Totals`, not `Shares`. The accompanying `Transfer` event updates per-address shares.

### LidoTransfer (immutable)

Notable fields:

- from
- to
- value
- shares
- sharesBeforeDecrease / sharesAfterDecrease
- sharesBeforeIncrease / sharesAfterIncrease
- totalPooledEther
- totalShares
- balanceAfterDecrease / balanceAfterIncrease

When updated:

1. User submits ether

- `Lido.Submitted` event is handled first
- `Lido.Transfer` (from 0x0 to user): creates mint transfer entity
- `Lido.TransferShares` (from 0x0 to user): provides shares value

2. User transfers stETH

- `Lido.Transfer` (from user to recipient): creates transfer entity
- `Lido.TransferShares` (from user to recipient): provides shares value

3. Oracle reports rewards

- `Lido.ETHDistributed` and `Lido.TokenRebased` events are parsed together
- `Lido.Transfer` (from 0x0 to Treasury): creates mint transfer for treasury fees
- `Lido.TransferShares` (from 0x0 to Treasury): provides shares value
- `Lido.Transfer` (from 0x0 to SR modules): creates mint transfers for node operator fees
- `Lido.TransferShares` (from 0x0 to SR modules): provides shares value

4. Shares are burnt (withdrawal finalization)

- `Lido.SharesBurnt`: creates transfer entity (from account to 0x0), shares value taken directly from event

Other entities used:

- `Totals`: provides `totalPooledEther` and `totalShares`
  - Used to calculate `balanceAfterIncrease`: `sharesAfterIncrease * totalPooledEther / totalShares`
  - Used to calculate `balanceAfterDecrease`: `sharesAfterDecrease * totalPooledEther / totalShares`
- `Shares` (for from/to addresses): provides account share balances
  - `sharesBeforeDecrease` = from address's current shares
  - `sharesAfterDecrease` = from address's shares after subtraction
  - `sharesBeforeIncrease` = to address's current shares
  - `sharesAfterIncrease` = to address's shares after addition
- `TotalReward`: identifies oracle report transfers and provides fee distribution data
  - Used to determine shares for treasury and node operator fee transfers

### TotalReward (immutable)

One per oracle report. Created iff profitable.

Notable fields:

- id (transaction hash)
- totalRewards / totalRewardsWithFees
- mevFee (execution layer rewards)
- feeBasis / treasuryFeeBasisPoints / operatorsFeeBasisPoints
- totalFee / treasuryFee / operatorsFee
- shares2mint / sharesToTreasury / sharesToOperators
- nodeOperatorFeesIds / nodeOperatorsSharesIds (references to per-module entities)
- totalPooledEtherBefore / totalPooledEtherAfter
- totalSharesBefore / totalSharesAfter
- timeElapsed
- apr / aprRaw / aprBeforeFees

When updated:

1. Oracle report

- `Lido.ETHDistributed`: creates entity; uses `preCLBalance`, `postCLBalance`, `withdrawalsWithdrawn`, `executionLayerRewardsWithdrawn` to calculate `totalRewards` and `mevFee`
- `Lido.TokenRebased`: provides values for `totalPooledEtherBefore/After`, `totalSharesBefore/After`, `shares2mint`, `timeElapsed`
- `Lido.Transfer` / `Lido.TransferShares` pairs (between ETHDistributed and TokenRebased): used to calculate fee distribution to treasury and SR modules

### NodeOperatorFees (immutable)

One per staking module that receives fees during an oracle report.

**Fields**: `id`, `totalRewardId`, `address`, `fee`

**When created**:

- During oracle report processing, for each `Lido.Transfer` from 0x0 to a staking module (NOR, SDVT, CSM)
- The `fee` field contains the ETH value transferred to that module

**Validation**: Sum of all `NodeOperatorFees.fee` for a report must equal `TotalReward.operatorsFee`

### NodeOperatorsShares (immutable)

One per staking module that receives shares during an oracle report.

**Fields**: `id`, `totalRewardId`, `address`, `shares`

**When created**:

- During oracle report processing, for each `Lido.TransferShares` from 0x0 to a staking module
- The `shares` field contains the shares minted to that module

**Validation**: Sum of all `NodeOperatorsShares.shares` for a report must equal `TotalReward.sharesToOperators`

### LidoSubmission (immutable)

One per user submission.

Notable fields:

- sender
- amount
- referral
- shares / sharesBefore / sharesAfter
- totalPooledEtherBefore / totalPooledEtherAfter
- totalSharesBefore / totalSharesAfter
- balanceAfter

When updated:

1. User submits ether

- `Lido.Submitted`: creates entity, provides `sender`, `amount`, `referral`
- `Lido.TransferShares`: provides `shares` value (parsed from next events in tx)

Other entities used:

- `Totals`: read before update, then updated with new amount/shares
  - `totalPooledEtherBefore` / `totalPooledEtherAfter`
  - `totalSharesBefore` / `totalSharesAfter`
- `Shares`: read sender's current shares
  - `sharesBefore` = sender's shares before submission
  - `sharesAfter` = sharesBefore + minted shares
- `balanceAfter` calculated as: `sharesAfter * totalPooledEtherAfter / totalSharesAfter`

### SharesBurn (immutable)

One per burn event.

Notable fields:

- account
- preRebaseTokenAmount
- postRebaseTokenAmount
- sharesAmount

When updated:

1. Withdrawal finalization (shares burnt from Burner contract)

- `Lido.SharesBurnt`: creates entity, provides `account`, `preRebaseTokenAmount`, `postRebaseTokenAmount`, `sharesAmount`

Side effects:

- Updates `Totals`: decreases `totalShares` by `sharesAmount`
- Creates `LidoTransfer` entity (from account to 0x0) with shares value from event
