# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Lido on Ethereum liquid-staking protocol core contracts repository. Users deposit ETH and receive stETH tokens representing their stake. The protocol uses Aragon DAO for governance.

## Build & Test Commands

```bash
yarn compile                    # Compile all contracts
yarn test                       # Run all unit tests (parallel)
yarn test:sequential            # Run tests sequentially (required for .only)
yarn test:trace                 # Run with call tracing
yarn test:forge                 # Run Foundry fuzzing tests
yarn test:integration:scratch   # Integration tests on scratch deploy
yarn test:integration           # Integration tests on mainnet fork
yarn lint                       # Run all linters
yarn lint:sol:fix              # Fix Solidity lint issues
yarn lint:ts:fix               # Fix TypeScript lint issues
yarn format:fix                # Fix formatting
yarn typecheck                 # TypeScript type checking
```

To run a single test: add `.only` to the test and run `yarn test:sequential`.

Environment: Copy `.env.example` to `.env` and configure `RPC_URL` for mainnet fork tests.

## Project Structure

### Contracts (`/contracts`)

Organized by Solidity version:

- `0.4.24/` - Core Aragon-managed contracts (Lido, stETH, NodeOperatorsRegistry)
- `0.6.12/` - wstETH (non-upgradeable, version-locked)
- `0.8.9/` - Modern contracts (StakingRouter, WithdrawalQueue, Oracles, Accounting)
- `0.8.25/` - Staking Vaults system (VaultHub, StakingVault, Dashboard, PredepositGuarantee)
- `common/` - Shared interfaces and libraries across versions

### Tests (`/test`)

Mirror the contracts structure. Naming conventions:

- `*.test.ts` - Hardhat unit tests
- `*.integration.ts` - Integration tests
- `*.t.sol` - Foundry tests (fuzzing)
- `__Harness` suffix - Test wrappers exposing private functions
- `__Mock` suffix - Simulated contract behavior

### Library (`/lib`)

TypeScript utilities for tests and scripts. Key modules:

- `protocol/` - Protocol discovery and helpers (accounting, staking, withdrawal, vaults)
- `eips/` - EIP implementations (EIP-712, EIP-4788, EIP-7002, EIP-7251)
- Test helpers: deposit, dsm, oracle, signing-keys

### Scripts (`/scripts`)

- `scratch/steps/` - Scratch deployment steps
- `upgrade/steps/` - Protocol upgrade scripts

## Architecture Notes

**Multi-compiler setup**: Different contracts use different Solidity versions due to Aragon compatibility (0.4.24) and feature requirements. See `contracts/COMPILERS.md`.

**OpenZeppelin v5.2 local copies**: Located in `contracts/openzeppelin/5.2/upgradeable/` with modified imports to support the aliased dependency `@openzeppelin/contracts-v5.2`.

**Tracing in tests**: Wrap code with `Tracing.enable()` and `Tracing.disable()` from `test/suite`, then run with `yarn test:trace`.

## Conventions

- Package manager: yarn (not npx)
- Commits: Conventional Commits format
- Solidity: Follow Official Solidity Style Guide, auto-format with Solhint
- TypeScript: Auto-format with ESLint
- Temporary data: Store in `data/temp/` directory
