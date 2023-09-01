// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { Versioned } from "../utils/Versioned.sol";

contract VersionedMock is Versioned {
    constructor() Versioned() {}

    function getPetrifiedVersionMark() external pure returns (uint256) {
        return PETRIFIED_VERSION_MARK;
    }

    function initializeContractVersionTo(uint256 version) external {
        _initializeContractVersionTo(version);
    }

    function checkContractVersion(uint256 version) external view {
        _checkContractVersion(version);
    }

    function updateContractVersion(uint256 newVersion) external {
        _updateContractVersion(newVersion);
    }
}
