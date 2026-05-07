# Sanity Checker Formula Specs

This folder contains formula-level tests for sanity checks.

A fixture defines report sequence, movements, limits, and the expected formula outcome.
Each spec can have multiple fixture sets, for example common, Hoodi, or mainnet data. The spec runner imports
`fixtures/index.ts` and runs every exported set.

## Two Layers

Technical tests live next to the contract test suites, for example `../oracleReportSanityChecker.negative-rebase.test.ts`.
They cover Solidity mechanics:

- authorization and roles
- storage updates and migrations
- custom errors and event plumbing
- ABI argument mapping
- helper predicates and external dependencies

Formula specs live under this folder. They cover protocol math:

- domain fixtures instead of raw ABI calls
- expected formula values next to each scenario
- scenario titles and rationale
- report sequences, migration steps, and boundary cases

## Scope

- `negative-rebase`: 36-day negative CL rebase window
- `cl-increase`: protocol pending and validators growth budget
- `module-balances`: per-module validators growth budget

Other checks stay in the technical test files unless their formula becomes large enough to need fixtures.

## Fixture Rules

- describe reports, balances, movements, and limits
- put oracle reports under `steps`
- use `migration` as a separate step, not as a fake report
- put the full limits object on each fixture set exactly once
- use case `limits` only for explicit overrides
- keep fixtures as data, not helper code
- keep fixture sets in separate files and export them from `fixtures/index.ts`
- keep plumbing fields out of fixtures unless the formula itself depends on them
- add explicit expected formula values for boundary and regression cases
- add a fixture for each new formula scenario
