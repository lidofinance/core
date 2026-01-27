// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.9;

contract NodeOperatorsRegistry__Mock {
    mapping(uint256 => mapping(uint256 => bytes)) public signingKeys;

    function setSigningKey(uint256 nodeOperatorId, uint256 keyIndex, bytes memory key) external {
        signingKeys[nodeOperatorId][keyIndex] = key;
    }

    function getSigningKey(
        uint256 nodeOperatorId,
        uint256 keyIndex
    ) external view returns (bytes memory key, bytes memory depositSignature, bool used) {
        key = signingKeys[nodeOperatorId][keyIndex];
        depositSignature = new bytes(96);
        used = false;
    }

    function getNodeOperatorsCount() external pure returns (uint256) {
        return 100;
    }
}
