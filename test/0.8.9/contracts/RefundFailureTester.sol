// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

interface IWithdrawalVault {
    function addFullWithdrawalRequests(bytes calldata pubkeys) external payable;
    function getWithdrawalRequestFee() external view returns (uint256);
}

/**
 * @notice This is a contract for testing refund failure in WithdrawalVault contract
 */
contract RefundFailureTester {
    IWithdrawalVault private immutable withdrawalVault;

    constructor(address _withdrawalVault) {
        withdrawalVault = IWithdrawalVault(_withdrawalVault);
    }

    receive() external payable {
        revert("Refund failed intentionally");
    }

    function addFullWithdrawalRequests(bytes calldata pubkeys) external payable {
        require(msg.value > withdrawalVault.getWithdrawalRequestFee(), "Not enough eth for Refund");

        // withdrawal vault should fail to refund
        withdrawalVault.addFullWithdrawalRequests{value: msg.value}(pubkeys);
    }
}
