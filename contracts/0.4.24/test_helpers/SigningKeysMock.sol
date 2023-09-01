// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.4.24;

import {SigningKeys} from "../lib/SigningKeys.sol";

contract SigningKeysMock {
    using SigningKeys for bytes32;

    bytes32 public constant KEYSSIGS_POSITION = keccak256("KEYSSIGS_POSITION");

    uint256[] public _nodeOperatorIds;

    constructor(uint256[] memory ids) public {
        _nodeOperatorIds = ids;
    }

    function getKeyOffset(uint256 _nodeOperatorId, uint256 _keyIndex) external pure returns (uint256) {
        return KEYSSIGS_POSITION.getKeyOffset(_nodeOperatorId, _keyIndex);
    }

    function saveKeysSigs(
        uint256 _nodeOperatorId,
        uint256 _startIndex,
        uint256 _keysCount,
        bytes _publicKeys,
        bytes _signatures
    ) external returns (uint256) {
        return KEYSSIGS_POSITION.saveKeysSigs(_nodeOperatorId, _startIndex, _keysCount, _publicKeys, _signatures);
    }

    function removeKeysSigs(uint256 _nodeOperatorId, uint256 _startIndex, uint256 _keysCount, uint256 _lastIndex)
        external
        returns (uint256)
    {
        return KEYSSIGS_POSITION.removeKeysSigs(_nodeOperatorId, _startIndex, _keysCount, _lastIndex);
    }

    function loadKeysSigs(uint256 _nodeOperatorId, uint256 _startIndex, uint256 _keysCount)
        external
        view
        returns (bytes memory pubkeys, bytes memory signatures)
    {
        (pubkeys, signatures) = SigningKeys.initKeysSigsBuf(_keysCount);
        KEYSSIGS_POSITION.loadKeysSigs(
            _nodeOperatorId,
            _startIndex,
            _keysCount,
            pubkeys,
            signatures,
            0 // key offset inside _pubkeys/_signatures buffers
        );
    }

    function loadKeysSigsBatch(uint256[] _nodeOpIds, uint256[] _startIndexes, uint256[] _keysCounts)
        external
        view
        returns (bytes memory pubkeys, bytes memory signatures)
    {
        require(_nodeOpIds.length == _startIndexes.length && _startIndexes.length == _keysCounts.length, "LENGTH_MISMATCH");
        uint256 totalKeysCount;
        uint256 i;
        for (i = 0; i < _nodeOpIds.length; ++i) {
            totalKeysCount += _keysCounts[i];
        }
        (pubkeys, signatures) = SigningKeys.initKeysSigsBuf(totalKeysCount);
        uint256 loadedKeysCount;
        for (i = 0; i < _nodeOpIds.length; ++i) {
            KEYSSIGS_POSITION.loadKeysSigs(
                _nodeOpIds[i],
                _startIndexes[i],
                _keysCounts[i],
                pubkeys,
                signatures,
                loadedKeysCount // key offset inside _pubkeys/_signatures buffers
            );
            loadedKeysCount += _keysCounts[i];
        }
    }
}
