// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {VaultHub} from "./VaultHub.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";

// TODO: natspec

// provides internal liquidity plumbing through the vault hub
abstract contract VaultPlumbing {
    VaultHub public immutable vaultHub;
    IStakingVault public immutable stakingVault;

    constructor(address _stakingVault) {
        if (_stakingVault == address(0)) revert ZeroArgument("_stakingVault");

        stakingVault = IStakingVault(_stakingVault);
        vaultHub = VaultHub(stakingVault.vaultHub());
    }

    function _mint(address _recipient, uint256 _tokens) internal returns (uint256 locked) {
        return vaultHub.mintStethBackedByVault(address(stakingVault), _recipient, _tokens);
    }

    function _burn(uint256 _tokens) internal {
        vaultHub.burnStethBackedByVault(address(stakingVault), _tokens);
    }

    error ZeroArgument(string);
}
