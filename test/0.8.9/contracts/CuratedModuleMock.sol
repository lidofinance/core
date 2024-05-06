// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// for testing purposes only

pragma solidity 0.4.24;

import {NodeOperatorsRegistry} from "contracts/0.4.24/nos/NodeOperatorsRegistry.sol";
import {Packed64x4} from "contracts/0.4.24/lib/Packed64x4.sol";

contract CuratedModuleMock is NodeOperatorsRegistry {
    constructor() NodeOperatorsRegistry {
        CONTRACT_VERSION_POSITION.setStorageUint256(0);
        INITIALIZATION_BLOCK_POSITION.setStorageUint256(0);
    }

    function initialize(address _locator, bytes32 _type, uint256 _stuckPenaltyDelay) {
        LIDO_LOCATOR_POSITION.setStorageAddress(_locator);
        TYPE_POSITION.setStorageBytes32(_type);

        _setContractVersion(2);

        _setStuckPenaltyDelay(_stuckPenaltyDelay);

        emit LocatorContractSet(_locator);
        emit StakingModuleTypeSet(_type);

        initialized();
    }

    function _onlyNodeOperatorManager(address _sender, uint256 _nodeOperatorId) internal view {
        //pass check for testing purpose
    }

    function _auth(bytes32 _role) internal view {
        //pass check for testing purpose
    }

    function _authP(bytes32 _role, uint256[] _params) internal view {
        //pass check for testing purpose
    }


    function testing_markAllKeysDeposited(uint256 _nodeOperatorId) external {
        _onlyExistedNodeOperator(_nodeOperatorId);
        Packed64x4.Packed memory signingKeysStats = _nodeOperators[_nodeOperatorId].signingKeysStats;
        testing_setDepositedSigningKeysCount(_nodeOperatorId, signingKeysStats.get(TOTAL_VETTED_KEYS_COUNT_OFFSET));
    }

    function testing_setDepositedSigningKeysCount(uint256 _nodeOperatorId, uint256 _depositedSigningKeysCount) public {
        _onlyExistedNodeOperator(_nodeOperatorId);

        NodeOperator storage nodeOperator = _nodeOperators[_nodeOperatorId];
        Packed64x4.Packed memory signingKeysStats = _loadOperatorSigningKeysStats(_nodeOperatorId);
        uint256 depositedSigningKeysCountBefore = signingKeysStats.get(TOTAL_DEPOSITED_KEYS_COUNT_OFFSET);

        if (_depositedSigningKeysCount == depositedSigningKeysCountBefore) {
            return;
        }

        require(
            _depositedSigningKeysCount <= signingKeysStats.get(TOTAL_VETTED_KEYS_COUNT_OFFSET),
            "DEPOSITED_SIGNING_KEYS_COUNT_TOO_HIGH"
        );

        require(
            _depositedSigningKeysCount >= signingKeysStats.get(TOTAL_EXITED_KEYS_COUNT_OFFSET), "DEPOSITED_SIGNING_KEYS_COUNT_TOO_LOW"
        );

        signingKeysStats.set(TOTAL_DEPOSITED_KEYS_COUNT_OFFSET, uint64(_depositedSigningKeysCount));
        _saveOperatorSigningKeysStats(_nodeOperatorId, signingKeysStats);

        emit DepositedSigningKeysCountChanged(_nodeOperatorId, _depositedSigningKeysCount);
        _increaseValidatorsKeysNonce();

    }
}
