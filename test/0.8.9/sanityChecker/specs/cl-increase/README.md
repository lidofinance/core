# CL Increase Formula Specs

## Goal

Test the protocol-level pending and validators growth formula.

## Formula

Funded pending balance:

```ts
fundedPendingBalance = prePendingBalance + deposits;
pendingBalanceCap = fundedPendingBalance + externalPendingBalanceCap;
```

Activated balance:

```ts
activatedBalance = fundedPendingBalance > postPendingBalance ? fundedPendingBalance - postPendingBalance : 0n;
```

Validators growth budget:

```ts
validatorsGrowthLimit = activatedBalance + annualSafetyCap(preValidatorsBalance + activatedBalance, timeElapsed);
```

CL withdrawals reduce the validator baseline before reported validator growth is measured.
The runner maps fixture `clWithdrawals` to the withdrawal vault balance used by the contract.
Migration fixtures may also run the real `finalizeUpgrade_v4()` path before calling `migrateBaselineSnapshot()`.

## Files

- Library: `lib.ts`
- Fixture sets: `fixtures/*.ts`
- Fixture index: `fixtures/index.ts`
- Test runner: `spec.test.ts`

The runner imports `fixtures/index.ts` and runs every fixture set exported there. Add network-specific data as separate
files, for example `fixtures/migration-mainnet.ts`.

Each fixture set defines the full `OracleReportSanityChecker` limits object once. A case uses `steps`; the final report
step is checked, and previous steps set up migration/report state.

## Run

```bash
corepack yarn hardhat test test/0.8.9/sanityChecker/specs/cl-increase/spec.test.ts
```
