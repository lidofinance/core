// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

interface ILido {
    function getSharesByPooledEth(uint256) external view returns (uint256);

    function getPooledEthByShares(uint256) external view returns (uint256);

    function getPooledEthBySharesRoundUp(uint256) external view returns (uint256);

    function transferFrom(address, address, uint256) external;

    function transferSharesFrom(address, address, uint256) external returns (uint256);

    function rebalanceExternalEtherToInternal() external payable;

    function getTotalPooledEther() external view returns (uint256);

    function getExternalEther() external view returns (uint256);

    function getExternalShares() external view returns (uint256);

    function mintExternalShares(address, uint256) external;

    function burnExternalShares(uint256) external;

    function getMaxMintableExternalShares() external view returns (uint256);

    function getTotalShares() external view returns (uint256);

    function getBeaconStat()
        external
        view
        returns (uint256 depositedValidators, uint256 beaconValidators, uint256 beaconBalance);

    function processClStateUpdate(
        uint256 _reportTimestamp,
        uint256 _preClValidators,
        uint256 _reportClValidators,
        uint256 _reportClBalance
    ) external;

    function collectRewardsAndProcessWithdrawals(
        uint256 _reportTimestamp,
        uint256 _reportClBalance,
        uint256 _adjustedPreCLBalance,
        uint256 _withdrawalsToWithdraw,
        uint256 _elRewardsToWithdraw,
        uint256 _lastWithdrawalRequestToFinalize,
        uint256 _simulatedShareRate,
        uint256 _etherToLockOnWithdrawalQueue
    ) external;

    function emitTokenRebase(
        uint256 _reportTimestamp,
        uint256 _timeElapsed,
        uint256 _preTotalShares,
        uint256 _preTotalEther,
        uint256 _postTotalShares,
        uint256 _postTotalEther,
        uint256 _sharesMintedAsFees
    ) external;

    function mintShares(address _recipient, uint256 _sharesAmount) external;

    function burnShares(address _account, uint256 _sharesAmount) external;
}
