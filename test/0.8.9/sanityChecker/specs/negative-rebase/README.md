# Negative Rebase Formula Specs

## Goal

Test the negative CL rebase formula with oracle report fixtures.

## Files

- Library: `lib.ts`
- Fixture sets: `fixtures/*.ts`
- Fixture index: `fixtures/index.ts`
- Test runner: `spec.test.ts`
- Common rules: `../README.md`

The lower-level Solidity plumbing tests stay in `../../oracleReportSanityChecker.negative-rebase.test.ts`.
Those tests cover authorization, storage side effects, second opinion oracle behavior, migration, and custom errors
that are not part of the formula.

## Step Shape

Each case is a `steps` sequence. A report step describes one oracle report snapshot:

```ts
{
  kind: "report",
  label: "baseline report",
  timeElapsed: DAY,
  cl: {
    preValidatorsBalance: ether("10000"),
    postValidatorsBalance: ether("10000"),
    postPendingBalance: 0n,
  },
  movements: {
    deposits: 0n,
    clWithdrawals: 0n,
  },
}
```

Use `ether("10000")` for ETH-denominated values in wei.

Do not put derived constants or calculation helpers into fixtures.

The runner translates `movements.clWithdrawals` into the withdrawal vault balance used by
`checkAccountingOracleReport(...)`.
Use `movements.withdrawalsVaultTransfer` only when the report explicitly transfers a different amount from the
withdrawal vault than the fresh `clWithdrawals` delta.

Use a migration step when the scenario starts from `migrateBaselineSnapshot()`:

```ts
migrate({
  label: "migration baseline",
  clValidators: 3_125n,
  transientDeposits: 0n,
  withdrawalVaultBalance: ether("10000"),
});
```

The migration call itself has no arguments. The fixture step describes the v3 state seeded before
`finalizeUpgrade_v4()` and the withdrawal vault balance observed by `migrateBaselineSnapshot()`.
Migrated CL balance is derived as `clValidators * 32 ETH`.
`transientDeposits` is the amount submitted to the deposit contract after the last report; the runner derives
`depositedValidators` from it.

```ts
migrate({
  label: "Mainnet finalized v4 migration",
  clValidators: 281_250n,
  transientDeposits: 0n,
  withdrawalVaultBalance: ether("100000"),
});
```

## Case Shape

Each fixture set has the full limits object exactly once:

```ts
{
  title: "hoodi",
  limits: {
    exitedEthAmountPerDayLimit: 57_600n,
    appearedEthAmountPerDayLimit: 57_600n,
    annualBalanceIncreaseBPLimit: 1_000n,
    simulatedShareRateDeviationBPLimit: 50n,
    maxBalanceExitRequestedPerReportInEth: 19_200n,
    maxEffectiveBalanceWeightWCType01: 32n,
    maxEffectiveBalanceWeightWCType02: 2_048n,
    maxItemsPerExtraDataTransaction: 8n,
    maxNodeOperatorsPerExtraDataItem: 24n,
    requestTimestampMargin: 128n,
    maxPositiveTokenRebase: 750_000n,
    maxCLBalanceDecreaseBP: 360n,
    clBalanceOraclesErrorUpperBPLimit: 50n,
    consolidationEthAmountPerDayLimit: 93_375n,
    exitedValidatorEthAmountLimit: 32n,
    externalPendingBalanceCapEth: 300n,
  },
  cases: [],
}
```

Use case `limits` only when a scenario explicitly overrides the fixture set limits.

Each case has:

```ts
{
  title: "short behavior description",
  rationale: "why this scenario matters to the formula",
  steps: [
    // setup reports
    // final checked report goes last
  ],
  expected: {
    outcome: "revert", // or "accepted"
    window: {
      actualCLBalanceDiff: ether("500"),
      maxAllowedCLBalanceDiff: ether("378"),
    },
  },
}
```

`expected.window` is optional. Use it for boundary and regression cases.

## Repeating Reports

To fill a 36-day window with identical reports:

```ts
...repeatReports(36, (index) =>
  report({
    label: `stable report ${index + 1}`,
    preValidatorsBalance: ether("10000"),
    postValidatorsBalance: ether("10000"),
    postPendingBalance: 0n,
    deposits: 0n,
    clWithdrawals: 0n,
  }),
),
```

## Formula

The recreated post-CL balance is:

```ts
adjustedWindowBalance = baselineCLBalance + totalDeposits;
recreatedPostCLBalance = adjustedWindowBalance > totalCLWithdrawals ? adjustedWindowBalance - totalCLWithdrawals : 0n;
```

The negative rebase diff is:

```ts
actualCLBalanceDiff =
  recreatedPostCLBalance > currentPostCLBalance ? recreatedPostCLBalance - currentPostCLBalance : 0n;
```

The contract reverts only when:

```ts
actualCLBalanceDiff > maxAllowedCLBalanceDiff;
```

So `actualCLBalanceDiff == maxAllowedCLBalanceDiff` is accepted.

## Adding A Case

Add a new object to an existing fixture set:

```ts
{
  title: "short behavior description",
  rationale: "why this scenario matters",
  steps: [
    // setup reports
    // final checked report goes last
  ],
  expected: {
    outcome: "revert", // or "accepted"
  },
}
```

The last report step is the checked report. Previous steps are setup state.

The runner calculates the window diff and compares it with optional fixture numbers before calling the contract.

To add network-specific data, create a separate fixture file such as `fixtures/hoodi.ts` or `fixtures/mainnet.ts`, then
export its fixture set from `fixtures/index.ts`.

## Run

```bash
corepack yarn hardhat test test/0.8.9/sanityChecker/specs/negative-rebase/spec.test.ts
```
