// SPDX-FileCopyrightText: 2022 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;


import "../lib/UnstructuredStorage.sol";


contract Versioned {
    using UnstructuredStorage for bytes32;

    event ContractVersionSet(uint256 version);

    error NonZeroContractVersionOnInit();
    error InvalidContractVersionIncrement();
    error UnexpectedContractVersion(uint256 expected, uint256 received);

    /// @dev Storage slot: uint256 version
    /// Version of the initialized contract storage.
    /// The version stored in CONTRACT_VERSION_POSITION equals to:
    /// - 0 right after the deployment, before an initializer is invoked (and only at that moment);
    /// - N after calling initialize(), where N is the initially deployed contract version;
    /// - N after upgrading contract by calling finalizeUpgrade_vN().
    bytes32 internal constant CONTRACT_VERSION_POSITION = keccak256("lido.Versioned.contractVersion");

    constructor() {
        // lock version in the implementation's storage to prevent initialization
        CONTRACT_VERSION_POSITION.setStorageUint256(type(uint256).max);
    }

    /// @notice Returns the current contract version.
    function getContractVersion() external view returns (uint256) {
        return _getContractVersion();
    }

    function _getContractVersion() internal view returns (uint256) {
        return CONTRACT_VERSION_POSITION.getStorageUint256();
    }

    function _checkContractVersion(uint256 version) internal view {
        uint256 expectedVersion = _getContractVersion();
        if (version != expectedVersion) {
            revert UnexpectedContractVersion(expectedVersion, version);
        }
    }

    /// @dev Sets the contract version to 1. Should be called from the initialize() function.
    function _initializeContractVersionTo1() internal {
        if (_getContractVersion() == 0) {
            _writeContractVersion(1);
        } else {
            revert NonZeroContractVersionOnInit();
        }
    }

    /// @dev Updates the contract version. Should be called from a finalizeUpgrade_vN() function.
    function _updateContractVersion(uint256 newVersion) internal {
        if (newVersion == _getContractVersion() + 1) {
            _writeContractVersion(newVersion);
        } else {
            revert InvalidContractVersionIncrement();
        }
    }

    function _writeContractVersion(uint256 version) private {
        CONTRACT_VERSION_POSITION.setStorageUint256(version);
        emit ContractVersionSet(version);
    }
}