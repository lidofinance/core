// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {Math256} from "contracts/common/lib/Math256.sol";
import {AccessControlEnumerableUpgradeable} from
    "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {BeaconChainDepositor, IDepositContract} from "contracts/0.8.25/lib/BeaconChainDepositor.sol";
import {DepositsTracker} from "contracts/common/lib/DepositsTracker.sol";
import {DepositsTempStorage} from "contracts/common/lib/DepositsTempStorage.sol";
import {WithdrawalCredentials} from "contracts/common/lib/WithdrawalCredentials.sol";
import {IStakingModule} from "contracts/common/interfaces/IStakingModule.sol";
import {IStakingModuleV2} from "contracts/common/interfaces/IStakingModuleV2.sol";
import {STASStorage} from "contracts/0.8.25/stas/STASTypes.sol";
import {STASCore} from "contracts/0.8.25/stas/STASCore.sol";
import {SRLib} from "./SRLib.sol";
import {SRStorage} from "./SRStorage.sol";
import {SRUtils} from "./SRUtils.sol";

import {
    RouterStorage,
    ModuleState,
    StakingModuleType,
    StakingModuleStatus,
    StakingModuleConfig,
    ValidatorsCountsCorrection,
    ValidatorExitData,
    StakingModule,
    StakingModuleSummary,
    NodeOperatorSummary,
    StakingModuleDigest,
    NodeOperatorDigest,
    StakingModuleCache,
    ModuleStateConfig,
    ModuleStateDeposits,
    ModuleStateAccounting
} from "./SRTypes.sol";

