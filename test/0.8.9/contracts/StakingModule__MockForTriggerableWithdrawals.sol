// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

import {IStakingModule} from "contracts/0.8.9/interfaces/IStakingModule.sol";

contract StakingModule__MockForTriggerableWithdrawals is IStakingModule {
    uint256 private _nonce;
    uint256[] private _nodeOperatorIds;
    bool private _onValidatorExitTriggeredResponse = true;
    string private _revertReason = "Mock revert";
    bool private _revertWithEmptyReason = false;

    // State control functions
    function setOnValidatorExitTriggeredResponse(bool response) external {
        _onValidatorExitTriggeredResponse = response;
    }

    function setRevertReason(string memory reason) external {
        _revertReason = reason;
    }

    function setRevertWithEmptyReason(bool value) external {
        _revertWithEmptyReason = value;
    }

    // Additional required implementations
    function exitDeadlineThreshold(uint256) external pure override returns (uint256) {
        return 7 days; // Default value for testing
    }

    function getType() external pure override returns (bytes32) {
        return keccak256("MOCK_STAKING_MODULE");
    }

    function isValidatorExitDelayPenaltyApplicable(
        uint256 _nodeOperatorId,
        uint256 _proofSlotTimestamp,
        bytes calldata _publicKey,
        uint256 _eligibleToExitInSec
    ) external pure override returns (bool) {
        return false; // Default value for testing
    }

    // IStakingModule implementations
    function obtainDepositData(
        uint256 count,
        bytes calldata
    ) external pure override returns (bytes memory publicKeys, bytes memory signatures) {
        publicKeys = new bytes(count * 48);
        signatures = new bytes(count * 96);
        return (publicKeys, signatures);
    }

    function onWithdrawalCredentialsChanged() external pure override {
        return;
    }

    function onRewardsMinted(uint256) external pure override {
        return;
    }

    function getNonce() external view override returns (uint256) {
        return _nonce;
    }

    function getStakingModuleSummary()
        external
        pure
        override
        returns (uint256 totalExitedValidators, uint256 totalDepositedValidators, uint256 depositableValidatorsCount)
    {
        return (0, 0, 0);
    }

    function getNodeOperatorSummary(
        uint256
    )
        external
        pure
        override
        returns (
            uint256 targetLimitMode,
            uint256 targetValidatorsCount,
            uint256 stuckValidatorsCount,
            uint256 refundedValidatorsCount,
            uint256 stuckPenaltyEndTimestamp,
            uint256 totalExitedValidators,
            uint256 totalDepositedValidators,
            uint256 depositableValidatorsCount
        )
    {
        return (0, 0, 0, 0, 0, 0, 0, 0);
    }

    function getNodeOperatorsCount() external view override returns (uint256) {
        return 1;
    }

    function getActiveNodeOperatorsCount() external view override returns (uint256) {
        return 1;
    }

    function getNodeOperatorIds(uint256, uint256) external view override returns (uint256[] memory) {
        return _nodeOperatorIds;
    }

    function getNodeOperatorIsActive(uint256) external pure override returns (bool) {
        return true;
    }

    function updateTargetValidatorsLimits(uint256, uint256, uint256) external pure override {
        return;
    }

    function updateRefundedValidatorsCount(uint256, uint256) external pure override {
        return;
    }

    function updateExitedValidatorsCount(bytes calldata, bytes calldata) external pure override {
        return;
    }

    function onExitedAndStuckValidatorsCountsUpdated() external pure override {
        return;
    }

    function decreaseVettedSigningKeysCount(bytes calldata, bytes calldata) external pure override {
        return;
    }

    function unsafeUpdateValidatorsCount(uint256, uint256) external pure override {
        return;
    }

    // The functions we are testing
    function reportValidatorExitDelay(uint256, uint256, bytes calldata, uint256) external pure override {
        return;
    }

    function onValidatorExitTriggered(uint256, bytes calldata, uint256, uint256) external view override {
        if (!_onValidatorExitTriggeredResponse) {
            if (_revertWithEmptyReason) {
                assembly {
                    revert(0, 0)
                }
            }
            revert(_revertReason);
        }
    }
}
