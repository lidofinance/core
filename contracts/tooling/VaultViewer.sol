// SPDX-License-Identifier: UNLICENSED
// for tooling purposes only

// ================================================================================================================= //
// DISCLAIMER: This contract is intended solely for tooling and is NOT an official component of the Lido core protocol.
// It is excluded from the Lido bug bounty program.
// This contract has not undergone security auditing and its interface or functionality may change without notice.
// ================================================================================================================= //

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import { VaultHub } from "contracts/0.8.25/vaults/VaultHub.sol";
import { IStakingVault } from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import { ILido } from "contracts/common/interfaces/ILido.sol";
import { ILidoLocator } from "contracts/common/interfaces/ILidoLocator.sol";
import { LazyOracle } from "contracts/0.8.25/vaults/LazyOracle.sol";

/// @title VaultViewer
/// @dev this contract is NOT a part of the Lido core protocol logic, it is only used for tooling purposes
contract VaultViewer {
    struct VaultData {
        address vaultAddress;
        VaultHub.VaultConnection connection;
        VaultHub.VaultRecord record;
        uint256 totalValue;
        uint256 liabilityStETH;
        uint256 nodeOperatorFeeRate;
        uint256 accruedFee;
        bool isReportFresh;
        LazyOracle.QuarantineInfo quarantineInfo;
    }

    struct VaultMembers {
        address vault;
        address owner;
        address nodeOperator;
        address[][] members;
    }

    /**
     * @notice Strict true value for checking role membership
     */
    bytes32 private constant STRICT_TRUE = keccak256(hex"0000000000000000000000000000000000000000000000000000000000000001");

    /**
     * @notice Default admin role for checking roles
     */
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    ILidoLocator public immutable LIDO_LOCATOR;
    VaultHub public immutable VAULT_HUB;
    LazyOracle public immutable LAZY_ORACLE;

    /// @notice Constructor
    /// @param _lidoLocator Address of the lido locator
    constructor(address _lidoLocator) {
        if (_lidoLocator == address(0)) revert ZeroArgument("_lidoLocator");
        LIDO_LOCATOR = ILidoLocator(_lidoLocator);

        VAULT_HUB = VaultHub(payable(LIDO_LOCATOR.vaultHub()));
        LAZY_ORACLE = LazyOracle(LIDO_LOCATOR.lazyOracle());
    }

    /// @notice Checks if a given address is the owner of a connection vault
    /// @param vault The vault to check
    /// @param _owner The address to check
    /// @return True if the address is the owner, false otherwise
    function isVaultOwner(IStakingVault vault, address _owner) public view returns (bool) {
        // For connected vaults the `vault.owner()` is VaultHub
        VaultHub.VaultConnection memory connection = VAULT_HUB.vaultConnection(address(vault));
        if (connection.owner == address(0)) {
            return false;
        }
        if (connection.owner == _owner) {
            return true;
        }

        return _checkHasRole(connection.owner, _owner, DEFAULT_ADMIN_ROLE);
    }

    /// @notice Checks if a given address has a given role on a connection vault owner contract
    /// @param vault The vault to check
    /// @param _member The address to check
    /// @param _role The role to check
    /// @return True if the address has the role, false otherwise
    /// @dev Return roles only for connection vault owner - dashboard contract
    function hasRole(IStakingVault vault, address _member, bytes32 _role) public view returns (bool) {
        // For connected vaults the `vault.owner()` is VaultHub
        VaultHub.VaultConnection memory connection = VAULT_HUB.vaultConnection(address(vault));
        if (connection.owner == address(0)) {
            return false;
        }

        return _checkHasRole(connection.owner, _member, _role);
    }

    /// @notice Returns vaults owned by `_owner` using batch pagination over the global vault list
    /// @param _owner Address of the owner
    /// @param _offset Zero-based offset in the vaults list [0, vaultsCount)
    /// @param _limit Maximum number of vaults to SCAN (must be > 0)
    /// @return vaults Array of owner-matching vaults found within the scanned window (length <= _limit)
    function vaultsByOwnerBatch(
        address _owner,
        uint256 _offset,
        uint256 _limit
    ) public view returns (IStakingVault[] memory vaults) {
        _requireNotZero(_limit, "_limit");

        VaultHub vaultHub = VAULT_HUB;
        uint256 count = vaultHub.vaultsCount();

        if (_offset >= count) {
            return new IStakingVault[](0);
        }

        uint256 remaining = count - _offset;
        uint256 scanSize = _limit > remaining ? remaining : _limit;

        vaults = new IStakingVault[](scanSize);
        IStakingVault vault;
        uint256 matchedCount = 0;

        uint256 end = _offset + scanSize;
        uint256 i = _offset;
        for (; i < end; ) {
            // vaultByIndex is 1-based, _offset is 0-based → add +1
            vault = IStakingVault(vaultHub.vaultByIndex(i + 1));
            if (isVaultOwner(vault, _owner)) {
                vaults[matchedCount] = vault;
                unchecked {
                    ++matchedCount;
                }
            }
            unchecked {
                ++i;
            }
        }

        // shrink to actual length
        assembly { mstore(vaults, matchedCount) }
    }

    /// @notice Returns vaults where `_member` has `_role`, scanning a batch of the global vault list
    /// @param _role Role to check
    /// @param _member Address to check for the role
    /// @param _offset Zero-based offset in the vaults list [0, vaultsCount)
    /// @param _limit Maximum number of vaults to SCAN (must be > 0)
    /// @return vaults Array of vaults where `_member` has `_role` found within the scanned window (length ≤ _limit)
    function vaultsByRoleBatch(
        bytes32 _role,
        address _member,
        uint256 _offset,
        uint256 _limit
    ) public view returns (IStakingVault[] memory vaults) {
        _requireNotZero(_limit, "_limit");

        VaultHub vaultHub = VAULT_HUB;
        uint256 count = vaultHub.vaultsCount();

        if (_offset >= count) {
            return new IStakingVault[](0);
        }

        uint256 remaining = count - _offset;
        uint256 scanSize = _limit > remaining ? remaining : _limit;

        vaults = new IStakingVault[](scanSize);
        IStakingVault vault;
        uint256 matchedCount = 0;

        uint256 end = _offset + scanSize;
        uint256 i = _offset;
        for (; i < end; ) {
            // vaultByIndex is 1-based, _offset is 0-based → add +1
            vault = IStakingVault(vaultHub.vaultByIndex(i + 1));
            if (hasRole(vault, _member, _role)) {
                vaults[matchedCount] = vault;
                unchecked {
                    ++matchedCount;
                }
            }
            unchecked {
                ++i;
            }
        }

        // shrink to actual number of matches
        assembly { mstore(vaults, matchedCount) }
    }

    /// @notice returns the number of vaults connected to the VaultHub
    /// @return the number of vaults connected to the VaultHub
    function vaultsCount() external view returns (uint256) {
        return VAULT_HUB.vaultsCount();
    }

    /// @notice Returns aggregated data for a single vault
    /// @param vault Address of the vault
    /// @return data Aggregated vault data
    function vaultData(address vault) public view returns (VaultData memory data) {
        ILido lido = VAULT_HUB.LIDO();
        VaultHub.VaultConnection memory connection = VAULT_HUB.vaultConnection(vault);
        VaultHub.VaultRecord memory record = VAULT_HUB.vaultRecord(vault);
        uint256 nodeOperatorFeeRate = _getNodeOperatorFeeRate(connection.owner);
        uint256 accruedFee = _getAccruedFee(connection.owner);
        LazyOracle.QuarantineInfo memory quarantineInfo = LAZY_ORACLE.vaultQuarantine(vault);

        data = VaultData({
            vaultAddress: vault,
            connection: connection,
            record: record,
            totalValue: VAULT_HUB.totalValue(vault),
            liabilityStETH: lido.getPooledEthBySharesRoundUp(record.liabilityShares),
            nodeOperatorFeeRate: nodeOperatorFeeRate,
            accruedFee: accruedFee,
            isReportFresh: VAULT_HUB.isReportFresh(vault),
            quarantineInfo: quarantineInfo
        });
    }

    /// @notice Returns aggregated data for a batch of vaults
    /// @param _offset Zero-based offset in the vaults list [0, vaultsCount)
    /// @param _limit Maximum number of vaults to return (must be > 0)
    /// @return vaultsData Array of aggregated vault data (length <= _limit)
    function vaultsDataBatch(uint256 _offset, uint256 _limit) external view returns (VaultData[] memory vaultsData) {
        _requireNotZero(_limit, "_limit");

        VaultHub vaultHub = VAULT_HUB;
        uint256 count = vaultHub.vaultsCount();

        if (_offset >= count) {
            return new VaultData[](0);
        }

        uint256 remaining = count - _offset;
        uint256 batchSize = _limit > remaining ? remaining : _limit;

        vaultsData = new VaultData[](batchSize);
        for (uint256 i = 0; i < batchSize; ) {
            // vaultByIndex is 1-based, _offset is 0-based → add +1
            address vaultAddress = vaultHub.vaultByIndex(_offset + i + 1);
            vaultsData[i] = vaultData(vaultAddress);
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Returns vault addresses for a range of vaults
    /// @param _offset Zero-based offset in the vaults list [0, vaultsCount)
    /// @param _limit Maximum number of vaults to return (must be > 0)
    /// @return vaults Array of vault contracts (IStakingVault)
    function vaultAddressesBatch(uint256 _offset, uint256 _limit) public view returns (IStakingVault[] memory vaults) {
        _requireNotZero(_limit, "_limit");

        VaultHub vaultHub = VAULT_HUB;
        uint256 count = vaultHub.vaultsCount();

        if (_offset >= count) {
            return new IStakingVault[](0);
        }

        uint256 remaining = count - _offset;
        uint256 batchSize = _limit > remaining ? remaining : _limit;

        vaults = new IStakingVault[](batchSize);
        for (uint256 i = 0; i < batchSize; ) {
            // vaultByIndex is 1-based, _offset is 0-based → add +1
            address vaultAddress = vaultHub.vaultByIndex(_offset + i + 1);
            vaults[i] = IStakingVault(vaultAddress);
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Returns the VaultMembers for each specified role on a single vault
    /// @param vaultAddress The address of the vault
    /// @param roles An array of role identifiers (bytes32) to query on the vault’s owner contract
    /// @return result VaultMembers containing vault address, owner, nodeOperator, and corresponding role members
    function roleMembers(
        address vaultAddress,
        bytes32[] calldata roles
    ) public view returns (VaultMembers memory result) {
        VaultHub.VaultConnection memory connection = VAULT_HUB.vaultConnection(vaultAddress);
        // For connected vaults the `vaultContract.owner()` is VaultHub
        // connection.owner is the owner of the vault - dashboard contract
        result.vault = vaultAddress;
        result.owner = connection.owner;
        result.nodeOperator = _getNodeOperatorAddress(vaultAddress);
        result.members = new address[][](roles.length);

        // owner may be an EOA wallet
        if (!_isContract(result.owner)) {
            return result;
        }

        for (uint256 i = 0; i < roles.length; i++) {
            result.members[i] = _getRoleMember(result.owner, roles[i]);
        }
        return result;
    }

    /// @notice Returns VaultMembers for each role on multiple vaults
    /// @param vaultAddresses Array of vault addresses to query
    /// @param roles Array of roles to check for each vault
    /// @return result Array of VaultMembers containing vault address, owner, nodeOperator and corresponding role members
    function roleMembersBatch(
        address[] calldata vaultAddresses,
        bytes32[] calldata roles
    ) external view returns (VaultMembers[] memory result) {
        result = new VaultMembers[](vaultAddresses.length);

        for (uint256 i = 0; i < vaultAddresses.length; i++) {
            result[i] = roleMembers(vaultAddresses[i], roles);
        }
    }

    // ==================== Internal Functions ====================

    /// @notice Safely attempt a staticcall to `getRoleMembers(bytes32)` on the owner address
    /// @dev common logic for roleMembers
    /// @dev More gas-efficient to do any `_isContract(owner)` check in the caller
    /// @param owner The address to call (may be a contract or an EOA)
    /// @param role The role identifier
    /// @return members Array of addresses if the call succeeds and returns a well-formed `address[]`; empty array otherwise
    function _getRoleMember(address owner, bytes32 role) internal view returns (address[] memory members) {
        (bool success, bytes memory data) = owner.staticcall(abi.encodeWithSignature("getRoleMembers(bytes32)", role));
        if (!success || data.length < 64) return members;

        // Validate the ABI layout before decoding: abi.decode reverts on a malformed offset/length or dirty address words
        uint256 offset;
        uint256 length;
        assembly {
            offset := mload(add(data, 32))
            length := mload(add(data, 64))
        }
        if (offset != 32 || length > (data.length - 64) / 32) return members;

        for (uint256 i = 0; i < length; ++i) {
            uint256 word;
            assembly {
                word := mload(add(data, add(96, mul(i, 32))))
            }
            if (word > type(uint160).max) return members;
        }

        members = abi.decode(data, (address[]));
    }

    /// @notice safely returns if role member has given role
    /// @param _contract that can have ACL or not
    /// @param _member addrress to check for role
    /// @param _role ACL role bytes
    /// @return bool status of check
    function _checkHasRole(address _contract, address _member, bytes32 _role) internal view returns (bool) {
        if (!_isContract(_contract)) return false;

        bytes memory payload = abi.encodeWithSignature("hasRole(bytes32,address)", _role, _member);
        (bool success, bytes memory result) = _contract.staticcall(payload);

        if (success && keccak256(result) == STRICT_TRUE) {
            return true;
        } else {
            return false;
        }
    }

    /// @notice Tries to fetch nodeOperator - feeRate() from the vault owner if it's a dashboard contract
    /// @dev Uses low-level staticcall to avoid reverting when the method is missing or the address is an EOA
    /// @param owner The address of the vault owner (can be either a contract or an EOA)
    /// @return fee The decoded fee value if present, otherwise 0
    function _getNodeOperatorFeeRate(address owner) internal view returns (uint256 fee) {
        if (_isContract(owner)) {
            // if dashboard contract and have feeRate method
            (bool success, bytes memory result) = owner.staticcall(abi.encodeWithSignature("feeRate()"));
            // Check ensures safe decoding — avoids abi.decode revert on short return data
            if (success && result.length >= 32) {
                fee = abi.decode(result, (uint256));
            }
        }
    }

    /// @notice Tries to fetch accruedFee() from the vault owner if it's a dashboard contract
    /// @dev Uses low-level staticcall to avoid reverting when the method is missing or the address is an EOA
    /// @param owner The address of the vault owner (can be either a contract or an EOA)
    /// @return accruedFee The decoded fee value if present, otherwise 0
    function _getAccruedFee(address owner) internal view returns (uint256 accruedFee) {
        if (_isContract(owner)) {
            // if dashboard contract and have accruedFee method
            (bool success, bytes memory result) = owner.staticcall(abi.encodeWithSignature("accruedFee()"));
            // Check ensures safe decoding — avoids abi.decode revert on short return data
            if (success && result.length >= 32) {
                accruedFee = abi.decode(result, (uint256));
            }
        }
    }

    /// @notice Tries to fetch nodeOperator() from the vault contract
    /// @dev Uses low-level staticcall to avoid reverting when the method is missing or vault is not a valid contract
    /// @param vault The address of the vault (must be a contract implementing nodeOperator())
    /// @return operator The decoded nodeOperator address if present, otherwise address(0)
    /// @custom:todo Think about the need for this method
    function _getNodeOperatorAddress(address vault) internal view returns (address operator) {
        if (_isContract(vault)) {
            (bool success, bytes memory result) = vault.staticcall(abi.encodeWithSignature("nodeOperator()"));
            // Check ensures safe decoding — avoids abi.decode revert on short return data or dirty upper bits
            if (success && result.length >= 32) {
                uint256 word = abi.decode(result, (uint256));
                if (word <= type(uint160).max) operator = address(uint160(word));
            }
        }
    }

    /// @notice Checks if a given address is a contract
    /// @param account The address to check
    /// @return True if the address is a contract, false otherwise
    function _isContract(address account) internal view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(account)
        }
        return size > 0;
    }

    /// @notice Reverts if a provided numeric argument is zero
    /// @param _value The argument value to validate
    /// @param _argName The name of the argument
    /// @custom:error ZeroArgument Thrown when `_value` equals zero
    function _requireNotZero(uint256 _value, string memory _argName) internal pure {
        if (_value == 0) revert ZeroArgument(_argName);
    }

    // ==================== Errors ====================

    /// @notice Error for zero address arguments
    /// @param argName Name of the argument that is zero
    error ZeroArgument(string argName);
}
