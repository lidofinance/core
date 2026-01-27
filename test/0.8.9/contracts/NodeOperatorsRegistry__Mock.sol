// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.9;

contract NodeOperatorsRegistry__Mock {
    mapping(uint256 => mapping(uint256 => bytes)) public signingKeys;
    bytes private defaultKey;
    bool private useDefaultKey = true;

    constructor() {
        // Initialize with a default 48-byte pubkey (all zeros) for tests that don't configure specific keys
        defaultKey = new bytes(48);
    }

    function setSigningKey(uint256 nodeOperatorId, uint256 keyIndex, bytes memory key) external {
        signingKeys[nodeOperatorId][keyIndex] = key;
        useDefaultKey = false; // Once keys are set, don't use default
    }

    function setDefaultKey(bytes memory key) external {
        defaultKey = key;
        useDefaultKey = true;
    }

    function getSigningKey(
        uint256 nodeOperatorId,
        uint256 keyIndex
    ) external view returns (bytes memory key, bytes memory depositSignature, bool used) {
        key = signingKeys[nodeOperatorId][keyIndex];

        // If no specific key is set and we're using defaults, return the default key
        if (key.length == 0 && useDefaultKey) {
            key = defaultKey;
        }

        depositSignature = new bytes(96);
        used = false;
    }

    function getNodeOperatorsCount() external pure returns (uint256) {
        return 100;
    }
}
