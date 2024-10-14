## Disclaimer!

This is the core repository of the Lido on Ethereum protocol. The entire codebase, excluding contracts, has undergone significant refactoring and tooling modernization. For historical context or legacy information, refer to the [last legacy commit](https://github.com/lidofinance/lido-dao/tree/de9e895879126b482effedd8fa1f2af3f7dc2dd4).

---

<div>
    <img alt="Lido" src="https://img.shields.io/badge/v2-version?label=lido&labelColor=rgb(91%2C%20162%2C%20252)&color=white"/>
    <img alt="GitHub license" src="https://img.shields.io/github/license/lidofinance/lido-dao?labelColor=orange&color=white"/>
    <img alt="Solidity" src="https://img.shields.io/badge/multiver-s?style=flat&label=solidity&labelColor=rgb(86%2C%2085%2C%20212)&color=white"/>
    <img alt="Aragon OS" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Flidofinance%2Fcore%2Fmaster%2Fpackage.json&query=%24.dependencies%5B'%40aragon%2Fos'%5D&style=flat&label=aragon%2Fos&labelColor=rgb(70%2C%20100%2C%20246)&color=white"/>
    <img alt="Node.js" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Flidofinance%2Fcore%2Fmaster%2Fpackage.json&query=%24.engines.node&style=flat&label=node.js&labelColor=rgb(62%2C%20109%2C%2026)&color=white"/>
    <img alt="TypeScript" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Flidofinance%2Fcore%2Fmaster%2Fpackage.json&query=%24.devDependencies.typescript&style=flat&label=typescript&labelColor=rgb(78%2C%20119%2C%20194)&color=white" />
    <img alt="Hardhat" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Flidofinance%2Fcore%2Fmaster%2Fpackage.json&query=%24.devDependencies.hardhat&style=flat&label=hardhat&labelColor=rgb(251%2C%20240%2C%2056)&color=white" />
    <img alt="Ethers" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Flidofinance%2Fcore%2Fmaster%2Fpackage.json&query=%24.devDependencies.ethers&style=flat&label=ethers&labelColor=rgb(51%2C%2077%2C%20121)&color=white" />
    <br/>
    <img alt="GitHub tests" src="https://img.shields.io/github/actions/workflow/status/lidofinance/core/tests.yml?label=tests">
    <img alt="GitHub linters" src="https://img.shields.io/github/actions/workflow/status/lidofinance/core/linters.yml?label=linters">
    <img alt="GitHub code analysis" src="https://img.shields.io/github/actions/workflow/status/lidofinance/core/analyse.yml?label=code analysis">
</div>

<div style="display: flex; flex-direction: column; align-items: center; justify-content: center;">
    <img alt="Lido on Ethereum Logo" src="./docs/assets/lido.png" />
</div>

**Lido on Ethereum** is a liquid-staking protocol allowing anyone to earn staking rewards without locking ether or maintaining infrastructure.

Users can deposit ether to the Lido smart contract and receive stETH tokens in return. The smart contract then stakes tokens with the DAO-picked node operators. Users' deposited funds are pooled by the DAO, and node operators never have direct access to the users' assets. Unlike staked ether, the stETH token is free from the limitations associated with a lack of liquidity, and can be transferred at any time. The stETH token balance corresponds to the amount of ether that the holder could request to withdraw.

**NB:** It's advised to read [Documentation](https://docs.lido.fi/) before getting started with this repo.

---

### Key features

- No minimum deposit amount,
- Instant rewards within 24 hours of deposit,
- stETH, an LST with the deepest liquidity in DeFi,
- In-protocol automated withdrawals,
- Governed by Lido DAO.

---

### Learn more

- [Lido DAO governance](https://docs.lido.fi/lido-dao)
- [Technical documentation](https://docs.lido.fi/contracts/lido)
- [Lido addresses](https://docs.lido.fi/deployed-contracts/)
- [Protocol levers](https://docs.lido.fi/guides/protocol-levers/)
- [Audits](https://github.com/lidofinance/audits)

## Bug Bounty

Please refer to the [Lido Bug Bounry](/bugbounty.md).

## Contributing

Please refer to the [Lido Contribution Guide](/CONTRIBUTING.md).

## Code of Conduct

Please refer to the [Lido Contributor Code of Conduct](/CODE_OF_CONDUCT.md).

## License

2024 Lido <info@lido.fi>

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, version 3 of the License, or any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU General Public License for more details.

You should have received a copy of the [GNU General Public License](LICENSE)
along with this program. If not, see <https://www.gnu.org/licenses/>.
