// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IBeaconProxyOssifiable} from "./interfaces/IBeaconProxyOssifiable.sol";
import {Ownable2Step} from "./lib/Ownable2Step.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";
import {StorageSlot} from "@openzeppelin/contracts-v5.2/utils/StorageSlot.sol";

contract BeaconProxyOssifiable is BeaconProxy, Ownable2Step, IBeaconProxyOssifiable {
    bytes32 internal constant OSSIFIED_SLOT = 0x8d75cfa6c9a3cd2fb8b6d445eafb32adc5497a45b333009f9000379f7024f9f5;

    constructor(
        address initialOwner,
        address beacon,
        bytes memory data
    ) BeaconProxy(beacon, data) Ownable2Step(initialOwner) {}

    receive() external payable {}

    function implementation() public view returns (address) {
        return _implementation();
    }

    function isOssified() public view returns (bool) {
        return _ossifiedImplementation() != address(0);
    }

    function ossify() external onlyOwner {
        if (isOssified()) revert AlreadyOssified();

        address currentImplementation = super._implementation();
        StorageSlot.getAddressSlot(OSSIFIED_SLOT).value = currentImplementation;

        emit Ossified(currentImplementation);
    }

    function _implementation() internal view override returns (address) {
        return isOssified() ? _ossifiedImplementation() : super._implementation();
    }

    function _ossifiedImplementation() internal view returns (address) {
        return StorageSlot.getAddressSlot(OSSIFIED_SLOT).value;
    }

    event Ossified(address implementation);

    error AlreadyOssified();
}
