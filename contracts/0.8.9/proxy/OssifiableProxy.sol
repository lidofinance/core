// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {Address} from "@openzeppelin/contracts-v4.4/utils/Address.sol";
import {StorageSlot} from "@openzeppelin/contracts-v4.4/utils/StorageSlot.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts-v4.4/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice An ossifiable proxy contract. Extends the ERC1967Proxy contract by
///     adding admin functionality
contract OssifiableProxy is ERC1967Proxy {
    /// @dev Initializes the upgradeable proxy with the initial implementation and admin
    /// @param implementation_ Address of the implementation
    /// @param admin_ Address of the admin of the proxy
    /// @param data_ Data used in a delegate call to implementation. The delegate call will be
    ///     skipped if the data is empty bytes
    constructor(
        address implementation_,
        address admin_,
        bytes memory data_
    ) ERC1967Proxy(implementation_, data_) {
        _changeAdmin(admin_);
    }

    /// @notice Returns the current admin of the proxy
    function proxy__getAdmin() external view returns (address) {
        return _getAdmin();
    }

    /// @notice Returns the current implementation address
    function proxy__getImplementation() external view returns (address) {
        return _implementation();
    }

    /// @notice Returns whether the implementation is locked forever
    function proxy__getIsOssified() external view returns (bool) {
        return _getAdmin() == address(0);
    }

    /// @notice Allows to transfer admin rights to zero address and prevent future
    ///     upgrades of the proxy
    function proxy__ossify() external onlyAdmin {
        address prevAdmin = _getAdmin();
        StorageSlot.getAddressSlot(_ADMIN_SLOT).value = address(0);
        emit AdminChanged(prevAdmin, address(0));
        emit ProxyOssified();
    }

    /// @notice Changes the admin of the proxy
    /// @param newAdmin_ Address of the new admin
    function proxy__changeAdmin(address newAdmin_) external onlyAdmin {
        _changeAdmin(newAdmin_);
    }

    /// @notice Upgrades the implementation of the proxy
    /// @param newImplementation_ Address of the new implementation
    function proxy__upgradeTo(address newImplementation_) external onlyAdmin {
        _upgradeTo(newImplementation_);
    }

    /// @notice Upgrades the proxy to a new implementation, optionally performing an additional
    ///     setup call.
    /// @param newImplementation_ Address of the new implementation
    /// @param setupCalldata_ Data for the setup call. The call is skipped if setupCalldata_ is
    ///     empty and forceCall_ is false
    /// @param forceCall_ Forces make delegate call to the implementation even with empty data_
    function proxy__upgradeToAndCall(
        address newImplementation_,
        bytes memory setupCalldata_,
        bool forceCall_
    ) external onlyAdmin {
        _upgradeToAndCall(newImplementation_, setupCalldata_, forceCall_);
    }

    /// @dev Validates that proxy is not ossified and that method is called by the admin
    ///     of the proxy
    modifier onlyAdmin() {
        address admin = _getAdmin();
        if (admin == address(0)) {
            revert ProxyIsOssified();
        }
        if (admin != msg.sender) {
            revert NotAdmin();
        }
        _;
    }

    event ProxyOssified();

    error NotAdmin();
    error ProxyIsOssified();
}
