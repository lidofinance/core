// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {NodeOperatorsRegistry} from "contracts/0.4.24/nos/NodeOperatorsRegistry.sol";
import {Packed64x4} from "contracts/0.4.24/lib/Packed64x4.sol";

contract NodeOperatorsRegistry__Harness is NodeOperatorsRegistry {
    bytes public obtainedPublicKeys;
    bytes public obtainedSignatures;

    function harness__initialize(uint256 _initialVersion) external {
        _setContractVersion(_initialVersion);
        initialized();
    }

    function harness__setDepositedSigningKeysCount(uint256 _nodeOperatorId, uint256 _depositedSigningKeysCount) public {
        _onlyExistedNodeOperator(_nodeOperatorId);
        // NodeOperator storage nodeOperator = _nodeOperators[_nodeOperatorId];
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
            _depositedSigningKeysCount >= signingKeysStats.get(TOTAL_EXITED_KEYS_COUNT_OFFSET),
            "DEPOSITED_SIGNING_KEYS_COUNT_TOO_LOW"
        );

        signingKeysStats.set(TOTAL_DEPOSITED_KEYS_COUNT_OFFSET, uint64(_depositedSigningKeysCount));
        _saveOperatorSigningKeysStats(_nodeOperatorId, signingKeysStats);

        emit DepositedSigningKeysCountChanged(_nodeOperatorId, _depositedSigningKeysCount);
        _increaseValidatorsKeysNonce();
    }

    function harness__addNodeOperator(
        string _name,
        address _rewardAddress,
        uint64 totalSigningKeysCount,
        uint64 vettedSigningKeysCount,
        uint64 depositedSigningKeysCount,
        uint64 exitedSigningKeysCount
    ) external returns (uint256 id) {
        id = getNodeOperatorsCount();

        TOTAL_OPERATORS_COUNT_POSITION.setStorageUint256(id + 1);

        NodeOperator storage operator = _nodeOperators[id];

        uint256 activeOperatorsCount = getActiveNodeOperatorsCount();
        ACTIVE_OPERATORS_COUNT_POSITION.setStorageUint256(activeOperatorsCount + 1);

        operator.active = true;
        operator.name = _name;
        operator.rewardAddress = _rewardAddress;

        Packed64x4.Packed memory signingKeysStats;
        signingKeysStats.set(TOTAL_DEPOSITED_KEYS_COUNT_OFFSET, depositedSigningKeysCount);
        signingKeysStats.set(TOTAL_VETTED_KEYS_COUNT_OFFSET, vettedSigningKeysCount);
        signingKeysStats.set(TOTAL_EXITED_KEYS_COUNT_OFFSET, exitedSigningKeysCount);
        signingKeysStats.set(TOTAL_KEYS_COUNT_OFFSET, totalSigningKeysCount);

        operator.signingKeysStats = signingKeysStats;

        Packed64x4.Packed memory operatorTargetStats;
        operatorTargetStats.set(MAX_VALIDATORS_COUNT_OFFSET, vettedSigningKeysCount);
        operator.targetValidatorsStats = operatorTargetStats;

        emit NodeOperatorAdded(id, _name, _rewardAddress, 0);

        Packed64x4.Packed memory summarySigningKeysStats = _loadSummarySigningKeysStats();
        summarySigningKeysStats.add(SUMMARY_MAX_VALIDATORS_COUNT_OFFSET, vettedSigningKeysCount);
        summarySigningKeysStats.add(SUMMARY_EXITED_KEYS_COUNT_OFFSET, exitedSigningKeysCount);
        summarySigningKeysStats.add(SUMMARY_TOTAL_KEYS_COUNT_OFFSET, totalSigningKeysCount);
        summarySigningKeysStats.add(SUMMARY_DEPOSITED_KEYS_COUNT_OFFSET, depositedSigningKeysCount);
        _saveSummarySigningKeysStats(summarySigningKeysStats);
    }

    function harness__setNodeOperatorLimits(
        uint256 _nodeOperatorId,
        uint64,
        uint64,
        uint64
    ) external {
        _updateSummaryMaxValidatorsCount(_nodeOperatorId);
    }

    function harness__obtainDepositData(
        uint256 _keysToAllocate
    ) external returns (uint256 loadedValidatorsKeysCount, bytes memory publicKeys, bytes memory signatures) {
        (publicKeys, signatures) = this.obtainDepositData(_keysToAllocate, new bytes(0));

        obtainedPublicKeys = publicKeys;
        obtainedSignatures = signatures;

        emit ValidatorsKeysLoaded(publicKeys, signatures);
    }

    function harness__loadAllocatedSigningKeys(
        uint256 _keysCountToLoad,
        uint256[] _nodeOperatorIds,
        uint256[] _activeKeyCountsAfterAllocation
    ) external returns (bytes memory pubkeys, bytes memory signatures) {
        (pubkeys, signatures) = _loadAllocatedSigningKeys(
            _keysCountToLoad,
            _nodeOperatorIds,
            _activeKeyCountsAfterAllocation
        );

        obtainedPublicKeys = pubkeys;
        obtainedSignatures = signatures;

        emit ValidatorsKeysLoaded(pubkeys, signatures);
    }

    function harness__getSigningKeysAllocationData(
        uint256 _keysCount
    )
    external
    view
    returns (
        uint256 allocatedKeysCount,
        uint256[] memory nodeOperatorIds,
        uint256[] memory activeKeyCountsAfterAllocation
    )
    {
        return _getSigningKeysAllocationData(_keysCount);
    }

    event ValidatorsKeysLoaded(bytes publicKeys, bytes signatures);

    function harness__setLocator(address _mockedLocator) external {
        LIDO_LOCATOR_POSITION.setStorageAddress(_mockedLocator);
    }

    function harness__setNonce(uint256 _nonce) external {
        KEYS_OP_INDEX_POSITION.setStorageUint256(_nonce);
    }

    /**
     * @dev Extra care is needed.
     * Doesn't update the active node operators counter and node operator's summary
     */
    function harness__unsafeSetNodeOperatorIsActive(uint256 _nodeOperatorId, bool _isActive) external {
        _nodeOperators[_nodeOperatorId].active = _isActive;
    }

    function harness__unsafeResetModuleSummary() external {
        Packed64x4.Packed memory summarySigningKeysStats = Packed64x4.Packed(0);
        _saveSummarySigningKeysStats(summarySigningKeysStats);
    }

    function harness__unsafeSetVettedKeys(uint256 _nodeOperatorId, uint256 _newVettedKeys) external {
        Packed64x4.Packed memory signingKeysStats = _loadOperatorSigningKeysStats(_nodeOperatorId);

        signingKeysStats.set(TOTAL_VETTED_KEYS_COUNT_OFFSET, _newVettedKeys);
        _saveOperatorSigningKeysStats(_nodeOperatorId, signingKeysStats);
    }

    function harness__setRewardDistributionState(RewardDistributionState _state) external {
        _updateRewardDistributionState(_state);
    }

    function harness__setBaseVersion(uint256 _newBaseVersion) external {
        _setContractVersion(_newBaseVersion);
    }
}
