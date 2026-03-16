// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {StakingModuleStatus} from "./SRTypes.sol";

/**
 * @title StakingRouter base interface, defines events and errors
 * @author KRogLA
 */

interface ISRBase {
    /**
     * Events
     */
    event StakingModuleAdded(uint256 indexed stakingModuleId, address stakingModule, string name, address createdBy);
    event StakingModuleShareLimitSet(
        uint256 indexed stakingModuleId, uint256 stakeShareLimit, uint256 priorityExitShareThreshold, address setBy
    );
    event StakingModuleFeesSet(
        uint256 indexed stakingModuleId, uint256 stakingModuleFee, uint256 treasuryFee, address setBy
    );
    event StakingModuleMaxDepositsPerBlockSet(
        uint256 indexed stakingModuleId, uint256 maxDepositsPerBlock, address setBy
    );
    event StakingModuleMinDepositBlockDistanceSet(
        uint256 indexed stakingModuleId, uint256 minDepositBlockDistance, address setBy
    );
    event StakingModuleStatusSet(uint256 indexed stakingModuleId, StakingModuleStatus status, address setBy);

    event WithdrawalCredentialsSet(bytes32 withdrawalCredentials, address setBy);

    event StakingRouterETHDeposited(uint256 indexed stakingModuleId, uint256 amount);
    event DepositableEthReceived(uint256 amount);

    event ExitedAndStuckValidatorsCountsUpdateFailed(uint256 indexed stakingModuleId, bytes lowLevelRevertData);
    event RewardsMintedReportFailed(uint256 indexed stakingModuleId, bytes lowLevelRevertData);
    event StakingModuleExitedValidatorsIncompleteReporting(
        uint256 indexed stakingModuleId, uint256 unreportedExitedValidatorsCount
    );
    event WithdrawalsCredentialsChangeFailed(uint256 indexed stakingModuleId, bytes lowLevelRevertData);
    event StakingModuleExitNotificationFailed(
        uint256 indexed stakingModuleId, uint256 indexed nodeOperatorId, bytes _publicKey
    );

    /**
     * Errors
     */

    // Validation
    error InvalidAmountGwei();
    error NotAuthorized();
    error ZeroAddress();
    error ZeroArgument();
    error ArraysLengthMismatch();
    error OracleExtraDataNotSubmitted();

    // Oracle report
    error InvalidReportData(uint256 code);
    error ReportedExitedValidatorsExceedDeposited(
        uint256 reportedExitedValidatorsCount, uint256 depositedValidatorsCount
    );
    error UnexpectedCurrentValidatorsCount(
        uint256 currentModuleExitedValidatorsCount, uint256 currentNodeOpExitedValidatorsCount
    );
    error UnexpectedFinalExitedValidatorsCount(
        uint256 newModuleTotalExitedValidatorsCount, uint256 newModuleTotalExitedValidatorsCountInStakingRouter
    );
    error UnrecoverableModuleError();
    error ExitedValidatorsCountCannotDecrease();

    // Deposits
    error CannotDeposit();
    error DirectETHTransfer();
    error ModuleReturnExceedTarget();
    error StakingModuleStatusTheSame();
    error EmptyKeysList();
    error WrongPubkeyLength();
    error AmountNotAlignedToGwei();
    error AllocationExceedsLimit();
    error ZeroDeposits();

    // Staking module
    error StakingModuleAddressExists();
    error StakingModulesLimitExceeded();
    error StakingModuleWrongName();
    error StakingModuleUnregistered();
    error WrongWithdrawalCredentialsType();
    error InvalidPriorityExitShareThreshold();
    error InvalidMinDepositBlockDistance();
    error InvalidMaxDepositPerBlockValue();
    error InvalidStakeShareLimit();
    error InvalidFeeSum();
}
