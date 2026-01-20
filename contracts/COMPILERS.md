# Compiler Versions Used in Lido Project

For Lido project coordination, governance, and funds management, we use [Aragon](https://aragon.org/dao), a
well-developed and proven DAO Framework. The current stable release of its
Kernel, [4.4.0](https://github.com/aragon/aragonOS/tree/v4.4.0), is fixed on a specific compiler
version - [solc 0.4.24](https://solidity.readthedocs.io/en/v0.4.24/), which is currently outdated. Keeping security and
consistency in mind, we decided to stay on an older yet proven combination. Therefore, for all the contracts under
Aragon management (`Lido`, `stETH`, `NodeOperatorsRegistry`), we use the `solc 0.4.24` release.

For the `wstETH` contract, we use `solc 0.6.12`, as it is non-upgradeable and bound to this version.

For the other contracts, newer compiler versions are used.

The `solc 0.8.25` version of the compiler was introduced for Lido Vaults to be able to support [OpenZeppelin v5.2.0](https://github.com/OpenZeppelin/openzeppelin-contracts/tree/v5.2.0) dependencies (under the "@openzeppelin/contracts-v5.2" alias).

NB! The OpenZeppelin 5.2.0 upgradeable contracts are copied locally in this repository (`contracts/openzeppelin/5.2/upgradeable`) instead of being imported from npm. This is because the original upgradeable contracts import from "@openzeppelin/contracts", but we use a custom alias "@openzeppelin/contracts-v5.2" to manage multiple OpenZeppelin versions. To resolve these import conflicts, we maintain local copies of the upgradeable contracts with corrected import paths that reference our aliased version.

## Compilation Instructions

```bash
yarn compile
```
