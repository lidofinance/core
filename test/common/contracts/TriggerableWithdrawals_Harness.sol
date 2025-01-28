// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {TriggerableWithdrawals} from "contracts/common/lib/TriggerableWithdrawals.sol";

/**
 * @notice This is a harness of TriggerableWithdrawals library.
 */
contract TriggerableWithdrawals_Harness {
    function addFullWithdrawalRequests(bytes calldata pubkeys, uint256 feePerRequest) external {
        TriggerableWithdrawals.addFullWithdrawalRequests(pubkeys, feePerRequest);
    }

    function addPartialWithdrawalRequests(
        bytes calldata pubkeys,
        uint64[] calldata amounts,
        uint256 feePerRequest
    ) external {
        TriggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, amounts, feePerRequest);
    }

    function addWithdrawalRequests(bytes calldata pubkeys, uint64[] calldata amounts, uint256 feePerRequest) external {
        TriggerableWithdrawals.addWithdrawalRequests(pubkeys, amounts, feePerRequest);
    }

    function getWithdrawalRequestFee() external view returns (uint256) {
        return TriggerableWithdrawals.getWithdrawalRequestFee();
    }

    function getWithdrawalsContractAddress() public pure returns (address) {
        return TriggerableWithdrawals.WITHDRAWAL_REQUEST;
    }

    function deposit() external payable {}
}
