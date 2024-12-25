// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;
import {IStakingVault} from "./interfaces/IStakingVault.sol";

interface IDashboardACL {
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

    /// @notice Checks if a given address is a contract
    /// @param account The address to check
    /// @return True if the address is a contract, false otherwise
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
        if (!isContract(currentOwner)) return false;

        try IDashboardACL(currentOwner).hasRole(DEFAULT_ADMIN_ROLE, _owner) returns (bool result) {
            return result;
        } catch {
            return false;
        }
    }

    /// @notice Checks if a given address has a given role on a vault
    /// @param vault The vault to check
    /// @param _member The address to check
    /// @param _role The role to check
    /// @return True if the address has the role, false otherwise
    function hasRole(IVault vault, address _member, bytes32 _role) public view returns (bool) {
        address owner = vault.owner();
        if (owner == address(0)) {
            return false;
        }

        if (!isContract(owner)) return false;

        try IDashboardACL(owner).hasRole(_role, _member) returns (bool result) {
            return result;
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
        uint256 valid = 0;

        // Populate the array with the owner's vaults
        for (uint256 i = 0; i < count; i++) {
            IVault vaultInstance = IVault(vaultHub.vault(i));
            if (isOwner(vaultInstance, _owner)) {
                vaults[valid] = vaultHub.vault(i);
                valid++;
            }
        }

        return _filterNonZeroVaults(vaults, valid);
    }

    /// @notice Returns all vaults with a given role on a given address
    /// @param _role Role to check
    /// @param _member Address to check
    /// @return An array of vaults with the given role on the given address
    function vaultsByRole(bytes32 _role, address _member) public view returns (IVault[] memory) {
        uint256 count = vaultHub.vaultsCount();
        IVault[] memory vaults = new IVault[](count);

        uint256 valid = 0;
        for (uint256 i = 0; i < count; i++) {
            if (hasRole(vaultHub.vault(i), _member, _role)) {
                vaults[valid] = vaultHub.vault(i);
                valid++;
            }
        }

        return _filterNonZeroVaults(vaults, valid);
    }

    /// @notice Filters out zero address vaults from an array
    /// @param _vaults Array of vaults to filter
    /// @param _validCount number of non-zero vaults
    /// @return filtered An array of non-zero vaults
    function _filterNonZeroVaults(
        IVault[] memory _vaults,
        uint256 _validCount
    ) internal pure returns (IVault[] memory filtered) {
        filtered = new IVault[](_validCount);
        for (uint256 i = 0; i < _validCount; i++) {
            filtered[i] = _vaults[i];
        }
    }

    /// @notice Error for zero address arguments
    /// @param argName Name of the argument that is zero
    error ZeroArgument(string argName);
}
