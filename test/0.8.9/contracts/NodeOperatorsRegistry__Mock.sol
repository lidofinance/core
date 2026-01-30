// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.9;

/**
 * @notice Mock NodeOperatorsRegistry for testing
 * @dev This mock is permissive - it accepts any pubkey for any (nodeOpId, keyIndex) combination
 * Tests can optionally configure specific keys using setSigningKey()
 */
contract NodeOperatorsRegistry__Mock {
    mapping(uint256 => mapping(uint256 => bytes)) public signingKeys;

    // If true, return any non-empty key even if not explicitly set
    bool public permissiveMode = true;

    function setSigningKey(uint256 nodeOperatorId, uint256 keyIndex, bytes memory key) external {
        signingKeys[nodeOperatorId][keyIndex] = key;
    }

    function setPermissiveMode(bool _permissive) external {
        permissiveMode = _permissive;
    }

    function getSigningKey(
        uint256 nodeOperatorId,
        uint256 keyIndex
    ) external view returns (bytes memory key, bytes memory depositSignature, bool used) {
        key = signingKeys[nodeOperatorId][keyIndex];

        // In permissive mode, return empty key if not explicitly set
        // The ValidatorsExitBus contract will skip validation for empty keys
        // This allows tests to work without pre-configuring every possible (nodeOpId, keyIndex) combination
        // Tests can still explicitly set keys using setSigningKey() if needed

        depositSignature = new bytes(96);
        used = false;
    }

    function getNodeOperatorsCount() external pure returns (uint256) {
        return 100;
    }
}
