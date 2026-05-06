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

## Files

- Library: `lib.ts`
- Fixture data: `fixtures.ts`
- Test runner: `spec.test.ts`

## Run

```bash
corepack yarn hardhat test test/0.8.9/sanityChecker/specs/cl-increase/spec.test.ts
```
