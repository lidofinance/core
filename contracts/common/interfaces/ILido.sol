// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.0;

import {IERC20} from "@openzeppelin/contracts-v4.4/token/ERC20/IERC20.sol";

import {IVersioned} from "contracts/common/interfaces/IVersioned.sol";

interface ILido is IERC20, IVersioned {
    function sharesOf(address) external view returns (uint256);

    function getSharesByPooledEth(uint256) external view returns (uint256);

    function getPooledEthByShares(uint256) external view returns (uint256);

    function getPooledEthBySharesRoundUp(uint256) external view returns (uint256);

    function transferSharesFrom(address, address, uint256) external returns (uint256);

    function transferShares(address, uint256) external returns (uint256);

    function rebalanceExternalEtherToInternal() external payable;

    function getTotalPooledEther() external view returns (uint256);

    function getExternalEther() external view returns (uint256);

    function getExternalShares() external view returns (uint256);

    function mintExternalShares(address, uint256) external;

    function burnExternalShares(uint256) external;

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
        uint256 _postInternalShares,
        uint256 _postInternalEther,
        uint256 _sharesMintedAsFees
    ) external;

    function mintShares(address _recipient, uint256 _sharesAmount) external;

    function internalizeExternalBadDebt(uint256 _amountOfShares) external;
}
