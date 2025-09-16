pragma solidity 0.8.9;

contract WithdrawalVault__MockForCG {
    event AddConsolidationRequestsCalled(bytes[] sourcePubkeys, bytes[] targetPubkeys);

    function addConsolidationRequests(bytes[] calldata sourcePubkeys, bytes[] calldata targetPubkeys) external payable {
        emit AddConsolidationRequestsCalled(sourcePubkeys, targetPubkeys);
    }

    function getConsolidationRequestFee() external view returns (uint256) {
        return 1;
    }
}
