// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// for testing purposes only

pragma solidity 0.8.9;

import {IStakingRouter} from "contracts/0.8.9/DepositSecurityModule.sol";
import {StakingRouter} from "contracts/0.8.9/StakingRouter.sol";

contract StakingRouterMockForDepositSecurityModule is IStakingRouter {
    error StakingModuleUnregistered();

    event StakingModuleVettedKeysDecreased(
        uint24 stakingModuleId, bytes nodeOperatorIds, bytes vettedSigningKeysCounts
    );
    event StakingModuleDeposited(uint256 maxDepositsCount, uint24 stakingModuleId, bytes depositCalldata);
    event StakingModuleStatusSet(
        uint24 indexed stakingModuleId, StakingRouter.StakingModuleStatus status, address setBy
    );

    struct StakingModule {
        uint256 stakingModuleId;
        uint256 nonce;
        uint256 lastDepositBlock;
        uint256 maxDepositsPerBlock;
        uint256 minDepositBlockDistance;
        uint256 activeValidatorsCount;
        StakingRouter.StakingModuleStatus status;
    }

    mapping(uint256 => StakingModule) private registeredStakingModules;

    constructor(uint256[] memory stakingModuleIds) {
        // registeredStakingModuleId = stakingModuleId;
        for (uint256 i = 0; i < stakingModuleIds.length; i++) {
            registeredStakingModules[stakingModuleIds[i]] = StakingModule({
                stakingModuleId: stakingModuleIds[i],
                nonce: 0,
                lastDepositBlock: 0,
                maxDepositsPerBlock: 0,
                minDepositBlockDistance: 0,
                activeValidatorsCount: 0,
                status: StakingRouter.StakingModuleStatus.Active
            });
        }
    }

    function deposit(uint256 maxDepositsCount, uint256 stakingModuleId, bytes calldata depositCalldata)
        external
        payable
        whenModuleIsRegistered(stakingModuleId)
        returns (uint256 keysCount)
    {
        emit StakingModuleDeposited(maxDepositsCount, uint24(stakingModuleId), depositCalldata);
        return maxDepositsCount;
    }

    function decreaseStakingModuleVettedKeysCountByNodeOperator(
        uint256 stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _vettedSigningKeysCounts
    ) external whenModuleIsRegistered(stakingModuleId) {
        emit StakingModuleVettedKeysDecreased(uint24(stakingModuleId), _nodeOperatorIds, _vettedSigningKeysCounts);
    }

    function hasStakingModule(uint256 _stakingModuleId) public view returns (bool) {
        return registeredStakingModules[_stakingModuleId].stakingModuleId != 0;
    }

    function getStakingModuleStatus(uint256 stakingModuleId)
        external
        view
        whenModuleIsRegistered(stakingModuleId)
        returns (StakingRouter.StakingModuleStatus)
    {
        return registeredStakingModules[stakingModuleId].status;
    }

    function setStakingModuleStatus(uint256 _stakingModuleId, StakingRouter.StakingModuleStatus _status)
        external
        whenModuleIsRegistered(_stakingModuleId)
    {
        emit StakingModuleStatusSet(uint24(_stakingModuleId), _status, msg.sender);
        registeredStakingModules[_stakingModuleId].status = _status;
    }

    function getStakingModuleIsStopped(uint256 stakingModuleId)
        external
        view
        whenModuleIsRegistered(stakingModuleId)
        returns (bool)
    {
        return registeredStakingModules[stakingModuleId].status == StakingRouter.StakingModuleStatus.Stopped;
    }

    function getStakingModuleIsDepositsPaused(uint256 stakingModuleId)
        external
        view
        whenModuleIsRegistered(stakingModuleId)
        returns (bool)
    {
        return registeredStakingModules[stakingModuleId].status == StakingRouter.StakingModuleStatus.DepositsPaused;
    }

    function getStakingModuleIsActive(uint256 stakingModuleId)
        external
        view
        whenModuleIsRegistered(stakingModuleId)
        returns (bool)
    {
        return registeredStakingModules[stakingModuleId].status == StakingRouter.StakingModuleStatus.Active;
    }

    function getStakingModuleNonce(uint256 stakingModuleId)
        external
        view
        whenModuleIsRegistered(stakingModuleId)
        returns (uint256)
    {
        return registeredStakingModules[stakingModuleId].nonce;
    }

    function getStakingModuleLastDepositBlock(uint256 stakingModuleId)
        external
        view
        whenModuleIsRegistered(stakingModuleId)
        returns (uint256)
    {
        return registeredStakingModules[stakingModuleId].lastDepositBlock;
    }

    function setStakingModuleNonce(uint256 stakingModuleId, uint256 value) external {
        registeredStakingModules[stakingModuleId].nonce = value;
    }

    function setStakingModuleLastDepositBlock(uint256 stakingModuleId, uint256 value) external {
        registeredStakingModules[stakingModuleId].lastDepositBlock = value;
    }

    function getStakingModuleMaxDepositsPerBlock(uint256 stakingModuleId)
        external
        view
        whenModuleIsRegistered(stakingModuleId)
        returns (uint256)
    {
        return registeredStakingModules[stakingModuleId].maxDepositsPerBlock;
    }

    function setStakingModuleMaxDepositsPerBlock(uint256 stakingModuleId, uint256 value) external {
        registeredStakingModules[stakingModuleId].maxDepositsPerBlock = value;
    }

    function getStakingModuleMinDepositBlockDistance(uint256 stakingModuleId)
        external
        view
        whenModuleIsRegistered(stakingModuleId)
        returns (uint256)
    {
        return registeredStakingModules[stakingModuleId].minDepositBlockDistance;
    }

    function setStakingModuleMinDepositBlockDistance(uint256 stakingModuleId, uint256 value) external {
        registeredStakingModules[stakingModuleId].minDepositBlockDistance = value;
    }

    function getStakingModuleActiveValidatorsCount(uint256 stakingModuleId) external view returns (uint256) {
        return registeredStakingModules[stakingModuleId].activeValidatorsCount;
    }

    function setStakingModuleActiveValidatorsCount(uint256 stakingModuleId, uint256 value) external {
        registeredStakingModules[stakingModuleId].activeValidatorsCount = value;
    }

    modifier whenModuleIsRegistered(uint256 _stakingModuleId) {
        if (!hasStakingModule(_stakingModuleId)) revert StakingModuleUnregistered();
        _;
    }
}
