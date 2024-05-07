// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.0.2) (utils/math/SafeCast.sol)
// Code extracted from https://github.com/OpenZeppelin/openzeppelin-contracts/releases/tag/v5.0.2

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

library SafeCastExt {
     /**
     * @dev Value doesn't fit in an uint of `bits` size.
     */
    error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value);

    /**
     * @dev Returns the downcasted uint48 from uint256, reverting on
     * overflow (when the input is greater than largest uint48).
     *
     * Counterpart to Solidity's `uint48` operator.
     *
     * Requirements:
     *
     * - input must fit into 48 bits
     */
    function toUint48(uint256 value) internal pure returns (uint48) {
        if (value > type(uint48).max) {
            revert SafeCastOverflowedUintDowncast(48, value);
        }
        return uint48(value);
    }
}

