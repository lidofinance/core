// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

/**
 * @notice Universal mock for staking modules that returns any requested signing key
 * @dev This mock implements both legacy (NOR, SDVT) and new (CSM, CuratedV2) interfaces
 *      and can be used for key verification testing in ValidatorsExitBus
 */
contract StakingModule__MockForKeyVerification {
    // Storage: nodeOpId => keyIndex => pubkey (48 bytes)
    mapping(uint256 => mapping(uint256 => bytes)) private _keys;

    /// @notice Configure a signing key for testing
    /// @param nodeOpId Node operator ID
    /// @param keyIndex Key index
    /// @param pubkey Public key (48 bytes)
    function setSigningKey(uint256 nodeOpId, uint256 keyIndex, bytes calldata pubkey) external {
        require(pubkey.length == 48, "Invalid pubkey length");
        _keys[nodeOpId][keyIndex] = pubkey;
    }

    /// @notice Legacy interface (NOR, SDVT): getSigningKeys returns pubkeys, signatures, and used flags
    /// @param _nodeOperatorId Node operator ID
    /// @param _offset Key index to start from
    /// @param _limit Number of keys to return
    /// @return pubkeys Concatenated public keys (48 bytes each)
    /// @return signatures Empty (not needed for exit verification)
    /// @return used Empty (not needed for exit verification)
    function getSigningKeys(
        uint256 _nodeOperatorId,
        uint256 _offset,
        uint256 _limit
    ) external view returns (bytes memory pubkeys, bytes memory signatures, bool[] memory used) {
        require(_limit == 1, "Mock only supports _limit=1");

        bytes memory key = _keys[_nodeOperatorId][_offset];
        if (key.length == 0) {
            // Permissive mode: generate a deterministic 48-byte key
            // This allows tests to work without explicitly configuring every key
            bytes32 hash1 = keccak256(abi.encode(_nodeOperatorId, _offset));
            bytes32 hash2 = keccak256(abi.encode(_nodeOperatorId, _offset, 1));
            key = new bytes(48);
            assembly {
                // Copy first 32 bytes from hash1
                mstore(add(key, 32), hash1)
                // Copy next 16 bytes from hash2 (total 48 bytes)
                mstore(add(key, 64), hash2)
            }
        }

        pubkeys = key;
        signatures = new bytes(0);
        used = new bool[](1);
    }
}
