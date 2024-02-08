# Lido Core

## Develop

```sh
# install deps
pnpm install

# run tests
pnpm test
```

## Setup

- node.js v20
- pnpm
- hardhat
- ethers v6
- typechain
- commitlint
- lint-staged
- eslint
- prettier
- solhint
- slither

## Todos

- anvil
- readme

## Conventions

- use the `batch` helper to resolve multiple promises in parallel
- use `Snapshot` helper to restore the state at the end of suite
- use `expect` statements instead of `assert`

### Pending

- test optional ERC-20 methods
