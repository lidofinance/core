pragma solidity 0.8.9;

import {WithdrawalCredentialsRequests} from "contracts/0.8.9/lib/WithdrawalCredentialsRequests.sol";

contract WithdrawalCredentials_Harness {
    function addWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint64[] calldata amounts
    ) external payable {
        WithdrawalCredentialsRequests.addWithdrawalRequests(pubkeys, amounts);
    }

    function getWithdrawalRequestFee() external view returns (uint256) {
        return WithdrawalCredentialsRequests.getWithdrawalRequestFee();
    }
}
