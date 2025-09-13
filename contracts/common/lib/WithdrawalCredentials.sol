// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.25;

/**
 * @title Withdrawal credentials helpers.
 * @author KRogLA
 * @notice Provides functionality for managing withdrawal credentials
 * @dev WC bytes layout: [0] = prefix (0x00/0x01/0x02), [1..11] = zero, [12..31] = execution address (20b)
 */
library WithdrawalCredentials {
    /// @notice Get the current prefix (0x00/0x01/0x02)
    function getType(bytes32 wc) internal pure returns (uint8) {
        return uint8(uint256(wc) >> 248);
    }

    /// @notice Extract the execution address from the WC (low 20 bytes)
    function getAddr(bytes32 wc) internal pure returns (address) {
        return address(uint160(uint256(wc)));
    }

    /// @notice Set 1st byte to wcType (0x00/0x01/0x02), keep the rest
    function setType(bytes32 wc, uint8 wcType) internal pure returns (bytes32) {
        return bytes32((uint256(wc) & type(uint248).max) | (uint256(wcType) << 248));
    }
}
