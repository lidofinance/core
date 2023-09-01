// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

import "../interfaces/IStakingModule.sol";
import {MemUtils} from "../../common/lib/MemUtils.sol";

contract ModuleSolo is IStakingModule {
    address private stakingRouter;
    address public immutable lido;

    uint256 public totalVetted;
    uint256 public totalDeposited;
    uint256 public totalExited;

    bytes32 public moduleType;

    uint16 public nonce;

    uint256 public constant PUBKEY_LENGTH = 48;
    uint256 public constant SIGNATURE_LENGTH = 96;

    constructor(address _lido) {
        lido = _lido;
    }

    function getType() external view returns (bytes32) {
        return moduleType;
    }

    function getStakingModuleSummary() external view returns (
        uint256 totalExitedValidators,
        uint256 totalDepositedValidators,
        uint256 depositableValidatorsCount
    ) {
        totalExitedValidators = totalExited;
        totalDepositedValidators = totalDeposited;
        depositableValidatorsCount = totalVetted - totalDeposited;
    }

    function getNodeOperatorSummary(uint256 _nodeOperatorId) external view returns (
        bool isTargetLimitActive,
        uint256 targetValidatorsCount,
        uint256 stuckValidatorsCount,
        uint256 refundedValidatorsCount,
        uint256 stuckPenaltyEndTimestamp,
        uint256 totalExitedValidators,
        uint256 totalDepositedValidators,
        uint256 depositableValidatorsCount
    ) {}

    function getNonce() external view returns (uint256) {
        return nonce;
    }

    function getNodeOperatorsCount() external view returns (uint256) {}

    function getActiveNodeOperatorsCount() external view returns (uint256) {}

    function getNodeOperatorIsActive(uint256 _nodeOperatorId) external view returns (bool) {}

    function getNodeOperatorIds(uint256 _offset, uint256 _limit)
        external
        view
        returns (uint256[] memory nodeOperatorIds) {}

    function getRewardsDistribution(uint256 _totalRewardShares)
        external
        view
        returns (address[] memory recipients, uint256[] memory shares)
    {}

    function addNodeOperator(string memory _name, address _rewardAddress) external returns (uint256 id) {}

    function setNodeOperatorStakingLimit(uint256 _id, uint256 _stakingLimit) external {}

    function onRewardsMinted(uint256 _totalShares) external {}

    function updateStuckValidatorsCount(
        bytes calldata _nodeOperatorIds,
        bytes calldata _stuckValidatorsCounts
    ) external {}

    function updateExitedValidatorsCount(
        bytes calldata _nodeOperatorIds,
        bytes calldata _stuckValidatorsCounts
    ) external {}

    function updateRefundedValidatorsCount(uint256 _nodeOperatorId, uint256 _refundedValidatorsCount) external {}

    function updateTargetValidatorsLimits(
        uint256 _nodeOperatorId,
        bool _isTargetLimitActive,
        uint256 _targetLimit
    ) external {}

    function onExitedAndStuckValidatorsCountsUpdated() external {}

    function unsafeUpdateValidatorsCount(
        uint256 /* _nodeOperatorId */,
        uint256 /* _exitedValidatorsKeysCount */,
        uint256 /* _stuckValidatorsKeysCount */
    ) external {}

    //only for testing purposes
    function setTotalVettedValidators(uint256 _vettedCount) external {
        totalVetted = _vettedCount;
    }

    function setTotalDepositedValidators(uint256 _depositedCount) external {
        totalDeposited = _depositedCount;
    }

    function setTotalExitedValidators(uint256 _exitedCount) external {
        totalExited = _exitedCount;
    }

    function setNodeOperatorActive(uint256 _id, bool _active) external {}

    function setStakingRouter(address _addr) public {
        stakingRouter = _addr;
    }

    function getStakingRouter() external view returns (address) {
        return stakingRouter;
    }

    function onWithdrawalCredentialsChanged() external {}

    function setType(bytes32 _type) external {
        moduleType = _type;
    }

    function obtainDepositData(uint256 _depositsCount, bytes calldata _calldata)
        external
        pure
        returns (
            bytes memory publicKeys,
            bytes memory signatures
        )
    {

        publicKeys = MemUtils.unsafeAllocateBytes(_depositsCount * PUBKEY_LENGTH);
        signatures = MemUtils.unsafeAllocateBytes(_depositsCount * SIGNATURE_LENGTH);
        MemUtils.copyBytes(_calldata, publicKeys, 0, 0, _depositsCount * PUBKEY_LENGTH);
        MemUtils.copyBytes(_calldata, signatures, _depositsCount * PUBKEY_LENGTH, 0, _depositsCount * PUBKEY_LENGTH);

        return (publicKeys, signatures);
    }
}
