// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {StakingRouter} from "contracts/0.8.9/StakingRouter.sol";

interface IStakingRouter {
    function getStakingModuleMinDepositBlockDistance(uint256 _stakingModuleId) external view returns (uint256);
    function getStakingModuleMaxDepositsPerBlock(uint256 _stakingModuleId) external view returns (uint256);
    function getStakingModuleIsActive(uint256 _stakingModuleId) external view returns (bool);
    function getStakingModuleNonce(uint256 _stakingModuleId) external view returns (uint256);
    function getStakingModuleLastDepositBlock(uint256 _stakingModuleId) external view returns (uint256);
    function hasStakingModule(uint256 _stakingModuleId) external view returns (bool);
    function decreaseStakingModuleVettedKeysCountByNodeOperator(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _vettedSigningKeysCounts
    ) external;
}
contract StakingRouter__MockForDepositSecurityModule is IStakingRouter {
    error StakingModuleUnregistered();

    event StakingModuleVettedKeysDecreased(
        uint24 stakingModuleId,
        bytes nodeOperatorIds,
        bytes vettedSigningKeysCounts
    );
    event StakingModuleDeposited(uint256 maxDepositsCount, uint24 stakingModuleId, bytes depositCalldata);
    event StakingModuleStatusSet(
        uint24 indexed stakingModuleId,
        StakingRouter.StakingModuleStatus status,
        address setBy
    );

    StakingRouter.StakingModuleStatus private status;
    uint256 private stakingModuleNonce;
    uint256 private stakingModuleLastDepositBlock;
    uint256 private stakingModuleMaxDepositsPerBlock;
    uint256 private stakingModuleMaxDepositsAmountPerBlock;
    uint256 private stakingModuleMinDepositBlockDistance;
    uint256 private registeredStakingModuleId;

    constructor(uint256 stakingModuleId) {
        registeredStakingModuleId = stakingModuleId;
    }

    function deposit(
        // uint256 maxDepositsCount,
        uint256 stakingModuleId,
        bytes calldata depositCalldata
    ) external payable whenModuleIsRegistered(stakingModuleId) returns (uint256 keysCount) {
        emit StakingModuleDeposited(msg.value, uint24(stakingModuleId), depositCalldata);
        return msg.value;
    }

    function decreaseStakingModuleVettedKeysCountByNodeOperator(
        uint256 stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _vettedSigningKeysCounts
    ) external whenModuleIsRegistered(stakingModuleId) {
        emit StakingModuleVettedKeysDecreased(uint24(stakingModuleId), _nodeOperatorIds, _vettedSigningKeysCounts);
    }

    function hasStakingModule(uint256 _stakingModuleId) public view returns (bool) {
        return _stakingModuleId == registeredStakingModuleId;
    }

    function getStakingModuleStatus(
        uint256 stakingModuleId
    ) external view whenModuleIsRegistered(stakingModuleId) returns (StakingRouter.StakingModuleStatus) {
        return status;
    }

    function setStakingModuleStatus(
        uint256 _stakingModuleId,
        StakingRouter.StakingModuleStatus _status
    ) external whenModuleIsRegistered(_stakingModuleId) {
        emit StakingModuleStatusSet(uint24(_stakingModuleId), _status, msg.sender);
        status = _status;
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

    function getStakingModuleMaxDepositsPerBlock(
        uint256 stakingModuleId
    ) external view whenModuleIsRegistered(stakingModuleId) returns (uint256) {
        return stakingModuleMaxDepositsPerBlock;
    }

    function getStakingModuleMaxDepositsAmountPerBlock(
        uint256 stakingModuleId
    ) external view whenModuleIsRegistered(stakingModuleId) returns (uint256) {
        return stakingModuleMaxDepositsAmountPerBlock;
    }

    function setStakingModuleMaxDepositsPerBlock(uint256 value) external {
        stakingModuleMaxDepositsPerBlock = value;
    }

    function setStakingModuleMaxDepositsAmountPerBlock(uint256 value) external {
        stakingModuleMaxDepositsAmountPerBlock = value;
    }

    function getStakingModuleMinDepositBlockDistance(
        uint256 stakingModuleId
    ) external view whenModuleIsRegistered(stakingModuleId) returns (uint256) {
        return stakingModuleMinDepositBlockDistance;
    }

    function setStakingModuleMinDepositBlockDistance(uint256 value) external {
        stakingModuleMinDepositBlockDistance = value;
    }

    modifier whenModuleIsRegistered(uint256 _stakingModuleId) {
        if (!hasStakingModule(_stakingModuleId)) revert StakingModuleUnregistered();
        _;
    }
}
