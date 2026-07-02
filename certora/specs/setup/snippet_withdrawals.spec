// summarizes withdrawals
// https://eips.ethereum.org/EIPS/eip-7002
methods {
    function _.addFullWithdrawalRequests(bytes, uint256) external => NONDET;
    function _.addFullWithdrawalRequests(bytes calldata, uint256) internal => NONDET;

    function _.addWithdrawalRequests(bytes, uint64[], uint256) external => NONDET;
    function _.addWithdrawalRequests(bytes calldata, uint64[] calldata, uint256) internal => NONDET;

    function _.getWithdrawalRequestFee() external => NONDET;
    function _.getWithdrawalRequestFee() internal => NONDET;

    function WithdrawableRequestMock._ external => NONDET;
}
