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

## Report Shape

Each report describes one oracle report snapshot:

```ts
{
  label: "baseline report",
  timeElapsed: DAY,
  cl: {
    preValidatorsBalance: ether("10000"),
    prePendingBalance: 0n,
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

Do not put ABI plumbing fields like `withdrawalVaultBalance` or `withdrawalsVaultTransfer` into fixtures.
The runner translates `movements.clWithdrawals` into the ABI inputs used by `checkAccountingOracleReport(...)`.

## Case Shape

Each case has:

```ts
{
  title: "short behavior description",
  rationale: "why this scenario matters to the formula",
  reports: [
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
    prePendingBalance: 0n,
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
recreatedPostCLBalance = baselineCLBalance + totalDeposits - totalCLWithdrawals;
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
  reports: [
    // setup reports
    // final checked report goes last
  ],
  expected: {
    outcome: "revert", // or "accepted"
  },
}
```

The last report is the checked report. Previous reports are setup snapshots.

The runner calculates the window diff and compares it with optional fixture numbers before calling the contract.

To add network-specific data, create a separate fixture file such as `fixtures/hoodi.ts` or `fixtures/mainnet.ts`, then
export its fixture set from `fixtures/index.ts`.

## Run

```bash
corepack yarn hardhat test test/0.8.9/sanityChecker/specs/negative-rebase/spec.test.ts
```
