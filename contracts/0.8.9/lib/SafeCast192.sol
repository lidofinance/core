// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.0.2) (utils/math/SafeCast.sol)
// Code extracted from https://github.com/OpenZeppelin/openzeppelin-contracts/releases/tag/v5.0.2

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

library SafeCast192 {
     /**
     * @dev Value doesn't fit in an uint of `bits` size.
     */
    error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value);

    /**
     * @dev Returns the downcasted uint192 from uint256, reverting on
     * overflow (when the input is greater than largest uint192).
     *
     * Counterpart to Solidity's `uint192` operator.
     *
     * Requirements:
     *
     * - input must fit into 192 bits
     */
    function toUint192(uint256 value) internal pure returns (uint192) {
        if (value > type(uint192).max) {
            revert SafeCastOverflowedUintDowncast(192, value);
        }
        return uint192(value);
    }
}

