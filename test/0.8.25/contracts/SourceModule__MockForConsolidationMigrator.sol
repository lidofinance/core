// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

/**
 * @dev Mock for source staking module for ConsolidationMigrator tests.
 *      Implements the IStakingModule interface (getSigningKeys + getNodeOperatorSummary).
 */
contract SourceModule__MockForConsolidationMigrator {
    uint256 public constant PUBKEY_LENGTH = 48;
    uint256 public constant SIGNATURE_LENGTH = 96;

    struct NodeOperatorData {
        uint256 totalDepositedValidators;
        bytes[] pubkeys;
    }

    // operatorId => data
    mapping(uint256 => NodeOperatorData) internal _operators;

    function mock__setOperatorData(
        uint256 operatorId,
        uint256 totalDepositedValidators,
        bytes[] calldata pubkeys
    ) external {
        _operators[operatorId].totalDepositedValidators = totalDepositedValidators;
        delete _operators[operatorId].pubkeys;
        for (uint256 i = 0; i < pubkeys.length; ++i) {
            _operators[operatorId].pubkeys.push(pubkeys[i]);
        }
    }

    function getNodeOperatorSummary(
        uint256 _nodeOperatorId
    )
        external
        view
        returns (
            uint256 targetLimitMode,
            uint256 targetValidatorsCount,
            uint256 stuckValidatorsCount,
            uint256 refundedValidatorsCount,
            uint256 stuckPenaltyEndTimestamp,
            uint256 totalExitedValidators,
            uint256 totalDepositedValidators,
            uint256 depositableValidatorsCount
        )
    {
        NodeOperatorData storage op = _operators[_nodeOperatorId];
        totalDepositedValidators = op.totalDepositedValidators;
        return (0, 0, 0, 0, 0, 0, totalDepositedValidators, 0);
    }

    // NOR interface
    function getSigningKeys(
        uint256 _nodeOperatorId,
        uint256 _offset,
        uint256 _limit
    ) external view returns (bytes memory pubkeys, bytes memory signatures, bool[] memory used) {
        NodeOperatorData storage op = _operators[_nodeOperatorId];

        pubkeys = new bytes(_limit * PUBKEY_LENGTH);
        signatures = new bytes(_limit * SIGNATURE_LENGTH);
        used = new bool[](_limit);

        for (uint256 i = 0; i < _limit; ++i) {
            uint256 keyIndex = _offset + i;
            if (keyIndex < op.pubkeys.length) {
                bytes storage key = op.pubkeys[keyIndex];
                for (uint256 j = 0; j < PUBKEY_LENGTH; ++j) {
                    pubkeys[i * PUBKEY_LENGTH + j] = key[j];
                }
                used[i] = keyIndex < op.totalDepositedValidators;
            }
        }

        return (pubkeys, signatures, used);
    }
}
