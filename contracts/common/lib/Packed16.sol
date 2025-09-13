// SPDX-License-Identifier: GPL-3.0
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9 <0.9.0;


/**
 * @title Packed16
 * @author KRogLA
 * @notice Provides an interface for gas-efficient store uint16 values tightly packed into one uint256
 */
library Packed16 {
    function get16(uint256 x, uint8 p) internal pure returns (uint16 v) {
        assembly ("memory-safe") {
            let s := shl(4, p) // p * 16
            v := and(shr(s, x), 0xffff)
        }
    }

    function set16(uint256 x, uint8 p, uint16 v) internal pure returns (uint256 r) {
        assembly ("memory-safe") {
            let s := shl(4, p) // p * 16
            r := or(and(x, not(shl(s, 0xffff))), shl(s, v))
        }
    }

    function pack16(uint16[] memory vs) internal pure returns (uint256 x) {
        for (uint8 i = 0; i < vs.length; ++i) {
            x = set16(x, i, vs[i]);
        }
    }

    function unpack16(uint256 x) internal pure returns (uint16[] memory vs) {
        vs = new uint16[](16);
        for (uint8 i = 0; i < 16; ++i) {
            vs[i] = uint16(get16(x, i));
        }
    }
}
