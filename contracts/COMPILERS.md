# Compiler Versions Used in Lido Project

For Lido project coordination, governance, and funds management, we use [Aragon](https://aragon.org/dao), a
well-developed and proven DAO Framework. The current stable release of its
Kernel, [4.4.0](https://github.com/aragon/aragonOS/tree/v4.4.0), is fixed on a specific compiler
version - [solc 0.4.24](https://solidity.readthedocs.io/en/v0.4.24/), which is currently outdated. Keeping security and
consistency in mind, we decided to stay on an older yet proven combination. Therefore, for all the contracts under
Aragon management (`Lido`, `stETH`, `LegacyOracle`), we use the `solc 0.4.24` release.

For the `wstETH` contract, we use `solc 0.6.12`, as it is non-upgradeable and bound to this version.

For the other contracts, newer compiler versions are used.

# Compilation Instructions

```bash
yarn compile
```
