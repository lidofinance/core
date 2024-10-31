// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {DelegatorAlligator} from "./DelegatorAlligator.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {VaultHub} from "./VaultHub.sol";

contract VaultFacade is DelegatorAlligator {
    constructor(address _stakingVault, address _defaultAdmin) DelegatorAlligator(_stakingVault, _defaultAdmin) {}

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
}
