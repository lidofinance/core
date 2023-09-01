// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "./utils/access/AccessControlEnumerable.sol";

import {IStakingModule} from "./interfaces/IStakingModule.sol";

import {Math256} from "../common/lib/Math256.sol";
import {UnstructuredStorage} from "./lib/UnstructuredStorage.sol";
import {MinFirstAllocationStrategy} from "../common/lib/MinFirstAllocationStrategy.sol";

import {BeaconChainDepositor} from "./BeaconChainDepositor.sol";
import {Versioned} from "./utils/Versioned.sol";

contract StakingRouter is AccessControlEnumerable, BeaconChainDepositor, Versioned {
    using UnstructuredStorage for bytes32;

    /// @dev events
    event StakingModuleAdded(uint256 indexed stakingModuleId, address stakingModule, string name, address createdBy);
    event StakingModuleTargetShareSet(uint256 indexed stakingModuleId, uint256 targetShare, address setBy);
    event StakingModuleFeesSet(uint256 indexed stakingModuleId, uint256 stakingModuleFee, uint256 treasuryFee, address setBy);
    event StakingModuleStatusSet(uint256 indexed stakingModuleId, StakingModuleStatus status, address setBy);
    event StakingModuleExitedValidatorsIncompleteReporting(uint256 indexed stakingModuleId, uint256 unreportedExitedValidatorsCount);
    event WithdrawalCredentialsSet(bytes32 withdrawalCredentials, address setBy);
    event WithdrawalsCredentialsChangeFailed(uint256 indexed stakingModuleId, bytes lowLevelRevertData);
    event ExitedAndStuckValidatorsCountsUpdateFailed(uint256 indexed stakingModuleId, bytes lowLevelRevertData);
    event RewardsMintedReportFailed(uint256 indexed stakingModuleId, bytes lowLevelRevertData);

    /// Emitted when the StakingRouter received ETH
    event StakingRouterETHDeposited(uint256 indexed stakingModuleId, uint256 amount);

    /// @dev errors
    error ZeroAddress(string field);
    error ValueOver100Percent(string field);
    error StakingModuleNotActive();
    error StakingModuleNotPaused();
    error EmptyWithdrawalsCredentials();
    error DirectETHTransfer();
    error InvalidReportData(uint256 code);
    error ExitedValidatorsCountCannotDecrease();
    error ReportedExitedValidatorsExceedDeposited(
        uint256 reportedExitedValidatorsCount,
        uint256 depositedValidatorsCount
    );
    error StakingModulesLimitExceeded();
    error StakingModuleUnregistered();
    error AppAuthLidoFailed();
    error StakingModuleStatusTheSame();
    error StakingModuleWrongName();
    error UnexpectedCurrentValidatorsCount(
        uint256 currentModuleExitedValidatorsCount,
        uint256 currentNodeOpExitedValidatorsCount,
        uint256 currentNodeOpStuckValidatorsCount
    );
    error InvalidDepositsValue(uint256 etherValue, uint256 depositsCount);
    error StakingModuleAddressExists();
    error ArraysLengthMismatch(uint256 firstArrayLength, uint256 secondArrayLength);
    error UnrecoverableModuleError();

    enum StakingModuleStatus {
        Active, // deposits and rewards allowed
        DepositsPaused, // deposits NOT allowed, rewards allowed
        Stopped // deposits and rewards NOT allowed
    }

    struct StakingModule {
        /// @notice unique id of the staking module
        uint24 id;
        /// @notice address of staking module
        address stakingModuleAddress;
        /// @notice part of the fee taken from staking rewards that goes to the staking module
        uint16 stakingModuleFee;
        /// @notice part of the fee taken from staking rewards that goes to the treasury
        uint16 treasuryFee;
        /// @notice target percent of total validators in protocol, in BP
        uint16 targetShare;
        /// @notice staking module status if staking module can not accept the deposits or can participate in further reward distribution
        uint8 status;
        /// @notice name of staking module
        string name;
        /// @notice block.timestamp of the last deposit of the staking module
        /// @dev NB: lastDepositAt gets updated even if the deposit value was 0 and no actual deposit happened
        uint64 lastDepositAt;
        /// @notice block.number of the last deposit of the staking module
        /// @dev NB: lastDepositBlock gets updated even if the deposit value was 0 and no actual deposit happened
        uint256 lastDepositBlock;
        /// @notice number of exited validators
        uint256 exitedValidatorsCount;
    }

    struct StakingModuleCache {
        address stakingModuleAddress;
        uint24 stakingModuleId;
        uint16 stakingModuleFee;
        uint16 treasuryFee;
        uint16 targetShare;
        StakingModuleStatus status;
        uint256 activeValidatorsCount;
        uint256 availableValidatorsCount;
    }

    bytes32 public constant MANAGE_WITHDRAWAL_CREDENTIALS_ROLE = keccak256("MANAGE_WITHDRAWAL_CREDENTIALS_ROLE");
    bytes32 public constant STAKING_MODULE_PAUSE_ROLE = keccak256("STAKING_MODULE_PAUSE_ROLE");
    bytes32 public constant STAKING_MODULE_RESUME_ROLE = keccak256("STAKING_MODULE_RESUME_ROLE");
    bytes32 public constant STAKING_MODULE_MANAGE_ROLE = keccak256("STAKING_MODULE_MANAGE_ROLE");
    bytes32 public constant REPORT_EXITED_VALIDATORS_ROLE = keccak256("REPORT_EXITED_VALIDATORS_ROLE");
    bytes32 public constant UNSAFE_SET_EXITED_VALIDATORS_ROLE = keccak256("UNSAFE_SET_EXITED_VALIDATORS_ROLE");
    bytes32 public constant REPORT_REWARDS_MINTED_ROLE = keccak256("REPORT_REWARDS_MINTED_ROLE");

    bytes32 internal constant LIDO_POSITION = keccak256("lido.StakingRouter.lido");

    /// @dev Credentials which allows the DAO to withdraw Ether on the 2.0 side
    bytes32 internal constant WITHDRAWAL_CREDENTIALS_POSITION = keccak256("lido.StakingRouter.withdrawalCredentials");

    /// @dev total count of staking modules
    bytes32 internal constant STAKING_MODULES_COUNT_POSITION = keccak256("lido.StakingRouter.stakingModulesCount");
    /// @dev id of the last added staking module. This counter grow on staking modules adding
    bytes32 internal constant LAST_STAKING_MODULE_ID_POSITION = keccak256("lido.StakingRouter.lastStakingModuleId");
    /// @dev mapping is used instead of array to allow to extend the StakingModule
    bytes32 internal constant STAKING_MODULES_MAPPING_POSITION = keccak256("lido.StakingRouter.stakingModules");
    /// @dev Position of the staking modules in the `_stakingModules` map, plus 1 because
    ///      index 0 means a value is not in the set.
    bytes32 internal constant STAKING_MODULE_INDICES_MAPPING_POSITION = keccak256("lido.StakingRouter.stakingModuleIndicesOneBased");

    uint256 public constant FEE_PRECISION_POINTS = 10 ** 20; // 100 * 10 ** 18
    uint256 public constant TOTAL_BASIS_POINTS = 10000;
    uint256 public constant MAX_STAKING_MODULES_COUNT = 32;
    /// @dev restrict the name size with 31 bytes to storage in a single slot
    uint256 public constant MAX_STAKING_MODULE_NAME_LENGTH = 31;

    constructor(address _depositContract) BeaconChainDepositor(_depositContract) {}

    /**
     * @dev proxy initialization
     * @param _admin Lido DAO Aragon agent contract address
     * @param _lido Lido address
     * @param _withdrawalCredentials Lido withdrawal vault contract address
     */
    function initialize(address _admin, address _lido, bytes32 _withdrawalCredentials) external {
        if (_admin == address(0)) revert ZeroAddress("_admin");
        if (_lido == address(0)) revert ZeroAddress("_lido");

        _initializeContractVersionTo(1);

        _setupRole(DEFAULT_ADMIN_ROLE, _admin);

        LIDO_POSITION.setStorageAddress(_lido);
        WITHDRAWAL_CREDENTIALS_POSITION.setStorageBytes32(_withdrawalCredentials);
        emit WithdrawalCredentialsSet(_withdrawalCredentials, msg.sender);
    }

    /// @dev prohibit direct transfer to contract
    receive() external payable {
        revert DirectETHTransfer();
    }

    /**
     * @notice Return the Lido contract address
     */
    function getLido() public view returns (address) {
        return LIDO_POSITION.getStorageAddress();
    }

    /**
     * @notice register a new staking module
     * @param _name name of staking module
     * @param _stakingModuleAddress address of staking module
     * @param _targetShare target total stake share
     * @param _stakingModuleFee fee of the staking module taken from the consensus layer rewards
     * @param _treasuryFee treasury fee
     */
    function addStakingModule(
        string calldata _name,
        address _stakingModuleAddress,
        uint256 _targetShare,
        uint256 _stakingModuleFee,
        uint256 _treasuryFee
    ) external onlyRole(STAKING_MODULE_MANAGE_ROLE) {
        if (_targetShare > TOTAL_BASIS_POINTS)
            revert ValueOver100Percent("_targetShare");
        if (_stakingModuleFee + _treasuryFee > TOTAL_BASIS_POINTS)
            revert ValueOver100Percent("_stakingModuleFee + _treasuryFee");
        if (_stakingModuleAddress == address(0))
            revert ZeroAddress("_stakingModuleAddress");
        if (bytes(_name).length == 0 || bytes(_name).length > MAX_STAKING_MODULE_NAME_LENGTH)
            revert StakingModuleWrongName();

        uint256 newStakingModuleIndex = getStakingModulesCount();

        if (newStakingModuleIndex >= MAX_STAKING_MODULES_COUNT)
            revert StakingModulesLimitExceeded();

        for (uint256 i; i < newStakingModuleIndex; ) {
            if (_stakingModuleAddress == _getStakingModuleByIndex(i).stakingModuleAddress)
                revert StakingModuleAddressExists();
            unchecked {
                ++i;
            }
        }

        StakingModule storage newStakingModule = _getStakingModuleByIndex(newStakingModuleIndex);
        uint24 newStakingModuleId = uint24(LAST_STAKING_MODULE_ID_POSITION.getStorageUint256()) + 1;

        newStakingModule.id = newStakingModuleId;
        newStakingModule.name = _name;
        newStakingModule.stakingModuleAddress = _stakingModuleAddress;
        newStakingModule.targetShare = uint16(_targetShare);
        newStakingModule.stakingModuleFee = uint16(_stakingModuleFee);
        newStakingModule.treasuryFee = uint16(_treasuryFee);
        /// @dev since `enum` is `uint8` by nature, so the `status` is stored as `uint8` to avoid
        ///      possible problems when upgrading. But for human readability, we use `enum` as
        ///      function parameter type. More about conversion in the docs
        ///      https://docs.soliditylang.org/en/v0.8.17/types.html#enums
        newStakingModule.status = uint8(StakingModuleStatus.Active);

        /// @dev  Simulate zero value deposit to prevent real deposits into the new StakingModule via
        ///       DepositSecurityModule just after the addition.
        ///       See DepositSecurityModule.getMaxDeposits() for details
        newStakingModule.lastDepositAt = uint64(block.timestamp);
        newStakingModule.lastDepositBlock = block.number;
        emit StakingRouterETHDeposited(newStakingModuleId, 0);

        _setStakingModuleIndexById(newStakingModuleId, newStakingModuleIndex);
        LAST_STAKING_MODULE_ID_POSITION.setStorageUint256(newStakingModuleId);
        STAKING_MODULES_COUNT_POSITION.setStorageUint256(newStakingModuleIndex + 1);

        emit StakingModuleAdded(newStakingModuleId, _stakingModuleAddress, _name, msg.sender);
        emit StakingModuleTargetShareSet(newStakingModuleId, _targetShare, msg.sender);
        emit StakingModuleFeesSet(newStakingModuleId, _stakingModuleFee, _treasuryFee, msg.sender);
    }

    /**
     * @notice Update staking module params
     * @param _stakingModuleId staking module id
     * @param _targetShare target total stake share
     * @param _stakingModuleFee fee of the staking module taken from the consensus layer rewards
     * @param _treasuryFee treasury fee
     */
    function updateStakingModule(
        uint256 _stakingModuleId,
        uint256 _targetShare,
        uint256 _stakingModuleFee,
        uint256 _treasuryFee
    ) external onlyRole(STAKING_MODULE_MANAGE_ROLE) {
        if (_targetShare > TOTAL_BASIS_POINTS) revert ValueOver100Percent("_targetShare");
        if (_stakingModuleFee + _treasuryFee > TOTAL_BASIS_POINTS) revert ValueOver100Percent("_stakingModuleFee + _treasuryFee");

        StakingModule storage stakingModule = _getStakingModuleById(_stakingModuleId);

        stakingModule.targetShare = uint16(_targetShare);
        stakingModule.treasuryFee = uint16(_treasuryFee);
        stakingModule.stakingModuleFee = uint16(_stakingModuleFee);

        emit StakingModuleTargetShareSet(_stakingModuleId, _targetShare, msg.sender);
        emit StakingModuleFeesSet(_stakingModuleId, _stakingModuleFee, _treasuryFee, msg.sender);
    }

    /// @notice Updates the limit of the validators that can be used for deposit
    /// @param _stakingModuleId Id of the staking module
    /// @param _nodeOperatorId Id of the node operator
    /// @param _isTargetLimitActive Active flag
    /// @param _targetLimit Target limit of the node operator
    function updateTargetValidatorsLimits(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        bool _isTargetLimitActive,
        uint256 _targetLimit
    ) external onlyRole(STAKING_MODULE_MANAGE_ROLE) {
        address moduleAddr = _getStakingModuleById(_stakingModuleId).stakingModuleAddress;
        IStakingModule(moduleAddr)
            .updateTargetValidatorsLimits(_nodeOperatorId, _isTargetLimitActive, _targetLimit);
    }

    /// @notice Updates the number of the refunded validators in the staking module with the given
    ///     node operator id
    /// @param _stakingModuleId Id of the staking module
    /// @param _nodeOperatorId Id of the node operator
    /// @param _refundedValidatorsCount New number of refunded validators of the node operator
    function updateRefundedValidatorsCount(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        uint256 _refundedValidatorsCount
    ) external onlyRole(STAKING_MODULE_MANAGE_ROLE) {
        address moduleAddr = _getStakingModuleById(_stakingModuleId).stakingModuleAddress;
        IStakingModule(moduleAddr)
            .updateRefundedValidatorsCount(_nodeOperatorId, _refundedValidatorsCount);
    }

    function reportRewardsMinted(uint256[] calldata _stakingModuleIds, uint256[] calldata _totalShares)
        external
        onlyRole(REPORT_REWARDS_MINTED_ROLE)
    {
        if (_stakingModuleIds.length != _totalShares.length) {
            revert ArraysLengthMismatch(_stakingModuleIds.length, _totalShares.length);
        }

        for (uint256 i = 0; i < _stakingModuleIds.length; ) {
            if (_totalShares[i] > 0) {
                address moduleAddr = _getStakingModuleById(_stakingModuleIds[i]).stakingModuleAddress;
                try IStakingModule(moduleAddr).onRewardsMinted(_totalShares[i]) {}
                catch (bytes memory lowLevelRevertData) {
                    /// @dev This check is required to prevent incorrect gas estimation of the method.
                    ///      Without it, Ethereum nodes that use binary search for gas estimation may
                    ///      return an invalid value when the onRewardsMinted() reverts because of the
                    ///      "out of gas" error. Here we assume that the onRewardsMinted() method doesn't
                    ///      have reverts with empty error data except "out of gas".
                    if (lowLevelRevertData.length == 0) revert UnrecoverableModuleError();
                    emit RewardsMintedReportFailed(
                        _stakingModuleIds[i],
                        lowLevelRevertData
                    );
                }
            }
            unchecked { ++i; }
        }
    }

    /// @notice Updates total numbers of exited validators for staking modules with the specified
    /// module ids.
    ///
    /// @param _stakingModuleIds Ids of the staking modules to be updated.
    /// @param _exitedValidatorsCounts New counts of exited validators for the specified staking modules.
    ///
    /// @return The total increase in the aggregate number of exited validators across all updated modules.
    ///
    /// The total numbers are stored in the staking router and can differ from the totals obtained by calling
    /// `IStakingModule.getStakingModuleSummary()`. The overall process of updating validator counts is the following:
    ///
    /// 1. In the first data submission phase, the oracle calls `updateExitedValidatorsCountByStakingModule` on the
    ///    staking router, passing the totals by module. The staking router stores these totals and uses them to
    ///    distribute new stake and staking fees between the modules. There can only be single call of this function
    ///    per oracle reporting frame.
    ///
    /// 2. In the first part of the second data submission phase, the oracle calls
    ///    `StakingRouter.reportStakingModuleStuckValidatorsCountByNodeOperator` on the staking router which passes the
    ///    counts by node operator to the staking module by calling `IStakingModule.updateStuckValidatorsCount`.
    ///    This can be done multiple times for the same module, passing data for different subsets of node operators.
    ///
    /// 3. In the second part of the second data submission phase, the oracle calls
    ///    `StakingRouter.reportStakingModuleExitedValidatorsCountByNodeOperator` on the staking router which passes
    ///    the counts by node operator to the staking module by calling `IStakingModule.updateExitedValidatorsCount`.
    ///    This can be done multiple times for the same module, passing data for different subsets of node
    ///    operators.
    ///
    /// 4. At the end of the second data submission phase, it's expected for the aggregate exited validators count
    ///    across all module's node operators (stored in the module) to match the total count for this module
    ///    (stored in the staking router). However, it might happen that the second phase of data submission doesn't
    ///    finish until the new oracle reporting frame is started, in which case staking router will emit a warning
    ///    event `StakingModuleExitedValidatorsIncompleteReporting` when the first data submission phase is performed
    ///    for a new reporting frame. This condition will result in the staking module having an incomplete data about
    ///    the exited and maybe stuck validator counts during the whole reporting frame. Handling this condition is
    ///    the responsibility of each staking module.
    ///
    /// 5. When the second reporting phase is finished, i.e. when the oracle submitted the complete data on the stuck
    ///    and exited validator counts per node operator for the current reporting frame, the oracle calls
    ///    `StakingRouter.onValidatorsCountsByNodeOperatorReportingFinished` which, in turn, calls
    ///    `IStakingModule.onExitedAndStuckValidatorsCountsUpdated` on all modules.
    ///
    function updateExitedValidatorsCountByStakingModule(
        uint256[] calldata _stakingModuleIds,
        uint256[] calldata _exitedValidatorsCounts
    )
        external
        onlyRole(REPORT_EXITED_VALIDATORS_ROLE)
        returns (uint256)
    {
        if (_stakingModuleIds.length != _exitedValidatorsCounts.length) {
            revert ArraysLengthMismatch(_stakingModuleIds.length, _exitedValidatorsCounts.length);
        }

        uint256 newlyExitedValidatorsCount;

        for (uint256 i = 0; i < _stakingModuleIds.length; ) {
            uint256 stakingModuleId = _stakingModuleIds[i];
            StakingModule storage stakingModule = _getStakingModuleById(stakingModuleId);

            uint256 prevReportedExitedValidatorsCount = stakingModule.exitedValidatorsCount;
            if (_exitedValidatorsCounts[i] < prevReportedExitedValidatorsCount) {
                revert ExitedValidatorsCountCannotDecrease();
            }

            (
                uint256 totalExitedValidators,
                uint256 totalDepositedValidators,
                /* uint256 depositableValidatorsCount */
            ) = IStakingModule(stakingModule.stakingModuleAddress).getStakingModuleSummary();

            if (_exitedValidatorsCounts[i] > totalDepositedValidators) {
                revert ReportedExitedValidatorsExceedDeposited(
                    _exitedValidatorsCounts[i],
                    totalDepositedValidators
                );
            }

            newlyExitedValidatorsCount += _exitedValidatorsCounts[i] - prevReportedExitedValidatorsCount;

            if (totalExitedValidators < prevReportedExitedValidatorsCount) {
                // not all of the exited validators were async reported to the module
                emit StakingModuleExitedValidatorsIncompleteReporting(
                    stakingModuleId,
                    prevReportedExitedValidatorsCount - totalExitedValidators
                );
            }

            stakingModule.exitedValidatorsCount = _exitedValidatorsCounts[i];
            unchecked { ++i; }
        }

        return newlyExitedValidatorsCount;
    }

    /// @notice Updates exited validators counts per node operator for the staking module with
    /// the specified id.
    ///
    /// See the docs for `updateExitedValidatorsCountByStakingModule` for the description of the
    /// overall update process.
    ///
    /// @param _stakingModuleId The id of the staking modules to be updated.
    /// @param _nodeOperatorIds Ids of the node operators to be updated.
    /// @param _exitedValidatorsCounts New counts of exited validators for the specified node operators.
    ///
    function reportStakingModuleExitedValidatorsCountByNodeOperator(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _exitedValidatorsCounts
    )
        external
        onlyRole(REPORT_EXITED_VALIDATORS_ROLE)
    {
        address moduleAddr = _getStakingModuleById(_stakingModuleId).stakingModuleAddress;
        _checkValidatorsByNodeOperatorReportData(_nodeOperatorIds, _exitedValidatorsCounts);
        IStakingModule(moduleAddr).updateExitedValidatorsCount(
            _nodeOperatorIds,
            _exitedValidatorsCounts
        );
    }

    struct ValidatorsCountsCorrection {
        /// @notice The expected current number of exited validators of the module that is
        /// being corrected.
        uint256 currentModuleExitedValidatorsCount;
        /// @notice The expected current number of exited validators of the node operator
        /// that is being corrected.
        uint256 currentNodeOperatorExitedValidatorsCount;
        /// @notice The expected current number of stuck validators of the node operator
        /// that is being corrected.
        uint256 currentNodeOperatorStuckValidatorsCount;
        /// @notice The corrected number of exited validators of the module.
        uint256 newModuleExitedValidatorsCount;
        /// @notice The corrected number of exited validators of the node operator.
        uint256 newNodeOperatorExitedValidatorsCount;
        /// @notice The corrected number of stuck validators of the node operator.
        uint256 newNodeOperatorStuckValidatorsCount;
    }

    /**
     * @notice Sets exited validators count for the given module and given node operator in that
     * module without performing critical safety checks, e.g. that exited validators count cannot
     * decrease.
     *
     * Should only be used by the DAO in extreme cases and with sufficient precautions to correct
     * invalid data reported by the oracle committee due to a bug in the oracle daemon.
     *
     * @param _stakingModuleId ID of the staking module.
     *
     * @param _nodeOperatorId ID of the node operator.
     *
     * @param _triggerUpdateFinish Whether to call `onExitedAndStuckValidatorsCountsUpdated` on
     *        the module after applying the corrections.
     *
     * @param _correction See the docs for the `ValidatorsCountsCorrection` struct.
     *
     * Reverts if the current numbers of exited and stuck validators of the module and node operator
     * don't match the supplied expected current values.
     */
    function unsafeSetExitedValidatorsCount(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        bool _triggerUpdateFinish,
        ValidatorsCountsCorrection memory _correction
    )
        external
        onlyRole(UNSAFE_SET_EXITED_VALIDATORS_ROLE)
    {
        StakingModule storage stakingModule = _getStakingModuleById(_stakingModuleId);
        address moduleAddr = stakingModule.stakingModuleAddress;

        (
            /* bool isTargetLimitActive */,
            /* uint256 targetValidatorsCount */,
            uint256 stuckValidatorsCount,
            /* uint256 refundedValidatorsCount */,
            /* uint256 stuckPenaltyEndTimestamp */,
            uint256 totalExitedValidators,
            /* uint256 totalDepositedValidators */,
            /* uint256 depositableValidatorsCount */
        ) = IStakingModule(moduleAddr).getNodeOperatorSummary(_nodeOperatorId);

        if (_correction.currentModuleExitedValidatorsCount != stakingModule.exitedValidatorsCount ||
            _correction.currentNodeOperatorExitedValidatorsCount != totalExitedValidators ||
            _correction.currentNodeOperatorStuckValidatorsCount != stuckValidatorsCount
        ) {
            revert UnexpectedCurrentValidatorsCount(
                stakingModule.exitedValidatorsCount,
                totalExitedValidators,
                stuckValidatorsCount
            );
        }

        stakingModule.exitedValidatorsCount = _correction.newModuleExitedValidatorsCount;

        IStakingModule(moduleAddr).unsafeUpdateValidatorsCount(
            _nodeOperatorId,
            _correction.newNodeOperatorExitedValidatorsCount,
            _correction.newNodeOperatorStuckValidatorsCount
        );

        if (_triggerUpdateFinish) {
            IStakingModule(moduleAddr).onExitedAndStuckValidatorsCountsUpdated();
        }
    }

    /// @notice Updates stuck validators counts per node operator for the staking module with
    /// the specified id.
    ///
    /// See the docs for `updateExitedValidatorsCountByStakingModule` for the description of the
    /// overall update process.
    ///
    /// @param _stakingModuleId The id of the staking modules to be updated.
    /// @param _nodeOperatorIds Ids of the node operators to be updated.
    /// @param _stuckValidatorsCounts New counts of stuck validators for the specified node operators.
    ///
    function reportStakingModuleStuckValidatorsCountByNodeOperator(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _stuckValidatorsCounts
    )
        external
        onlyRole(REPORT_EXITED_VALIDATORS_ROLE)
    {
        address moduleAddr = _getStakingModuleById(_stakingModuleId).stakingModuleAddress;
        _checkValidatorsByNodeOperatorReportData(_nodeOperatorIds, _stuckValidatorsCounts);
        IStakingModule(moduleAddr).updateStuckValidatorsCount(_nodeOperatorIds, _stuckValidatorsCounts);
    }

    /// @notice Called by the oracle when the second phase of data reporting finishes, i.e. when the
    /// oracle submitted the complete data on the stuck and exited validator counts per node operator
    /// for the current reporting frame.
    ///
    /// See the docs for `updateExitedValidatorsCountByStakingModule` for the description of the
    /// overall update process.
    ///
    function onValidatorsCountsByNodeOperatorReportingFinished()
        external
        onlyRole(REPORT_EXITED_VALIDATORS_ROLE)
    {
        uint256 stakingModulesCount = getStakingModulesCount();

        for (uint256 i; i < stakingModulesCount; ) {
            StakingModule storage stakingModule = _getStakingModuleByIndex(i);
            IStakingModule moduleContract = IStakingModule(stakingModule.stakingModuleAddress);

            (uint256 exitedValidatorsCount, , ) = moduleContract.getStakingModuleSummary();
            if (exitedValidatorsCount == stakingModule.exitedValidatorsCount) {
                // oracle finished updating exited validators for all node ops
                try moduleContract.onExitedAndStuckValidatorsCountsUpdated() {}
                catch (bytes memory lowLevelRevertData) {
                    /// @dev This check is required to prevent incorrect gas estimation of the method.
                    ///      Without it, Ethereum nodes that use binary search for gas estimation may
                    ///      return an invalid value when the onExitedAndStuckValidatorsCountsUpdated()
                    ///      reverts because of the "out of gas" error. Here we assume that the
                    ///      onExitedAndStuckValidatorsCountsUpdated() method doesn't have reverts with
                    ///      empty error data except "out of gas".
                    if (lowLevelRevertData.length == 0) revert UnrecoverableModuleError();
                    emit ExitedAndStuckValidatorsCountsUpdateFailed(
                        stakingModule.id,
                        lowLevelRevertData
                    );
                }
            }

            unchecked { ++i; }
        }
    }

    /**
     * @notice Returns all registered staking modules
     */
    function getStakingModules() external view returns (StakingModule[] memory res) {
        uint256 stakingModulesCount = getStakingModulesCount();
        res = new StakingModule[](stakingModulesCount);
        for (uint256 i; i < stakingModulesCount; ) {
            res[i] = _getStakingModuleByIndex(i);
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Returns the ids of all registered staking modules
     */
    function getStakingModuleIds() public view returns (uint256[] memory stakingModuleIds) {
        uint256 stakingModulesCount = getStakingModulesCount();
        stakingModuleIds = new uint256[](stakingModulesCount);
        for (uint256 i; i < stakingModulesCount; ) {
            stakingModuleIds[i] = _getStakingModuleByIndex(i).id;
            unchecked {
                ++i;
            }
        }
    }

    /**
     *  @dev Returns staking module by id
     */
    function getStakingModule(uint256 _stakingModuleId)
        public
        view
        returns (StakingModule memory)
    {
        return _getStakingModuleById(_stakingModuleId);
    }

    /**
     * @dev Returns total number of staking modules
     */
    function getStakingModulesCount() public view returns (uint256) {
        return STAKING_MODULES_COUNT_POSITION.getStorageUint256();
    }

    /**
     * @dev Returns true if staking module with the given id was registered via `addStakingModule`, false otherwise
     */
    function hasStakingModule(uint256 _stakingModuleId) external view returns (bool) {
        return _getStorageStakingIndicesMapping()[_stakingModuleId] != 0;
    }

    /**
     * @dev Returns status of staking module
     */
    function getStakingModuleStatus(uint256 _stakingModuleId)
        public
        view
        returns (StakingModuleStatus)
    {
        return StakingModuleStatus(_getStakingModuleById(_stakingModuleId).status);
    }

    /// @notice A summary of the staking module's validators
    struct StakingModuleSummary {
        /// @notice The total number of validators in the EXITED state on the Consensus Layer
        /// @dev This value can't decrease in normal conditions
        uint256 totalExitedValidators;

        /// @notice The total number of validators deposited via the official Deposit Contract
        /// @dev This value is a cumulative counter: even when the validator goes into EXITED state this
        ///     counter is not decreasing
        uint256 totalDepositedValidators;

        /// @notice The number of validators in the set available for deposit
        uint256 depositableValidatorsCount;
    }

    /// @notice A summary of node operator and its validators
    struct NodeOperatorSummary {
        /// @notice Shows whether the current target limit applied to the node operator
        bool isTargetLimitActive;

        /// @notice Relative target active validators limit for operator
        uint256 targetValidatorsCount;

        /// @notice The number of validators with an expired request to exit time
        uint256 stuckValidatorsCount;

        /// @notice The number of validators that can't be withdrawn, but deposit costs were
        ///     compensated to the Lido by the node operator
        uint256 refundedValidatorsCount;

        /// @notice A time when the penalty for stuck validators stops applying to node operator rewards
        uint256 stuckPenaltyEndTimestamp;

        /// @notice The total number of validators in the EXITED state on the Consensus Layer
        /// @dev This value can't decrease in normal conditions
        uint256 totalExitedValidators;

        /// @notice The total number of validators deposited via the official Deposit Contract
        /// @dev This value is a cumulative counter: even when the validator goes into EXITED state this
        ///     counter is not decreasing
        uint256 totalDepositedValidators;

        /// @notice The number of validators in the set available for deposit
        uint256 depositableValidatorsCount;
    }

    /// @notice Returns all-validators summary in the staking module
    /// @param _stakingModuleId id of the staking module to return summary for
    function getStakingModuleSummary(uint256 _stakingModuleId)
        public
        view
        returns (StakingModuleSummary memory summary)
    {
        StakingModule memory stakingModuleState = getStakingModule(_stakingModuleId);
        IStakingModule stakingModule = IStakingModule(stakingModuleState.stakingModuleAddress);
        (
            summary.totalExitedValidators,
            summary.totalDepositedValidators,
            summary.depositableValidatorsCount
        ) = stakingModule.getStakingModuleSummary();
    }


    /// @notice Returns node operator summary from the staking module
    /// @param _stakingModuleId id of the staking module where node operator is onboarded
    /// @param _nodeOperatorId id of the node operator to return summary for
    function getNodeOperatorSummary(uint256 _stakingModuleId, uint256 _nodeOperatorId)
        public
        view
        returns (NodeOperatorSummary memory summary)
    {
        StakingModule memory stakingModuleState = getStakingModule(_stakingModuleId);
        IStakingModule stakingModule = IStakingModule(stakingModuleState.stakingModuleAddress);
        /// @dev using intermediate variables below due to "Stack too deep" error in case of
        ///     assigning directly into the NodeOperatorSummary struct
        (
            bool isTargetLimitActive,
            uint256 targetValidatorsCount,
            uint256 stuckValidatorsCount,
            uint256 refundedValidatorsCount,
            uint256 stuckPenaltyEndTimestamp,
            uint256 totalExitedValidators,
            uint256 totalDepositedValidators,
            uint256 depositableValidatorsCount
        ) = stakingModule.getNodeOperatorSummary(_nodeOperatorId);
        summary.isTargetLimitActive = isTargetLimitActive;
        summary.targetValidatorsCount = targetValidatorsCount;
        summary.stuckValidatorsCount = stuckValidatorsCount;
        summary.refundedValidatorsCount = refundedValidatorsCount;
        summary.stuckPenaltyEndTimestamp = stuckPenaltyEndTimestamp;
        summary.totalExitedValidators = totalExitedValidators;
        summary.totalDepositedValidators = totalDepositedValidators;
        summary.depositableValidatorsCount = depositableValidatorsCount;
    }

    /// @notice A collection of the staking module data stored across the StakingRouter and the
    ///     staking module contract
    /// @dev This data, first of all, is designed for off-chain usage and might be redundant for
    ///     on-chain calls. Give preference for dedicated methods for gas-efficient on-chain calls
    struct StakingModuleDigest {
        /// @notice The number of node operators registered in the staking module
        uint256 nodeOperatorsCount;
        /// @notice The number of node operators registered in the staking module in active state
        uint256 activeNodeOperatorsCount;
        /// @notice The current state of the staking module taken from the StakingRouter
        StakingModule state;
        /// @notice A summary of the staking module's validators
        StakingModuleSummary summary;
    }

    /// @notice A collection of the node operator data stored in the staking module
    /// @dev This data, first of all, is designed for off-chain usage and might be redundant for
    ///     on-chain calls. Give preference for dedicated methods for gas-efficient on-chain calls
    struct NodeOperatorDigest {
        /// @notice id of the node operator
        uint256 id;
        /// @notice Shows whether the node operator is active or not
        bool isActive;
        /// @notice A summary of node operator and its validators
        NodeOperatorSummary summary;
    }

    /// @notice Returns staking module digest for each staking module registered in the staking router
    /// @dev WARNING: This method is not supposed to be used for onchain calls due to high gas costs
    ///     for data aggregation
    function getAllStakingModuleDigests() external view returns (StakingModuleDigest[] memory) {
        return getStakingModuleDigests(getStakingModuleIds());
    }

    /// @notice Returns staking module digest for passed staking module ids
    /// @param _stakingModuleIds ids of the staking modules to return data for
    /// @dev WARNING: This method is not supposed to be used for onchain calls due to high gas costs
    ///     for data aggregation
    function getStakingModuleDigests(uint256[] memory _stakingModuleIds)
        public
        view
        returns (StakingModuleDigest[] memory digests)
    {
        digests = new StakingModuleDigest[](_stakingModuleIds.length);
        for (uint256 i = 0; i < _stakingModuleIds.length; ++i) {
            StakingModule memory stakingModuleState = getStakingModule(_stakingModuleIds[i]);
            IStakingModule stakingModule = IStakingModule(stakingModuleState.stakingModuleAddress);
            digests[i] = StakingModuleDigest({
                nodeOperatorsCount: stakingModule.getNodeOperatorsCount(),
                activeNodeOperatorsCount: stakingModule.getActiveNodeOperatorsCount(),
                state: stakingModuleState,
                summary: getStakingModuleSummary(_stakingModuleIds[i])
            });
        }
    }

    /// @notice Returns node operator digest for each node operator registered in the given staking module
    /// @param _stakingModuleId id of the staking module to return data for
    /// @dev WARNING: This method is not supposed to be used for onchain calls due to high gas costs
    ///     for data aggregation
    function getAllNodeOperatorDigests(uint256 _stakingModuleId) external view returns (NodeOperatorDigest[] memory) {
        IStakingModule stakingModule = IStakingModule(_getStakingModuleAddressById(_stakingModuleId));
        uint256 nodeOperatorsCount = stakingModule.getNodeOperatorsCount();
        return getNodeOperatorDigests(_stakingModuleId, 0, nodeOperatorsCount);
    }

    /// @notice Returns node operator digest for passed node operator ids in the given staking module
    /// @param _stakingModuleId id of the staking module where node operators registered
    /// @param _offset node operators offset starting with 0
    /// @param _limit the max number of node operators to return
    /// @dev WARNING: This method is not supposed to be used for onchain calls due to high gas costs
    ///     for data aggregation
    function getNodeOperatorDigests(
        uint256 _stakingModuleId,
        uint256 _offset,
        uint256 _limit
    ) public view returns (NodeOperatorDigest[] memory) {
        IStakingModule stakingModule = IStakingModule(_getStakingModuleAddressById(_stakingModuleId));
        uint256[] memory nodeOperatorIds = stakingModule.getNodeOperatorIds(_offset, _limit);
        return getNodeOperatorDigests(_stakingModuleId, nodeOperatorIds);
    }

    /// @notice Returns node operator digest for a slice of node operators registered in the given
    ///     staking module
    /// @param _stakingModuleId id of the staking module where node operators registered
    /// @param _nodeOperatorIds ids of the node operators to return data for
    /// @dev WARNING: This method is not supposed to be used for onchain calls due to high gas costs
    ///     for data aggregation
    function getNodeOperatorDigests(uint256 _stakingModuleId, uint256[] memory _nodeOperatorIds)
        public
        view
        returns (NodeOperatorDigest[] memory digests)
    {
        IStakingModule stakingModule = IStakingModule(_getStakingModuleAddressById(_stakingModuleId));
        digests = new NodeOperatorDigest[](_nodeOperatorIds.length);
        for (uint256 i = 0; i < _nodeOperatorIds.length; ++i) {
            digests[i] = NodeOperatorDigest({
                id: _nodeOperatorIds[i],
                isActive: stakingModule.getNodeOperatorIsActive(_nodeOperatorIds[i]),
                summary: getNodeOperatorSummary(_stakingModuleId, _nodeOperatorIds[i])
            });
        }
    }

    /**
     * @notice set the staking module status flag for participation in further deposits and/or reward distribution
     */
    function setStakingModuleStatus(uint256 _stakingModuleId, StakingModuleStatus _status) external
        onlyRole(STAKING_MODULE_MANAGE_ROLE)
    {
        StakingModule storage stakingModule = _getStakingModuleById(_stakingModuleId);
        if (StakingModuleStatus(stakingModule.status) == _status)
            revert StakingModuleStatusTheSame();
        _setStakingModuleStatus(stakingModule, _status);
    }

    /**
     * @notice pause deposits for staking module
     * @param _stakingModuleId id of the staking module to be paused
     */
    function pauseStakingModule(uint256 _stakingModuleId) external
        onlyRole(STAKING_MODULE_PAUSE_ROLE)
    {
        StakingModule storage stakingModule = _getStakingModuleById(_stakingModuleId);
        if (StakingModuleStatus(stakingModule.status) != StakingModuleStatus.Active)
            revert StakingModuleNotActive();
        _setStakingModuleStatus(stakingModule, StakingModuleStatus.DepositsPaused);
    }

    /**
     * @notice resume deposits for staking module
     * @param _stakingModuleId id of the staking module to be unpaused
     */
    function resumeStakingModule(uint256 _stakingModuleId) external
        onlyRole(STAKING_MODULE_RESUME_ROLE)
    {
        StakingModule storage stakingModule = _getStakingModuleById(_stakingModuleId);
        if (StakingModuleStatus(stakingModule.status) != StakingModuleStatus.DepositsPaused)
            revert StakingModuleNotPaused();
        _setStakingModuleStatus(stakingModule, StakingModuleStatus.Active);
    }

    function getStakingModuleIsStopped(uint256 _stakingModuleId) external view returns (bool)
    {
        return getStakingModuleStatus(_stakingModuleId) == StakingModuleStatus.Stopped;
    }

    function getStakingModuleIsDepositsPaused(uint256 _stakingModuleId)
        external
        view
        returns (bool)
    {
        return getStakingModuleStatus(_stakingModuleId) == StakingModuleStatus.DepositsPaused;
    }

    function getStakingModuleIsActive(uint256 _stakingModuleId) external view returns (bool) {
        return getStakingModuleStatus(_stakingModuleId) == StakingModuleStatus.Active;
    }

    function getStakingModuleNonce(uint256 _stakingModuleId) external view returns (uint256) {
        return IStakingModule(_getStakingModuleAddressById(_stakingModuleId)).getNonce();
    }

    function getStakingModuleLastDepositBlock(uint256 _stakingModuleId)
        external
        view
        returns (uint256)
    {
        StakingModule storage stakingModule = _getStakingModuleById(_stakingModuleId);
        return stakingModule.lastDepositBlock;
    }

    function getStakingModuleActiveValidatorsCount(uint256 _stakingModuleId)
        external
        view
        returns (uint256 activeValidatorsCount)
    {
        StakingModule storage stakingModule = _getStakingModuleById(_stakingModuleId);
        (
            uint256 totalExitedValidators,
            uint256 totalDepositedValidators,
            /* uint256 depositableValidatorsCount */
        ) = IStakingModule(stakingModule.stakingModuleAddress).getStakingModuleSummary();

        activeValidatorsCount = totalDepositedValidators - Math256.max(
            stakingModule.exitedValidatorsCount, totalExitedValidators
        );
    }

    /// @dev calculate the max count of deposits which the staking module can provide data for based
    ///     on the passed `_maxDepositsValue` amount
    /// @param _stakingModuleId id of the staking module to be deposited
    /// @param _maxDepositsValue max amount of ether that might be used for deposits count calculation
    /// @return max number of deposits might be done using the given staking module
    function getStakingModuleMaxDepositsCount(uint256 _stakingModuleId, uint256 _maxDepositsValue)
        public
        view
        returns (uint256)
    {
        (
            /* uint256 allocated */,
            uint256[] memory newDepositsAllocation,
            StakingModuleCache[] memory stakingModulesCache
        ) = _getDepositsAllocation(_maxDepositsValue / DEPOSIT_SIZE);
        uint256 stakingModuleIndex = _getStakingModuleIndexById(_stakingModuleId);
        return
            newDepositsAllocation[stakingModuleIndex] - stakingModulesCache[stakingModuleIndex].activeValidatorsCount;
    }

    /**
     * @notice Returns the aggregate fee distribution proportion
     * @return modulesFee modules aggregate fee in base precision
     * @return treasuryFee treasury fee in base precision
     * @return basePrecision base precision: a value corresponding to the full fee
     */
    function getStakingFeeAggregateDistribution() public view returns (
        uint96 modulesFee,
        uint96 treasuryFee,
        uint256 basePrecision
    ) {
        uint96[] memory moduleFees;
        uint96 totalFee;
        (, , moduleFees, totalFee, basePrecision) = getStakingRewardsDistribution();
        for (uint256 i; i < moduleFees.length; ++i) {
            modulesFee += moduleFees[i];
        }
        treasuryFee = totalFee - modulesFee;
    }

    /**
     * @notice Return shares table
     *
     * @return recipients rewards recipient addresses corresponding to each module
     * @return stakingModuleIds module IDs
     * @return stakingModuleFees fee of each recipient
     * @return totalFee total fee to mint for each staking module and treasury
     * @return precisionPoints base precision number, which constitutes 100% fee
     */
    function getStakingRewardsDistribution()
        public
        view
        returns (
            address[] memory recipients,
            uint256[] memory stakingModuleIds,
            uint96[] memory stakingModuleFees,
            uint96 totalFee,
            uint256 precisionPoints
        )
    {
        (uint256 totalActiveValidators, StakingModuleCache[] memory stakingModulesCache) = _loadStakingModulesCache();
        uint256 stakingModulesCount = stakingModulesCache.length;

        /// @dev return empty response if there are no staking modules or active validators yet
        if (stakingModulesCount == 0 || totalActiveValidators == 0) {
            return (new address[](0), new uint256[](0), new uint96[](0), 0, FEE_PRECISION_POINTS);
        }

        precisionPoints = FEE_PRECISION_POINTS;
        stakingModuleIds = new uint256[](stakingModulesCount);
        recipients = new address[](stakingModulesCount);
        stakingModuleFees = new uint96[](stakingModulesCount);

        uint256 rewardedStakingModulesCount = 0;
        uint256 stakingModuleValidatorsShare;
        uint96 stakingModuleFee;

        for (uint256 i; i < stakingModulesCount; ) {
            /// @dev skip staking modules which have no active validators
            if (stakingModulesCache[i].activeValidatorsCount > 0) {
                stakingModuleIds[rewardedStakingModulesCount] = stakingModulesCache[i].stakingModuleId;
                stakingModuleValidatorsShare = ((stakingModulesCache[i].activeValidatorsCount * precisionPoints) / totalActiveValidators);

                recipients[rewardedStakingModulesCount] = address(stakingModulesCache[i].stakingModuleAddress);
                stakingModuleFee = uint96((stakingModuleValidatorsShare * stakingModulesCache[i].stakingModuleFee) / TOTAL_BASIS_POINTS);
                /// @dev if the staking module has the `Stopped` status for some reason, then
                ///      the staking module's rewards go to the treasury, so that the DAO has ability
                ///      to manage them (e.g. to compensate the staking module in case of an error, etc.)
                if (stakingModulesCache[i].status != StakingModuleStatus.Stopped) {
                    stakingModuleFees[rewardedStakingModulesCount] = stakingModuleFee;
                }
                // else keep stakingModuleFees[rewardedStakingModulesCount] = 0, but increase totalFee

                totalFee += (uint96((stakingModuleValidatorsShare * stakingModulesCache[i].treasuryFee) / TOTAL_BASIS_POINTS) + stakingModuleFee);

                unchecked {
                    rewardedStakingModulesCount++;
                }
            }
            unchecked {
                ++i;
            }
        }

        // Total fee never exceeds 100%
        assert(totalFee <= precisionPoints);

        /// @dev shrink arrays
        if (rewardedStakingModulesCount < stakingModulesCount) {
            assembly {
                mstore(stakingModuleIds, rewardedStakingModulesCount)
                mstore(recipients, rewardedStakingModulesCount)
                mstore(stakingModuleFees, rewardedStakingModulesCount)
            }
        }
    }

    /// @notice Helper for Lido contract (DEPRECATED)
    ///         Returns total fee total fee to mint for each staking
    ///         module and treasury in reduced, 1e4 precision.
    ///         In integrations please use getStakingRewardsDistribution().
    ///         reduced, 1e4 precision.
    function getTotalFeeE4Precision() external view returns (uint16 totalFee) {
        /// @dev The logic is placed here but in Lido contract to save Lido bytecode
        (, , , uint96 totalFeeInHighPrecision, uint256 precision) = getStakingRewardsDistribution();
        // Here we rely on (totalFeeInHighPrecision <= precision)
        totalFee = _toE4Precision(totalFeeInHighPrecision, precision);
    }

    /// @notice Helper for Lido contract (DEPRECATED)
    ///         Returns the same as getStakingFeeAggregateDistribution() but in reduced, 1e4 precision
    /// @dev Helper only for Lido contract. Use getStakingFeeAggregateDistribution() instead
    function getStakingFeeAggregateDistributionE4Precision()
        external view
        returns (uint16 modulesFee, uint16 treasuryFee)
    {
        /// @dev The logic is placed here but in Lido contract to save Lido bytecode
        (
            uint256 modulesFeeHighPrecision,
            uint256 treasuryFeeHighPrecision,
            uint256 precision
        ) = getStakingFeeAggregateDistribution();
        // Here we rely on ({modules,treasury}FeeHighPrecision <= precision)
        modulesFee = _toE4Precision(modulesFeeHighPrecision, precision);
        treasuryFee = _toE4Precision(treasuryFeeHighPrecision, precision);
    }

    /// @notice returns new deposits allocation after the distribution of the `_depositsCount` deposits
    function getDepositsAllocation(uint256 _depositsCount) external view returns (uint256 allocated, uint256[] memory allocations) {
        (allocated, allocations, ) = _getDepositsAllocation(_depositsCount);
    }

    /// @dev Invokes a deposit call to the official Deposit contract
    /// @param _depositsCount number of deposits to make
    /// @param _stakingModuleId id of the staking module to be deposited
    /// @param _depositCalldata staking module calldata
    function deposit(
        uint256 _depositsCount,
        uint256 _stakingModuleId,
        bytes calldata _depositCalldata
    ) external payable {
        if (msg.sender != LIDO_POSITION.getStorageAddress()) revert AppAuthLidoFailed();

        bytes32 withdrawalCredentials = getWithdrawalCredentials();
        if (withdrawalCredentials == 0) revert EmptyWithdrawalsCredentials();

        StakingModule storage stakingModule = _getStakingModuleById(_stakingModuleId);
        if (StakingModuleStatus(stakingModule.status) != StakingModuleStatus.Active)
            revert StakingModuleNotActive();

        /// @dev firstly update the local state of the contract to prevent a reentrancy attack
        ///     even though the staking modules are trusted contracts
        stakingModule.lastDepositAt = uint64(block.timestamp);
        stakingModule.lastDepositBlock = block.number;

        uint256 depositsValue = msg.value;
        emit StakingRouterETHDeposited(_stakingModuleId, depositsValue);

        if (depositsValue != _depositsCount * DEPOSIT_SIZE)
            revert InvalidDepositsValue(depositsValue, _depositsCount);

        if (_depositsCount > 0) {
            (bytes memory publicKeysBatch, bytes memory signaturesBatch) =
                IStakingModule(stakingModule.stakingModuleAddress)
                    .obtainDepositData(_depositsCount, _depositCalldata);

            uint256 etherBalanceBeforeDeposits = address(this).balance;
            _makeBeaconChainDeposits32ETH(
                _depositsCount,
                abi.encodePacked(withdrawalCredentials),
                publicKeysBatch,
                signaturesBatch
            );
            uint256 etherBalanceAfterDeposits = address(this).balance;

            /// @dev all sent ETH must be deposited and self balance stay the same
            assert(etherBalanceBeforeDeposits - etherBalanceAfterDeposits == depositsValue);
        }
    }

    /**
     * @notice Set credentials to withdraw ETH on Consensus Layer side after the phase 2 is launched to `_withdrawalCredentials`
     * @dev Note that setWithdrawalCredentials discards all unused deposits data as the signatures are invalidated.
     * @param _withdrawalCredentials withdrawal credentials field as defined in the Ethereum PoS consensus specs
     */
    function setWithdrawalCredentials(bytes32 _withdrawalCredentials) external onlyRole(MANAGE_WITHDRAWAL_CREDENTIALS_ROLE) {
        WITHDRAWAL_CREDENTIALS_POSITION.setStorageBytes32(_withdrawalCredentials);

        uint256 stakingModulesCount = getStakingModulesCount();
        for (uint256 i; i < stakingModulesCount; ) {
            StakingModule storage stakingModule = _getStakingModuleByIndex(i);
            unchecked { ++i; }

            try IStakingModule(stakingModule.stakingModuleAddress)
                .onWithdrawalCredentialsChanged() {}
            catch (bytes memory lowLevelRevertData) {
                /// @dev This check is required to prevent incorrect gas estimation of the method.
                ///      Without it, Ethereum nodes that use binary search for gas estimation may
                ///      return an invalid value when the onWithdrawalCredentialsChanged()
                ///      reverts because of the "out of gas" error. Here we assume that the
                ///      onWithdrawalCredentialsChanged() method doesn't have reverts with
                ///      empty error data except "out of gas".
                if (lowLevelRevertData.length == 0) revert UnrecoverableModuleError();
                _setStakingModuleStatus(stakingModule, StakingModuleStatus.DepositsPaused);
                emit WithdrawalsCredentialsChangeFailed(stakingModule.id, lowLevelRevertData);
            }
        }

        emit WithdrawalCredentialsSet(_withdrawalCredentials, msg.sender);
    }

    /**
     * @notice Returns current credentials to withdraw ETH on Consensus Layer side after the phase 2 is launched
     */
    function getWithdrawalCredentials() public view returns (bytes32) {
        return WITHDRAWAL_CREDENTIALS_POSITION.getStorageBytes32();
    }

    function _checkValidatorsByNodeOperatorReportData(
        bytes calldata _nodeOperatorIds,
        bytes calldata _validatorsCounts
    ) internal pure {
        if (_nodeOperatorIds.length % 8 != 0 || _validatorsCounts.length % 16 != 0) {
            revert InvalidReportData(3);
        }
        uint256 nodeOperatorsCount = _nodeOperatorIds.length / 8;
        if (_validatorsCounts.length / 16 != nodeOperatorsCount) {
            revert InvalidReportData(2);
        }
        if (nodeOperatorsCount == 0) {
            revert InvalidReportData(1);
        }
    }

    /// @dev load modules into a memory cache
    ///
    /// @return totalActiveValidators total active validators across all modules
    /// @return stakingModulesCache array of StakingModuleCache structs
    function _loadStakingModulesCache() internal view returns (
        uint256 totalActiveValidators,
        StakingModuleCache[] memory stakingModulesCache
    ) {
        uint256 stakingModulesCount = getStakingModulesCount();
        stakingModulesCache = new StakingModuleCache[](stakingModulesCount);
        for (uint256 i; i < stakingModulesCount; ) {
            stakingModulesCache[i] = _loadStakingModulesCacheItem(i);
            totalActiveValidators += stakingModulesCache[i].activeValidatorsCount;
            unchecked {
                ++i;
            }
        }
    }

    function _loadStakingModulesCacheItem(uint256 _stakingModuleIndex)
        internal
        view
        returns (StakingModuleCache memory cacheItem)
    {
        StakingModule storage stakingModuleData = _getStakingModuleByIndex(_stakingModuleIndex);

        cacheItem.stakingModuleAddress = stakingModuleData.stakingModuleAddress;
        cacheItem.stakingModuleId = stakingModuleData.id;
        cacheItem.stakingModuleFee = stakingModuleData.stakingModuleFee;
        cacheItem.treasuryFee = stakingModuleData.treasuryFee;
        cacheItem.targetShare = stakingModuleData.targetShare;
        cacheItem.status = StakingModuleStatus(stakingModuleData.status);

        (
            uint256 totalExitedValidators,
            uint256 totalDepositedValidators,
            uint256 depositableValidatorsCount
        ) = IStakingModule(cacheItem.stakingModuleAddress).getStakingModuleSummary();

        cacheItem.availableValidatorsCount = cacheItem.status == StakingModuleStatus.Active
            ? depositableValidatorsCount
            : 0;

        // the module might not receive all exited validators data yet => we need to replacing
        // the exitedValidatorsCount with the one that the staking router is aware of
        cacheItem.activeValidatorsCount =
            totalDepositedValidators -
            Math256.max(totalExitedValidators, stakingModuleData.exitedValidatorsCount);
    }

    function _setStakingModuleStatus(StakingModule storage _stakingModule, StakingModuleStatus _status) internal {
        StakingModuleStatus prevStatus = StakingModuleStatus(_stakingModule.status);
        if (prevStatus != _status) {
            _stakingModule.status = uint8(_status);
            emit StakingModuleStatusSet(_stakingModule.id, _status, msg.sender);
        }
    }

    function _getDepositsAllocation(
        uint256 _depositsToAllocate
    ) internal view returns (uint256 allocated, uint256[] memory allocations, StakingModuleCache[] memory stakingModulesCache) {
        // calculate total used validators for operators
        uint256 totalActiveValidators;

        (totalActiveValidators, stakingModulesCache) = _loadStakingModulesCache();

        uint256 stakingModulesCount = stakingModulesCache.length;
        allocations = new uint256[](stakingModulesCount);
        if (stakingModulesCount > 0) {
            /// @dev new estimated active validators count
            totalActiveValidators += _depositsToAllocate;
            uint256[] memory capacities = new uint256[](stakingModulesCount);
            uint256 targetValidators;

            for (uint256 i; i < stakingModulesCount; ) {
                allocations[i] = stakingModulesCache[i].activeValidatorsCount;
                targetValidators = (stakingModulesCache[i].targetShare * totalActiveValidators) / TOTAL_BASIS_POINTS;
                capacities[i] = Math256.min(targetValidators, stakingModulesCache[i].activeValidatorsCount + stakingModulesCache[i].availableValidatorsCount);
                unchecked {
                    ++i;
                }
            }

            allocated = MinFirstAllocationStrategy.allocate(allocations, capacities, _depositsToAllocate);
        }
    }

    function _getStakingModuleIndexById(uint256 _stakingModuleId) internal view returns (uint256) {
        mapping(uint256 => uint256) storage _stakingModuleIndicesOneBased = _getStorageStakingIndicesMapping();
        uint256 indexOneBased = _stakingModuleIndicesOneBased[_stakingModuleId];
        if (indexOneBased == 0) revert StakingModuleUnregistered();
        return indexOneBased - 1;
    }

    function _setStakingModuleIndexById(uint256 _stakingModuleId, uint256 _stakingModuleIndex) internal {
        mapping(uint256 => uint256) storage _stakingModuleIndicesOneBased = _getStorageStakingIndicesMapping();
        _stakingModuleIndicesOneBased[_stakingModuleId] = _stakingModuleIndex + 1;
    }

    function _getStakingModuleById(uint256 _stakingModuleId) internal view returns (StakingModule storage) {
        return _getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId));
    }

    function _getStakingModuleByIndex(uint256 _stakingModuleIndex) internal view returns (StakingModule storage) {
        mapping(uint256 => StakingModule) storage _stakingModules = _getStorageStakingModulesMapping();
        return _stakingModules[_stakingModuleIndex];
    }

    function _getStakingModuleAddressById(uint256 _stakingModuleId) internal view returns (address) {
        return _getStakingModuleById(_stakingModuleId).stakingModuleAddress;
    }

    function _getStorageStakingModulesMapping() internal pure returns (mapping(uint256 => StakingModule) storage result) {
        bytes32 position = STAKING_MODULES_MAPPING_POSITION;
        assembly {
            result.slot := position
        }
    }

    function _getStorageStakingIndicesMapping() internal pure returns (mapping(uint256 => uint256) storage result) {
        bytes32 position = STAKING_MODULE_INDICES_MAPPING_POSITION;
        assembly {
            result.slot := position
        }
    }

    function _toE4Precision(uint256 _value, uint256 _precision) internal pure returns (uint16) {
        return uint16((_value * TOTAL_BASIS_POINTS) / _precision);
    }
}
