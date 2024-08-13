// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// for testing purposes only

pragma solidity 0.4.24;

import {Versioned} from "contracts/0.4.24/utils/Versioned.sol";

contract Versioned__Harness0424 is Versioned {
    constructor() public {}

    function getPetrifiedVersionMark() external pure returns (uint256) {
        return PETRIFIED_VERSION_MARK;
    }

    function checkContractVersion(uint256 version) external view {
        _checkContractVersion(version);
    }

    function setContractVersion(uint256 version) external {
        _setContractVersion(version);
    }
}
