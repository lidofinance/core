pragma solidity 0.8.9;

contract WithdrawalVault__MockForVebo {

    event AddFullWithdrawalRequestsCalled(bytes[] pubkeys);

    function addFullWithdrawalRequests(bytes[] calldata pubkeys) external {
        emit AddFullWithdrawalRequestsCalled(pubkeys);
    }

    function getWithdrawalRequestFee() external view returns (uint256) {
        return 1;
    }
}