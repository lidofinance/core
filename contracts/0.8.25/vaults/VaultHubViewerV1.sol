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

/// @todo VaultHub.VaultSocket should be public to remove duplicate initialization from here
struct VaultSocket {
    // ### 1st slot
    /// @notice vault address
    address vault;
    /// @notice total number of stETH shares minted by the vault
    uint96 sharesMinted;
    // ### 2nd slot
    /// @notice maximum number of stETH shares that can be minted by vault owner
    uint96 shareLimit;
    /// @notice minimal share of ether that is reserved for each stETH minted
    uint16 reserveRatioBP;
    /// @notice if vault's reserve decreases to this threshold ratio,
    /// it should be force rebalanced
    uint16 reserveRatioThresholdBP;
    /// @notice treasury fee in basis points
    uint16 treasuryFeeBP;
    /// @notice if true, vault is disconnected and fee is not accrued
    bool isDisconnected;
    // ### we have 104 bits left in this slot
}

interface IVaultHub {
    function vaultsCount() external view returns (uint256);

    function vault(uint256 _index) external view returns (IVault);

    function vaultSocket(uint256 _index) external view returns (VaultSocket memory);
}

contract VaultHubViewerV1 {
    bytes32 constant strictTrue = keccak256(hex"0000000000000000000000000000000000000000000000000000000000000001");

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
        address vaultOwner = vault.owner();
        if (vaultOwner == _owner) {
            return true;
        }

        return _checkHasRole(vaultOwner, _owner, DEFAULT_ADMIN_ROLE);
    }

    /// @notice Checks if a given address has a given role on a vault owner contract
    /// @param vault The vault to check
    /// @param _member The address to check
    /// @param _role The role to check
    /// @return True if the address has the role, false otherwise
    function hasRole(IVault vault, address _member, bytes32 _role) public view returns (bool) {
        address vaultOwner = vault.owner();
        if (vaultOwner == address(0)) {
            return false;
        }

        return _checkHasRole(vaultOwner, _member, _role);
    }

    /// @notice Returns all vaults owned by a given address
    /// @param _owner Address of the owner
    /// @return An array of vaults owned by the given address
    function vaultsByOwner(address _owner) public view returns (IVault[] memory) {
        (IVault[] memory vaults, uint256 valid) = _vaultsByOwner(_owner);

        return _filterNonZeroVaults(vaults, 0, valid);
    }

    /// @notice Returns all vaults owned by a given address
    /// @param _owner Address of the owner
    /// @param _from Index to start from inclisive
    /// @param _to Index to end at non-inculsive
    /// @return array of vaults owned by the given address
    /// @return number of leftover vaults in range
    function vaultsByOwnerBound(
        address _owner,
        uint256 _from,
        uint256 _to
    ) public view returns (IVault[] memory, uint256) {
        (IVault[] memory vaults, uint256 valid) = _vaultsByOwner(_owner);

        uint256 count = valid > _to ? _to : valid;
        uint256 leftover = valid > _to ? valid - _to : 0;

        return (_filterNonZeroVaults(vaults, _from, count), leftover);
    }

    /// @notice Returns all vaults with a given role on a given address
    /// @param _role Role to check
    /// @param _member Address to check
    /// @return An array of vaults with the given role on the given address
    function vaultsByRole(bytes32 _role, address _member) public view returns (IVault[] memory) {
        (IVault[] memory vaults, uint256 valid) = _vaultsByRole(_role, _member);

        return _filterNonZeroVaults(vaults, 0, valid);
    }

    /// @notice Returns all vaults with a given role on a given address
    /// @param _role Role to check
    /// @param _member Address to check
    /// @param _from Index to start from inclisive
    /// @param _to Index to end at non-inculsive
    /// @return array of vaults in range with the given role on the given address
    /// @return number of leftover vaults
    function vaultsByRoleBound(
        bytes32 _role,
        address _member,
        uint256 _from,
        uint256 _to
    ) public view returns (IVault[] memory, uint256) {
        (IVault[] memory vaults, uint256 valid) = _vaultsByRole(_role, _member);

        uint256 count = valid > _to ? _to : valid;
        uint256 leftover = valid > _to ? valid - _to : 0;

        return (_filterNonZeroVaults(vaults, _from, count), leftover);
    }

    /// @notice Returns all connected vaults
    /// @return array of connected vaults
    function vaultsConnected() public view returns (IVault[] memory) {
        (IVault[] memory vaults, uint256 valid) = _vaultsConnected();

        return _filterNonZeroVaults(vaults, 0, valid);
    }

    /// @notice Returns all connected vaults within a range
    /// @param _from Index to start from inclisive
    /// @param _to Index to end at non-inculsive
    /// @return array of connected vaults
    /// @return number of leftover connected vaults
    function vaultsConnectedBound(
        uint256 _from,
        uint256 _to
    ) public view returns (IVault[] memory, uint256) {
        (IVault[] memory vaults, uint256 valid) = _vaultsConnected();

        uint256 count = valid > _to ? _to : valid;
        uint256 leftover = valid > _to ? valid - _to : 0;

        return (_filterNonZeroVaults(vaults, _from, count), leftover);
    }

    // ==================== Internal Functions ====================

    /// @dev common logic for vaultsConnected and vaultsConnectedBound
    function _vaultsConnected() internal view returns (IVault[] memory, uint256) {
        uint256 count = vaultHub.vaultsCount();
        IVault[] memory vaults = new IVault[](count);

        uint256 valid = 0;
        for (uint256 i = 0; i < count; i++) {
            if (!vaultHub.vaultSocket(i).isDisconnected) {
                vaults[valid] = vaultHub.vault(i);
                valid++;
            }
        }

        return (vaults, valid);
    }

    /// @dev common logic for vaultsByRole and vaultsByRoleBound
    function _vaultsByRole(bytes32 _role, address _member) internal view returns (IVault[] memory, uint256) {
        uint256 count = vaultHub.vaultsCount();
        IVault[] memory vaults = new IVault[](count);

        uint256 valid = 0;
        for (uint256 i = 0; i < count; i++) {
            if (hasRole(vaultHub.vault(i), _member, _role)) {
                vaults[valid] = vaultHub.vault(i);
                valid++;
            }
        }

        return (vaults, valid);
    }

    /// @dev common logic for vaultsByOwner and vaultsByOwnerBound
    function _vaultsByOwner(address _owner) internal view returns (IVault[] memory, uint256) {
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
        return (vaults, valid);
    }

    /// @notice safely returns if role member has given role
    /// @param _contract that can have ACL or not
    /// @param _member addrress to check for role
    /// @return _role ACL role bytes
    function _checkHasRole(address _contract, address _member, bytes32 _role) internal view returns (bool) {
        if (!isContract(_contract)) return false;

        bytes memory payload = abi.encodeWithSignature("hasRole(bytes32,address)", _role, _member);
        (bool success, bytes memory result) = _contract.staticcall(payload);

        if (success && keccak256(result) == strictTrue) {
            return true;
        } else {
            return false;
        }
    }

    /// @notice Filters out zero address vaults from an array
    /// @param _vaults Array of vaults to filter
    /// @return filtered An array of non-zero vaults
    function _filterNonZeroVaults(
        IVault[] memory _vaults,
        uint256 _from,
        uint256 _to
    ) internal pure returns (IVault[] memory filtered) {
        uint256 count = _to - _from;
        filtered = new IVault[](count);
        for (uint256 i = _from; i < _to; i++) {
            filtered[i] = _vaults[i];
        }
    }

    // ==================== Errors ====================

    /// @notice Error for zero address arguments
    /// @param argName Name of the argument that is zero
    error ZeroArgument(string argName);
}