contract StakingRouter is AccessControlEnumerableUpgradeable {
    using STASCore for STASStorage;
    using WithdrawalCredentials for bytes32;
    using SRStorage for ModuleState;
    using SRStorage for uint256; // for module IDs

    /// @dev Events

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
    event StakingModuleExitedValidatorsIncompleteReporting(
        uint256 indexed stakingModuleId, uint256 unreportedExitedValidatorsCount
    );

    event WithdrawalCredentialsSet(bytes32 withdrawalCredentials, address setBy);
    event WithdrawalCredentials02Set(bytes32 withdrawalCredentials02, address setBy);

    /// Emitted when the StakingRouter received ETH
    event StakingRouterETHDeposited(uint256 indexed stakingModuleId, uint256 amount);

    // uint256 public constant TOTAL_BASIS_POINTS = 10000;
    uint256 public constant FEE_PRECISION_POINTS = 10 ** 20; // 100 * 10 ** 18

/// @notice Initial deposit amount made for validator creation
    /// @dev Identical for both 0x01 and 0x02 types.
    ///      For 0x02, the validator may later be topped up.
    ///      Top-ups are not supported for 0x01.
    uint256 public constant INITIAL_DEPOSIT_SIZE = 32 ether;

    /// @dev Module trackers will be derived from this position
    bytes32 internal constant DEPOSITS_TRACKER = keccak256("lido.StakingRouter.depositTracker");

    /// @dev ACL roles
    bytes32 public constant MANAGE_WITHDRAWAL_CREDENTIALS_ROLE = keccak256("MANAGE_WITHDRAWAL_CREDENTIALS_ROLE");
    bytes32 public constant STAKING_MODULE_MANAGE_ROLE = keccak256("STAKING_MODULE_MANAGE_ROLE");
    bytes32 public constant STAKING_MODULE_UNVETTING_ROLE = keccak256("STAKING_MODULE_UNVETTING_ROLE");
    bytes32 public constant REPORT_EXITED_VALIDATORS_ROLE = keccak256("REPORT_EXITED_VALIDATORS_ROLE");
    bytes32 public constant REPORT_VALIDATOR_EXITING_STATUS_ROLE = keccak256("REPORT_VALIDATOR_EXITING_STATUS_ROLE");
    bytes32 public constant REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE = keccak256("REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE");
    bytes32 public constant UNSAFE_SET_EXITED_VALIDATORS_ROLE = keccak256("UNSAFE_SET_EXITED_VALIDATORS_ROLE");
    bytes32 public constant REPORT_REWARDS_MINTED_ROLE = keccak256("REPORT_REWARDS_MINTED_ROLE");

    /// Chain specification
    uint64 internal immutable SECONDS_PER_SLOT;
    uint64 internal immutable GENESIS_TIME;
    IDepositContract public immutable DEPOSIT_CONTRACT;

    error WrongWithdrawalCredentialsType();
    error ZeroAddressLido();
    error ZeroAddressAdmin();
    error StakingModuleNotActive();
    error EmptyWithdrawalsCredentials();
    error DirectETHTransfer();
    error AppAuthLidoFailed();
    // error InvalidDepositsValue(uint256 etherValue, uint256 depositsCount);
    error InvalidChainConfig();
    error AllocationExceedsTarget();
    error DepositContractZeroAddress();
    error DepositValueNotMultipleOfInitialDeposit();
    error ModuleTypeNotSupported();
    error StakingModuleStatusTheSame();

    /// @dev compatibility getters for constants removed in favor of SRLib
    // function INITIAL_DEPOSIT_SIZE() external pure returns (uint256) {
    //     return SRUtils.INITIAL_DEPOSIT_SIZE;
    // }
    function TOTAL_BASIS_POINTS() external pure returns (uint256) {
        return SRUtils.TOTAL_BASIS_POINTS;
    }

    function MAX_STAKING_MODULES_COUNT() external pure returns (uint256) {
        return SRUtils.MAX_STAKING_MODULES_COUNT;
    }

    function MAX_STAKING_MODULE_NAME_LENGTH() external pure returns (uint256) {
        return SRUtils.MAX_STAKING_MODULE_NAME_LENGTH;
    }

    constructor(address _depositContract, uint256 secondsPerSlot, uint256 genesisTime) {
        if (_depositContract == address(0)) revert DepositContractZeroAddress();
        if (secondsPerSlot == 0) revert InvalidChainConfig();

        _disableInitializers();

        SECONDS_PER_SLOT = uint64(secondsPerSlot);
        GENESIS_TIME = uint64(genesisTime);
        DEPOSIT_CONTRACT = IDepositContract(_depositContract);
    }

    /// @notice Initializes the contract.
    /// @param _admin Lido DAO Aragon agent contract address.
    /// @param _lido Lido address.
    /// @param _withdrawalCredentials 0x01 credentials to withdraw ETH on Consensus Layer side.
    /// @param _withdrawalCredentials02 0x02 Credentials to withdraw ETH on Consensus Layer side
    /// @dev Proxy initialization method.
    function initialize(address _admin, address _lido, bytes32 _withdrawalCredentials, bytes32 _withdrawalCredentials02)
        external
        reinitializer(4)
    {
        if (_admin == address(0)) revert ZeroAddressAdmin();
        if (_lido == address(0)) revert ZeroAddressLido();

        __AccessControlEnumerable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);

        _initializeSTAS();

        RouterStorage storage rs = SRStorage.getRouterStorage();
        rs.lido = _lido;

        // TODO: maybe store withdrawalVault
        rs.withdrawalCredentials = _withdrawalCredentials;
        rs.withdrawalCredentials02 = _withdrawalCredentials02;
        emit WithdrawalCredentialsSet(_withdrawalCredentials, _msgSender());
        emit WithdrawalCredentials02Set(_withdrawalCredentials02, _msgSender());
    }

    /// @dev Prohibit direct transfer to contract.
    receive() external payable {
        revert DirectETHTransfer();
    }

    /// @notice A function to finalize upgrade to v2 (from v1). Removed and no longer used.
    /// @dev https://github.com/lidofinance/lido-improvement-proposals/blob/develop/LIPS/lip-10.md
    /// See historical usage in commit: https://github.com/lidofinance/core/blob/c19480aa3366b26aa6eac17f85a6efae8b9f4f72/contracts/0.8.9/StakingRouter.sol#L190
    // function finalizeUpgrade_v2(
    //     uint256[] memory _priorityExitShareThresholds,
    //     uint256[] memory _maxDepositsPerBlock,
    //     uint256[] memory _minDepositBlockDistances
    // ) external

    /// @notice Finalizes upgrade to v3 (from v2). Can be called only once. Removed and no longer used
    /// See historical usage in commit:
    // function finalizeUpgrade_v3() external {
    //     _checkContractVersion(2);
    //     _updateContractVersion(3);
    // }

    /// @notice A function to migrade upgrade to v4 (from v3) and use Openzeppelin versioning.
    function migrateUpgrade_v4() external reinitializer(4) {
        // TODO: here is problem, that last version of
        __AccessControlEnumerable_init();

        _initializeSTAS();
        // migrate current modules to new storage
        SRLib._migrateStorage();

        // emit STASInitialized();

        RouterStorage storage rs = SRStorage.getRouterStorage();
        emit WithdrawalCredentialsSet(rs.withdrawalCredentials, _msgSender());
        emit WithdrawalCredentials02Set(rs.withdrawalCredentials02, _msgSender());
    }

    /// @notice Returns Lido contract address.
    /// @return Lido contract address.
    function getLido() external view returns (address) {
        return _getLido();
    }

    /// @notice Registers a new staking module.
    /// @param _name Name of staking module.
    /// @param _stakingModuleAddress Address of staking module.
    /// @param _stakingModuleConfig Staking module config
    /// @dev The function is restricted to the `STAKING_MODULE_MANAGE_ROLE` role.
    function addStakingModule(
        string calldata _name,
        address _stakingModuleAddress,
        StakingModuleConfig calldata _stakingModuleConfig
    ) external onlyRole(STAKING_MODULE_MANAGE_ROLE) {
        uint256 newModuleId = SRLib._addModule(_stakingModuleAddress, _name, _stakingModuleConfig);

        /// @dev Simulate last deposit state to prevent real deposits into the new ModuleState via
        ///      DepositSecurityModule just after the addition.
        _updateModuleLastDepositState(newModuleId, 0);
        emit StakingModuleAdded(newModuleId, _stakingModuleAddress, _name, _msgSender());

        _emitUpdateModuleParamsEvents(
            newModuleId,
            _stakingModuleConfig.stakeShareLimit,
            _stakingModuleConfig.priorityExitShareThreshold,
            _stakingModuleConfig.stakingModuleFee,
            _stakingModuleConfig.treasuryFee,
            _stakingModuleConfig.maxDepositsPerBlock,
            _stakingModuleConfig.minDepositBlockDistance
        );
    }

    /// @notice Updates staking module params.
    /// @param _stakingModuleId Staking module id.
    // @param _stakingModuleConfig Staking module config
    /// @dev The function is restricted to the `STAKING_MODULE_MANAGE_ROLE` role.
    function updateStakingModule(
        uint256 _stakingModuleId,
        uint256 _stakeShareLimit,
        uint256 _priorityExitShareThreshold,
        uint256 _stakingModuleFee,
        uint256 _treasuryFee,
        uint256 _maxDepositsPerBlock,
        uint256 _minDepositBlockDistance
    ) external onlyRole(STAKING_MODULE_MANAGE_ROLE) {
        SRUtils._validateModuleId(_stakingModuleId);
        SRLib._updateModuleParams(
            _stakingModuleId,
            _stakeShareLimit,
            _priorityExitShareThreshold,
            _stakingModuleFee,
            _treasuryFee,
            _maxDepositsPerBlock,
            _minDepositBlockDistance
        );

        _emitUpdateModuleParamsEvents(
            _stakingModuleId,
            _stakeShareLimit,
            _priorityExitShareThreshold,
            _stakingModuleFee,
            _treasuryFee,
            _maxDepositsPerBlock,
            _minDepositBlockDistance
        );
    }

    function _emitUpdateModuleParamsEvents(
        uint256 _moduleId,
        uint256 _stakeShareLimit,
        uint256 _priorityExitShareThreshold,
        uint256 _stakingModuleFee,
        uint256 _treasuryFee,
        uint256 _maxDepositsPerBlock,
        uint256 _minDepositBlockDistance
    ) internal {
        address setBy = _msgSender();
        emit StakingModuleShareLimitSet(_moduleId, _stakeShareLimit, _priorityExitShareThreshold, setBy);
        emit StakingModuleFeesSet(_moduleId, _stakingModuleFee, _treasuryFee, setBy);
        emit StakingModuleMaxDepositsPerBlockSet(_moduleId, _maxDepositsPerBlock, setBy);
        emit StakingModuleMinDepositBlockDistanceSet(_moduleId, _minDepositBlockDistance, setBy);
    }

    /// @notice Updates the limit of the validators that can be used for deposit.
    /// @param _stakingModuleId Id of the staking module.
    /// @param _nodeOperatorId Id of the node operator.
    /// @param _targetLimitMode Target limit mode.
    /// @param _targetLimit Target limit of the node operator.
    /// @dev The function is restricted to the `STAKING_MODULE_MANAGE_ROLE` role.
    function updateTargetValidatorsLimits(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        uint256 _targetLimitMode,
        uint256 _targetLimit
    ) external onlyRole(STAKING_MODULE_MANAGE_ROLE) {
        _stakingModuleId.getIStakingModule().updateTargetValidatorsLimits(
            _nodeOperatorId, _targetLimitMode, _targetLimit
        );
    }

    /// @dev See {SRLib._reportRewardsMinted}.
    ///
    /// @dev The function is restricted to the `REPORT_REWARDS_MINTED_ROLE` role.
    function reportRewardsMinted(uint256[] calldata _stakingModuleIds, uint256[] calldata _totalShares)
        external
        onlyRole(REPORT_REWARDS_MINTED_ROLE)
    {
        SRLib._reportRewardsMinted(_stakingModuleIds, _totalShares);
    }

    /// @dev See {SRLib._updateExitedValidatorsCountByStakingModule}.
    ///
    /// @dev The function is restricted to the `REPORT_EXITED_VALIDATORS_ROLE` role.
    function updateExitedValidatorsCountByStakingModule(
        uint256[] calldata _stakingModuleIds,
        uint256[] calldata _exitedValidatorsCounts
    ) external onlyRole(REPORT_EXITED_VALIDATORS_ROLE) returns (uint256) {
        return SRLib._updateExitedValidatorsCountByStakingModule(_stakingModuleIds, _exitedValidatorsCounts);
    }

    /// @dev See {SRLib._reportStakingModuleExitedValidatorsCountByNodeOperator}.
    ///
    /// @dev The function is restricted to the `REPORT_EXITED_VALIDATORS_ROLE` role.
    function reportStakingModuleExitedValidatorsCountByNodeOperator(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _exitedValidatorsCounts
    ) external onlyRole(REPORT_EXITED_VALIDATORS_ROLE) {
        SRLib._reportStakingModuleExitedValidatorsCountByNodeOperator(
            _stakingModuleId, _nodeOperatorIds, _exitedValidatorsCounts
        );
    }

    /// @dev See {SRLib._unsafeSetExitedValidatorsCount}.
    ///
    /// @dev The function is restricted to the `UNSAFE_SET_EXITED_VALIDATORS_ROLE` role.
    // todo REMOVE
    function unsafeSetExitedValidatorsCount(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        bool _triggerUpdateFinish,
        ValidatorsCountsCorrection calldata _correction
    ) external onlyRole(UNSAFE_SET_EXITED_VALIDATORS_ROLE) {
        SRLib._unsafeSetExitedValidatorsCount(_stakingModuleId, _nodeOperatorId, _triggerUpdateFinish, _correction);
    }

    /// @dev See {SRLib._onValidatorsCountsByNodeOperatorReportingFinished}.
    ///
    /// @dev The function is restricted to the `REPORT_EXITED_VALIDATORS_ROLE` role.
    function onValidatorsCountsByNodeOperatorReportingFinished() external onlyRole(REPORT_EXITED_VALIDATORS_ROLE) {
        SRLib._onValidatorsCountsByNodeOperatorReportingFinished();
    }

    /// @dev See {SRLib._decreaseStakingModuleVettedKeysCountByNodeOperator}.
    ///
    /// @dev The function is restricted to the `STAKING_MODULE_UNVETTING_ROLE` role.
    function decreaseStakingModuleVettedKeysCountByNodeOperator(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _vettedSigningKeysCounts
    ) external onlyRole(STAKING_MODULE_UNVETTING_ROLE) {
        SRLib._decreaseStakingModuleVettedKeysCountByNodeOperator(
            _stakingModuleId, _nodeOperatorIds, _vettedSigningKeysCounts
        );
    }

    /// @dev See {SRLib._reportValidatorExitDelay}.
    function reportValidatorExitDelay(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        uint256 _proofSlotTimestamp,
        bytes calldata _publicKey,
        uint256 _eligibleToExitInSec
    ) external onlyRole(REPORT_VALIDATOR_EXITING_STATUS_ROLE) {
        SRLib._reportValidatorExitDelay(
            _stakingModuleId, _nodeOperatorId, _proofSlotTimestamp, _publicKey, _eligibleToExitInSec
        );
    }

    /// @dev See {SRLib._onValidatorExitTriggered}.
    function onValidatorExitTriggered(
        ValidatorExitData[] calldata validatorExitData,
        uint256 _withdrawalRequestPaidFee,
        uint256 _exitType
    ) external onlyRole(REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE) {
        SRLib._onValidatorExitTriggered(validatorExitData, _withdrawalRequestPaidFee, _exitType);
    }

    /// @dev DEPRECATED, use getStakingModuleStates() instead
    /// @notice Returns all registered staking modules.
    /// @return moduleStates Array of staking modules.
    function getStakingModules() external view returns (StakingModule[] memory moduleStates) {
        uint256[] memory moduleIds = SRStorage.getModuleIds();
        moduleStates = new StakingModule[](moduleIds.length);

        for (uint256 i; i < moduleIds.length; ++i) {
            moduleStates[i] = _getModuleStateCompat(moduleIds[i]);
        }
    }

    // /// @notice Returns state for all registered staking modules.
    // /// @return moduleStates Array of staking modules.
    // function getStakingModuleStates() external view returns (ModuleState[] memory moduleStates) {
    //     uint256[] memory moduleIds = SRStorage.getModuleIds();
    //     moduleStates = new ModuleState[](moduleIds.length);

    //     for (uint256 i; i < moduleIds.length; ++i) {
    //         moduleStates[i] = moduleIds[i].getModuleState();
    //     }
    // }

    /// @notice Returns the ids of all registered staking modules.
    /// @return Array of staking module ids.
    function getStakingModuleIds() external view returns (uint256[] memory) {
        return SRStorage.getModuleIds();
    }

    /// @dev DEPRECATED, use getStakingModuleState() instead
    /// @notice Returns the staking module by its id.
    /// @param _stakingModuleId Id of the staking module.
    /// @return moduleState Staking module data.
    function getStakingModule(uint256 _stakingModuleId) external view returns (StakingModule memory) {
        SRUtils._validateModuleId(_stakingModuleId);
        return _getModuleStateCompat(_stakingModuleId);
    }

    /// @notice Returns total number of staking modules.
    /// @return Total number of staking modules.
    function getStakingModulesCount() external view returns (uint256) {
        return SRStorage.getModulesCount();
    }

    /// @notice Returns true if staking module with the given id was registered via `addStakingModule`, false otherwise.
    /// @param _stakingModuleId Id of the staking module.
    /// @return True if staking module with the given id was registered, false otherwise.
    function hasStakingModule(uint256 _stakingModuleId) external view returns (bool) {
        return SRStorage.isModuleId(_stakingModuleId);
    }

    /// @notice Returns status of staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return Status of the staking module.
    function getStakingModuleStatus(uint256 _stakingModuleId) public view returns (StakingModuleStatus) {
        SRUtils._validateModuleId(_stakingModuleId);
        return _stakingModuleId.getModuleState().getStateConfig().status;
    }

    function getContractVersion() external view returns (uint256) {
        return _getInitializedVersion();
    }

    /// @notice Returns all-validators summary in the staking module.
    /// @param _stakingModuleId Id of the staking module to return summary for.
    /// @return summary Staking module summary.
    function getStakingModuleSummary(uint256 _stakingModuleId)
        external
        view
        returns (StakingModuleSummary memory summary)
    {
        SRUtils._validateModuleId(_stakingModuleId);
        return _getStakingModuleSummaryStruct(_stakingModuleId);
    }

    /// @notice Returns node operator summary from the staking module.
    /// @param _stakingModuleId Id of the staking module where node operator is onboarded.
    /// @param _nodeOperatorId Id of the node operator to return summary for.
    /// @return summary Node operator summary.
    function getNodeOperatorSummary(uint256 _stakingModuleId, uint256 _nodeOperatorId)
        external
        view
        returns (NodeOperatorSummary memory summary)
    {
        SRUtils._validateModuleId(_stakingModuleId);
        return _getNodeOperatorSummary(_stakingModuleId.getIStakingModule(), _nodeOperatorId);
        // _fillNodeOperatorSummary(_stakingModuleId, _nodeOperatorId, summary);
    }

    /// @notice Returns staking module digest for each staking module registered in the staking router.
    /// @return Array of staking module digests.
    /// @dev WARNING: This method is not supposed to be used for onchain calls due to high gas costs
    /// for data aggregation.
    function getAllStakingModuleDigests() external view returns (StakingModuleDigest[] memory) {
        return getStakingModuleDigests(SRStorage.getModuleIds());
    }

    /// @notice Returns staking module digest for passed staking module ids.
    /// @param _stakingModuleIds Ids of the staking modules to return data for.
    /// @return digests Array of staking module digests.
    /// @dev WARNING: This method is not supposed to be used for onchain calls due to high gas costs
    /// for data aggregation.
    function getStakingModuleDigests(uint256[] memory _stakingModuleIds)
        public
        view
        returns (StakingModuleDigest[] memory digests)
    {
        digests = new StakingModuleDigest[](_stakingModuleIds.length);

        for (uint256 i = 0; i < _stakingModuleIds.length; ++i) {
            uint256 stakingModuleId = _stakingModuleIds[i];
            SRUtils._validateModuleId(stakingModuleId);
            IStakingModule stakingModule = stakingModuleId.getIStakingModule();

            digests[i].nodeOperatorsCount = _getStakingModuleNodeOperatorsCount(stakingModule);
            digests[i].activeNodeOperatorsCount = _getStakingModuleActiveNodeOperatorsCount(stakingModule);
            digests[i].state = _getModuleStateCompat(stakingModuleId);
            digests[i].summary = _getStakingModuleSummaryStruct(stakingModuleId);
        }
    }

    /// @notice Returns node operator digest for each node operator registered in the given staking module.
    /// @param _stakingModuleId Id of the staking module to return data for.
    /// @return Array of node operator digests.
    /// @dev WARNING: This method is not supposed to be used for onchain calls due to high gas costs
    /// for data aggregation.
    function getAllNodeOperatorDigests(uint256 _stakingModuleId) external view returns (NodeOperatorDigest[] memory) {
        return getNodeOperatorDigests(
            _stakingModuleId, 0, _getStakingModuleNodeOperatorsCount(_stakingModuleId.getIStakingModule())
        );
    }

    /// @notice Returns node operator digest for passed node operator ids in the given staking module.
    /// @param _stakingModuleId Id of the staking module where node operators registered.
    /// @param _offset Node operators offset starting with 0.
    /// @param _limit The max number of node operators to return.
    /// @return Array of node operator digests.
    /// @dev WARNING: This method is not supposed to be used for onchain calls due to high gas costs
    /// for data aggregation.
    function getNodeOperatorDigests(uint256 _stakingModuleId, uint256 _offset, uint256 _limit)
        public
        view
        returns (NodeOperatorDigest[] memory)
    {
        return getNodeOperatorDigests(
            _stakingModuleId, _getStakingModuleNodeOperatorIds(_stakingModuleId.getIStakingModule(), _offset, _limit)
        );
    }

    /// @notice Returns node operator digest for a slice of node operators registered in the given
    /// staking module.
    /// @param _stakingModuleId Id of the staking module where node operators registered.
    /// @param _nodeOperatorIds Ids of the node operators to return data for.
    /// @return digests Array of node operator digests.
    /// @dev WARNING: This method is not supposed to be used for onchain calls due to high gas costs
    /// for data aggregation.
    function getNodeOperatorDigests(uint256 _stakingModuleId, uint256[] memory _nodeOperatorIds)
        public
        view
        returns (NodeOperatorDigest[] memory digests)
    {
        SRUtils._validateModuleId(_stakingModuleId);
        digests = new NodeOperatorDigest[](_nodeOperatorIds.length);
        for (uint256 i = 0; i < _nodeOperatorIds.length; ++i) {
            uint256 nodeOperatorId = _nodeOperatorIds[i];
            IStakingModule stakingModule = _stakingModuleId.getIStakingModule();

            digests[i].id = nodeOperatorId;
            digests[i].isActive = _getStakingModuleNodeOperatorIsActive(stakingModule, nodeOperatorId);
            digests[i].summary = _getNodeOperatorSummary(stakingModule, nodeOperatorId);
        }
    }

    /// @notice Sets the staking module status flag for participation in further deposits and/or reward distribution.
    /// @param _stakingModuleId Id of the staking module to be updated.
    /// @param _status New status of the staking module.
    /// @dev The function is restricted to the `STAKING_MODULE_MANAGE_ROLE` role.
    function setStakingModuleStatus(uint256 _stakingModuleId, StakingModuleStatus _status)
        external
        onlyRole(STAKING_MODULE_MANAGE_ROLE)
    {
        SRUtils._validateModuleId(_stakingModuleId);
        if (!SRLib._setModuleStatus(_stakingModuleId, _status)) revert StakingModuleStatusTheSame();
    }

    // function _setStakingModuleStatus(uint256 _stakingModuleId, StakingModuleStatus _status)
    //     internal
    //     returns (bool isChanged)
    // {
    //     ModuleStateConfig storage stateConfig = _stakingModuleId.getModuleState().getStateConfig();
    //     isChanged = stateConfig.status != _status;
    //     if (isChanged) {
    //         stateConfig.status = _status;
    //         emit StakingModuleStatusSet(_stakingModuleId, _status, _msgSender());
    //     }
    // }

    // function _updateModuleStatus(uint256 _moduleId, StakingModuleStatus _status) public returns (bool isChanged) {
    //     isChanged = _setModuleStatus(_moduleId, _status);
    //     if (!isChanged) revert StakingModuleStatusTheSame();
    // }

    // function _setModuleStatus(uint256 _moduleId, StakingModuleStatus _status) public returns (bool isChanged) {
    //     ModuleStateConfig storage stateConfig = _moduleId.getModuleState().getStateConfig();
    //     isChanged = stateConfig.status != _status;
    //     if (isChanged) {
    //         stateConfig.status = _status;
    //     }
    // }

    /// @notice Returns whether the staking module is stopped.
    /// @param _stakingModuleId Id of the staking module.
    /// @return True if the staking module is stopped, false otherwise.
    function getStakingModuleIsStopped(uint256 _stakingModuleId) external view returns (bool) {
        return getStakingModuleStatus(_stakingModuleId) == StakingModuleStatus.Stopped;
    }

    /// @notice Returns whether the deposits are paused for the staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return True if the deposits are paused, false otherwise.
    function getStakingModuleIsDepositsPaused(uint256 _stakingModuleId) external view returns (bool) {
        return getStakingModuleStatus(_stakingModuleId) == StakingModuleStatus.DepositsPaused;
    }

    /// @notice Returns whether the staking module is active.
    /// @param _stakingModuleId Id of the staking module.
    /// @return True if the staking module is active, false otherwise.
    function getStakingModuleIsActive(uint256 _stakingModuleId) external view returns (bool) {
        return getStakingModuleStatus(_stakingModuleId) == StakingModuleStatus.Active;
    }

    /// @notice Returns staking module nonce.
    /// @param _stakingModuleId Id of the staking module.
    /// @return Staking module nonce.
    function getStakingModuleNonce(uint256 _stakingModuleId) external view returns (uint256) {
        SRUtils._validateModuleId(_stakingModuleId);
        return _stakingModuleId.getIStakingModule().getNonce();
    }

    /// @notice Returns the last deposit block for the staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return Last deposit block for the staking module.
    function getStakingModuleLastDepositBlock(uint256 _stakingModuleId) external view returns (uint256) {
        (ModuleState storage state, ) = _validateAndGetModuleState(_stakingModuleId);
        return state.getStateDeposits().lastDepositBlock;
    }

    /// @notice Returns the min deposit block distance for the staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return Min deposit block distance for the staking module.
    function getStakingModuleMinDepositBlockDistance(uint256 _stakingModuleId) external view returns (uint256) {
        (ModuleState storage state, ) = _validateAndGetModuleState(_stakingModuleId);
        return state.getStateDeposits().minDepositBlockDistance;
    }

    /// @notice Returns the max deposits count per block for the staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return Max deposits count per block for the staking module.
    function getStakingModuleMaxDepositsPerBlock(uint256 _stakingModuleId) external view returns (uint256) {
        (ModuleState storage state, ) = _validateAndGetModuleState(_stakingModuleId);
        return state.getStateDeposits().maxDepositsPerBlock;
    }

    /// @notice Returns the max eth deposit amount per block for the staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return Max deposits count per block for the staking module.
    function getStakingModuleMaxDepositsAmountPerBlock(uint256 _stakingModuleId) external view returns (uint256) {
        // TODO: maybe will be defined via staking module config
        // MAX_EFFECTIVE_BALANCE_01 here is old deposit value per validator
        (ModuleState storage state, ) = _validateAndGetModuleState(_stakingModuleId);
        return (
            state.getStateDeposits().maxDepositsPerBlock * SRUtils.MAX_EFFECTIVE_BALANCE_01
        );
    }

    /// @notice Returns active validators count for the staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return activeValidatorsCount Active validators count for the staking module.
    function getStakingModuleActiveValidatorsCount(uint256 _stakingModuleId)
        external
        view
        returns (uint256 activeValidatorsCount)
    {
        (ModuleState storage state, ) = _validateAndGetModuleState(_stakingModuleId);
        (uint256 totalExitedValidators, uint256 totalDepositedValidators,) = _getStakingModuleSummary(_stakingModuleId);

        activeValidatorsCount = totalDepositedValidators
            - Math256.max(
                state.getStateAccounting().exitedValidatorsCount, totalExitedValidators
            );
    }



    /// @notice Returns withdrawal credentials type
    /// @param _stakingModuleId Id of the staking module to be deposited.
    /// @return module type: 0 - Legacy (WC type 0x01) or 1 - New (WC type 0x02)
    function getStakingModuleWithdrawalCredentialType(uint256 _stakingModuleId) external view returns (uint8) {
        (, ModuleStateConfig storage stateConfig) = _validateAndGetModuleState(_stakingModuleId);
        return SRUtils._getModuleWCType(stateConfig.moduleType);
    }

    function getStakingModuleType(uint256 _stakingModuleId) external view returns (StakingModuleType) {
        (, ModuleStateConfig storage stateConfig) = _validateAndGetModuleState(_stakingModuleId);
        return stateConfig.moduleType;
    }

    /// @notice Returns the max amount of Eth for initial 32 eth deposits in staking module.
    /// @param _stakingModuleId Id of the staking module to be deposited.
    /// @param _depositableEth Max amount of ether that might be used for deposits count calculation.
    /// @return Max amount of Eth that can be deposited using the given staking module.
    function getStakingModuleMaxInitialDepositsAmount(uint256 _stakingModuleId, uint256 _depositableEth)
        public
        returns (uint256)
    {
         (, ModuleStateConfig storage stateConfig) = _validateAndGetModuleState(_stakingModuleId);

        // TODO: is it correct?
        if (stateConfig.status != StakingModuleStatus.Active) return 0;

        if (stateConfig.moduleType == StakingModuleType.New) {
            (, uint256 stakingModuleTargetEthAmount,) = _getTargetDepositsAllocation(_stakingModuleId, _depositableEth);
            (uint256[] memory operators, uint256[] memory allocations) =
                IStakingModuleV2(stateConfig.moduleAddress).getAllocation(stakingModuleTargetEthAmount);

            (uint256 totalCount, uint256[] memory counts) =
                _getNewDepositsCount02(stakingModuleTargetEthAmount, allocations, INITIAL_DEPOSIT_SIZE);

            // this will be read and clean in deposit method
            DepositsTempStorage.storeOperators(operators);
            DepositsTempStorage.storeCounts(counts);

            return totalCount * INITIAL_DEPOSIT_SIZE;
        } else if (stateConfig.moduleType == StakingModuleType.Legacy) {
            uint256 count = getStakingModuleMaxDepositsCount(_stakingModuleId, _depositableEth);

            return count * INITIAL_DEPOSIT_SIZE;
        } else {
            revert WrongWithdrawalCredentialsType();
        }
    }

    /// @notice DEPRECATED: use getStakingModuleMaxInitialDepositsAmount
    /// This method only for the legacy modules
    function getStakingModuleMaxDepositsCount(uint256 _stakingModuleId, uint256 _depositableEth)
        public
        view
        returns (uint256)
    {
         (, ModuleStateConfig storage stateConfig) = _validateAndGetModuleState(_stakingModuleId);

        require(stateConfig.moduleType == StakingModuleType.Legacy, "This method is only supported for legacy modules");
        (, uint256 stakingModuleTargetEthAmount,) = _getTargetDepositsAllocation(_stakingModuleId, _depositableEth);

        uint256 countKeys = stakingModuleTargetEthAmount / SRUtils.MAX_EFFECTIVE_BALANCE_01;
        // todo move up
        if (stateConfig.status != StakingModuleStatus.Active) return 0;

        // todo: remove, as stakingModuleTargetEthAmount is already capped by depositableValidatorsCount
        (,, uint256 depositableValidatorsCount) = _getStakingModuleSummary(_stakingModuleId);
        return Math256.min(depositableValidatorsCount, countKeys);
    }

    function _getNewDepositsCount02(
        uint256 stakingModuleTargetEthAmount,
        uint256[] memory allocations,
        uint256 initialDeposit
    ) internal pure returns (uint256 totalCount, uint256[] memory counts) {
        uint256 len = allocations.length;
        counts = new uint256[](len);
        unchecked {
            for (uint256 i = 0; i < len; ++i) {
                uint256 allocation = allocations[i];

                // should sum of uint256[] memory allocations be <= stakingModuleTargetEthAmount?
                if (allocation > stakingModuleTargetEthAmount) {
                    revert AllocationExceedsTarget();
                }

                stakingModuleTargetEthAmount -= allocation;
                uint256 depositsCount;

                if (allocation >= initialDeposit) {
                    // if allocation is 4000 - 2
                    // if allocation 32 - 1
                    // if less than 32 - 0
                    // is it correct situation if allocation 32 for new type of keys?
                    depositsCount = 1 + (allocation - initialDeposit) / SRUtils.MAX_EFFECTIVE_BALANCE_02;
                }

                counts[i] = depositsCount;
                totalCount += depositsCount;
            }
        }
    }

    /// @notice Returns the aggregate fee distribution proportion.
    /// @return modulesFee Modules aggregate fee in base precision.
    /// @return treasuryFee Treasury fee in base precision.
    /// @return basePrecision Base precision: a value corresponding to the full fee.
    function getStakingFeeAggregateDistribution()
        public
        view
        returns (uint96 modulesFee, uint96 treasuryFee, uint256 basePrecision)
    {
        uint96[] memory moduleFees;
        uint96 totalFee;
        (,, moduleFees, totalFee, basePrecision) = getStakingRewardsDistribution();
        for (uint256 i; i < moduleFees.length; ++i) {
            modulesFee += moduleFees[i];
        }
        treasuryFee = totalFee - modulesFee;
    }

    /// @notice Return shares table.
    /// @return recipients Rewards recipient addresses corresponding to each module.
    /// @return stakingModuleIds Module IDs.
    /// @return stakingModuleFees Fee of each recipient.
    /// @return totalFee Total fee to mint for each staking module and treasury.
    /// @return precisionPoints Base precision number, which constitutes 100% fee.
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
        (uint256 totalActiveBalance, StakingModuleCache[] memory stakingModulesCache) = _loadStakingModulesCache();
        uint256 stakingModulesCount = stakingModulesCache.length;

        /// @dev Return empty response if there are no staking modules or active validators yet.
        if (stakingModulesCount == 0 || totalActiveBalance == 0) {
            return (new address[](0), new uint256[](0), new uint96[](0), 0, FEE_PRECISION_POINTS);
        }

        // precisionPoints = FEE_PRECISION_POINTS;
        stakingModuleIds = new uint256[](stakingModulesCount);
        recipients = new address[](stakingModulesCount);
        stakingModuleFees = new uint96[](stakingModulesCount);

        uint256 rewardedStakingModulesCount = 0;

        for (uint256 i; i < stakingModulesCount; ++i) {
            /// @dev Skip staking modules which have no active balance.
            if (stakingModulesCache[i].activeBalance == 0) continue;

            stakingModuleIds[rewardedStakingModulesCount] = stakingModulesCache[i].moduleId;
            recipients[rewardedStakingModulesCount] = stakingModulesCache[i].moduleAddress;

            (uint96 moduleFee, uint96 treasuryFee) = _computeModuleFee(stakingModulesCache[i], totalActiveBalance);

            /// @dev If the staking module has the Stopped status for some reason, then
            ///      the staking module's rewards go to the treasury, so that the DAO has ability
            ///      to manage them (e.g. to compensate the staking module in case of an error, etc.)
            if (stakingModulesCache[i].status != StakingModuleStatus.Stopped) {
                stakingModuleFees[rewardedStakingModulesCount] = moduleFee;
            }
            // Else keep stakingModuleFees[rewardedStakingModulesCount] = 0, but increase totalFee.
            totalFee += treasuryFee + moduleFee;

            unchecked {
                ++rewardedStakingModulesCount;
            }
        }

        // Total fee never exceeds 100%.
        assert(totalFee <= FEE_PRECISION_POINTS);

        /// @dev Shrink arrays.
        if (rewardedStakingModulesCount < stakingModulesCount) {
            assembly {
                mstore(stakingModuleIds, rewardedStakingModulesCount)
                mstore(recipients, rewardedStakingModulesCount)
                mstore(stakingModuleFees, rewardedStakingModulesCount)
            }
        }

        return (recipients, stakingModuleIds, stakingModuleFees, totalFee, FEE_PRECISION_POINTS);
    }

    function _computeModuleFee(StakingModuleCache memory moduleCache, uint256 totalActiveBalance)
        internal
        pure
        returns (uint96 moduleFee, uint96 treasuryFee)
    {
        // uint256 share = Math.mulDiv(moduleCache.activeBalance, FEE_PRECISION_POINTS, totalActiveBalance);
        // moduleFee = uint96(Math.mulDiv(share, moduleCache.moduleFee, TOTAL_BASIS_POINTS));
        // treasuryFee = uint96(Math.mulDiv(share, moduleCache.treasuryFee, TOTAL_BASIS_POINTS));
        uint256 share = moduleCache.activeBalance * FEE_PRECISION_POINTS / totalActiveBalance;
        moduleFee = uint96(share * moduleCache.moduleFee / SRUtils.TOTAL_BASIS_POINTS);
        treasuryFee = uint96(share * moduleCache.treasuryFee / SRUtils.TOTAL_BASIS_POINTS);
    }

    /// @notice Returns the same as getStakingRewardsDistribution() but in reduced, 1e4 precision (DEPRECATED).
    /// @dev Helper only for Lido contract. Use getStakingRewardsDistribution() instead.
    /// @return totalFee Total fee to mint for each staking module and treasury in reduced, 1e4 precision.
    function getTotalFeeE4Precision() external view returns (uint16 totalFee) {
        /// @dev The logic is placed here but in Lido contract to save Lido bytecode.
        (,,, uint96 totalFeeInHighPrecision, uint256 precision) = getStakingRewardsDistribution();
        // Here we rely on (totalFeeInHighPrecision <= precision).
        totalFee = SRUtils._toE4Precision(totalFeeInHighPrecision, precision);
    }

    /// @notice Returns the same as getStakingFeeAggregateDistribution() but in reduced, 1e4 precision (DEPRECATED).
    /// @dev Helper only for Lido contract. Use getStakingFeeAggregateDistribution() instead.
    /// @return modulesFee Modules aggregate fee in reduced, 1e4 precision.
    /// @return treasuryFee Treasury fee in reduced, 1e4 precision.
    function getStakingFeeAggregateDistributionE4Precision()
        external
        view
        returns (uint16 modulesFee, uint16 treasuryFee)
    {
        /// @dev The logic is placed here but in Lido contract to save Lido bytecode.
        (uint256 modulesFeeHighPrecision, uint256 treasuryFeeHighPrecision, uint256 precision) =
            getStakingFeeAggregateDistribution();
        // Here we rely on ({modules,treasury}FeeHighPrecision <= precision).
        modulesFee = SRUtils._toE4Precision(modulesFeeHighPrecision, precision);
        treasuryFee = SRUtils._toE4Precision(treasuryFeeHighPrecision, precision);
    }

    /// @notice Returns new deposits allocation after the distribution of the `_depositsCount` deposits.
    /// @param _depositsCount The maximum number of deposits to be allocated.
    /// @return allocated Number of deposits allocated to the staking modules.
    /// @return allocations Array of new deposits allocation to the staking modules.
    function getDepositsAllocation(uint256 _depositsCount)
        external
        view
        returns (uint256 allocated, uint256[] memory allocations)
    {
        // todo
        // (allocated, allocations, ) = _getDepositsAllocation(_depositsCount);
    }

    /// @notice Invokes a deposit call to the official Deposit contract.
    /// @param _stakingModuleId Id of the staking module to be deposited.
    /// @param _depositCalldata Staking module calldata.
    /// @dev Only the Lido contract is allowed to call this method.
    function deposit(uint256 _stakingModuleId, bytes calldata _depositCalldata) external payable {
        if (_msgSender() != _getLido()) revert AppAuthLidoFailed();
         (ModuleState storage moduleState, ModuleStateConfig storage stateConfig) = _validateAndGetModuleState(_stakingModuleId);

        if (stateConfig.status != StakingModuleStatus.Active) revert StakingModuleNotActive();

        bytes32 withdrawalCredentials = _getWithdrawalCredentialsWithType(stateConfig.moduleType);

        uint256 depositsValue = msg.value;
        address stakingModuleAddress = stateConfig.moduleAddress;

        /// @dev Firstly update the local state of the contract to prevent a reentrancy attack
        /// even though the staking modules are trusted contracts.
        _updateModuleLastDepositState(_stakingModuleId, depositsValue);

        if (depositsValue == 0) return;

        // on previous step should calc exact amount of eth
        if (depositsValue % INITIAL_DEPOSIT_SIZE != 0) revert DepositValueNotMultipleOfInitialDeposit();

        uint256 etherBalanceBeforeDeposits = address(this).balance;

        uint256 depositsCount = depositsValue / INITIAL_DEPOSIT_SIZE;

        (bytes memory publicKeysBatch, bytes memory signaturesBatch) =
            _getOperatorAvailableKeys(stateConfig.moduleType, stakingModuleAddress, depositsCount, _depositCalldata);

        // TODO: maybe some checks of  module's answer

        BeaconChainDepositor.makeBeaconChainDeposits32ETH(
            DEPOSIT_CONTRACT,
            depositsCount,
            INITIAL_DEPOSIT_SIZE,
            abi.encodePacked(withdrawalCredentials),
            publicKeysBatch,
            signaturesBatch
        );

        // Deposits amount should be tracked for module
        // here calculate slot based on timestamp and genesis time
        // and just put new value in state
        // also find position for module tracker
        // TODO: here depositsValue  in wei, check type
        // TODO: maybe tracker should be stored in AO and AO will use it
        DepositsTracker.insertSlotDeposit(
            _getStakingModuleTrackerPosition(_stakingModuleId), _getCurrentSlot(), depositsValue
        );

        // TODO: notify module about deposits


        // todo Update total effective balance gwei via deposit tracked in module and total
        RouterStorage storage rs = SRStorage.getRouterStorage();
        uint256 totalEffectiveBalanceGwei = rs.totalEffectiveBalanceGwei;
        rs.totalEffectiveBalanceGwei = totalEffectiveBalanceGwei + depositsValue / 1 gwei;



        uint256 etherBalanceAfterDeposits = address(this).balance;

        /// @dev All sent ETH must be deposited and self balance stay the same.
        assert(etherBalanceBeforeDeposits - etherBalanceAfterDeposits == depositsValue);
    }

    function _getOperatorAvailableKeys(
        StakingModuleType moduleType,
        address stakingModuleAddress,
        uint256 depositsCount,
        bytes calldata depositCalldata
    ) internal returns (bytes memory keys, bytes memory signatures) {
        if (moduleType == StakingModuleType.Legacy) {
            return IStakingModule(stakingModuleAddress).obtainDepositData(depositsCount, depositCalldata);
        } else {
            (keys, signatures) = IStakingModuleV2(stakingModuleAddress).getOperatorAvailableKeys(
                DepositsTempStorage.getOperators(), DepositsTempStorage.getCounts()
            );

            DepositsTempStorage.clearOperators();
            DepositsTempStorage.clearCounts();
        }
    }

    /// @notice Set 0x01 credentials to withdraw ETH on Consensus Layer side.
    /// @param _withdrawalCredentials 0x01 withdrawal credentials field as defined in the Consensus Layer specs.
    /// @dev Note that setWithdrawalCredentials discards all unused deposits data as the signatures are invalidated.
    /// @dev The function is restricted to the `MANAGE_WITHDRAWAL_CREDENTIALS_ROLE` role.
    function setWithdrawalCredentials(bytes32 _withdrawalCredentials)
        external
        onlyRole(MANAGE_WITHDRAWAL_CREDENTIALS_ROLE)
    {
        SRStorage.getRouterStorage().withdrawalCredentials = _withdrawalCredentials;
        SRLib._notifyStakingModulesOfWithdrawalCredentialsChange();
        emit WithdrawalCredentialsSet(_withdrawalCredentials, _msgSender());
    }

    /// @notice Set 0x02 credentials to withdraw ETH on Consensus Layer side.
    /// @param _withdrawalCredentials 0x02 withdrawal credentials field as defined in the Consensus Layer specs.
    /// @dev Note that setWithdrawalCredentials discards all unused deposits data as the signatures are invalidated.
    /// @dev The function is restricted to the `MANAGE_WITHDRAWAL_CREDENTIALS_ROLE` role.
    function setWithdrawalCredentials02(bytes32 _withdrawalCredentials)
        external
        onlyRole(MANAGE_WITHDRAWAL_CREDENTIALS_ROLE)
    {
        SRStorage.getRouterStorage().withdrawalCredentials02 = _withdrawalCredentials;
        SRLib._notifyStakingModulesOfWithdrawalCredentialsChange();
        emit WithdrawalCredentials02Set(_withdrawalCredentials, _msgSender());
    }

    /// @notice Returns current credentials to withdraw ETH on Consensus Layer side.
    /// @return Withdrawal credentials.
    function getWithdrawalCredentials() public view returns (bytes32) {
        return SRStorage.getRouterStorage().withdrawalCredentials;
    }

    /// @notice Returns current 0x02 credentials to withdraw ETH on Consensus Layer side.
    /// @return Withdrawal credentials.
    function getWithdrawalCredentials02() public view returns (bytes32) {
        return SRStorage.getRouterStorage().withdrawalCredentials02;
    }

    function _getWithdrawalCredentialsWithType(StakingModuleType moduleType) internal view returns (bytes32) {
        bytes32 wc = getWithdrawalCredentials();
        if (wc == 0) revert EmptyWithdrawalsCredentials();
        return wc.setType(SRUtils._getModuleWCType(moduleType));
    }

    /// @dev Save the last deposit state for the staking module and emit the event
    /// @param stakingModuleId id of the staking module to be deposited
    /// @param depositsValue value to deposit
    function _updateModuleLastDepositState(uint256 stakingModuleId, uint256 depositsValue) internal {
        SRStorage.setModuleLastDepositState(stakingModuleId);
        emit StakingRouterETHDeposited(stakingModuleId, depositsValue);
    }

    /// @dev Loads modules into a memory cache.
    /// @return totalActiveBalance Total active balance (effective + deposited) across all modules.
    /// @return stakingModulesCache Array of StakingModuleCache structs.
    function _loadStakingModulesCache()
        internal
        view
        returns (uint256 totalActiveBalance, StakingModuleCache[] memory stakingModulesCache)
    {
        uint256[] memory moduleIds = SRStorage.getModuleIds();
        uint256 stakingModulesCount = moduleIds.length;
        stakingModulesCache = new StakingModuleCache[](stakingModulesCount);

        for (uint256 i; i < stakingModulesCount; ++i) {
            _loadStakingModulesCacheItem(stakingModulesCache[i], moduleIds[i]);
            totalActiveBalance += stakingModulesCache[i].activeBalance;
        }
    }

    /// @dev fill cache object with module data
    /// @param cacheItem The cache object to fill
    /// @param moduleId The ID of the module to load
    function _loadStakingModulesCacheItem(StakingModuleCache memory cacheItem, uint256 moduleId) internal view {
        ModuleState storage state = moduleId.getModuleState();

        ModuleStateConfig memory stateConfig = state.getStateConfig();
        ModuleStateAccounting memory stateAccounting = state.getStateAccounting();
        // ModuleStateDeposits memory stateDeposit = state.getStateDeposits();

        cacheItem.moduleId = moduleId;
        cacheItem.moduleAddress = stateConfig.moduleAddress;
        cacheItem.moduleFee = stateConfig.moduleFee;
        cacheItem.treasuryFee = stateConfig.treasuryFee;
        cacheItem.status = stateConfig.status;

        cacheItem.exitedValidatorsCount = stateAccounting.exitedValidatorsCount;
        // todo load deposit tracker
        cacheItem.activeBalance = stateAccounting.effectiveBalanceGwei * 1 gwei + 0;

        StakingModuleType moduleType = stateConfig.moduleType;
        cacheItem.moduleType = moduleType;

        if (stateConfig.status != StakingModuleStatus.Active) {
            return;
        }

        (,, uint256 depositableValidatorsCount) = _getStakingModuleSummary(moduleId);
        cacheItem.depositableValidatorsCount = depositableValidatorsCount;
        cacheItem.depositableAmount = depositableValidatorsCount * SRUtils._getModuleMEB(moduleType);
    }

    // function _getModuleBalance(uint256 _moduleId) internal view returns (uint256) {
    //     // TODO: add deposit tracker
    //     return _loadModuleStateAccounting(_moduleId).effectiveBalanceGwei * 1 gwei;
    // }

    /// @notice Allocation for module based on target share
    /// @param stakingModuleId - Id of staking module
    /// @param amountToAllocate - Eth amount that can be deposited in module
    function _getTargetDepositsAllocation(uint256 stakingModuleId, uint256 amountToAllocate)
        internal
        view
        returns (uint256 allocated, uint256 allocation, StakingModuleCache memory moduleCache)
    {
        // todo check cache initialization
        _loadStakingModulesCacheItem(moduleCache, stakingModuleId);
        (allocated, allocation) =
            SRLib._getDepositAllocation(stakingModuleId, moduleCache.depositableAmount, amountToAllocate);
    }

    /// module wrapper
    function _getStakingModuleNodeOperatorsCount(IStakingModule _stakingModule) internal view returns (uint256) {
        return _stakingModule.getNodeOperatorsCount();
    }

    function _getStakingModuleActiveNodeOperatorsCount(IStakingModule _stakingModule) internal view returns (uint256) {
        return _stakingModule.getActiveNodeOperatorsCount();
    }

    function _getStakingModuleNodeOperatorIds(IStakingModule _stakingModule, uint256 _offset, uint256 _limit)
        internal
        view
        returns (uint256[] memory)
    {
        return _stakingModule.getNodeOperatorIds(_offset, _limit);
    }

    function _getStakingModuleNodeOperatorIsActive(IStakingModule _stakingModule, uint256 _nodeOperatorId)
        internal
        view
        returns (bool)
    {
        return _stakingModule.getNodeOperatorIsActive(_nodeOperatorId);
    }

    /// ---

    function _validateAndGetModuleState(uint256 _moduleId)
        internal
        view
        returns (ModuleState storage state, ModuleStateConfig storage stateConfig)
    {
        SRUtils._validateModuleId(_moduleId);
        state = _moduleId.getModuleState();
        stateConfig = state.getStateConfig();
    }

    function _initializeSTAS() internal {
        SRLib._initializeSTAS();
    }

    function _getModuleStateCompat(uint256 _moduleId) internal view returns (StakingModule memory moduleState) {
        moduleState.id = uint24(_moduleId);

        ModuleState storage state = _moduleId.getModuleState();
        moduleState.name = state.name;

        /// @dev use multiply SLOAD as this data readonly by offchain tools, so minimize bytecode size

        ModuleStateConfig storage stateConfig = state.getStateConfig();
        moduleState.stakingModuleAddress = stateConfig.moduleAddress;
        moduleState.stakingModuleFee = stateConfig.moduleFee;
        moduleState.treasuryFee = stateConfig.treasuryFee;
        moduleState.stakeShareLimit = stateConfig.depositTargetShare;
        moduleState.status = uint8(stateConfig.status);
        moduleState.priorityExitShareThreshold = stateConfig.withdrawalProtectShare;
        moduleState.moduleType = uint8(stateConfig.moduleType);
        moduleState.withdrawalCredentialsType = SRUtils._getModuleWCType(stateConfig.moduleType);

        ModuleStateDeposits storage stateDeposits = state.getStateDeposits();
        moduleState.lastDepositAt = stateDeposits.lastDepositAt;
        moduleState.lastDepositBlock = stateDeposits.lastDepositBlock;
        moduleState.maxDepositsPerBlock = stateDeposits.maxDepositsPerBlock;
        moduleState.minDepositBlockDistance = stateDeposits.minDepositBlockDistance;

        ModuleStateAccounting storage stateAccounting = state.getStateAccounting();
        moduleState.exitedValidatorsCount = stateAccounting.exitedValidatorsCount;
    }

    /// @dev Optimizes contract deployment size by wrapping the 'stakingModule.getStakingModuleSummary' function.
    function _getStakingModuleSummary(uint256 _moduleId)
        internal
        view
        returns (uint256 totalExitedValidators, uint256 totalDepositedValidators, uint256 depositableValidatorsCount)
    {
        return _moduleId.getIStakingModule().getStakingModuleSummary();
    }

    function _getStakingModuleSummaryStruct(uint256 _stakingModuleId)
        internal
        view
        returns (StakingModuleSummary memory summary)
    {
        (summary.totalExitedValidators, summary.totalDepositedValidators, summary.depositableValidatorsCount) =
            _getStakingModuleSummary(_stakingModuleId);
    }

    function _getNodeOperatorSummary(IStakingModule _stakingModule, uint256 _nodeOperatorId)
        internal
        view
        returns (NodeOperatorSummary memory summary)
    {
        (
            summary.targetLimitMode,
            summary.targetValidatorsCount,
            ,
            ,
            ,
            summary.totalExitedValidators,
            summary.totalDepositedValidators,
            summary.depositableValidatorsCount
        ) = _stakingModule.getNodeOperatorSummary(_nodeOperatorId);
    }

    function _getLido() internal view returns (address) {
        return SRStorage.getRouterStorage().lido;
    }

    function _getStakingModuleTrackerPosition(uint256 stakingModuleId) internal pure returns (bytes32) {
        // Mirrors mapping slot formula: keccak256(abi.encode(key, baseSlot))
        return keccak256(abi.encode(stakingModuleId, DEPOSITS_TRACKER));
    }

    // Helpers

    function _getCurrentSlot() internal view returns (uint256) {
        return (block.timestamp - GENESIS_TIME) / SECONDS_PER_SLOT;
    }
}
