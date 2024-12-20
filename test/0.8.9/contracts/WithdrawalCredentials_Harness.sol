pragma solidity 0.8.9;

import {WithdrawalRequests} from "contracts/0.8.9/lib/WithdrawalRequests.sol";

contract WithdrawalCredentials_Harness {
    function addFullWithdrawalRequests(
        bytes[] calldata pubkeys
    ) external payable {
        WithdrawalRequests.addFullWithdrawalRequests(pubkeys);
    }

    function addPartialWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint64[] calldata amounts
    ) external payable {
        WithdrawalRequests.addPartialWithdrawalRequests(pubkeys, amounts);
    }

    function getWithdrawalRequestFee() external view returns (uint256) {
        return WithdrawalRequests.getWithdrawalRequestFee();
    }
}
