// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.25;

import "./STASErrors.sol" as E;

/**
 * @title STAS Metric Conversion Helpers
 * @author KRogLA
 * @notice Library containing converters for metrics that allow converting absolute and human-readable metric values to values for the STAS
 */
library STASConvertor {


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
            revert E.BPSOverflow();
        }

        if (undefinedCount == 0) {
            return vals;
        }

        uint256 remaining;
        unchecked {
            remaining = 10000 - totalDefined;
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 share = uint16(remaining / undefinedCount);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 remainder = uint16(remaining % undefinedCount);

        unchecked {
            for (uint256 i; i < n && undefinedCount > 0; ++i) {
                uint16 v = vals[i];
                if (v == 10000) {
                    v = share;
                    if (remainder > 0) {
                        ++v;
                        --remainder;
                    }
                    vals[i] = v;
                    --undefinedCount;
                }
            }
        }
        return vals;
    }
}
