// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {Math} from "@openzeppelin/contracts-v5.2/utils/math/Math.sol";
import {
    AccessControlEnumerableUpgradeable
} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {BeaconChainDepositor, IDepositContract} from "contracts/0.8.25/lib/BeaconChainDepositor.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {WithdrawalCredentials} from "contracts/common/lib/WithdrawalCredentials.sol";
import {IStakingModule} from "contracts/common/interfaces/IStakingModule.sol";
import {IStakingModuleV2} from "contracts/common/interfaces/IStakingModuleV2.sol";
import {SRLib} from "./SRLib.sol";
import {SRStorage} from "./SRStorage.sol";
import {SRUtils} from "./SRUtils.sol";

import {
    ModuleState,
    StakingModuleStatus,
    StakingModuleConfig,
    ValidatorsCountsCorrection,
    ValidatorExitData,
    StakingModule,
    StakingModuleSummary,
    NodeOperatorSummary,
    StakingModuleDigest,
    NodeOperatorDigest,
    ModuleStateConfig,
    ModuleStateDeposits,
    ModuleStateAccounting,
    ILido,
    IAccountingOracle
} from "./SRTypes.sol";

contract StakingRouter is AccessControlEnumerableUpgradeable {
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
    event WithdrawalCredentialsSet(bytes32 withdrawalCredentials, address setBy);

    /// Emitted when the StakingRouter received ETH
    event StakingRouterETHDeposited(uint256 indexed stakingModuleId, uint256 amount);

    event DepositableEthReceived(uint256 amount);

    uint256 public constant FEE_PRECISION_POINTS = 10 ** 20; // 100 * 10 ** 18

    uint64 internal constant PUBKEY_LENGTH = 48;
    uint64 internal constant MIN_DEPOSIT_IN_GWEI = 1 ether / 1 gwei;

    /// @dev ACL roles
    bytes32 public constant MANAGE_WITHDRAWAL_CREDENTIALS_ROLE = keccak256("MANAGE_WITHDRAWAL_CREDENTIALS_ROLE");
    bytes32 public constant STAKING_MODULE_MANAGE_ROLE = keccak256("STAKING_MODULE_MANAGE_ROLE");
    bytes32 public constant STAKING_MODULE_UNVETTING_ROLE = keccak256("STAKING_MODULE_UNVETTING_ROLE");
    bytes32 public constant REPORT_EXITED_VALIDATORS_ROLE = keccak256("REPORT_EXITED_VALIDATORS_ROLE");
    bytes32 public constant REPORT_VALIDATOR_EXITING_STATUS_ROLE = keccak256("REPORT_VALIDATOR_EXITING_STATUS_ROLE");
    bytes32 public constant REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE = keccak256("REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE");
    bytes32 public constant UNSAFE_SET_EXITED_VALIDATORS_ROLE = keccak256("UNSAFE_SET_EXITED_VALIDATORS_ROLE");
    bytes32 public constant REPORT_REWARDS_MINTED_ROLE = keccak256("REPORT_REWARDS_MINTED_ROLE");
    bytes32 public constant ACCOUNTING_REPORT_ROLE = keccak256("ACCOUNTING_REPORT_ROLE");

    /// Chain specification
    IDepositContract public immutable DEPOSIT_CONTRACT;
    ILido public immutable LIDO;
    ILidoLocator public immutable LIDO_LOCATOR;

    error CannotDeposit();
    error EmptyWithdrawalsCredentials();
    error DirectETHTransfer();
    error AppAuthDSMFailed();
    error ModuleReturnExceedTarget();
    error StakingModuleStatusTheSame();
    error LegacyStakingModuleRequired();
    error WrongArrayLength();
    error EmptyKeysList();
    error WrongPubkeysLength();
    error TopUpAmountTooLow();
    error AmountNotAlignedToGwei();
    error AllocationExceedsLimit();

    /// @dev compatibility getters for constants removed in favor of SRLib
    function INITIAL_DEPOSIT_SIZE() external pure returns (uint256) {
        return SRUtils.INITIAL_DEPOSIT_SIZE;
    }

    function TOTAL_BASIS_POINTS() external pure returns (uint256) {
        return SRUtils.TOTAL_BASIS_POINTS;
    }

    function MAX_STAKING_MODULES_COUNT() external pure returns (uint256) {
        return SRUtils.MAX_STAKING_MODULES_COUNT;
    }

    function MAX_STAKING_MODULE_NAME_LENGTH() external pure returns (uint256) {
        return SRUtils.MAX_STAKING_MODULE_NAME_LENGTH;
    }

    constructor(address _depositContract, address _lido, address _lidoLocator) {
        SRUtils._validateZeroAddress(_depositContract);
        SRUtils._validateZeroAddress(_lido);
        SRUtils._validateZeroAddress(_lidoLocator);

        DEPOSIT_CONTRACT = IDepositContract(_depositContract);
        LIDO = ILido(_lido);
        LIDO_LOCATOR = ILidoLocator(_lidoLocator);

        _disableInitializers();
    }

    /// @notice Initializes the contract.
    /// @param _admin Lido DAO Aragon agent contract address.
    /// @param _withdrawalCredentials 0x01 credentials to withdraw ETH on Consensus Layer side.
    /// @dev Proxy initialization method.
    function initialize(address _admin, bytes32 _withdrawalCredentials) external reinitializer(4) {
        SRUtils._validateZeroAddress(_admin);

        __AccessControlEnumerable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _setWithdrawalCredentials(_withdrawalCredentials);
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
    // function finalizeUpgrade_v3() external

    /// @notice A function to migrate upgrade to v4 (from v3) and use OpenZeppelin versioning.
    /// @param _admin Address to grant DEFAULT_ADMIN_ROLE
    /// @dev Old AccessControl roles (stored at keccak256("openzeppelin.AccessControl._roles") and
    ///      keccak256("openzeppelin.AccessControlEnumerable._roleMembers")) are inaccessible by the new code.
    ///      New OZ 5.2 AccessControl uses ERC-7201 namespaced storage at different slots.
    ///      All roles (STAKING_MODULE_MANAGE_ROLE, REPORT_EXITED_VALIDATORS_ROLE, etc.)
    ///      must be re-granted via grantRole() after this migration in the upgrade Vote Script.
    function migrateUpgrade_v4(address _admin) external reinitializer(4) {
        __AccessControlEnumerable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);

        // migrate current modules to new storage
        SRLib._migrateStorage();
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
        SRUtils._validateModuleId(_stakingModuleId);
        _stakingModuleId.getIStakingModule()
            .updateTargetValidatorsLimits(_nodeOperatorId, _targetLimitMode, _targetLimit);
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
        /// @dev validation of _stakingModuleId is done in _reportValidatorExitDelay
        return SRLib._updateExitedValidatorsCountByStakingModule(_stakingModuleIds, _exitedValidatorsCounts);
    }

    /// @dev The function is restricted to the same role as `updateExitedValidatorsCountByStakingModule`,
    /// i.e. `REPORT_EXITED_VALIDATORS_ROLE` role.
    function reportActiveBalancesByStakingModule(
        uint256[] calldata _stakingModuleIds,
        uint256[] calldata _activeBalancesGwei,
        uint256[] calldata _pendingBalancesGwei
    ) external onlyRole(REPORT_EXITED_VALIDATORS_ROLE) {
        SRLib._reportActiveBalancesByStakingModule(_stakingModuleIds, _activeBalancesGwei, _pendingBalancesGwei);
    }

    /// @dev See {SRLib._reportStakingModuleExitedValidatorsCountByNodeOperator}.
    ///
    /// @dev The function is restricted to the `REPORT_EXITED_VALIDATORS_ROLE` role.
    function reportStakingModuleExitedValidatorsCountByNodeOperator(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _exitedValidatorsCounts
    ) external onlyRole(REPORT_EXITED_VALIDATORS_ROLE) {
        /// @dev validation of _stakingModuleId is done inside
        SRLib._reportStakingModuleOperatorExitedValidators(_stakingModuleId, _nodeOperatorIds, _exitedValidatorsCounts);
    }

    /// @notice Reports operator balances for balance-based staking modules (v2 modules with 0x02 withdrawal credentials)
    /// @param _stakingModuleId The id of the staking module to be updated
    /// @param _nodeOperatorIds Ids of the node operators to be updated
    /// @param _totalBalancesGwei Total CL balances (active + pending) for the specified operators
    function reportStakingModuleOperatorBalances(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _totalBalancesGwei
    ) external onlyRole(REPORT_EXITED_VALIDATORS_ROLE) {
        SRLib._reportStakingModuleOperatorBalances(_stakingModuleId, _nodeOperatorIds, _totalBalancesGwei);
    }

    /// @dev DEPRECATED
    /// @dev See {SRLib._unsafeSetExitedValidatorsCount}.
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
        /// @dev validation of _stakingModuleId is done inside
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
        /// @dev validation of _stakingModuleId is done inside
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

    /// @notice Returns all registered staking modules.
    /// @return moduleStates Array of staking modules.
    function getStakingModules() external view returns (StakingModule[] memory) {
        uint256[] memory moduleIds = SRStorage.getModuleIds();
        StakingModule[] memory moduleStates = new StakingModule[](moduleIds.length);

        for (uint256 i; i < moduleIds.length; ++i) {
            moduleStates[i] = _getModuleStateCompat(moduleIds[i]);
        }
        return moduleStates;
    }

    /// @notice Returns state for staking modules.
    /// @param _stakingModuleId Id of the staking module.
    /// @return stateConfig staking modules config state
    function getStakingModuleStateConfig(uint256 _stakingModuleId)
        external
        view
        returns (ModuleStateConfig memory stateConfig)
    {
        (, stateConfig) = _getModuleState(_stakingModuleId);
    }

    function getStakingModuleStateDeposits(uint256 _stakingModuleId)
        external
        view
        returns (ModuleStateDeposits memory stateDeposits)
    {
        (ModuleState storage state,) = _getModuleState(_stakingModuleId);
        stateDeposits = state.deposits;
    }

    function getStakingModuleStateAccounting(uint256 _stakingModuleId)
        external
        view
        returns (uint64 activeBalanceGwei, uint64 pendingBalanceGwei, uint64 exitedValidatorsCount)
    {
        (ModuleState storage state,) = _getModuleState(_stakingModuleId);
        ModuleStateAccounting memory moduleAcc = state.accounting;
        return (moduleAcc.activeBalanceGwei, moduleAcc.pendingBalanceGwei, moduleAcc.exitedValidatorsCount);
    }

    /// @notice Returns the ids of all registered staking modules.
    /// @return stakingModuleIds Array of staking module ids.
    function getStakingModuleIds() external view returns (uint256[] memory) {
        return SRStorage.getModuleIds();
    }

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
    function hasStakingModule(uint256 _stakingModuleId) public view returns (bool) {
        return SRStorage.isModuleId(_stakingModuleId);
    }

    /// @notice Returns status of staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return Status of the staking module.
    function getStakingModuleStatus(uint256 _stakingModuleId) public view returns (StakingModuleStatus) {
        SRUtils._validateModuleId(_stakingModuleId);
        return _stakingModuleId.getModuleState().config.status;
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
        (ModuleState storage state,) = _getModuleState(_stakingModuleId);
        return state.deposits.lastDepositBlock;
    }

    /// @notice Returns the min deposit block distance for the staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return Min deposit block distance for the staking module.
    function getStakingModuleMinDepositBlockDistance(uint256 _stakingModuleId) external view returns (uint256) {
        (ModuleState storage state,) = _getModuleState(_stakingModuleId);
        return state.deposits.minDepositBlockDistance;
    }

    /// @notice Returns the max deposits count per block for the staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return Max deposits count per block for the staking module.
    function getStakingModuleMaxDepositsPerBlock(uint256 _stakingModuleId) external view returns (uint256) {
        return _getStakingModuleMaxDepositsPerBlock(_stakingModuleId);
    }

    /// @notice Returns active validators count for the staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return activeValidatorsCount Active validators count for the staking module.
    function getStakingModuleActiveValidatorsCount(uint256 _stakingModuleId)
        external
        view
        returns (uint256 activeValidatorsCount)
    {
        (ModuleState storage state,) = _getModuleState(_stakingModuleId);
        (uint256 totalExitedValidators, uint256 totalDepositedValidators,) = _getStakingModuleSummary(_stakingModuleId);

        activeValidatorsCount =
            totalDepositedValidators - Math.max(state.accounting.exitedValidatorsCount, totalExitedValidators);
    }

    /// @notice Returns withdrawal credentials type
    /// @param _stakingModuleId Id of the staking module to be deposited.
    /// @return withdrawal credentials: 0x01... - for Legacy modules, 0x02... - for New modules
    function getStakingModuleWithdrawalCredentials(uint256 _stakingModuleId) external view returns (bytes32) {
        (, ModuleStateConfig storage stateConfig) = _getModuleState(_stakingModuleId);
        return _getWithdrawalCredentialsWithType(stateConfig.withdrawalCredentialsType);
    }

    /// @notice Returns max effective balance for the staking module according WC type.
    /// @param _stakingModuleId Id of the staking module.
    /// @return Max effective balance for the staking module.
    function getStakingModuleMaxEB(uint256 _stakingModuleId) external view returns (uint256) {
        (, ModuleStateConfig storage stateConfig) = _getModuleState(_stakingModuleId);
        return SRUtils._getModuleMEB(stateConfig.withdrawalCredentialsType);
    }

    /// @notice Returns the max count of deposits which the staking module can provide data for based
    /// on the passed `_maxDepositsValue` amount.
    /// @param _stakingModuleId Id of the staking module to be deposited.
    /// @param _maxDepositsValue Max amount of ether that might be used for deposits count calculation.
    /// @return Max number of deposits might be done using the given staking module.
    function getStakingModuleMaxDepositsCount(uint256 _stakingModuleId, uint256 _maxDepositsValue)
        public
        view
        returns (uint256)
    {
        SRUtils._validateModuleId(_stakingModuleId);
        // If module is not active, then it capacity is 0, so stakingModuleDepositableEthAmount will be 0.
        // Module capacity is calculated based on the depositableValidatorsCount (from getStakingModuleSummary), so
        // stakingModuleDepositableEthAmount is already capped by the module capacity and represents the max ETH amount possible to deposit.
        return SRUtils._getInitialDepositCountByAmount(
            _getModuleDepositAllocation(_stakingModuleId, _maxDepositsValue, false)
        );
    }

    function canDeposit(uint256 _stakingModuleId) external view returns (bool) {
        return hasStakingModule(_stakingModuleId) && _canDeposit(_stakingModuleId);
    }

    // function _canDeposit(uint256 _stakingModuleId) internal view returns (bool) {
    //     return SRLib._canDeposit(_stakingModuleId, _getAccountingOracle());
    // }

    function _canDeposit(uint256 _moduleId) internal view returns (bool) {
        if (_moduleId.getModuleState().config.status == StakingModuleStatus.Active) {
            IAccountingOracle oracle = IAccountingOracle(_getAccountingOracle());
            (,,,,,, bool extraDataSubmitted,,) = oracle.getProcessingState();
            if (!extraDataSubmitted) {
                /// @dev allow deposits in case of initial deploy
                ///      this flow will not be triggered onchain in most cases, so
                ///      no worry about gas consumption on 2nd call
                uint256 lastProcessingRefSlot = oracle.getLastProcessingRefSlot();
                return lastProcessingRefSlot == 0;
            }
            return true;
        }
        return false;
    }

    /**
     * @notice A payable function for depositable eth acquisition. Can be called only by `Lido`
     */
    function receiveDepositableEther() external payable {
        SRUtils._validateAuth(address(LIDO));

        emit DepositableEthReceived(msg.value);
    }

    /// @notice Method performs top-up calls to the official Deposit contract. Determines how much Lido buffered ether can be deposited
    /// to the staking module, obtains keys from the staking module with exact allocation for each key, pulls ether from Lido,
    /// and performs the top-up call.
    /// @param _stakingModuleId Id of the staking module to be deposited.
    /// @param _keyIndices List of keys' indices
    /// @param _operatorIds List of operator indices
    /// @param _pubkeys List of validator public keys to top up
    /// @param _topUpLimits Maximum amount (in wei) that can be deposited per key based on CL data and TopUpGateway logic
    function topUp(
        uint256 _stakingModuleId,
        uint256[] calldata _keyIndices,
        uint256[] calldata _operatorIds,
        bytes[] calldata _pubkeys,
        uint256[] calldata _topUpLimits
    ) external {
        SRUtils._validateAuth(_getTopUpGateway());
        _validateTopUpInputs(_keyIndices, _operatorIds, _topUpLimits, _pubkeys);

        (, ModuleStateConfig storage stateConfig) = _getModuleState(_stakingModuleId);

        if (!_canDeposit(_stakingModuleId)) revert CannotDeposit();

        /// @dev This method is only supported for new modules (0x02 withdrawal credentials)
        SRUtils._validateWC0x02(stateConfig.withdrawalCredentialsType);

        // Get allocation based on target share
        uint256 depositableEther = LIDO.getDepositableEther();
        uint256 smDepositableEthAmount =
            _getModuleDepositAllocation(_stakingModuleId, depositableEther, true);

        // Call allocateDeposits on the staking module to determine for what amount deposit each key
        // The module verifies keys belong to it and reverts if invalid.
        // Even if smDepositableEthAmount is 0, we still call the module
        // to allow CSM queue cursor advancement.
        uint256[] memory allocations;
        uint256 smDepositableEthAmountRounded = smDepositableEthAmount - (smDepositableEthAmount % 1 gwei);
        allocations = IStakingModuleV2(stateConfig.moduleAddress)
            .allocateDeposits(smDepositableEthAmountRounded, _pubkeys, _keyIndices, _operatorIds, _topUpLimits);

        // Calculate total amount from allocations returned by module (in wei)
        uint256 amount;
        unchecked {
            for (uint256 i; i < allocations.length; ++i) {
                if (allocations[i] % 1 gwei != 0) {
                    revert AmountNotAlignedToGwei();
                }

                if (allocations[i] > _topUpLimits[i]) {
                    revert AllocationExceedsLimit();
                }

                amount += allocations[i];
            }
        }

        // Verify sum of allocations does not exceed module's max deposit amount
        if (amount > smDepositableEthAmountRounded) {
            revert ModuleReturnExceedTarget();
        }

        if (amount > 0) {
            uint256 etherBalanceBeforeDeposits = address(this).balance;
            // Pull ETH from Lido
            LIDO.withdrawDepositableEther(amount, 0);

            bytes32 withdrawalCredentials = _getWithdrawalCredentialsWithType(stateConfig.withdrawalCredentialsType);
            bytes memory wcBytes = abi.encodePacked(withdrawalCredentials);

            // Make beacon chain top-up deposits
            BeaconChainDepositor.makeBeaconChainTopUp(DEPOSIT_CONTRACT, wcBytes, _pubkeys, allocations);
            _updateModulePendingBalance(_stakingModuleId, amount);

            uint256 etherBalanceAfterDeposits = address(this).balance;

            /// @dev All pulled ETH must be deposited
            assert(etherBalanceBeforeDeposits == etherBalanceAfterDeposits);
        }
    }

    function _validateTopUpInputs(
        uint256[] calldata _keyIndices,
        uint256[] calldata _operatorIds,
        uint256[] calldata _topUpLimits,
        bytes[] calldata _pubkeys
    ) internal pure {
        uint256 n = _keyIndices.length;

        if (n == 0) {
            revert EmptyKeysList();
        }

        if (_operatorIds.length != n || _topUpLimits.length != n || _pubkeys.length != n) {
            revert WrongArrayLength();
        }

        for (uint256 i; i < n; ++i) {
            if (_pubkeys[i].length != PUBKEY_LENGTH) {
                revert WrongPubkeysLength();
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
        uint256 totalActiveBalance = SRUtils._getTotalModulesActiveBalance();

        uint256[] memory moduleIds = SRStorage.getModuleIds();
        uint256 stakingModulesCount = totalActiveBalance == 0 ? 0 : moduleIds.length;

        stakingModuleIds = new uint256[](stakingModulesCount);
        recipients = new address[](stakingModulesCount);
        stakingModuleFees = new uint96[](stakingModulesCount);
        precisionPoints = FEE_PRECISION_POINTS;

        /// @dev Return empty response if there are no staking modules or active validators yet.
        if (stakingModulesCount == 0) {
            return (recipients, stakingModuleIds, stakingModuleFees, totalFee, precisionPoints);
        }

        uint256 rewardedStakingModulesCount = 0;

        for (uint256 i; i < stakingModulesCount; ++i) {
            uint256 moduleId = moduleIds[i];
            uint256 allocation = SRUtils._getModuleActiveBalance(moduleId);

            /// @dev Skip staking modules which have no active balance.
            if (allocation == 0) continue;

            stakingModuleIds[rewardedStakingModulesCount] = moduleId;

            ModuleStateConfig memory stateConfig = moduleId.getModuleState().config;
            recipients[rewardedStakingModulesCount] = stateConfig.moduleAddress;

            (uint96 moduleFee, uint96 treasuryFee) = _computeModuleFee(allocation, totalActiveBalance, stateConfig);

            /// @dev If the staking module has the Stopped status for some reason, then
            ///      the staking module's rewards go to the treasury, so that the DAO has ability
            ///      to manage them (e.g. to compensate the staking module in case of an error, etc.)
            if (stateConfig.status != StakingModuleStatus.Stopped) {
                stakingModuleFees[rewardedStakingModulesCount] = moduleFee;
            }
            totalFee += treasuryFee + moduleFee;

            unchecked {
                ++rewardedStakingModulesCount;
            }
        }

        // Total fee never exceeds 100%.
        assert(totalFee <= precisionPoints);

        /// @dev Shrink arrays.
        if (rewardedStakingModulesCount < stakingModulesCount) {
            assembly ("memory-safe") {
                mstore(stakingModuleIds, rewardedStakingModulesCount)
                mstore(recipients, rewardedStakingModulesCount)
                mstore(stakingModuleFees, rewardedStakingModulesCount)
            }
        }

        return (recipients, stakingModuleIds, stakingModuleFees, totalFee, precisionPoints);
    }

    function getStakingModuleBalance(uint256 moduleId) external view returns (uint256) {
        SRUtils._validateModuleId(moduleId);
        return SRUtils._getModuleBalance(moduleId);
    }

    function getTotalStakingModulesBalance() external view returns (uint256) {
        return SRUtils._getTotalModulesBalance();
    }

    function _computeModuleFee(uint256 activeBalance, uint256 totalActiveBalance, ModuleStateConfig memory stateConfig)
        internal
        pure
        returns (uint96 moduleFee, uint96 treasuryFee)
    {
        // uint256 share = Math.mulDiv(moduleCache.activeBalance, FEE_PRECISION_POINTS, totalActiveBalance);
        // moduleFee = uint96(Math.mulDiv(share, moduleCache.moduleFee, TOTAL_BASIS_POINTS));
        // treasuryFee = uint96(Math.mulDiv(share, moduleCache.treasuryFee, TOTAL_BASIS_POINTS));
        uint256 share = activeBalance * FEE_PRECISION_POINTS / totalActiveBalance;
        moduleFee = uint96(share * stateConfig.moduleFee / SRUtils.TOTAL_BASIS_POINTS);
        treasuryFee = uint96(share * stateConfig.treasuryFee / SRUtils.TOTAL_BASIS_POINTS);
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

    /// @notice Returns new deposits allocation after the distribution of the `_depositAmount` deposits.
    /// @param _depositAmount The maximum ETH amount of deposits to be allocated.
    /// @return allocated Number of deposits allocated to the staking modules.
    /// @return allocations Array of new deposits allocation to the staking modules.
    function getDepositsAllocation(uint256 _depositAmount)
        external
        view
        returns (uint256 allocated, uint256[] memory allocations)
    {
        (allocated,, allocations) = SRLib._getDepositAllocations(_depositAmount, false);
    }

    function getTopUpAllocation(uint256 _depositAmount)
        external
        view
        returns (uint256 allocated, uint256[] memory allocations)
    {
        (allocated,, allocations) = SRLib._getDepositAllocations(_depositAmount, true);
    }

    /// @notice Invokes a deposit call to the official Deposit contract.
    /// @param _stakingModuleId Id of the staking module to be deposited.
    /// @param _depositCalldata Staking module calldata.
    /// @dev Only the DepositSecurityModule is allowed to call this method.
    function deposit(uint256 _stakingModuleId, bytes calldata _depositCalldata) external {
        SRUtils._validateAuth(_getDepositSecurityModule());
        (, ModuleStateConfig storage stateConfig) = _getModuleState(_stakingModuleId);

        if (!_canDeposit(_stakingModuleId)) revert CannotDeposit();

        bytes32 withdrawalCredentials = _getWithdrawalCredentialsWithType(stateConfig.withdrawalCredentialsType);
        address stakingModuleAddress = stateConfig.moduleAddress;

        // Get depositable ether from Lido (similar to topUp)
        uint256 depositableEther = LIDO.getDepositableEther();
        uint256 stakingModuleDepositableEthAmount =
            _getModuleDepositAllocation(_stakingModuleId, depositableEther, false);
        // Calculate max deposits count (capped by max and module capacity)
        (,, uint256 depositableValidatorsCount) = _getStakingModuleSummary(_stakingModuleId);
        uint256 _maxDepositsCount = _getStakingModuleMaxDepositsPerBlock(_stakingModuleId);
        uint256 maxDepositsCount = Math.min(
            Math.min(_maxDepositsCount, depositableValidatorsCount),
            SRUtils._getInitialDepositCountByAmount(stakingModuleDepositableEthAmount)
        );

        if (maxDepositsCount == 0) return;

        // Get deposit data from module first - it may return fewer keys than requested
        (bytes memory publicKeysBatch, bytes memory signaturesBatch) =
            IStakingModule(stakingModuleAddress).obtainDepositData(maxDepositsCount, _depositCalldata);

        // Calculate actual deposits count from returned keys
        if (publicKeysBatch.length % PUBKEY_LENGTH != 0) revert WrongPubkeysLength();
        uint256 actualDepositsCount = publicKeysBatch.length / PUBKEY_LENGTH;

        if (actualDepositsCount > maxDepositsCount) revert ModuleReturnExceedTarget();

        // Calculate actual deposit value based on keys returned
        uint256 depositsValue = SRUtils._getInitialDepositAmountByCount(actualDepositsCount);

        /// @dev Update the local state of the contract to prevent a reentrancy attack
        /// even though the staking modules are trusted contracts.
        _updateModuleLastDepositState(_stakingModuleId, depositsValue);

        if (actualDepositsCount == 0) return;

        // Pull ETH from Lido based on actual keys returned
        LIDO.withdrawDepositableEther(depositsValue, actualDepositsCount);

        uint256 etherBalanceBeforeDeposits = address(this).balance;

        BeaconChainDepositor.makeBeaconChainDeposits32ETH(
            DEPOSIT_CONTRACT,
            actualDepositsCount,
            abi.encodePacked(withdrawalCredentials),
            publicKeysBatch,
            signaturesBatch
        );

        _updateModulePendingBalance(_stakingModuleId, depositsValue);

        uint256 etherBalanceAfterDeposits = address(this).balance;

        /// @dev All pulled ETH must be deposited and self balance stay the same.
        assert(etherBalanceBeforeDeposits - etherBalanceAfterDeposits == depositsValue);
    }

    /// @notice Set 0x01 credentials to withdraw ETH on Consensus Layer side.
    /// @param _withdrawalCredentials 0x01 withdrawal credentials field as defined in the Consensus Layer specs.
    /// @dev Note that setWithdrawalCredentials discards all unused deposits data as the signatures are invalidated.
    /// @dev The function is restricted to the `MANAGE_WITHDRAWAL_CREDENTIALS_ROLE` role.
    function setWithdrawalCredentials(bytes32 _withdrawalCredentials)
        external
        onlyRole(MANAGE_WITHDRAWAL_CREDENTIALS_ROLE)
    {
        _setWithdrawalCredentials(_withdrawalCredentials);
    }

    /// @notice Returns current credentials to withdraw ETH on Consensus Layer side.
    /// @return Withdrawal credentials.
    function getWithdrawalCredentials() public view returns (bytes32) {
        return SRStorage.getRouterState().withdrawalCredentials;
    }

    function _getStakingModuleMaxDepositsPerBlock(uint256 _stakingModuleId) internal view returns (uint256) {
        (ModuleState storage state,) = _getModuleState(_stakingModuleId);
        return state.deposits.maxDepositsPerBlock;
    }

    function _setWithdrawalCredentials(bytes32 wc) internal {
        if (wc == 0) revert EmptyWithdrawalsCredentials();
        SRStorage.getRouterState().withdrawalCredentials = wc;
        SRLib._notifyStakingModulesOfWithdrawalCredentialsChange();
        emit WithdrawalCredentialsSet(wc, _msgSender());
    }

    function _getWithdrawalCredentialsWithType(uint8 withdrawalCredentialsType) internal view returns (bytes32) {
        bytes32 wc = getWithdrawalCredentials();
        // if (wc == 0) revert EmptyWithdrawalsCredentials();
        return wc.setType(withdrawalCredentialsType);
    }

    /// @dev Save the last deposit state for the staking module and emit the event
    /// @param stakingModuleId id of the staking module to be deposited
    /// @param depositsValue value to deposit
    function _updateModuleLastDepositState(uint256 stakingModuleId, uint256 depositsValue) internal {
        SRLib._updateModuleLastDepositState(stakingModuleId);
        emit StakingRouterETHDeposited(stakingModuleId, depositsValue);
    }

    function _updateModulePendingBalance(uint256 stakingModuleId, uint256 depositsValue) internal {
        SRLib._updateModulePendingBalance(stakingModuleId, depositsValue);
    }

    /// @notice Allocation for single module based on target share
    /// @param moduleId Id of staking module
    /// @param amountToAllocate Eth amount that can be deposited in module
    /// @param isTopUp Whether the allocation is for top-up deposits
    /// @return allocation Eth amount that can be deposited in module with id `moduleId` (can be less than `amountToAllocate`)
    function _getModuleDepositAllocation(uint256 moduleId, uint256 amountToAllocate, bool isTopUp)
        internal
        view
        returns (uint256 allocation)
    {
        return SRLib._getModuleDepositAllocation(moduleId, amountToAllocate, isTopUp);
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

    function _getModuleState(uint256 _moduleId)
        internal
        view
        returns (ModuleState storage state, ModuleStateConfig storage stateConfig)
    {
        SRUtils._validateModuleId(_moduleId);
        state = _moduleId.getModuleState();
        stateConfig = state.config;
    }

    function _getModuleStateCompat(uint256 _moduleId) internal view returns (StakingModule memory moduleState) {
        moduleState.id = uint24(_moduleId);

        ModuleState storage state = _moduleId.getModuleState();
        moduleState.name = state.name;

        /// @dev use multiply SLOAD as this data readonly by offchain tools, so minimize bytecode size

        ModuleStateConfig storage stateConfig = state.config;
        moduleState.stakingModuleAddress = stateConfig.moduleAddress;
        moduleState.stakingModuleFee = stateConfig.moduleFee;
        moduleState.treasuryFee = stateConfig.treasuryFee;
        moduleState.stakeShareLimit = stateConfig.depositTargetShare;
        moduleState.status = uint8(stateConfig.status);
        moduleState.priorityExitShareThreshold = stateConfig.withdrawalProtectShare;
        moduleState.withdrawalCredentialsType = stateConfig.withdrawalCredentialsType;

        ModuleStateDeposits storage stateDeposits = state.deposits;
        moduleState.lastDepositAt = stateDeposits.lastDepositAt;
        moduleState.lastDepositBlock = stateDeposits.lastDepositBlock;
        moduleState.maxDepositsPerBlock = stateDeposits.maxDepositsPerBlock;
        moduleState.minDepositBlockDistance = stateDeposits.minDepositBlockDistance;

        ModuleStateAccounting storage moduleAcc = state.accounting;
        moduleState.exitedValidatorsCount = moduleAcc.exitedValidatorsCount;
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
            summary.targetValidatorsCount,,,,
            summary.totalExitedValidators,
            summary.totalDepositedValidators,
            summary.depositableValidatorsCount
        ) = _stakingModule.getNodeOperatorSummary(_nodeOperatorId);
    }

    function _getAccountingOracle() internal view returns (address) {
        return LIDO_LOCATOR.accountingOracle();
    }

    function _getTopUpGateway() internal view returns (address) {
        return LIDO_LOCATOR.topUpGateway();
    }

    function _getDepositSecurityModule() internal view returns (address) {
        return LIDO_LOCATOR.depositSecurityModule();
    }
}
