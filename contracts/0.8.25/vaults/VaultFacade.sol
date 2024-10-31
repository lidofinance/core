// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {DelegatorAlligator} from "./DelegatorAlligator.sol";
import {VaultHub} from "./VaultHub.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";

contract VaultFacade is DelegatorAlligator {
    VaultHub public immutable vaultHub;

    constructor(address _stakingVault, address _defaultAdmin) DelegatorAlligator(_stakingVault, _defaultAdmin) {
        vaultHub = VaultHub(stakingVault.vaultHub());
    }

    /// GETTERS ///

    function vaultSocket() external view returns (VaultHub.VaultSocket memory) {
        return vaultHub.vaultSocket(address(stakingVault));
    }

    function shareLimit() external view returns (uint96) {
        return vaultHub.vaultSocket(address(stakingVault)).shareLimit;
    }

    function sharesMinted() external view returns (uint96) {
        return vaultHub.vaultSocket(address(stakingVault)).sharesMinted;
    }

    function minReserveRatioBP() external view returns (uint16) {
        return vaultHub.vaultSocket(address(stakingVault)).minReserveRatioBP;
    }

    function thresholdReserveRatioBP() external view returns (uint16) {
        return vaultHub.vaultSocket(address(stakingVault)).thresholdReserveRatioBP;
    }

    function treasuryFeeBP() external view returns (uint16) {
        return vaultHub.vaultSocket(address(stakingVault)).treasuryFeeBP;
    }

    /// LIQUIDITY ///

    function mint(address _recipient, uint256 _tokens) external payable onlyRole(MANAGER_ROLE) {
        vaultHub.mintStethBackedByVault(address(stakingVault), _recipient, _tokens);
    }

    function burn(uint256 _tokens) external onlyRole(MANAGER_ROLE) {
        vaultHub.burnStethBackedByVault(address(stakingVault), _tokens);
    }

    function rebalanceVault(uint256 _ether) external payable onlyRole(MANAGER_ROLE) {
        stakingVault.rebalance{value: msg.value}(_ether);
    }
}
