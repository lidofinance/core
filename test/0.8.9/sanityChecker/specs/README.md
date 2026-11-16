# Sanity Checker Formula Specs

This folder contains independent formula-level tests for sanity checks whose protocol math benefits from fixtures separate from contract plumbing.

## Two Layers

Technical tests live next to the contract test suites. They cover authorization, ABI mapping, external dependencies, storage-backed baselines, and custom errors.

Formula specs live under this folder. They calculate expected values in TypeScript and compare them with the Solidity implementation using named scenarios and explicit boundary values.

## Scope

- `module-balances`: pending, activation, ordinary-reward, and consolidation allowances used by the per-module validators-balance guard.

The aggregate CL rebase ranges are stateless amount comparisons and remain covered directly in `../oracleReportSanityChecker.rebase-ranges.test.ts`. The removed rolling negative-rebase window, migration baseline, and positive-rebase smoother are intentionally not modeled here.

## Fixture Rules

- Keep fixtures as data and put expected intermediate formula values next to each scenario.
- Keep contract deployment and ABI plumbing in the spec runner.
- Add fixtures for formula boundaries and interactions; keep low-level interface and authorization cases in the technical suites.
- Do not recreate migration or state that no longer exists in the production contracts.
