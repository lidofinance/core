# Lido Contribution Guide

Welcome to the Lido Contribution Guide! Thank you for your interest in contributing to Lido! Join our community of
contributors who are passionate about advancing liquid staking. Whether you're fixing a bug, adding a new feature, or
improving the documentation, your contribution is valuable and your effort to make Lido better is appreciated.

## Ways to Contribute

### Opening an Issue

Issues are a great way to contribute to the project by reporting bugs or suggesting enhancements.

- **Bug Reports**. If you encounter a bug, please report it using the GitHub issues feature. Check first to ensure the
  bug hasn't already been reported. If it has, you can contribute further by adding more detail to the existing report.
  _Note that this only relates to off-chain code (tests, scripts, etc.), for bugs in contracts and protocol
  vulnerabilities, please refer to [Bug Bounty](/README.md#bug-bounty)_.

- **Feature Requests**: Have an idea for a new feature or an improvement to an existing one? Submit a feature request
  through the GitHub issues, detailing your proposed enhancements and how they would benefit the Lido Finance Core.

### Improving Documentation

Good documentation is crucial for any project. If you have suggestions for improving the documentation, or if you've
noticed an omission or error, making these corrections is a significant contribution. Whether it's a typo, additional
examples, or clearer explanations, your help in making the documentation more accessible and understandable is highly
appreciated.

For expansive documentation, visit the [Lido Docs repo](https://github.com/lidofinance/docs).

### Contributing to codebase

Contributing by resolving open issues is a valuable way to help improve the project. Look through the existing issues
for something that interests you or matches your expertise. Don't hesitate to ask for more information or clarification
if needed before starting. If you're interested in improving tooling and CI in this repository, consider opening a
feature request issue first to discuss it with the community of contributors.

If you have a bigger idea on how to improve the protocol, consider publishing your proposal
to [Lido Forum](https://research.lido.fi/).

## Getting started

### Requirements

- [Node.js](https://nodejs.org/en) version 20 (LTS) with `corepack` enabled
- [Yarn](https://yarnpkg.com/) installed via corepack (see below)
- [Foundry](https://book.getfoundry.sh/) latest available version

> [!NOTE]
> On macOS with Homebrew it is recommended to install Node.js using [`n`](https://github.com/tj/n)
> or [`nvm`](https://github.com/nvm-sh/nvm) version managers.  
> Example setup process using `n` package manager for zsh users:
>
> ```
> $ brew install n
> $ echo "\n\nexport N_PREFIX=\$HOME/.local\nexport PATH=\$N_PREFIX/bin:\$PATH" >> ~/.zshrc
> $ source ~/.zshrc
> $ n lts
> $ corepack enable
> $ cd /path/to/core
> $ yarn
> ```

### Setup

> Installation is local and doesn't require root privileges.

Install dependencies

```bash
yarn install
```

### Test

Run Hardhat tests

```bash
yarn test
```

See `package.json` for more commands.

## Local deployment

WIP

## Conventions

All contributions must follow the established conventions:

1. All Solidity code must be autoformatted using Solhint. Contracts largely follow
   the [Official Solidity Guide](https://docs.soliditylang.org/en/latest/style-guide.html) with some exceptions. When
   writing contracts, refer to existing contracts for conventions, naming patterns, formatting, etc.
2. All TypeScript code must be autoformatted using ESLint. When writing tests and scripts, please refer to existing
   codebase.
3. Commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) format.

The repository includes a commit hook that checks your code and commit messages, resolve any issues before submitting a
pull request.

## Branches

### `master`

The production branch of the protocol and the default branch of the repository.
The [deployed protocol contracts](https://docs.lido.fi/deployed-contracts/) must match what is stored in
the `/contracts` directory. Pull requests to `master` must originate from `develop` branch and have at least one
approving review before merging.

### `develop`

The development branch. All pull requests to `master` must be submitted to `develop` first for peer review. If
appropriate, delete the feature branch after merging to `develop`.

## Repository structure

### Contracts

All production contracts are located in `/contracts` in the root of the project. The subdirectory names indicate the
Solidity version of the contracts inside, e.g. the contracts in `/contracts/0.4.24` are all written in Solidity v0.4.24.
Common interfaces and libraries shared by contracts with different versions are located in `/contracts/common`
subdirectory.

### Tests

This repository features a Hardhat-Foundry dual setup:

- Hardhat gives much more flexibility when writing complex tests;
- Foundry's anvil is faster than the Hardhat Network;
- Foundry fuzzing capabilities allows for a better edge-case coverage.

#### Tracing

`hardhat-tracer` is used to trace contract calls and state changes during tests.
Full scale transaction tracing is disabled by default because it can significantly slow down the tests.

To enable tracing, you need wrap the code you want to trace with `Tracer.enable()` and `Tracer.disable()` functions and
run the tests with commands that have the `:trace` or `:fulltrace` postfix.

```typescript
import { Tracer } from 'test/suite';

describe('MyContract', () => {
  it('should do something', async () => {
    Tracer.enable();
    // code to trace
    Tracer.disable();
  });
});
```

And then run the tests with the following commands:

```bash
yarn test:trace                   # Run all tests with trace logging (calls only)
yarn test:fulltrace               # Run all tests with full trace logging (calls and storage ops)
yarn test:integration:trace       # Run all integration tests with trace logging
yarn test:integration:fulltrace   # Run all integration tests with full trace logging
```

> [!NOTE]
> Tracing is not supported in Foundry tests and integration tests other that Hardhat mainnet fork tests.

#### Hardhat

Hardhat tests are all located in ` / tests` in the root of the project.
Each subdirectory name corresponds to the version of the contract being tested, mirroring the ` / contracts` directory
structure. Integration, regression and other non-unit tests are placed into corresponding subdirectories,
e.g. ` / tests / integration / `, ` / tests / regression`, etc.

```bash
yarn test               # Run all tests in parallel
yarn test:sequential    # Run all tests sequentially
yarn test:trace         # Run all tests with trace logging (see Tracing section)
yarn test:watch         # Run all tests in watch mode
```

#### Foundry

Foundry's Solidity tests are used only for fuzzing library contracts or functions performing complex calculations
or byte juggling. Solidity tests are located under ` / tests` and in the appropriate subdirectories. Naming conventions
follow the Foundry's [documentation](https://book.getfoundry.sh/tutorials/best-practices#general-test-guidance):

- for tests, postfix `.t.sol` is used (e.g., `MyContract.t.sol`)
- for scripts, postfix `.s.sol` is used (e.g., `MyScript.s.sol`)
- for helpers, postfix `.h.sol` is used (e.g., `MyHelper.h.sol`).

Following the convention of distinguishing Hardhat test files from Foundry-related files is essential to ensure the
proper execution of Hardhat tests.

```bash
yarn test:foundry        # Run all Foundry tests
```

#### Integration tests

Integration tests are located in ` / tests / integration` in the root of the project.
These tests are used to verify the interaction between different contracts and their behavior in a real-world scenario.

You can run integration tests in multiple ways, but for all of them, you need to have a `.env` file in the root of
the project (you can use `.env.example` as a template).

##### Hardhat Mainnet Fork

This is the most common way to run integration tests. It uses the Hardhat mainnet fork to simulate the mainnet
environment. Requires `HARDHAT_FORKING_URL` and `HARDHAT_FORKING_BLOCK_NUMBER` (optional) to be set in the `.env` file
along with `MAINNET_*` env variables (see `.env.example`).

```bash
yarn test:integration         # Run all integration tests
yarn test:integration:trace   # Run all integration tests with trace logging (see Tracing section) 
```

##### Local setup

This method is used to run integration tests against a local scratch deployment (
see [scratch-deploy.md](./docs/scratch-deploy.md)).
Requires `LOCAL_*` env variables to be set and a local deployment to be running on port `8555`.

```bash
yarn test:integration:local
```

##### Any fork setup

This method is used to run integration tests against any fork. Requires `MAINNET_*` env variables to be set in the
`.env` file and a fork to be running on port `8545`.

```bash
yarn test:integration:fork
```

#### Coverage

Project uses `hardhat-coverage` plugin to generate coverage reports.
Foundry tests are not included in the coverage.

To generate coverage reports, run the following command:

```bash
yarn test:coverage
```

#### Mocks

The `/tests` directory also contains contract mocks and helpers which are placed in the `.../contracts` subdirectory,
e.g. `/tests/0.4.24/contracts`. Mocks and helpers **DO NOT** have to be written using the version of Solidity of the
contract being tested. For example, it is okay to have a mock contract written in Solidity v0.8.9
in `/tests/0.4.24/contracts`.

### Library

TypeScript utilities and helpers are located in `/lib` in the root of the project. When adding a new file to this
directory, please re-export everything from the `/lib/index.ts` file to keep import statement clean.

### Typechain types

All typechain types are placed in `/typechain-types` in the root of the project. DO NOT manually edit in this directory.
These types are autogenerated on each compilation.

There have been issues with IDEs failing to properly index this directory resulting in import errors. If you are
experiencing similar issues, the solutions above should resolve them:

- open the `/typechain-types/index.ts` file to force the IDE to index it;
- delete the directory and re-compile `yarn hardhat compile --force`.

### Config files

All configuration files are located in the root of the project.

## Code of Conduct

Please refer to the [Lido Contributor Code of Conduct](/CODE_OF_CONDUCT.md).
