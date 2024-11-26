// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {IWithdrawalQueue} from "contracts/0.8.9/sanity_checks/OracleReportSanityChecker.sol";

contract WithdrawalQueue__MockForSanityChecker is IWithdrawalQueue {
    mapping(uint256 => uint256) private _timestamps;

    function setRequestTimestamp(uint256 _requestId, uint256 _timestamp) external {
        _timestamps[_requestId] = _timestamp;
    }

    function getWithdrawalStatus(
        uint256[] calldata _requestIds
    ) external view returns (WithdrawalRequestStatus[] memory statuses) {
        statuses = new WithdrawalRequestStatus[](_requestIds.length);
        for (uint256 i; i < _requestIds.length; ++i) {
            statuses[i].timestamp = _timestamps[_requestIds[i]];
        }
    }
}
