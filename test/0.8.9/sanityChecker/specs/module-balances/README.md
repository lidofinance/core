# Module Balance Formula Specs

## Goal

Check the per-module validators-balance guard against an independent TypeScript implementation of its current formula.

## Formula

The model first bounds the reported pending balance:

```ts
fundedPendingBalance = prePendingBalance + deposits;
pendingBalanceCap = fundedPendingBalance + externalPendingBalanceCap;
```

Pending consumed by the report is treated as activated balance. Its period allowance includes one 2048 ETH validator to account for discrete Electra activations:

```ts
activatedBalance = max(fundedPendingBalance - postPendingBalance, 0n);
activatedBalanceLimit = appearedBalanceAllowance + 2048 ETH;
```

The module-growth budget consists of activated balance, the annual soft rewards allowance calculated on `preValidatorsBalance + activatedBalance`, and the consolidation allowance:

```ts
moduleGrowthLimit = activatedBalance + annualSoftAllowance + consolidationAllowance;
```

Only positive deltas of modules with a previous accounting baseline consume this budget:

```ts
grossPositiveModuleDeltas = sum(max(postModuleBalance - previousModuleBalance, 0n));
```

A newly registered empty module has no baseline, so its first reported balance is excluded from the delta aggregation. Subsequent reports use the balance stored by `StakingRouter`.

Zero elapsed time uses the same one-hour effective interval as the contract.

## Scope

These specs exercise `checkModuleAndCLBalancesChangeRates(...)`. They intentionally do not model migration, vault transfers, accounting-report application, or the separate aggregate CL rebase classifier.

## Files

- Independent formula: `lib.ts`
- Fixtures: `fixtures/*.ts`
- Fixture index: `fixtures/index.ts`
- Contract runner: `spec.test.ts`

## Run

```bash
corepack yarn hardhat test test/0.8.9/sanityChecker/specs/module-balances/spec.test.ts
```
