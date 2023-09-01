// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.4.24;

import {SafeMath} from "@aragon/os/contracts/lib/math/SafeMath.sol";
import {SafeMath64} from "@aragon/os/contracts/lib/math/SafeMath64.sol";

/// @title Library for manage operator keys in storage
/// @author KRogLA
library SigningKeys {
    using SafeMath for uint256;
    using SafeMath64 for uint64;
    using SigningKeys for bytes32;

    uint64 internal constant PUBKEY_LENGTH = 48;
    uint64 internal constant SIGNATURE_LENGTH = 96;
    uint256 internal constant UINT64_MAX = 0xFFFFFFFFFFFFFFFF;

    event SigningKeyAdded(uint256 indexed nodeOperatorId, bytes pubkey);
    event SigningKeyRemoved(uint256 indexed nodeOperatorId, bytes pubkey);

    function getKeyOffset(bytes32 _position, uint256 _nodeOperatorId, uint256 _keyIndex) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(_position, _nodeOperatorId, _keyIndex)));
    }

    /// @dev store opeartor keys to storage
    /// @param _position storage slot
    /// @param _nodeOperatorId operator id
    /// @param _startIndex start index
    /// @param _keysCount keys count to load
    /// @param _pubkeys kes buffer to read from
    /// @param _signatures signatures buffer to read from
    /// @return new total keys count
    function saveKeysSigs(
        bytes32 _position,
        uint256 _nodeOperatorId,
        uint256 _startIndex,
        uint256 _keysCount,
        bytes _pubkeys,
        bytes _signatures
    ) internal returns (uint256) {
        require(_keysCount > 0 && _startIndex.add(_keysCount) <= UINT64_MAX, "INVALID_KEYS_COUNT");
        require(
            _pubkeys.length == _keysCount.mul(PUBKEY_LENGTH) && _signatures.length == _keysCount.mul(SIGNATURE_LENGTH),
            "LENGTH_MISMATCH"
        );

        uint256 curOffset;
        bool isEmpty;
        bytes memory tmpKey = new bytes(48);

        for (uint256 i; i < _keysCount;) {
            curOffset = _position.getKeyOffset(_nodeOperatorId, _startIndex);
            assembly {
                let _ofs := add(add(_pubkeys, 0x20), mul(i, 48)) //PUBKEY_LENGTH = 48
                let _part1 := mload(_ofs) // bytes 0..31
                let _part2 := mload(add(_ofs, 0x10)) // bytes 16..47
                isEmpty := iszero(or(_part1, _part2))
                mstore(add(tmpKey, 0x30), _part2) // store 2nd part first
                mstore(add(tmpKey, 0x20), _part1) // store 1st part with overwrite bytes 16-31
            }

            require(!isEmpty, "EMPTY_KEY");
            assembly {
                // store key
                sstore(curOffset, mload(add(tmpKey, 0x20))) // store bytes 0..31
                sstore(add(curOffset, 1), shl(128, mload(add(tmpKey, 0x30)))) // store bytes 32..47
                // store signature
                let _ofs := add(add(_signatures, 0x20), mul(i, 96)) //SIGNATURE_LENGTH = 96
                sstore(add(curOffset, 2), mload(_ofs))
                sstore(add(curOffset, 3), mload(add(_ofs, 0x20)))
                sstore(add(curOffset, 4), mload(add(_ofs, 0x40)))
                i := add(i, 1)
                _startIndex := add(_startIndex, 1)
            }
            emit SigningKeyAdded(_nodeOperatorId, tmpKey);
        }
        return _startIndex;
    }

    /// @dev remove opeartor keys from storage
    /// @param _position storage slot
    /// @param _nodeOperatorId operator id
    /// @param _startIndex start index
    /// @param _keysCount keys count to load
    /// @param _totalKeysCount current total keys count for operator
    /// @return new _totalKeysCount
    function removeKeysSigs(
        bytes32 _position,
        uint256 _nodeOperatorId,
        uint256 _startIndex,
        uint256 _keysCount,
        uint256 _totalKeysCount
    ) internal returns (uint256) {
        require(
            _keysCount > 0 && _startIndex.add(_keysCount) <= _totalKeysCount && _totalKeysCount <= UINT64_MAX,
            "INVALID_KEYS_COUNT"
        );

        uint256 curOffset;
        uint256 lastOffset;
        uint256 j;
        bytes memory tmpKey = new bytes(48);
        // removing from the last index
        for (uint256 i = _startIndex + _keysCount; i > _startIndex;) {
            curOffset = _position.getKeyOffset(_nodeOperatorId, i - 1);
            assembly {
                // read key
                mstore(add(tmpKey, 0x30), shr(128, sload(add(curOffset, 1)))) // bytes 16..47
                mstore(add(tmpKey, 0x20), sload(curOffset)) // bytes 0..31
            }
            if (i < _totalKeysCount) {
                lastOffset = _position.getKeyOffset(_nodeOperatorId, _totalKeysCount - 1);
                // move last key to deleted key index
                for (j = 0; j < 5;) {
                    assembly {
                        sstore(add(curOffset, j), sload(add(lastOffset, j)))
                        j := add(j, 1)
                    }
                }
                curOffset = lastOffset;
            }
            // clear storage
            for (j = 0; j < 5;) {
                assembly {
                    sstore(add(curOffset, j), 0)
                    j := add(j, 1)
                }
            }
            assembly {
                _totalKeysCount := sub(_totalKeysCount, 1)
                i := sub(i, 1)
            }
            emit SigningKeyRemoved(_nodeOperatorId, tmpKey);
        }
        return _totalKeysCount;
    }

    /// @dev laod opeartor keys from storage
    /// @param _position storage slot
    /// @param _nodeOperatorId operator id
    /// @param _startIndex start index
    /// @param _keysCount keys count to load
    /// @param _pubkeys preallocated kes buffer to read in
    /// @param _signatures preallocated signatures buffer to read in
    /// @param _bufOffset start offset in `_pubkeys`/`_signatures` buffer to place values (in number of keys)
    function loadKeysSigs(
        bytes32 _position,
        uint256 _nodeOperatorId,
        uint256 _startIndex,
        uint256 _keysCount,
        bytes memory _pubkeys,
        bytes memory _signatures,
        uint256 _bufOffset
    ) internal view {
        uint256 curOffset;
        for (uint256 i; i < _keysCount;) {
            curOffset = _position.getKeyOffset(_nodeOperatorId, _startIndex + i);
            assembly {
                // read key
                let _ofs := add(add(_pubkeys, 0x20), mul(add(_bufOffset, i), 48)) //PUBKEY_LENGTH = 48
                mstore(add(_ofs, 0x10), shr(128, sload(add(curOffset, 1)))) // bytes 16..47
                mstore(_ofs, sload(curOffset)) // bytes 0..31
                // store signature
                _ofs := add(add(_signatures, 0x20), mul(add(_bufOffset, i), 96)) //SIGNATURE_LENGTH = 96
                mstore(_ofs, sload(add(curOffset, 2)))
                mstore(add(_ofs, 0x20), sload(add(curOffset, 3)))
                mstore(add(_ofs, 0x40), sload(add(curOffset, 4)))
                i := add(i, 1)
            }
        }
    }

    function initKeysSigsBuf(uint256 _count) internal pure returns (bytes memory, bytes memory) {
        return (new bytes(_count.mul(PUBKEY_LENGTH)), new bytes(_count.mul(SIGNATURE_LENGTH)));
    }
}
