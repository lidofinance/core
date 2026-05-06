# Module Balance Formula Specs

## Goal

Test per-module validators balance checks on top of the protocol-level CL increase formula.

## Formula

The checker first verifies that module validators balances sum to the reported post-CL validators balance.
That consistency check is covered by technical tests.

The formula specs focus on two budgets:

```ts
validatorsGrowthLimit = activatedBalance + annualSafetyCap;
moduleValidatorsGrowthLimit = validatorsGrowthLimit + consolidationLimit;
```

Only positive module deltas with previous accounting are aggregated:

```ts
totalPositiveModuleDelta = sum(max(postModuleValidators - previousModuleValidators, 0n));
```

Modules without previous accounting do not contribute to `totalPositiveModuleDelta`.

## Files

- Library: `lib.ts`
- Fixture sets: `fixtures/*.ts`
- Fixture index: `fixtures/index.ts`
- Test runner: `spec.test.ts`

The runner imports `fixtures/index.ts` and runs every fixture set exported there. Add network-specific data as separate
files, for example `fixtures/hoodi.ts` or `fixtures/mainnet.ts`.

Each fixture set defines the full `OracleReportSanityChecker` limits object once. Cases do not override limits.

## Run

```bash
corepack yarn hardhat test test/0.8.9/sanityChecker/specs/module-balances/spec.test.ts
```
