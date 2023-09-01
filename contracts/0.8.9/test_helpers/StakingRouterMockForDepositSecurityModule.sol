// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {IStakingRouter} from "../DepositSecurityModule.sol";
import {StakingRouter} from "../StakingRouter.sol";


contract StakingRouterMockForDepositSecurityModule is IStakingRouter {
    error StakingModuleUnregistered();

    event StakingModuleDeposited(uint256 maxDepositsCount, uint24 stakingModuleId, bytes depositCalldata);
    event StakingModuleStatusSet(uint24 indexed stakingModuleId, StakingRouter.StakingModuleStatus status, address setBy);

    StakingRouter.StakingModuleStatus private status;
    uint256 private stakingModuleNonce;
    uint256 private stakingModuleLastDepositBlock;
    uint256 private registeredStakingModuleId;

    constructor(uint256 stakingModuleId) {
        registeredStakingModuleId = stakingModuleId;
    }

    function deposit(
        uint256 maxDepositsCount,
        uint256 stakingModuleId,
        bytes calldata depositCalldata
    ) external whenModuleIsRegistered(stakingModuleId) payable returns (uint256 keysCount) {
        emit StakingModuleDeposited(maxDepositsCount, uint24(stakingModuleId), depositCalldata);
        return maxDepositsCount;
    }

    function hasStakingModule(uint256 _stakingModuleId) public view returns (bool) {
        return _stakingModuleId == registeredStakingModuleId;
    }

    function getStakingModuleStatus(uint256 stakingModuleId) external view whenModuleIsRegistered(stakingModuleId) returns (StakingRouter.StakingModuleStatus) {
        return status;
    }

    function setStakingModuleStatus(
        uint256 _stakingModuleId, StakingRouter.StakingModuleStatus _status
    ) external whenModuleIsRegistered(_stakingModuleId) {
        emit StakingModuleStatusSet(uint24(_stakingModuleId), _status, msg.sender);
        status = _status;
    }

    function pauseStakingModule(uint256 stakingModuleId) external whenModuleIsRegistered(stakingModuleId) {
        emit StakingModuleStatusSet(uint24(stakingModuleId), StakingRouter.StakingModuleStatus.DepositsPaused, msg.sender);
        status = StakingRouter.StakingModuleStatus.DepositsPaused;
    }

    function resumeStakingModule(uint256 stakingModuleId) external whenModuleIsRegistered(stakingModuleId) {
        emit StakingModuleStatusSet(uint24(stakingModuleId), StakingRouter.StakingModuleStatus.Active, msg.sender);
        status = StakingRouter.StakingModuleStatus.Active;
    }

    function getStakingModuleIsStopped(
        uint256 stakingModuleId
    ) external view whenModuleIsRegistered(stakingModuleId) returns (bool) {
        return status == StakingRouter.StakingModuleStatus.Stopped;
    }

    function getStakingModuleIsDepositsPaused(
        uint256 stakingModuleId
    ) external view whenModuleIsRegistered(stakingModuleId) returns (bool) {
        return status == StakingRouter.StakingModuleStatus.DepositsPaused;
    }

    function getStakingModuleIsActive(
        uint256 stakingModuleId
    ) external view whenModuleIsRegistered(stakingModuleId) returns (bool) {
        return status == StakingRouter.StakingModuleStatus.Active;
    }

    function getStakingModuleNonce(
        uint256 stakingModuleId
    ) external view whenModuleIsRegistered(stakingModuleId) returns (uint256) {
        return stakingModuleNonce;
    }

    function getStakingModuleLastDepositBlock(
        uint256 stakingModuleId
    ) external view whenModuleIsRegistered(stakingModuleId) returns (uint256) {
        return stakingModuleLastDepositBlock;
    }

    function setStakingModuleNonce(uint256 value) external {
        stakingModuleNonce = value;
    }

    function setStakingModuleLastDepositBlock(uint256 value) external {
        stakingModuleLastDepositBlock = value;
    }

    modifier whenModuleIsRegistered(uint256 _stakingModuleId) {
        if (!hasStakingModule(_stakingModuleId)) revert StakingModuleUnregistered();
        _;
    }
}
