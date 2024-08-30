// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {SigningKeys} from "contracts/0.4.24/lib/SigningKeys.sol";

contract SigningKeys__Harness {
    using SigningKeys for bytes32;

    bytes32 public constant KEYSSIGS_POSITION = keccak256("KEYSSIGS_POSITION");

    uint256[] public _nodeOperatorIds;

    event SigningKeyAdded(uint256 indexed nodeOperatorId, bytes pubkey);
    event SigningKeyRemoved(uint256 indexed nodeOperatorId, bytes pubkey);

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

    function removeKeysSigs(
        uint256 _nodeOperatorId,
        uint256 _startIndex,
        uint256 _keysCount,
        uint256 _lastIndex
    ) external returns (uint256) {
        return KEYSSIGS_POSITION.removeKeysSigs(_nodeOperatorId, _startIndex, _keysCount, _lastIndex);
    }

    function loadKeysSigs(
        uint256 _nodeOperatorId,
        uint256 _startIndex,
        uint256 _keysCount
    ) external view returns (bytes memory pubkeys, bytes memory signatures) {
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
}
