// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

/**
 * @dev Mock for source staking module (CMv1/NOR) for ConsolidationMigrator tests
 */
contract SourceModule__MockForConsolidationMigrator {
    struct SigningKey {
        bytes pubkey;
        bytes depositSignature;
        bool used;
    }

    struct NodeOperator {
        bool active;
        string name;
        address rewardAddress;
        uint64 totalVettedValidators;
        uint64 totalExitedValidators;
        uint64 totalAddedValidators;
        uint64 totalDepositedValidators;
    }

    // operatorId => keyIndex => SigningKey
    mapping(uint256 => mapping(uint256 => SigningKey)) internal _signingKeys;
    mapping(uint256 => NodeOperator) internal _operators;

    function mock__setSigningKey(uint256 operatorId, uint256 keyIndex, bytes calldata pubkey, bool used) external {
        _signingKeys[operatorId][keyIndex] = SigningKey({pubkey: pubkey, depositSignature: new bytes(96), used: used});
    }

    function mock__setNodeOperator(uint256 operatorId, address rewardAddress, bool active) external {
        _operators[operatorId] = NodeOperator({
            active: active,
            name: "",
            rewardAddress: rewardAddress,
            totalVettedValidators: 0,
            totalExitedValidators: 0,
            totalAddedValidators: 0,
            totalDepositedValidators: 0
        });
    }

    function getSigningKey(
        uint256 _nodeOperatorId,
        uint256 _index
    ) external view returns (bytes memory key, bytes memory depositSignature, bool used) {
        SigningKey storage sk = _signingKeys[_nodeOperatorId][_index];
        return (sk.pubkey, sk.depositSignature, sk.used);
    }

    function getNodeOperator(
        uint256 _nodeOperatorId,
        bool /* _fullInfo */
    )
        external
        view
        returns (
            bool active,
            string memory name,
            address rewardAddress,
            uint64 totalVettedValidators,
            uint64 totalExitedValidators,
            uint64 totalAddedValidators,
            uint64 totalDepositedValidators
        )
    {
        NodeOperator storage op = _operators[_nodeOperatorId];
        return (
            op.active,
            op.name,
            op.rewardAddress,
            op.totalVettedValidators,
            op.totalExitedValidators,
            op.totalAddedValidators,
            op.totalDepositedValidators
        );
    }
}
