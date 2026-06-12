// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract Lido__MockForAccounting {
    uint256 internal constant MOCK_TOTAL_POOLED_ETHER = 3201 ether;
    uint256 internal constant MOCK_TOTAL_SHARES = 1 ether;

    uint256 public depositedValidatorsValue;
    uint256 public reportClValidators;
    uint256 public reportClBalance;
    uint256 public reportClValidatorsBalance;
    uint256 public reportClPendingBalance;
    uint256 public depositedLastReport;
    uint256 public depositedCurrentReport;

    // Emitted when CL balances are updated by the oracle
    event CLBalancesUpdated(uint256 indexed reportTimestamp, uint256 clValidatorsBalance, uint256 clPendingBalance);
    event Mock__CollectRewardsAndProcessWithdrawals(
        uint256 _reportTimestamp,
        uint256 _reportClBalance,
        uint256 _principalCLBalance,
        uint256 _withdrawalsToWithdraw,
        uint256 _elRewardsToWithdraw,
        uint256 _lastWithdrawalRequestToFinalize,
        uint256 _withdrawalsShareRate,
        uint256 _etherToLockOnWithdrawalQueue,
        uint256 _redeemedEther,
        uint256 _redeemedShares
    );
    /**
     * @notice An executed shares transfer from `sender` to `recipient`.
     *
     * @dev emitted in pair with an ERC20-defined `Transfer` event.
     */
    event TransferShares(address indexed from, address indexed to, uint256 sharesValue);

    function mock__setDepositedValidators(uint256 _amount) external {
        depositedValidatorsValue = _amount;
    }

    function mock__setClValidatorsBalance(uint256 _amount) external {
        reportClValidatorsBalance = _amount;
    }

    function mock__setClPendingBalance(uint256 _amount) external {
        reportClPendingBalance = _amount;
    }

    function mock__setDepositedLastReportBalance(uint256 _amount) external {
        depositedLastReport = _amount;
    }

    function mock__setDepositedCurrentReportBalance(uint256 _amount) external {
        depositedCurrentReport = _amount;
    }

    function getBeaconStat()
        external
        view
        returns (uint256 depositedValidators, uint256 beaconValidators, uint256 beaconBalance)
    {
        depositedValidators = depositedValidatorsValue;
        beaconValidators = depositedValidators;
        beaconBalance = reportClValidatorsBalance + reportClPendingBalance;
    }

    function getBalanceStats()
        external
        view
        returns (
            uint256 clValidatorsBalanceAtLastReport,
            uint256 clPendingBalanceAtLastReport,
            uint256 depositedSinceLastReport,
            uint256 depositedForCurrentReport
        )
    {
        clValidatorsBalanceAtLastReport = reportClValidatorsBalance;
        clPendingBalanceAtLastReport = reportClPendingBalance;
        depositedSinceLastReport = depositedLastReport;
        depositedForCurrentReport = depositedCurrentReport;
    }

    function getTotalPooledEther() external pure returns (uint256) {
        return MOCK_TOTAL_POOLED_ETHER;
    }

    function getTotalShares() external pure returns (uint256) {
        return MOCK_TOTAL_SHARES;
    }

    function getSharesByPooledEth(uint256 _ethAmount) external pure returns (uint256) {
        // Mirrors the real Lido formula at the constant rate exposed above.
        return (_ethAmount * MOCK_TOTAL_SHARES) / MOCK_TOTAL_POOLED_ETHER;
    }

    function getExternalShares() external pure returns (uint256) {
        return 0;
    }

    function getExternalEther() external pure returns (uint256) {
        return 0;
    }

    function collectRewardsAndProcessWithdrawals(
        uint256 _reportTimestamp,
        uint256 _reportClBalance,
        uint256 _adjustedPreCLBalance,
        uint256 _withdrawalsToWithdraw,
        uint256 _elRewardsToWithdraw,
        uint256 _lastWithdrawalRequestToFinalize,
        uint256 _simulatedShareRate,
        uint256 _etherToLockOnWithdrawalQueue,
        uint256 _redeemedEther,
        uint256 _redeemedShares
    ) external {
        emit Mock__CollectRewardsAndProcessWithdrawals(
            _reportTimestamp,
            _reportClBalance,
            _adjustedPreCLBalance,
            _withdrawalsToWithdraw,
            _elRewardsToWithdraw,
            _lastWithdrawalRequestToFinalize,
            _simulatedShareRate,
            _etherToLockOnWithdrawalQueue,
            _redeemedEther,
            _redeemedShares
        );
    }

    function emitTokenRebase(
        uint256 _reportTimestamp,
        uint256 _timeElapsed,
        uint256 _preTotalShares,
        uint256 _preTotalEther,
        uint256 _postTotalShares,
        uint256 _postTotalEther,
        uint256 _postInternalShares,
        uint256 _postInternalEther,
        uint256 _sharesMintedAsFees
    ) external {}

    function processClStateUpdate(
        uint256 _reportTimestamp,
        uint256 _clValidatorsBalance,
        uint256 _clPendingBalance
    ) external {
        reportClValidatorsBalance = _clValidatorsBalance;
        reportClPendingBalance = _clPendingBalance;

        emit CLBalancesUpdated(_reportTimestamp, _clValidatorsBalance, _clPendingBalance);
    }

    function mintShares(address _recipient, uint256 _sharesAmount) external {
        emit TransferShares(address(0), _recipient, _sharesAmount);
    }

    function transferShares(address _recipient, uint256 _amount) external returns (uint256) {
        emit TransferShares(msg.sender, _recipient, _amount);
        return _amount;
    }
}
