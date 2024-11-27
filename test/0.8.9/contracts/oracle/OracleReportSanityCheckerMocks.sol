// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// for testing purposes only

pragma solidity 0.8.9;

import {IWithdrawalQueue} from "contracts/0.8.9/sanity_checks/OracleReportSanityChecker.sol";

contract LidoStub {
    uint256 private _shareRate = 1 ether;

    function getSharesByPooledEth(uint256 _sharesAmount) external view returns (uint256) {
        return (_shareRate * _sharesAmount) / 1 ether;
    }

    function setShareRate(uint256 _value) external {
        _shareRate = _value;
    }
}

contract WithdrawalQueueStub is IWithdrawalQueue {
    mapping(uint256 => uint256) private _timestamps;

    function setRequestTimestamp(uint256 _requestId, uint256 _timestamp) external {
        _timestamps[_requestId] = _timestamp;
    }

    function getWithdrawalStatus(
        uint256[] calldata _requestIds
    ) external view returns (
        WithdrawalRequestStatus[] memory statuses
    ) {
        statuses = new WithdrawalRequestStatus[](_requestIds.length);
        for (uint256 i; i < _requestIds.length; ++i) {
            statuses[i].timestamp = _timestamps[_requestIds[i]];
        }
    }
}

contract BurnerStub {
    uint256 private nonCover;
    uint256 private cover;

    function getSharesRequestedToBurn() external view returns (
        uint256 coverShares, uint256 nonCoverShares
    ) {
        coverShares = cover;
        nonCoverShares = nonCover;
    }

    function setSharesRequestedToBurn(uint256 _cover, uint256 _nonCover) external {
        cover = _cover;
        nonCover = _nonCover;
    }
}

interface ILidoLocator {
    function lido() external view returns (address);

    function burner() external view returns (address);

    function withdrawalVault() external view returns (address);

    function withdrawalQueue() external view returns (address);
}

contract LidoLocatorStub is ILidoLocator {
    address private immutable LIDO;
    address private immutable WITHDRAWAL_VAULT;
    address private immutable WITHDRAWAL_QUEUE;
    address private immutable EL_REWARDS_VAULT;
    address private immutable BURNER;

    constructor(
        address _lido,
        address _withdrawalVault,
        address _withdrawalQueue,
        address _elRewardsVault,
        address _burner
    ) {
        LIDO = _lido;
        WITHDRAWAL_VAULT = _withdrawalVault;
        WITHDRAWAL_QUEUE = _withdrawalQueue;
        EL_REWARDS_VAULT = _elRewardsVault;
        BURNER = _burner;
    }

    function lido() external view returns (address) {
        return LIDO;
    }

    function withdrawalQueue() external view returns (address) {
        return WITHDRAWAL_QUEUE;
    }

    function withdrawalVault() external view returns (address) {
        return WITHDRAWAL_VAULT;
    }

    function elRewardsVault() external view returns (address) {
        return EL_REWARDS_VAULT;
    }

    function burner() external view returns (address) {
        return BURNER;
    }
}

contract OracleReportSanityCheckerStub {
    error SelectorNotFound(bytes4 sig, uint256 value, bytes data);

    fallback() external payable {revert SelectorNotFound(msg.sig, msg.value, msg.data);}

    function checkAccountingOracleReport(
        uint256 _timeElapsed,
        uint256 _preCLBalance,
        uint256 _postCLBalance,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256 _sharesRequestedToBurn,
        uint256 _preCLValidators,
        uint256 _postCLValidators
    ) external view {}

    function checkWithdrawalQueueOracleReport(
        uint256[] calldata _withdrawalFinalizationBatches,
        uint256 _reportTimestamp
    ) external view {}

    function checkSimulatedShareRate(
        uint256 _postTotalPooledEther,
        uint256 _postTotalShares,
        uint256 _etherLockedOnWithdrawalQueue,
        uint256 _sharesBurntDueToWithdrawals,
        uint256 _simulatedShareRate
    ) external view {}

    function smoothenTokenRebase(
        uint256,
        uint256,
        uint256,
        uint256,
        uint256 _withdrawalVaultBalance,
        uint256 _elRewardsVaultBalance,
        uint256,
        uint256 _etherToLockForWithdrawals,
        uint256
    ) external view returns (
        uint256 withdrawals,
        uint256 elRewards,
        uint256 simulatedSharesToBurn,
        uint256 sharesToBurn
    ) {
        withdrawals = _withdrawalVaultBalance;
        elRewards = _elRewardsVaultBalance;

        simulatedSharesToBurn = 0;
        sharesToBurn = _etherToLockForWithdrawals;
    }

    function checkExtraDataItemsCountPerTransaction(uint256 _extraDataListItemsCount) external view {}
}
