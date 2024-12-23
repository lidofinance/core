// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/OwnableUpgradeable.sol";


interface IDashboard {
    function getRoleMember(bytes32 role, uint256 index) external view returns (address);
    function hasRole(bytes32 role, address account) external view returns (bool);
}

interface IVault is IStakingVault {
    function owner() external view returns (address);
}

interface IVaultHub {
    function vaultsCount() external view returns (uint256);
    function vault(uint256 _index) external view returns (IVault);
}

contract VaultHubViewerV1 {
    IVaultHub public immutable vaultHub;
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    constructor(address _vaultHubAddress) {
        if (_vaultHubAddress == address(0)) revert ZeroArgument("_vaultHubAddress");
        vaultHub = IVaultHub(_vaultHubAddress);
    }

    function isContract(address account) public view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(account)
        }
        return size > 0;
    }


    /// @notice Checks if a given address is the owner of a vault
    /// @param vault The vault to check
    /// @param _owner The address to check
    /// @return True if the address is the owner, false otherwise
    function isOwner(IVault vault, address _owner) public view returns (bool) {
        address currentOwner = vault.owner();
        if (currentOwner == _owner) {
            return true;
        }
        if (isContract(currentOwner)) {
            try IDashboard(currentOwner).hasRole(DEFAULT_ADMIN_ROLE, _owner) returns (bool hasRole) {
                return hasRole;
            } catch {
                return false;
            }
        }
        return false;
    }

    /// @notice Checks if a given address has a given role on a vault
    /// @param vault The vault to check
    /// @param _member The address to check
    /// @param _role The role to check
    /// @return True if the address has the role, false otherwise
    function isHasRole(IVault vault, address _member, bytes32 _role) public view returns (bool) {
        address owner = vault.owner();
        if (owner == address(0)) {
            return false;
        }

        try IDashboard(owner).hasRole(_role, _member) returns (bool hasRole) {
                return hasRole;
        } catch {
                return false;
        }
    }

    /// @notice Returns all vaults owned by a given address
    /// @param _owner Address of the owner
    /// @return An array of vaults owned by the given address
    function vaultsByOwner(address _owner) public view returns (IVault[] memory) {
        uint256 count = vaultHub.vaultsCount();
        IVault[] memory vaults = new IVault[](count);

        // Populate the array with the owner's vaults
        for (uint256 i = 0; i < count; i++) {
            if (isOwner(vaultHub.vault(i), _owner)) {
                vaults[i] = vaultHub.vault(i);
            }
        }

        return _filterNonZeroVaults(vaults);
    }

    /// @notice Returns all vaults with a given role on a given address
    /// @param _role Role to check
    /// @param _member Address to check
    /// @return An array of vaults with the given role on the given address
    function vaultsByRole(bytes32 _role, address _member) public view returns (IVault[] memory) {
        uint256 count = vaultHub.vaultsCount();
        IVault[] memory vaults = new IVault[](count);

        for (uint256 i = 0; i < count; i++) {
            if (isHasRole(vaultHub.vault(i), _member, _role)) {
                vaults[i] = vaultHub.vault(i);
            }
        }

        return _filterNonZeroVaults(vaults);
    }

    /// @notice Filters out zero address vaults from an array
    /// @param vaults Array of vaults to filter
    /// @return An array of non-zero vaults
    function _filterNonZeroVaults(IVault[] memory vaults) internal pure returns (IVault[] memory) {
        uint256 nonZeroLength = 0;
        for (uint256 i = 0; i < vaults.length; i++) {
            if (address(vaults[i]) != address(0)) {
                nonZeroLength++;
            }
        }
        IVault[] memory nonZeroVaults = new IVault[](nonZeroLength);
        uint256 index = 0;
        for (uint256 i = 0; i < vaults.length; i++) {
            if (address(vaults[i]) != address(0)) {
                nonZeroVaults[index] = vaults[i];
                index++;
            }
        }
        return nonZeroVaults;
    }

    /// @notice Error for zero address arguments
    /// @param argName Name of the argument that is zero
    error ZeroArgument(string argName);
}
