pragma solidity 0.8.9;

interface IWithdrawalVault {
    function addFullWithdrawalRequests(bytes[] calldata pubkeys) external;
}