# Graph tests intro

These graph integration tests are intended to simulate calculations done by the Graph based on
(mostly) events and compare with the actual on-chain state after a number of transactions.

## Scope & Limitations

- **V3 only**: Tests only V3 (post-V2) code paths; historical sync is skipped
- **Initial state from chain**: Simulator initializes from current on-chain state at test start
- **Legacy fields omitted**: V1 fields (`insuranceFee`, `dust`, `sharesToInsuranceFund`, etc.) are not implemented as they're unused since V2
- **OracleCompleted skipped**: Legacy entity tracking replaced by `TokenRebased.timeElapsed`

## Test Environment

- Hoodi testnet via forking
- Uses `lib/protocol/` helpers and `test/suite/` utilities

## Success Criteria

- **Exact match**: All `bigint` values must match exactly (no tolerance for rounding)
- **Entity consistency**: Simulator's `Totals` must match on-chain `lido.getTotalPooledEther()` and `lido.getTotalShares()`
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

Each transaction is processed through `GraphSimulator.processTransaction()` which parses events and updates entities. Validation helpers check:

- **`validateSubmission`**: Verifies `LidoSubmission` entity fields (`sender`, `amount`, `referral`, `shares > 0`)
- **`validateTransfer`**: Verifies `LidoTransfer` entity fields and share balance arithmetic:
  - `sharesBeforeDecrease - sharesAfterDecrease == shares`
  - `sharesAfterIncrease - sharesBeforeIncrease == shares`
- **`validateOracleReport`**: For profitable reports, verifies `TotalReward` fee distribution:
  - `shares2mint == sharesToTreasury + sharesToOperators`
  - `totalFee == treasuryFee + operatorsFee`
  - For non-profitable (zero/negative), verifies no `TotalReward` is created
- **`validateGlobalConsistency`**: Compares simulator's `Totals` entity against on-chain `lido.getTotalPooledEther()` and `lido.getTotalShares()`

## Specifics

- This document does not describe legacy code written for pre-V2 upgrade.
- there are specific workarounds for specific networks for cases when an event does not exist ([Voting example](https://github.com/lidofinance/lido-subgraph/blob/6334a6a28ab6978b66d45220a27c3c2dc78be918/src/Voting.ts#L67))

## Entities

Subgraph calculates and stores various data structures called entities. Some of them are iteratively modified (cumulative), e.g. total pooled ether. Some of them are immutable like stETH transfers.

### Totals (cumulative)

Notable fields:

- totalPooledEther
- totalShares

Events used when:

1. User submits ether

- `Lido.Submitted`: `amount`

2. Oracle reports

- `Lido.TokenRebased`: `postTotalShares`, `postTotalEther`
- `Lido.SharesBurnt.sharesAmount`

3. StETH minted on VaultHub

- `Lido.ExternalSharesMinted`: increases `totalShares` by `amountOfShares`, updates `totalPooledEther` via contract read

4. External shares burnt (emitted by `VaultHub.burnShares`, `Lido.rebalanceExternalEtherToInternal()`, `Lido.internalizeExternalBadDebt`)

- `Lido.ExternalSharesBurnt`: updates `totalPooledEther` via contract read

### Shares (cumulative)

Notable fields:

- id (holder address as Bytes)
- shares

When updated:

1. User submits ether

- `Lido.Transfer` (from 0x0 to user): increases user's shares
- `Lido.TransferShares` (from 0x0 to user): provides shares value

2. User transfers stETH

- `Lido.Transfer` (from user to recipient): decreases sender's shares, increases recipient's shares
- `Lido.TransferShares` (from user to recipient): provides shares value

3. Oracle reports rewards

- `Lido.Transfer` (from 0x0 to Treasury): increases Treasury's shares
- `Lido.Transfer` (from 0x0 to SR modules): increases SR module's shares

4. Shares are burnt (withdrawal finalization)

- `Lido.SharesBurnt`: decreases account's shares

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

One per oracle report.

Notable fields:

- id (transaction hash)
- totalRewards / totalRewardsWithFees
- mevFee (execution layer rewards)
- feeBasis / treasuryFeeBasisPoints / operatorsFeeBasisPoints
- totalFee / treasuryFee / operatorsFee
- shares2mint / sharesToTreasury / sharesToOperators
- totalPooledEtherBefore / totalPooledEtherAfter
- totalSharesBefore / totalSharesAfter
- timeElapsed
- apr / aprRaw / aprBeforeFees

When updated:

1. Oracle report

- `Lido.ETHDistributed`: creates entity; uses `preCLBalance`, `postCLBalance`, `withdrawalsWithdrawn`, `executionLayerRewardsWithdrawn` to calculate `totalRewards` and `mevFee`
- `Lido.TokenRebased`: provides values for `totalPooledEtherBefore/After`, `totalSharesBefore/After`, `shares2mint`, `timeElapsed`
- `Lido.Transfer` / `Lido.TransferShares` pairs (between ETHDistributed and TokenRebased): used to calculate fee distribution to treasury and SR modules

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
