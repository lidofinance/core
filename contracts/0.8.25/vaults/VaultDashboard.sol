// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {VaultStaffRoom} from "./VaultStaffRoom.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {VaultHub} from "./VaultHub.sol";

// TODO: natspec
// TODO: think about the name

contract VaultDashboard is VaultStaffRoom {
    constructor(address _stakingVault, address _defaultAdmin) VaultStaffRoom(_stakingVault, _defaultAdmin) {}

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

    function reserveRatio() external view returns (int256) {
        return vaultHub.reserveRatio(address(stakingVault));
    }

    function thresholdReserveRatioBP() external view returns (uint16) {
        return vaultHub.vaultSocket(address(stakingVault)).thresholdReserveRatioBP;
    }

    function treasuryFeeBP() external view returns (uint16) {
        return vaultHub.vaultSocket(address(stakingVault)).treasuryFeeBP;
    }

    /// LIQUIDITY FUNCTIONS ///

    function mint(
        address _recipient,
        uint256 _tokens
    ) external payable onlyRoles(MANAGER_ROLE, FUNDER_ROLE) fundAndProceed {
        _mint(_recipient, _tokens);
    }

    function burn(uint256 _tokens) external onlyRole(MANAGER_ROLE) {
        _burn(_tokens);
    }

    function rebalanceVault(uint256 _ether) external payable onlyRoles(MANAGER_ROLE, FUNDER_ROLE) fundAndProceed {
        stakingVault.rebalance{value: msg.value}(_ether);
    }
}
