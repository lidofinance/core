interface IWithdrawalCredentialsRequests {
    function addWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint64[] calldata amounts
    ) external payable;

    // function addConsolidationRequests(
    //     bytes[] calldata sourcePubkeys,
    //     bytes[] calldata targetPubkeys
    // ) external payable;
}
