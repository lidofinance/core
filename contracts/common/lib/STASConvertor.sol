// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.25;

/**
 * @title STAS Metric Conversion Helpers
 * @author KRogLA
 * @notice Library containing converters for metrics that allow converting absolute and human-readable metric values to values for the STAS
 */
library STASConvertor {
    error BPSOverflow();

    function _rescaleBps(uint16[] memory vals) public pure returns (uint16[] memory) {
        uint256 n = vals.length;
        uint256 totalDefined;
        uint256 undefinedCount;

        unchecked {
            for (uint256 i; i < n; ++i) {
                uint256 v = vals[i];
                if (v == 10000) {
                    ++undefinedCount;
                } else {
                    totalDefined += v;
                }
            }
        }

        if (totalDefined > 10000) {
            revert BPSOverflow();
        }

        if (undefinedCount == 0) {
            return vals;
        }

        uint256 remaining;
        unchecked {
            remaining = 10000 - totalDefined;
        }
        uint256 share = remaining / undefinedCount;
        uint256 remainder = remaining % undefinedCount;

        unchecked {
            for (uint256 i; i < n && undefinedCount > 0; ++i) {
                uint256 v = vals[i];
                if (v == 10000) {
                    v = share;
                    if (remainder > 0) {
                        ++v;
                        --remainder;
                    }
                    vals[i] = uint16(v);
                    --undefinedCount;
                }
            }
        }
        return vals;
    }
}
