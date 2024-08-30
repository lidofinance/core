// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {WithdrawalQueueBase} from "contracts/0.8.9/WithdrawalQueueBase.sol";

contract WithdrawalsQueueBase__Harness is WithdrawalQueueBase {
    constructor() {
        _initializeQueue();
    }

    function harness__enqueue(
        uint128 _amountOfStETH,
        uint128 _amountOfShares,
        address _owner
    ) external returns (uint256 requestId) {
        return _enqueue(_amountOfStETH, _amountOfShares, _owner);
    }

    function harness__finalize(
        uint256 _lastRequestIdToBeFinalized,
        uint256 _amountOfETH,
        uint256 _maxShareRate
    ) external {
        _finalize(_lastRequestIdToBeFinalized, _amountOfETH, _maxShareRate);
    }

    function harness__getStatus(uint256 _requestId) external view returns (WithdrawalRequestStatus memory status) {
        return _getStatus(_requestId);
    }

    function harness__findCheckpointHint(
        uint256 _requestId,
        uint256 _start,
        uint256 _end
    ) external view returns (uint256) {
        return _findCheckpointHint(_requestId, _start, _end);
    }

    function harness__sendValue(address _recipient, uint256 _amount) external {
        return _sendValue(_recipient, _amount);
    }

    function harness__calcBatch(
        WithdrawalRequest memory _preStartRequest,
        WithdrawalRequest memory _endRequest
    ) external pure returns (uint256 shareRate, uint256 stETH, uint256 shares) {
        return _calcBatch(_preStartRequest, _endRequest);
    }

    function harness__claim(uint256 _requestId, uint256 _hint, address _recipient) external {
        return _claim(_requestId, _hint, _recipient);
    }

    function harness__calculateClaimableEther(uint256 _requestId, uint256 _hint) external view returns (uint256) {
        WithdrawalRequest storage request = _getQueue()[_requestId];

        return _calculateClaimableEther(request, _requestId, _hint);
    }

    function harness__initializeQueue() external {
        _initializeQueue();
    }

    // Internal functions

    function harness__getLastReportTimestamp() external view returns (uint256) {
        return _getLastReportTimestamp();
    }

    function harness__setLastRequestId(uint256 _requestId) external {
        _setLastRequestId(_requestId);
    }

    function harness__setLastFinalizedRequestId(uint256 _requestId) external {
        _setLastFinalizedRequestId(_requestId);
    }

    function harness__setLastCheckpointIndex(uint256 _index) external {
        _setLastCheckpointIndex(_index);
    }

    function harness__setLockedEtherAmount(uint256 _lockedEtherAmount) external {
        _setLockedEtherAmount(_lockedEtherAmount);
    }

    function harness__setLastReportTimestamp(uint256 _timestamp) external {
        _setLastReportTimestamp(_timestamp);
    }
}
