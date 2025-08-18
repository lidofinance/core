pragma solidity 0.8.9;

contract WithdrawalVault__MockForTWG {
    event AddFullWithdrawalRequestsCalled(bytes[] pubkeys);

    function addWithdrawalRequests(bytes[] calldata pubkeys, uint64[] calldata amount) external payable {
        emit AddFullWithdrawalRequestsCalled(pubkeys);
    }

    function getWithdrawalRequestFee() external view returns (uint256) {
        return 1;
    }
}
