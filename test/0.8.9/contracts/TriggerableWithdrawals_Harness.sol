pragma solidity 0.8.9;

import {TriggerableWithdrawals} from "contracts/0.8.9/lib/TriggerableWithdrawals.sol";

contract TriggerableWithdrawals_Harness {
    function addFullWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint256 feePerRequest
    ) external {
        TriggerableWithdrawals.addFullWithdrawalRequests(pubkeys, feePerRequest);
    }

    function addPartialWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint64[] calldata amounts,
        uint256 feePerRequest
    ) external {
        TriggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, amounts, feePerRequest);
    }

    function addWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint64[] calldata amounts,
        uint256 feePerRequest
    ) external {
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
