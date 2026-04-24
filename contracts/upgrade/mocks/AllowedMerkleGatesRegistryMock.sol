// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {IAllowedMerkleGatesRegistry} from "contracts/upgrade/UpgradeTypes.sol";

contract AllowedMerkleGatesRegistryMock is IAllowedMerkleGatesRegistry {
    address[] private _allowedGates;

    constructor(address[] memory initialAllowedGates) {
        _setAllowedGates(initialAllowedGates);
    }

    function getAllowedGates() external view returns (address[] memory) {
        return _allowedGates;
    }

    function setAllowedGates(address[] calldata allowedGates) external {
        _setAllowedGates(allowedGates);
    }

    function addAllowedGate(address allowedGate) external {
        _allowedGates.push(allowedGate);
    }

    function _setAllowedGates(address[] memory allowedGates) private {
        delete _allowedGates;

        uint256 length = allowedGates.length;
        for (uint256 i = 0; i < length; ++i) {
            _allowedGates.push(allowedGates[i]);
        }
    }
}
