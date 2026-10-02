/* Common summaries for `WithdrawalQueue` */

methods {
    // `WithdrawalQueueBase`
    function _.prefinalize(
        uint256[] batches,
        uint256 maxShareRate
    ) external => CVLprefinalize(batches, maxShareRate) expect (uint256, uint256);
    function _.unfinalizedStETH() external =>  DISPATCHER(true);

    // The following methods are not implemented in `WithdrawalQueueMock`
    function _.finalize(uint256, uint256) external => NONDET;
    function _.getWithdrawalStatus(uint256[]) external => NONDET;
}


/// @dev Summarizes `WithdrawalQueueBase.prefinalize`
function CVLprefinalize(uint256[] batches, uint256 maxShareRate) returns (uint256, uint256) {
    uint256 ethToLock;
    uint256 sharesToBurn;
    require(sharesToBurn >= batches.length, "Assume at least one share per batch");
    require(
        ethToLock <= sharesToBurn * maxShareRate,
        "Maximal share rate is not surpassed"
    );
    return (ethToLock, sharesToBurn);
}
