pragma solidity 0.8.9;

import {WithdrawalRequests} from "contracts/0.8.9/lib/WithdrawalRequests.sol";

contract WithdrawalCredentials_Harness {
    function addFullWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint256 totalWithdrawalFee
    ) external {
        WithdrawalRequests.addFullWithdrawalRequests(pubkeys, totalWithdrawalFee);
    }

    function addPartialWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint64[] calldata amounts,
        uint256 totalWithdrawalFee
    ) external {
        WithdrawalRequests.addPartialWithdrawalRequests(pubkeys, amounts, totalWithdrawalFee);
    }

    function addWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint64[] calldata amounts,
        uint256 totalWithdrawalFee
    ) external {
        WithdrawalRequests.addWithdrawalRequests(pubkeys, amounts, totalWithdrawalFee);
    }

    function getWithdrawalRequestFee() external view returns (uint256) {
        return WithdrawalRequests.getWithdrawalRequestFee();
    }

    function getWithdrawalsContractAddress() public pure returns (address) {
        return WithdrawalRequests.WITHDRAWAL_REQUEST;
    }

    function deposit() external payable {}
}
