// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract Lido__MockForAccounting {
    uint256 public depositedValidatorsValue;
    uint256 public reportClValidators;
    uint256 public reportClBalance;
    uint256 public reportClActiveBalance;
    uint256 public reportClPendingBalance;

    // Emitted when validators number delivered by the oracle
    // @deprecated This event is deprecated. Use CLBalancesUpdated instead for balance-based accounting
    event CLValidatorsUpdated(uint256 indexed reportTimestamp, uint256 preCLValidators, uint256 postCLValidators);

    // Emitted when CL balances are updated by the oracle
    event CLBalancesUpdated(uint256 indexed reportTimestamp, uint256 clActiveBalance, uint256 clPendingBalance);
    event Mock__CollectRewardsAndProcessWithdrawals(
        uint256 _reportTimestamp,
        uint256 _reportClBalance,
        uint256 _principalCLBalance,
        uint256 _withdrawalsToWithdraw,
        uint256 _elRewardsToWithdraw,
        uint256 _lastWithdrawalRequestToFinalize,
        uint256 _withdrawalsShareRate,
        uint256 _etherToLockOnWithdrawalQueue
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

    function getBeaconStat()
        external
        view
        returns (uint256 depositedValidators, uint256 beaconValidators, uint256 beaconBalance)
    {
        depositedValidators = depositedValidatorsValue;
        beaconValidators = reportClValidators;
        beaconBalance = 0;
    }

    function getTotalPooledEther() external pure returns (uint256) {
        return 3201000000000000000000;
    }

    function getTotalShares() external pure returns (uint256) {
        return 1000000000000000000;
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
        uint256 _etherToLockOnWithdrawalQueue
    ) external {
        emit Mock__CollectRewardsAndProcessWithdrawals(
            _reportTimestamp,
            _reportClBalance,
            _adjustedPreCLBalance,
            _withdrawalsToWithdraw,
            _elRewardsToWithdraw,
            _lastWithdrawalRequestToFinalize,
            _simulatedShareRate,
            _etherToLockOnWithdrawalQueue
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

    function processClStateUpdateV2(
        uint256 _reportTimestamp,
        uint256 _clActiveBalance,
        uint256 _clPendingBalance
    ) external {
        reportClActiveBalance = _clActiveBalance;
        reportClPendingBalance = _clPendingBalance;

        emit CLBalancesUpdated(_reportTimestamp, _clActiveBalance, _clPendingBalance);
    }

    function mintShares(address _recipient, uint256 _sharesAmount) external {
        emit TransferShares(address(0), _recipient, _sharesAmount);
    }
}
