// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract Lido__MockForAccounting {
    uint256 public depositedValidatorsValue;
    uint256 public reportClValidators;
    uint256 public reportClBalance;

    // Emitted when validators number delivered by the oracle
    event CLValidatorsUpdated(uint256 indexed reportTimestamp, uint256 preCLValidators, uint256 postCLValidators);
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

    /**
     * @notice Process CL related state changes as a part of the report processing
     * @dev All data validation was done by Accounting and OracleReportSanityChecker
     * @param _reportTimestamp timestamp of the report
     * @param _preClValidators number of validators in the previous CL state (for event compatibility)
     * @param _reportClValidators number of validators in the current CL state
     * @param _reportClBalance total balance of the current CL state
     */
    function processClStateUpdate(
        uint256 _reportTimestamp,
        uint256 _preClValidators,
        uint256 _reportClValidators,
        uint256 _reportClBalance
    ) external {
        reportClValidators = _reportClValidators;
        reportClBalance = _reportClBalance;

        emit CLValidatorsUpdated(_reportTimestamp, _preClValidators, _reportClValidators);
    }

    function mintShares(address _recipient, uint256 _sharesAmount) external {
        emit TransferShares(address(0), _recipient, _sharesAmount);
    }
}
