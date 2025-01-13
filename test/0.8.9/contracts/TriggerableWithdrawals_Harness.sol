pragma solidity 0.8.9;

import {TriggerableWithdrawals} from "contracts/0.8.9/lib/TriggerableWithdrawals.sol";

contract TriggerableWithdrawals_Harness {
    function addFullWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint256 totalWithdrawalFee
    ) external {
        TriggerableWithdrawals.addFullWithdrawalRequests(pubkeys, totalWithdrawalFee);
    }

    function addPartialWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint64[] calldata amounts,
        uint256 totalWithdrawalFee
    ) external {
        TriggerableWithdrawals.addPartialWithdrawalRequests(pubkeys, amounts, totalWithdrawalFee);
    }

    function addWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint64[] calldata amounts,
        uint256 totalWithdrawalFee
    ) external {
        TriggerableWithdrawals.addWithdrawalRequests(pubkeys, amounts, totalWithdrawalFee);
    }

    function getWithdrawalRequestFee() external view returns (uint256) {
        return TriggerableWithdrawals.getWithdrawalRequestFee();
    }

    function getWithdrawalsContractAddress() public pure returns (address) {
        return TriggerableWithdrawals.WITHDRAWAL_REQUEST;
    }

    function deposit() external payable {}
}
