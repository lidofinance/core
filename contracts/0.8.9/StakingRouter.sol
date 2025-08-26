// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

// import {MinFirstAllocationStrategy} from "contracts/common/lib/MinFirstAllocationStrategy.sol";
import {Math256} from "contracts/common/lib/Math256.sol";

import {
    AccessControlEnumerableUpgradeable
} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

import {IStakingModule} from "./interfaces/IStakingModule.sol";
import {IStakingModuleV2} from "./interfaces/IStakingModuleV2.sol";
import {BeaconChainDepositor, IDepositContract} from "./BeaconChainDepositor.sol";
import {DepositsTracker} from "contracts/common/lib/DepositsTracker.sol";
import {DepositsTempStorage} from "contracts/common/lib/DepositsTempStorage.sol";

contract StakingRouter is AccessControlEnumerableUpgradeable {
    /// @dev Events
    event StakingModuleAdded(uint256 indexed stakingModuleId, address stakingModule, string name, address createdBy);
    event StakingModuleShareLimitSet(
        uint256 indexed stakingModuleId,
        uint256 stakeShareLimit,
        uint256 priorityExitShareThreshold,
        address setBy
    );
    event StakingModuleFeesSet(
        uint256 indexed stakingModuleId,
        uint256 stakingModuleFee,
        uint256 treasuryFee,
        address setBy
    );
    event StakingModuleStatusSet(uint256 indexed stakingModuleId, StakingModuleStatus status, address setBy);
    event StakingModuleExitedValidatorsIncompleteReporting(
        uint256 indexed stakingModuleId,
        uint256 unreportedExitedValidatorsCount
    );
    event StakingModuleMaxDepositsPerBlockSet(
        uint256 indexed stakingModuleId,
        uint256 maxDepositsPerBlock,
        address setBy
    );
    event StakingModuleMinDepositBlockDistanceSet(
        uint256 indexed stakingModuleId,
        uint256 minDepositBlockDistance,
        address setBy
    );
    event WithdrawalCredentialsSet(bytes32 withdrawalCredentials, address setBy);
    event WithdrawalCredentials02Set(bytes32 withdrawalCredentials02, address setBy);
    event WithdrawalsCredentialsChangeFailed(uint256 indexed stakingModuleId, bytes lowLevelRevertData);
    event ExitedAndStuckValidatorsCountsUpdateFailed(uint256 indexed stakingModuleId, bytes lowLevelRevertData);
    event RewardsMintedReportFailed(uint256 indexed stakingModuleId, bytes lowLevelRevertData);

    /// Emitted when the StakingRouter received ETH
    event StakingRouterETHDeposited(uint256 indexed stakingModuleId, uint256 amount);

    event StakingModuleExitNotificationFailed(
        uint256 indexed stakingModuleId,
        uint256 indexed nodeOperatorId,
        bytes _publicKey
    );

    /// @dev Errors
    error ZeroAddressLido();
    error ZeroAddressAdmin();
    error ZeroAddressStakingModule();
    error InvalidStakeShareLimit();
    error InvalidFeeSum();
    error StakingModuleNotActive();
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
        uint256 currentNodeOpExitedValidatorsCount
    );
    error UnexpectedFinalExitedValidatorsCount(
        uint256 newModuleTotalExitedValidatorsCount,
        uint256 newModuleTotalExitedValidatorsCountInStakingRouter
    );
    error InvalidDepositsValue(uint256 etherValue, uint256 depositsCount);
    error StakingModuleAddressExists();
    error ArraysLengthMismatch(uint256 firstArrayLength, uint256 secondArrayLength);
    error UnrecoverableModuleError();
    error InvalidPriorityExitShareThreshold();
    error InvalidMinDepositBlockDistance();
    error InvalidMaxDepositPerBlockValue();
    error WrongWithdrawalCredentialsType();
    error InvalidChainConfig();
    error AllocationExceedsTarget();
    error DepositContractZeroAddress();
    error DepositValueNotMultipleOfInitialDeposit();

    enum StakingModuleStatus {
        Active, // deposits and rewards allowed
        DepositsPaused, // deposits NOT allowed, rewards allowed
        Stopped // deposits and rewards NOT allowed
    }

    /// @notice Configuration parameters for a staking module.
    /// @dev Used when adding or updating a staking module to set operational limits, fee parameters,
    ///      and withdrawal credential type.
    struct StakingModuleConfig {
        /// @notice Maximum stake share that can be allocated to a module, in BP.
        /// @dev Must be less than or equal to TOTAL_BASIS_POINTS (10_000 BP = 100%).
        uint256 stakeShareLimit;
        /// @notice Module's share threshold, upon crossing which, exits of validators from the module will be prioritized, in BP.
        /// @dev Must be less than or equal to TOTAL_BASIS_POINTS (10_000 BP = 100%) and
        ///      greater than or equal to `stakeShareLimit`.
        uint256 priorityExitShareThreshold;
        /// @notice Part of the fee taken from staking rewards that goes to the staking module, in BP.
        /// @dev Together with `treasuryFee`, must not exceed TOTAL_BASIS_POINTS.
        uint256 stakingModuleFee;
        /// @notice Part of the fee taken from staking rewards that goes to the treasury, in BP.
        /// @dev Together with `stakingModuleFee`, must not exceed TOTAL_BASIS_POINTS.
        uint256 treasuryFee;
        /// @notice The maximum number of validators that can be deposited in a single block.
        /// @dev Must be harmonized with `OracleReportSanityChecker.appearedValidatorsPerDayLimit`.
        ///      Value must not exceed type(uint64).max.
        uint256 maxDepositsPerBlock;
        /// @notice The minimum distance between deposits in blocks.
        /// @dev Must be harmonized with `OracleReportSanityChecker.appearedValidatorsPerDayLimit`.
        ///      Value must be > 0 and ≤ type(uint64).max.
        uint256 minDepositBlockDistance;
        /// @notice The type of withdrawal credentials for creation of validators.
        /// @dev 1 = 0x01 withdrawals, 2 = 0x02 withdrawals.
        uint256 withdrawalCredentialsType;
    }

    struct StakingModule {
        /// @notice Unique id of the staking module.
        uint24 id;
        /// @notice Address of the staking module.
        address stakingModuleAddress;
        /// @notice Part of the fee taken from staking rewards that goes to the staking module.
        uint16 stakingModuleFee;
        /// @notice Part of the fee taken from staking rewards that goes to the treasury.
        uint16 treasuryFee;
        /// @notice Maximum stake share that can be allocated to a module, in BP.
        /// @dev Formerly known as `targetShare`.
        uint16 stakeShareLimit;
        /// @notice Staking module status if staking module can not accept the deposits or can
        /// participate in further reward distribution.
        uint8 status;
        /// @notice Name of the staking module.
        string name;
        /// @notice block.timestamp of the last deposit of the staking module.
        /// @dev NB: lastDepositAt gets updated even if the deposit value was 0 and no actual deposit happened.
        uint64 lastDepositAt;
        /// @notice block.number of the last deposit of the staking module.
        /// @dev NB: lastDepositBlock gets updated even if the deposit value was 0 and no actual deposit happened.
        uint256 lastDepositBlock;
        /// @notice Number of exited validators.
        uint256 exitedValidatorsCount;
        /// @notice Module's share threshold, upon crossing which, exits of validators from the module will be prioritized, in BP.
        uint16 priorityExitShareThreshold;
        /// @notice The maximum number of validators that can be deposited in a single block.
        /// @dev Must be harmonized with `OracleReportSanityChecker.appearedValidatorsPerDayLimit`.
        /// See docs for the `OracleReportSanityChecker.setAppearedValidatorsPerDayLimit` function.
        uint64 maxDepositsPerBlock;
        /// @notice The minimum distance between deposits in blocks.
        /// @dev Must be harmonized with `OracleReportSanityChecker.appearedValidatorsPerDayLimit`.
        /// See docs for the `OracleReportSanityChecker.setAppearedValidatorsPerDayLimit` function).
        uint64 minDepositBlockDistance;
        /// @notice The type of withdrawal credentials for creation of validators
        // TODO: use some enum type?
        uint8 withdrawalCredentialsType;
    }

    struct StakingModuleCache {
        address stakingModuleAddress;
        uint24 stakingModuleId;
        uint16 stakingModuleFee;
        uint16 treasuryFee;
        uint16 stakeShareLimit;
        StakingModuleStatus status;
        uint256 activeValidatorsCount;
        uint256 availableValidatorsCount;
    }

    struct ValidatorExitData {
        uint256 stakingModuleId;
        uint256 nodeOperatorId;
        bytes pubkey;
    }
    struct RouterStorage {
        bytes32 withdrawalCredentials;
        bytes32 withdrawalCredentials02;
        address lido;
        uint16 lastStakingModuleId;
        uint16 stakingModulesCount;
    }

    bytes32 public constant MANAGE_WITHDRAWAL_CREDENTIALS_ROLE = keccak256("MANAGE_WITHDRAWAL_CREDENTIALS_ROLE");
    bytes32 public constant STAKING_MODULE_MANAGE_ROLE = keccak256("STAKING_MODULE_MANAGE_ROLE");
    bytes32 public constant STAKING_MODULE_UNVETTING_ROLE = keccak256("STAKING_MODULE_UNVETTING_ROLE");
    bytes32 public constant REPORT_EXITED_VALIDATORS_ROLE = keccak256("REPORT_EXITED_VALIDATORS_ROLE");
    bytes32 public constant REPORT_VALIDATOR_EXITING_STATUS_ROLE = keccak256("REPORT_VALIDATOR_EXITING_STATUS_ROLE");
    bytes32 public constant REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE = keccak256("REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE");
    bytes32 public constant UNSAFE_SET_EXITED_VALIDATORS_ROLE = keccak256("UNSAFE_SET_EXITED_VALIDATORS_ROLE");
    bytes32 public constant REPORT_REWARDS_MINTED_ROLE = keccak256("REPORT_REWARDS_MINTED_ROLE");

    // [DEPRECATED] This code was removed from the contract and replaced with ROUTER_STORAGE_POSITION, but slots can still contain data.
    // bytes32 internal constant LIDO_POSITION = keccak256("lido.StakingRouter.lido");
    // /// @dev Credentials to withdraw ETH on Consensus Layer side.
    // bytes32 internal constant WITHDRAWAL_CREDENTIALS_POSITION = keccak256("lido.StakingRouter.withdrawalCredentials");
    // /// @dev 0x02 credentials to withdraw ETH on Consensus Layer side.
    // bytes32 internal constant WITHDRAWAL_CREDENTIALS_02_POSITION =
    //     keccak256("lido.StakingRouter.withdrawalCredentials02");
    // /// @dev Total count of staking modules.
    // bytes32 internal constant STAKING_MODULES_COUNT_POSITION = keccak256("lido.StakingRouter.stakingModulesCount");
    // /// @dev Id of the last added staking module. This counter grow on staking modules adding.
    // bytes32 internal constant LAST_STAKING_MODULE_ID_POSITION = keccak256("lido.StakingRouter.lastStakingModuleId");
    /// @dev Mapping is used instead of array to allow to extend the StakingModule.
    bytes32 internal constant ROUTER_STORAGE_POSITION = keccak256("lido.StakingRouterStorage");

    bytes32 internal constant STAKING_MODULES_MAPPING_POSITION = keccak256("lido.StakingRouter.stakingModules");
    /// @dev Position of the staking modules in the `_stakingModules` map, plus 1 because
    /// index 0 means a value is not in the set.
    bytes32 internal constant STAKING_MODULE_INDICES_MAPPING_POSITION =
        keccak256("lido.StakingRouter.stakingModuleIndicesOneBased");
    /// @dev Module trackers will be derived from this position
    bytes32 internal constant DEPOSITS_TRACKER = keccak256("lido.StakingRouter.depositTracker");

    /// Chain specification
    uint64 internal immutable SECONDS_PER_SLOT;
    uint64 internal immutable GENESIS_TIME;

    uint256 public constant FEE_PRECISION_POINTS = 10 ** 20; // 100 * 10 ** 18
    uint256 public constant TOTAL_BASIS_POINTS = 10000;
    uint256 public constant MAX_STAKING_MODULES_COUNT = 32;
    /// @dev Restrict the name size with 31 bytes to storage in a single slot.
    uint256 public constant MAX_STAKING_MODULE_NAME_LENGTH = 31;

    /// @notice Type identifier for modules that support only 0x01 deposits
    uint256 public constant LEGACY_WITHDRAWAL_CREDENTIALS_TYPE = 1;

    /// @notice Type identifier for modules that support only 0x02 deposits
    /// @dev For simplicity, only one deposit type is allowed per module.
    uint256 public constant NEW_WITHDRAWAL_CREDENTIALS_TYPE = 2;

    /// @notice Initial deposit amount made for validator creation
    /// @dev Identical for both 0x01 and 0x02 types.
    /// For 0x02, the validator may later be topped up.
    /// Top-ups are not supported for 0x01.
    uint256 internal constant INITIAL_DEPOSIT_SIZE = 32 ether;

    uint256 internal constant DEPOSIT_SIZE = 32 ether;
    uint256 internal constant DEPOSIT_SIZE_02 = 2048 ether;

    IDepositContract public immutable DEPOSIT_CONTRACT;

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
    function initialize(
        address _admin,
        address _lido,
        bytes32 _withdrawalCredentials,
        bytes32 _withdrawalCredentials02
    ) external reinitializer(4) {
        if (_admin == address(0)) revert ZeroAddressAdmin();
        if (_lido == address(0)) revert ZeroAddressLido();

        __AccessControlEnumerable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);

        RouterStorage storage rs = _getRouterStorage();
        rs.lido = _lido;
        rs.withdrawalCredentials = _withdrawalCredentials;
        rs.withdrawalCredentials02 = _withdrawalCredentials02;

        emit WithdrawalCredentialsSet(_withdrawalCredentials, msg.sender);
        emit WithdrawalCredentials02Set(_withdrawalCredentials02, msg.sender);
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
    /// @param _withdrawalCredentials02 0x02 Credentials to withdraw ETH on Consensus Layer side
    function migrateUpgrade_v4(
        address _lido,
        bytes32 _withdrawalCredentials,
        bytes32 _withdrawalCredentials02
    ) external reinitializer(4) {
        // TODO: here is problem, that last version of
        __AccessControlEnumerable_init();

        RouterStorage storage rs = _getRouterStorage();
        rs.lido = _lido;
        rs.withdrawalCredentials = _withdrawalCredentials;
        rs.withdrawalCredentials02 = _withdrawalCredentials02;

        emit WithdrawalCredentialsSet(_withdrawalCredentials, msg.sender);
        emit WithdrawalCredentials02Set(_withdrawalCredentials02, msg.sender);

        // TODO: migrate deposits values
    }

    /// @notice Returns Lido contract address.
    /// @return Lido contract address.
    function getLido() public view returns (address) {
        return _getRouterStorage().lido;
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
        if (_stakingModuleAddress == address(0)) revert ZeroAddressStakingModule();
        if (bytes(_name).length == 0 || bytes(_name).length > MAX_STAKING_MODULE_NAME_LENGTH)
            revert StakingModuleWrongName();

        uint256 newStakingModuleIndex = getStakingModulesCount();

        if (newStakingModuleIndex >= MAX_STAKING_MODULES_COUNT) revert StakingModulesLimitExceeded();

        for (uint256 i; i < newStakingModuleIndex; ) {
            if (_stakingModuleAddress == _getStakingModuleByIndex(i).stakingModuleAddress)
                revert StakingModuleAddressExists();

            unchecked {
                ++i;
            }
        }

        StakingModule storage newStakingModule = _getStakingModuleByIndex(newStakingModuleIndex);
        uint24 newStakingModuleId = uint24(_getRouterStorage().lastStakingModuleId) + 1;

        newStakingModule.id = newStakingModuleId;
        newStakingModule.name = _name;
        newStakingModule.stakingModuleAddress = _stakingModuleAddress;
        /// @dev Since `enum` is `uint8` by nature, so the `status` is stored as `uint8` to avoid
        ///      possible problems when upgrading. But for human readability, we use `enum` as
        ///      function parameter type. More about conversion in the docs:
        ///      https://docs.soliditylang.org/en/v0.8.17/types.html#enums
        newStakingModule.status = uint8(StakingModuleStatus.Active);

        /// @dev Simulate zero value deposit to prevent real deposits into the new StakingModule via
        ///      DepositSecurityModule just after the addition.
        _updateModuleLastDepositState(newStakingModule, newStakingModuleId, 0);

        _setStakingModuleIndexById(newStakingModuleId, newStakingModuleIndex);

        RouterStorage storage rs = _getRouterStorage();

        rs.lastStakingModuleId = uint16(newStakingModuleId);
        rs.stakingModulesCount = uint16(newStakingModuleIndex + 1);

        emit StakingModuleAdded(newStakingModuleId, _stakingModuleAddress, _name, msg.sender);

        _updateStakingModule(
            newStakingModule,
            newStakingModuleId,
            _stakingModuleConfig.stakeShareLimit,
            _stakingModuleConfig.priorityExitShareThreshold,
            _stakingModuleConfig.stakingModuleFee,
            _stakingModuleConfig.treasuryFee,
            _stakingModuleConfig.maxDepositsPerBlock,
            _stakingModuleConfig.minDepositBlockDistance,
            _stakingModuleConfig.withdrawalCredentialsType
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
        uint256 _minDepositBlockDistance,
        uint256 _withdrawalCredentialsType
    ) external onlyRole(STAKING_MODULE_MANAGE_ROLE) {
        StakingModule storage stakingModule = _getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId));
        _updateStakingModule(
            stakingModule,
            _stakingModuleId,
            _stakeShareLimit,
            _priorityExitShareThreshold,
            _stakingModuleFee,
            _treasuryFee,
            _maxDepositsPerBlock,
            _minDepositBlockDistance,
            _withdrawalCredentialsType
        );
    }

    function _updateStakingModule(
        StakingModule storage stakingModule,
        uint256 _stakingModuleId,
        uint256 _stakeShareLimit,
        uint256 _priorityExitShareThreshold,
        uint256 _stakingModuleFee,
        uint256 _treasuryFee,
        uint256 _maxDepositsPerBlock,
        uint256 _minDepositBlockDistance,
        uint256 _withdrawalCredentialsType
    ) internal {
        if (_stakeShareLimit > TOTAL_BASIS_POINTS) revert InvalidStakeShareLimit();
        if (_priorityExitShareThreshold > TOTAL_BASIS_POINTS) revert InvalidPriorityExitShareThreshold();
        if (_stakeShareLimit > _priorityExitShareThreshold) revert InvalidPriorityExitShareThreshold();
        if (_stakingModuleFee + _treasuryFee > TOTAL_BASIS_POINTS) revert InvalidFeeSum();
        if (_minDepositBlockDistance == 0 || _minDepositBlockDistance > type(uint64).max) {
            revert InvalidMinDepositBlockDistance();
        }
        if (_maxDepositsPerBlock > type(uint64).max) revert InvalidMaxDepositPerBlockValue();

        stakingModule.stakeShareLimit = uint16(_stakeShareLimit);
        stakingModule.priorityExitShareThreshold = uint16(_priorityExitShareThreshold);
        stakingModule.treasuryFee = uint16(_treasuryFee);
        stakingModule.stakingModuleFee = uint16(_stakingModuleFee);
        stakingModule.maxDepositsPerBlock = uint64(_maxDepositsPerBlock);
        stakingModule.minDepositBlockDistance = uint64(_minDepositBlockDistance);
        // TODO: add check on type
        stakingModule.withdrawalCredentialsType = uint8(_withdrawalCredentialsType);

        emit StakingModuleShareLimitSet(_stakingModuleId, _stakeShareLimit, _priorityExitShareThreshold, msg.sender);
        emit StakingModuleFeesSet(_stakingModuleId, _stakingModuleFee, _treasuryFee, msg.sender);
        emit StakingModuleMaxDepositsPerBlockSet(_stakingModuleId, _maxDepositsPerBlock, msg.sender);
        emit StakingModuleMinDepositBlockDistanceSet(_stakingModuleId, _minDepositBlockDistance, msg.sender);
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
        _getIStakingModuleById(_stakingModuleId).updateTargetValidatorsLimits(
            _nodeOperatorId,
            _targetLimitMode,
            _targetLimit
        );
    }

    /// @notice Reports the minted rewards to the staking modules with the specified ids.
    /// @param _stakingModuleIds Ids of the staking modules.
    /// @param _totalShares Total shares minted for the staking modules.
    /// @dev The function is restricted to the `REPORT_REWARDS_MINTED_ROLE` role.
    function reportRewardsMinted(
        uint256[] calldata _stakingModuleIds,
        uint256[] calldata _totalShares
    ) external onlyRole(REPORT_REWARDS_MINTED_ROLE) {
        _validateEqualArrayLengths(_stakingModuleIds.length, _totalShares.length);

        for (uint256 i = 0; i < _stakingModuleIds.length; ) {
            if (_totalShares[i] > 0) {
                try _getIStakingModuleById(_stakingModuleIds[i]).onRewardsMinted(_totalShares[i]) {} catch (
                    bytes memory lowLevelRevertData
                ) {
                    /// @dev This check is required to prevent incorrect gas estimation of the method.
                    ///      Without it, Ethereum nodes that use binary search for gas estimation may
                    ///      return an invalid value when the onRewardsMinted() reverts because of the
                    ///      "out of gas" error. Here we assume that the onRewardsMinted() method doesn't
                    ///      have reverts with empty error data except "out of gas".
                    if (lowLevelRevertData.length == 0) revert UnrecoverableModuleError();
                    emit RewardsMintedReportFailed(_stakingModuleIds[i], lowLevelRevertData);
                }
            }

            unchecked {
                ++i;
            }
        }
    }

    /// @notice Updates total numbers of exited validators for staking modules with the specified module ids.
    /// @param _stakingModuleIds Ids of the staking modules to be updated.
    /// @param _exitedValidatorsCounts New counts of exited validators for the specified staking modules.
    /// @return The total increase in the aggregate number of exited validators across all updated modules.
    ///
    /// @dev The total numbers are stored in the staking router and can differ from the totals obtained by calling
    /// `IStakingModule.getStakingModuleSummary()`. The overall process of updating validator counts is the following:
    ///
    /// 1. In the first data submission phase, the oracle calls `updateExitedValidatorsCountByStakingModule` on the
    ///    staking router, passing the totals by module. The staking router stores these totals and uses them to
    ///    distribute new stake and staking fees between the modules. There can only be single call of this function
    ///    per oracle reporting frame.
    ///
    /// 2. In the second part of the second data submission phase, the oracle calls
    ///    `StakingRouter.reportStakingModuleExitedValidatorsCountByNodeOperator` on the staking router which passes
    ///    the counts by node operator to the staking module by calling `IStakingModule.updateExitedValidatorsCount`.
    ///    This can be done multiple times for the same module, passing data for different subsets of node
    ///    operators.
    ///
    /// 3. At the end of the second data submission phase, it's expected for the aggregate exited validators count
    ///    across all module's node operators (stored in the module) to match the total count for this module
    ///    (stored in the staking router). However, it might happen that the second phase of data submission doesn't
    ///    finish until the new oracle reporting frame is started, in which case staking router will emit a warning
    ///    event `StakingModuleExitedValidatorsIncompleteReporting` when the first data submission phase is performed
    ///    for a new reporting frame. This condition will result in the staking module having an incomplete data about
    ///    the exited validator counts during the whole reporting frame. Handling this condition is
    ///    the responsibility of each staking module.
    ///
    /// 4. When the second reporting phase is finished, i.e. when the oracle submitted the complete data on the exited
    ///    validator counts per node operator for the current reporting frame, the oracle calls
    ///    `StakingRouter.onValidatorsCountsByNodeOperatorReportingFinished` which, in turn, calls
    ///    `IStakingModule.onExitedAndStuckValidatorsCountsUpdated` on all modules.
    ///
    /// @dev The function is restricted to the `REPORT_EXITED_VALIDATORS_ROLE` role.
    function updateExitedValidatorsCountByStakingModule(
        uint256[] calldata _stakingModuleIds,
        uint256[] calldata _exitedValidatorsCounts
    ) external onlyRole(REPORT_EXITED_VALIDATORS_ROLE) returns (uint256) {
        _validateEqualArrayLengths(_stakingModuleIds.length, _exitedValidatorsCounts.length);

        uint256 newlyExitedValidatorsCount;

        for (uint256 i = 0; i < _stakingModuleIds.length; ) {
            uint256 stakingModuleId = _stakingModuleIds[i];
            StakingModule storage stakingModule = _getStakingModuleByIndex(_getStakingModuleIndexById(stakingModuleId));

            uint256 prevReportedExitedValidatorsCount = stakingModule.exitedValidatorsCount;
            if (_exitedValidatorsCounts[i] < prevReportedExitedValidatorsCount) {
                revert ExitedValidatorsCountCannotDecrease();
            }

            (
                uint256 totalExitedValidators,
                uint256 totalDepositedValidators,

            ) = /* uint256 depositableValidatorsCount */ _getStakingModuleSummary(
                    IStakingModule(stakingModule.stakingModuleAddress)
                );

            if (_exitedValidatorsCounts[i] > totalDepositedValidators) {
                revert ReportedExitedValidatorsExceedDeposited(_exitedValidatorsCounts[i], totalDepositedValidators);
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

            unchecked {
                ++i;
            }
        }

        return newlyExitedValidatorsCount;
    }

    /// @notice Updates exited validators counts per node operator for the staking module with
    /// the specified id. See the docs for `updateExitedValidatorsCountByStakingModule` for the
    /// description of the overall update process.
    ///
    /// @param _stakingModuleId The id of the staking modules to be updated.
    /// @param _nodeOperatorIds Ids of the node operators to be updated.
    /// @param _exitedValidatorsCounts New counts of exited validators for the specified node operators.
    ///
    /// @dev The function is restricted to the `REPORT_EXITED_VALIDATORS_ROLE` role.
    function reportStakingModuleExitedValidatorsCountByNodeOperator(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _exitedValidatorsCounts
    ) external onlyRole(REPORT_EXITED_VALIDATORS_ROLE) {
        _checkValidatorsByNodeOperatorReportData(_nodeOperatorIds, _exitedValidatorsCounts);
        _getIStakingModuleById(_stakingModuleId).updateExitedValidatorsCount(_nodeOperatorIds, _exitedValidatorsCounts);
    }

    struct ValidatorsCountsCorrection {
        /// @notice The expected current number of exited validators of the module that is
        /// being corrected.
        uint256 currentModuleExitedValidatorsCount;
        /// @notice The expected current number of exited validators of the node operator
        /// that is being corrected.
        uint256 currentNodeOperatorExitedValidatorsCount;
        /// @notice The corrected number of exited validators of the module.
        uint256 newModuleExitedValidatorsCount;
        /// @notice The corrected number of exited validators of the node operator.
        uint256 newNodeOperatorExitedValidatorsCount;
    }

    /// @notice Sets exited validators count for the given module and given node operator in that module
    /// without performing critical safety checks, e.g. that exited validators count cannot decrease.
    ///
    /// Should only be used by the DAO in extreme cases and with sufficient precautions to correct invalid
    /// data reported by the oracle committee due to a bug in the oracle daemon.
    ///
    /// @param _stakingModuleId Id of the staking module.
    /// @param _nodeOperatorId Id of the node operator.
    /// @param _triggerUpdateFinish Whether to call `onExitedAndStuckValidatorsCountsUpdated` on the module
    /// after applying the corrections.
    /// @param _correction See the docs for the `ValidatorsCountsCorrection` struct.
    ///
    /// @dev Reverts if the current numbers of exited validators of the module and node operator
    /// don't match the supplied expected current values.
    ///
    /// @dev The function is restricted to the `UNSAFE_SET_EXITED_VALIDATORS_ROLE` role.
    function unsafeSetExitedValidatorsCount(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        bool _triggerUpdateFinish,
        ValidatorsCountsCorrection memory _correction
    ) external onlyRole(UNSAFE_SET_EXITED_VALIDATORS_ROLE) {
        StakingModule storage stakingModuleState = _getStakingModuleByIndex(
            _getStakingModuleIndexById(_stakingModuleId)
        );
        IStakingModule stakingModule = IStakingModule(stakingModuleState.stakingModuleAddress);

        (
            ,
            ,
            ,
            ,
            ,
            /* uint256 targetLimitMode */ /* uint256 targetValidatorsCount */ /* uint256 stuckValidatorsCount, */ /* uint256 refundedValidatorsCount */ /* uint256 stuckPenaltyEndTimestamp */ uint256 totalExitedValidators,
            ,

        ) = /* uint256 totalDepositedValidators */ /* uint256 depositableValidatorsCount */ stakingModule
                .getNodeOperatorSummary(_nodeOperatorId);

        if (
            _correction.currentModuleExitedValidatorsCount != stakingModuleState.exitedValidatorsCount ||
            _correction.currentNodeOperatorExitedValidatorsCount != totalExitedValidators
        ) {
            revert UnexpectedCurrentValidatorsCount(stakingModuleState.exitedValidatorsCount, totalExitedValidators);
        }

        stakingModuleState.exitedValidatorsCount = _correction.newModuleExitedValidatorsCount;

        stakingModule.unsafeUpdateValidatorsCount(_nodeOperatorId, _correction.newNodeOperatorExitedValidatorsCount);

        (uint256 moduleTotalExitedValidators, uint256 moduleTotalDepositedValidators, ) = _getStakingModuleSummary(
            stakingModule
        );

        if (_correction.newModuleExitedValidatorsCount > moduleTotalDepositedValidators) {
            revert ReportedExitedValidatorsExceedDeposited(
                _correction.newModuleExitedValidatorsCount,
                moduleTotalDepositedValidators
            );
        }

        if (_triggerUpdateFinish) {
            if (moduleTotalExitedValidators != _correction.newModuleExitedValidatorsCount) {
                revert UnexpectedFinalExitedValidatorsCount(
                    moduleTotalExitedValidators,
                    _correction.newModuleExitedValidatorsCount
                );
            }

            stakingModule.onExitedAndStuckValidatorsCountsUpdated();
        }
    }

    /// @notice Finalizes the reporting of the exited validators counts for the current
    /// reporting frame.
    ///
    /// @dev Called by the oracle when the second phase of data reporting finishes, i.e. when the
    /// oracle submitted the complete data on the exited validator counts per node operator
    /// for the current reporting frame. See the docs for `updateExitedValidatorsCountByStakingModule`
    /// for the description of the overall update process.
    ///
    /// @dev The function is restricted to the `REPORT_EXITED_VALIDATORS_ROLE` role.
    function onValidatorsCountsByNodeOperatorReportingFinished() external onlyRole(REPORT_EXITED_VALIDATORS_ROLE) {
        uint256 stakingModulesCount = getStakingModulesCount();
        StakingModule storage stakingModule;
        IStakingModule moduleContract;

        for (uint256 i; i < stakingModulesCount; ) {
            stakingModule = _getStakingModuleByIndex(i);
            moduleContract = IStakingModule(stakingModule.stakingModuleAddress);

            (uint256 exitedValidatorsCount, , ) = _getStakingModuleSummary(moduleContract);
            if (exitedValidatorsCount == stakingModule.exitedValidatorsCount) {
                // oracle finished updating exited validators for all node ops
                try moduleContract.onExitedAndStuckValidatorsCountsUpdated() {} catch (
                    bytes memory lowLevelRevertData
                ) {
                    /// @dev This check is required to prevent incorrect gas estimation of the method.
                    ///      Without it, Ethereum nodes that use binary search for gas estimation may
                    ///      return an invalid value when the onExitedAndStuckValidatorsCountsUpdated()
                    ///      reverts because of the "out of gas" error. Here we assume that the
                    ///      onExitedAndStuckValidatorsCountsUpdated() method doesn't have reverts with
                    ///      empty error data except "out of gas".
                    if (lowLevelRevertData.length == 0) revert UnrecoverableModuleError();
                    emit ExitedAndStuckValidatorsCountsUpdateFailed(stakingModule.id, lowLevelRevertData);
                }
            }

            unchecked {
                ++i;
            }
        }
    }

    /// @notice Decreases vetted signing keys counts per node operator for the staking module with
    /// the specified id.
    /// @param _stakingModuleId The id of the staking module to be updated.
    /// @param _nodeOperatorIds Ids of the node operators to be updated.
    /// @param _vettedSigningKeysCounts New counts of vetted signing keys for the specified node operators.
    /// @dev The function is restricted to the `STAKING_MODULE_UNVETTING_ROLE` role.
    function decreaseStakingModuleVettedKeysCountByNodeOperator(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _vettedSigningKeysCounts
    ) external onlyRole(STAKING_MODULE_UNVETTING_ROLE) {
        _checkValidatorsByNodeOperatorReportData(_nodeOperatorIds, _vettedSigningKeysCounts);
        _getIStakingModuleById(_stakingModuleId).decreaseVettedSigningKeysCount(
            _nodeOperatorIds,
            _vettedSigningKeysCounts
        );
    }

    /// @notice Returns all registered staking modules.
    /// @return res Array of staking modules.
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

    /// @notice Returns the ids of all registered staking modules.
    /// @return stakingModuleIds Array of staking module ids.
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

    /// @notice Returns the staking module by its id.
    /// @param _stakingModuleId Id of the staking module.
    /// @return Staking module data.
    function getStakingModule(uint256 _stakingModuleId) public view returns (StakingModule memory) {
        return _getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId));
    }

    /// @notice Returns total number of staking modules.
    /// @return Total number of staking modules.
    function getStakingModulesCount() public view returns (uint256) {
        return _getRouterStorage().stakingModulesCount;
    }

    /// @notice Returns true if staking module with the given id was registered via `addStakingModule`, false otherwise.
    /// @param _stakingModuleId Id of the staking module.
    /// @return True if staking module with the given id was registered, false otherwise.
    function hasStakingModule(uint256 _stakingModuleId) external view returns (bool) {
        return _getStorageStakingIndicesMapping()[_stakingModuleId] != 0;
    }

    /// @notice Returns status of staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return Status of the staking module.
    function getStakingModuleStatus(uint256 _stakingModuleId) public view returns (StakingModuleStatus) {
        return StakingModuleStatus(_getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId)).status);
    }

    function getContractVersion() external view returns (uint256) {
        return _getInitializedVersion();
    }

    /// @notice A summary of the staking module's validators.
    struct StakingModuleSummary {
        /// @notice The total number of validators in the EXITED state on the Consensus Layer.
        /// @dev This value can't decrease in normal conditions.
        uint256 totalExitedValidators;
        /// @notice The total number of validators deposited via the official Deposit Contract.
        /// @dev This value is a cumulative counter: even when the validator goes into EXITED state this
        /// counter is not decreasing.
        uint256 totalDepositedValidators;
        /// @notice The number of validators in the set available for deposit
        uint256 depositableValidatorsCount;
    }

    /// @notice A summary of node operator and its validators.
    struct NodeOperatorSummary {
        /// @notice Shows whether the current target limit applied to the node operator.
        uint256 targetLimitMode;
        /// @notice Relative target active validators limit for operator.
        uint256 targetValidatorsCount;
        /// @notice The number of validators with an expired request to exit time.
        /// @dev [deprecated] Stuck key processing has been removed, this field is no longer used.
        uint256 stuckValidatorsCount;
        /// @notice The number of validators that can't be withdrawn, but deposit costs were
        /// compensated to the Lido by the node operator.
        /// @dev [deprecated] Refunded validators processing has been removed, this field is no longer used.
        uint256 refundedValidatorsCount;
        /// @notice A time when the penalty for stuck validators stops applying to node operator rewards.
        /// @dev [deprecated] Stuck key processing has been removed, this field is no longer used.
        uint256 stuckPenaltyEndTimestamp;
        /// @notice The total number of validators in the EXITED state on the Consensus Layer.
        /// @dev This value can't decrease in normal conditions.
        uint256 totalExitedValidators;
        /// @notice The total number of validators deposited via the official Deposit Contract.
        /// @dev This value is a cumulative counter: even when the validator goes into EXITED state this
        /// counter is not decreasing.
        uint256 totalDepositedValidators;
        /// @notice The number of validators in the set available for deposit.
        uint256 depositableValidatorsCount;
    }

    /// @notice Returns all-validators summary in the staking module.
    /// @param _stakingModuleId Id of the staking module to return summary for.
    /// @return summary Staking module summary.
    function getStakingModuleSummary(
        uint256 _stakingModuleId
    ) public view returns (StakingModuleSummary memory summary) {
        IStakingModule stakingModule = IStakingModule(getStakingModule(_stakingModuleId).stakingModuleAddress);
        (
            summary.totalExitedValidators,
            summary.totalDepositedValidators,
            summary.depositableValidatorsCount
        ) = _getStakingModuleSummary(stakingModule);
    }

    /// @notice Returns node operator summary from the staking module.
    /// @param _stakingModuleId Id of the staking module where node operator is onboarded.
    /// @param _nodeOperatorId Id of the node operator to return summary for.
    /// @return summary Node operator summary.
    function getNodeOperatorSummary(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId
    ) public view returns (NodeOperatorSummary memory summary) {
        IStakingModule stakingModule = IStakingModule(getStakingModule(_stakingModuleId).stakingModuleAddress);
        /// @dev using intermediate variables below due to "Stack too deep" error in case of
        /// assigning directly into the NodeOperatorSummary struct
        (
            uint256 targetLimitMode,
            uint256 targetValidatorsCount,
            ,
            ,
            ,
            /* uint256 stuckValidatorsCount */ /* uint256 refundedValidatorsCount */ /* uint256 stuckPenaltyEndTimestamp */ uint256 totalExitedValidators,
            uint256 totalDepositedValidators,
            uint256 depositableValidatorsCount
        ) = stakingModule.getNodeOperatorSummary(_nodeOperatorId);
        summary.targetLimitMode = targetLimitMode;
        summary.targetValidatorsCount = targetValidatorsCount;
        summary.totalExitedValidators = totalExitedValidators;
        summary.totalDepositedValidators = totalDepositedValidators;
        summary.depositableValidatorsCount = depositableValidatorsCount;
    }

    /// @notice A collection of the staking module data stored across the StakingRouter and the
    /// staking module contract.
    ///
    /// @dev This data, first of all, is designed for off-chain usage and might be redundant for
    /// on-chain calls. Give preference for dedicated methods for gas-efficient on-chain calls.
    struct StakingModuleDigest {
        /// @notice The number of node operators registered in the staking module.
        uint256 nodeOperatorsCount;
        /// @notice The number of node operators registered in the staking module in active state.
        uint256 activeNodeOperatorsCount;
        /// @notice The current state of the staking module taken from the StakingRouter.
        StakingModule state;
        /// @notice A summary of the staking module's validators.
        StakingModuleSummary summary;
    }

    /// @notice A collection of the node operator data stored in the staking module.
    /// @dev This data, first of all, is designed for off-chain usage and might be redundant for
    /// on-chain calls. Give preference for dedicated methods for gas-efficient on-chain calls.
    struct NodeOperatorDigest {
        /// @notice Id of the node operator.
        uint256 id;
        /// @notice Shows whether the node operator is active or not.
        bool isActive;
        /// @notice A summary of node operator and its validators.
        NodeOperatorSummary summary;
    }

    /// @notice Returns staking module digest for each staking module registered in the staking router.
    /// @return Array of staking module digests.
    /// @dev WARNING: This method is not supposed to be used for onchain calls due to high gas costs
    /// for data aggregation.
    function getAllStakingModuleDigests() external view returns (StakingModuleDigest[] memory) {
        return getStakingModuleDigests(getStakingModuleIds());
    }

    /// @notice Returns staking module digest for passed staking module ids.
    /// @param _stakingModuleIds Ids of the staking modules to return data for.
    /// @return digests Array of staking module digests.
    /// @dev WARNING: This method is not supposed to be used for onchain calls due to high gas costs
    /// for data aggregation.
    /// TODO: Can be moved in separate external library
    function getStakingModuleDigests(
        uint256[] memory _stakingModuleIds
    ) public view returns (StakingModuleDigest[] memory digests) {
        digests = new StakingModuleDigest[](_stakingModuleIds.length);
        for (uint256 i = 0; i < _stakingModuleIds.length; ) {
            StakingModule memory stakingModuleState = getStakingModule(_stakingModuleIds[i]);
            IStakingModule stakingModule = IStakingModule(stakingModuleState.stakingModuleAddress);
            digests[i] = StakingModuleDigest({
                nodeOperatorsCount: stakingModule.getNodeOperatorsCount(),
                activeNodeOperatorsCount: stakingModule.getActiveNodeOperatorsCount(),
                state: stakingModuleState,
                summary: getStakingModuleSummary(_stakingModuleIds[i])
            });

            unchecked {
                ++i;
            }
        }
    }

    /// @notice Returns node operator digest for each node operator registered in the given staking module.
    /// @param _stakingModuleId Id of the staking module to return data for.
    /// @return Array of node operator digests.
    /// @dev WARNING: This method is not supposed to be used for onchain calls due to high gas costs
    /// for data aggregation.
    /// TODO: Can be moved in separate external library
    function getAllNodeOperatorDigests(uint256 _stakingModuleId) external view returns (NodeOperatorDigest[] memory) {
        return
            getNodeOperatorDigests(
                _stakingModuleId,
                0,
                _getIStakingModuleById(_stakingModuleId).getNodeOperatorsCount()
            );
    }

    /// @notice Returns node operator digest for passed node operator ids in the given staking module.
    /// @param _stakingModuleId Id of the staking module where node operators registered.
    /// @param _offset Node operators offset starting with 0.
    /// @param _limit The max number of node operators to return.
    /// @return Array of node operator digests.
    /// @dev WARNING: This method is not supposed to be used for onchain calls due to high gas costs
    /// for data aggregation.
    /// TODO: Can be moved in separate external library
    function getNodeOperatorDigests(
        uint256 _stakingModuleId,
        uint256 _offset,
        uint256 _limit
    ) public view returns (NodeOperatorDigest[] memory) {
        return
            getNodeOperatorDigests(
                _stakingModuleId,
                _getIStakingModuleById(_stakingModuleId).getNodeOperatorIds(_offset, _limit)
            );
    }

    /// @notice Returns node operator digest for a slice of node operators registered in the given
    /// staking module.
    /// @param _stakingModuleId Id of the staking module where node operators registered.
    /// @param _nodeOperatorIds Ids of the node operators to return data for.
    /// @return digests Array of node operator digests.
    /// @dev WARNING: This method is not supposed to be used for onchain calls due to high gas costs
    /// for data aggregation.
    function getNodeOperatorDigests(
        uint256 _stakingModuleId,
        uint256[] memory _nodeOperatorIds
    ) public view returns (NodeOperatorDigest[] memory digests) {
        IStakingModule stakingModule = _getIStakingModuleById(_stakingModuleId);
        digests = new NodeOperatorDigest[](_nodeOperatorIds.length);
        for (uint256 i = 0; i < _nodeOperatorIds.length; ) {
            digests[i] = NodeOperatorDigest({
                id: _nodeOperatorIds[i],
                isActive: stakingModule.getNodeOperatorIsActive(_nodeOperatorIds[i]),
                summary: getNodeOperatorSummary(_stakingModuleId, _nodeOperatorIds[i])
            });

            unchecked {
                ++i;
            }
        }
    }

    /// @notice Sets the staking module status flag for participation in further deposits and/or reward distribution.
    /// @param _stakingModuleId Id of the staking module to be updated.
    /// @param _status New status of the staking module.
    /// @dev The function is restricted to the `STAKING_MODULE_MANAGE_ROLE` role.
    function setStakingModuleStatus(
        uint256 _stakingModuleId,
        StakingModuleStatus _status
    ) external onlyRole(STAKING_MODULE_MANAGE_ROLE) {
        StakingModule storage stakingModule = _getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId));
        if (StakingModuleStatus(stakingModule.status) == _status) revert StakingModuleStatusTheSame();
        _setStakingModuleStatus(stakingModule, _status);
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
        return _getIStakingModuleById(_stakingModuleId).getNonce();
    }

    /// @notice Returns the last deposit block for the staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return Last deposit block for the staking module.
    function getStakingModuleLastDepositBlock(uint256 _stakingModuleId) external view returns (uint256) {
        return _getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId)).lastDepositBlock;
    }

    /// @notice Returns the min deposit block distance for the staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return Min deposit block distance for the staking module.
    function getStakingModuleMinDepositBlockDistance(uint256 _stakingModuleId) external view returns (uint256) {
        return _getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId)).minDepositBlockDistance;
    }

    /// @notice Returns the max deposits count per block for the staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return Max deposits count per block for the staking module.
    function getStakingModuleMaxDepositsPerBlock(uint256 _stakingModuleId) external view returns (uint256) {
        return _getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId)).maxDepositsPerBlock;
    }

    /// @notice Returns the max eth deposit amount per block for the staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return Max deposits count per block for the staking module.
    function getStakingModuleMaxDepositsAmountPerBlock(uint256 _stakingModuleId) external view returns (uint256) {
        // TODO: maybe will be defined via staking module config
        // DEPOSIT_SIZE here is old deposit value per validator
        return (_getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId)).maxDepositsPerBlock *
            DEPOSIT_SIZE);
    }

    /// @notice Returns active validators count for the staking module.
    /// @param _stakingModuleId Id of the staking module.
    /// @return activeValidatorsCount Active validators count for the staking module.
    function getStakingModuleActiveValidatorsCount(
        uint256 _stakingModuleId
    ) external view returns (uint256 activeValidatorsCount) {
        StakingModule storage stakingModule = _getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId));
        (
            uint256 totalExitedValidators,
            uint256 totalDepositedValidators,

        ) = /* uint256 depositableValidatorsCount */ _getStakingModuleSummary(
                IStakingModule(stakingModule.stakingModuleAddress)
            );

        activeValidatorsCount =
            totalDepositedValidators -
            Math256.max(stakingModule.exitedValidatorsCount, totalExitedValidators);
    }

    /// @notice Returns withdrawal credentials type
    /// @param _stakingModuleId Id of the staking module to be deposited.
    /// @return Withdrawal credentials type: 1 (0x01) or 2 (0x02)
    function getStakingModuleWithdrawalCredentialsType(uint256 _stakingModuleId) public view returns (uint256) {
        StakingModule storage stakingModule = _getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId));
        return stakingModule.withdrawalCredentialsType;
    }

    /// @notice Returns the max amount of Eth for initial 32 eth deposits in staking module.
    /// @param _stakingModuleId Id of the staking module to be deposited.
    /// @param _depositableEth Max amount of ether that might be used for deposits count calculation.
    /// @return Max amount of Eth that can be deposited using the given staking module.
    function getStakingModuleMaxInitialDepositsAmount(
        uint256 _stakingModuleId,
        uint256 _depositableEth
    ) public returns (uint256) {
        StakingModule storage stakingModule = _getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId));

        // TODO: is it correct?
        if (stakingModule.status != uint8(StakingModuleStatus.Active)) return 0;

        if (stakingModule.withdrawalCredentialsType == NEW_WITHDRAWAL_CREDENTIALS_TYPE) {
            uint256 stakingModuleTargetEthAmount = _getTargetDepositsAllocation(_stakingModuleId, _depositableEth);
            (uint256[] memory operators, uint256[] memory allocations) = IStakingModuleV2(
                stakingModule.stakingModuleAddress
            ).getAllocation(stakingModuleTargetEthAmount);

            (uint256 totalCount, uint256[] memory counts) = _getNewDepositsCount02(
                stakingModuleTargetEthAmount,
                allocations,
                INITIAL_DEPOSIT_SIZE
            );

            // this will be read and clean in deposit method
            DepositsTempStorage.storeOperators(operators);
            DepositsTempStorage.storeCounts(counts);

            return totalCount * INITIAL_DEPOSIT_SIZE;
        } else if (stakingModule.withdrawalCredentialsType == LEGACY_WITHDRAWAL_CREDENTIALS_TYPE) {
            uint256 count = getStakingModuleMaxDepositsCount(_stakingModuleId, _depositableEth);

            return count * INITIAL_DEPOSIT_SIZE;
        } else {
            revert WrongWithdrawalCredentialsType();
        }
    }

    /// @notice DEPRECATED: use getStakingModuleMaxInitialDepositsAmount
    /// This method only for the legacy modules
    function getStakingModuleMaxDepositsCount(
        uint256 _stakingModuleId,
        uint256 _depositableEth
    ) public view returns (uint256) {
        StakingModule storage stakingModule = _getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId));

        require(
            stakingModule.withdrawalCredentialsType == LEGACY_WITHDRAWAL_CREDENTIALS_TYPE,
            "This method is only supported for legace modules"
        );
        uint256 stakingModuleTargetEthAmount = _getTargetDepositsAllocation(_stakingModuleId, _depositableEth);

        uint256 countKeys = stakingModuleTargetEthAmount / DEPOSIT_SIZE;
        if (stakingModule.status != uint8(StakingModuleStatus.Active)) return 0;

        (, , uint256 depositableValidatorsCount) = _getStakingModuleSummary(
            IStakingModule(stakingModule.stakingModuleAddress)
        );
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
                    depositsCount = 1 + (allocation - initialDeposit) / DEPOSIT_SIZE_02;
                }

                counts[i] = depositsCount;
                totalCount += depositsCount;

                ++i;
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
        (, , moduleFees, totalFee, basePrecision) = getStakingRewardsDistribution();
        for (uint256 i; i < moduleFees.length; ) {
            modulesFee += moduleFees[i];

            unchecked {
                ++i;
            }
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
        (uint256 totalActiveValidators, StakingModuleCache[] memory stakingModulesCache) = _loadStakingModulesCache();
        uint256 stakingModulesCount = stakingModulesCache.length;

        /// @dev Return empty response if there are no staking modules or active validators yet.
        if (stakingModulesCount == 0 || totalActiveValidators == 0) {
            return (new address[](0), new uint256[](0), new uint96[](0), 0, FEE_PRECISION_POINTS);
        }

        return _computeDistribution(stakingModulesCache, totalActiveValidators);
    }

    function _computeDistribution(
        StakingModuleCache[] memory stakingModulesCache,
        uint256 totalActiveValidators
    )
        internal
        pure
        returns (
            address[] memory recipients,
            uint256[] memory stakingModuleIds,
            uint96[] memory stakingModuleFees,
            uint96 totalFee,
            uint256 precisionPoints
        )
    {
        uint256 stakingModulesCount = stakingModulesCache.length;

        precisionPoints = FEE_PRECISION_POINTS;
        stakingModuleIds = new uint256[](stakingModulesCount);
        recipients = new address[](stakingModulesCount);
        stakingModuleFees = new uint96[](stakingModulesCount);

        uint256 rewardedStakingModulesCount = 0;

        for (uint256 i; i < stakingModulesCount; ) {
            /// @dev Skip staking modules which have no active validators.
            if (stakingModulesCache[i].activeValidatorsCount > 0) {
                ModuleShare memory share = _computeModuleShare(stakingModulesCache[i], totalActiveValidators);

                stakingModuleIds[rewardedStakingModulesCount] = share.stakingModuleId;
                recipients[rewardedStakingModulesCount] = share.recipient;

                /// @dev If the staking module has the Stopped status for some reason, then
                ///      the staking module's rewards go to the treasury, so that the DAO has ability
                ///      to manage them (e.g. to compensate the staking module in case of an error, etc.)
                if (stakingModulesCache[i].status != StakingModuleStatus.Stopped) {
                    // stakingModuleFees[rewardedStakingModulesCount] = moduleFee;
                    stakingModuleFees[rewardedStakingModulesCount] = share.stakingModuleFee;
                }
                // Else keep stakingModuleFees[rewardedStakingModulesCount] = 0, but increase totalFee.

                totalFee += share.treasuryFee + share.stakingModuleFee;

                unchecked {
                    rewardedStakingModulesCount++;
                }
            }

            unchecked {
                ++i;
            }
        }

        // Total fee never exceeds 100%.
        assert(totalFee <= precisionPoints);

        /// @dev Shrink arrays.
        if (rewardedStakingModulesCount < stakingModulesCount) {
            assembly {
                mstore(stakingModuleIds, rewardedStakingModulesCount)
                mstore(recipients, rewardedStakingModulesCount)
                mstore(stakingModuleFees, rewardedStakingModulesCount)
            }
        }
    }

    struct ModuleShare {
        uint256 stakingModuleId;
        address recipient;
        uint96 stakingModuleFee;
        uint96 treasuryFee;
    }

    function _computeModuleShare(
        StakingModuleCache memory stakingModule,
        uint256 totalActiveValidators
    ) internal pure returns (ModuleShare memory share) {
        share.stakingModuleId = stakingModule.stakingModuleId;
        uint256 stakingModuleValidatorsShare = ((stakingModule.activeValidatorsCount * FEE_PRECISION_POINTS) /
            totalActiveValidators);
        share.recipient = address(stakingModule.stakingModuleAddress);
        share.stakingModuleFee = uint96(
            (stakingModuleValidatorsShare * stakingModule.stakingModuleFee) / TOTAL_BASIS_POINTS
        );
        // TODO: rename
        share.treasuryFee = uint96((stakingModuleValidatorsShare * stakingModule.treasuryFee) / TOTAL_BASIS_POINTS);
    }

    /// @notice Returns the same as getStakingRewardsDistribution() but in reduced, 1e4 precision (DEPRECATED).
    /// @dev Helper only for Lido contract. Use getStakingRewardsDistribution() instead.
    /// @return totalFee Total fee to mint for each staking module and treasury in reduced, 1e4 precision.
    function getTotalFeeE4Precision() external view returns (uint16 totalFee) {
        /// @dev The logic is placed here but in Lido contract to save Lido bytecode.
        (, , , uint96 totalFeeInHighPrecision, uint256 precision) = getStakingRewardsDistribution();
        // Here we rely on (totalFeeInHighPrecision <= precision).
        totalFee = _toE4Precision(totalFeeInHighPrecision, precision);
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
        (
            uint256 modulesFeeHighPrecision,
            uint256 treasuryFeeHighPrecision,
            uint256 precision
        ) = getStakingFeeAggregateDistribution();
        // Here we rely on ({modules,treasury}FeeHighPrecision <= precision).
        modulesFee = _toE4Precision(modulesFeeHighPrecision, precision);
        treasuryFee = _toE4Precision(treasuryFeeHighPrecision, precision);
    }

    /// @notice Returns new deposits allocation after the distribution of the `_depositsCount` deposits.
    /// @param _depositsCount The maximum number of deposits to be allocated.
    /// @return allocated Number of deposits allocated to the staking modules.
    /// @return allocations Array of new deposits allocation to the staking modules.
    function getDepositsAllocation(
        uint256 _depositsCount
    ) external view returns (uint256 allocated, uint256[] memory allocations) {
        // (allocated, allocations, ) = _getDepositsAllocation(_depositsCount);
    }

    /// @notice Invokes a deposit call to the official Deposit contract.
    /// @param _stakingModuleId Id of the staking module to be deposited.
    /// @param _depositCalldata Staking module calldata.
    /// @dev Only the Lido contract is allowed to call this method.
    function deposit(uint256 _stakingModuleId, bytes calldata _depositCalldata) external payable {
        if (msg.sender != _getRouterStorage().lido) revert AppAuthLidoFailed();

        StakingModule storage stakingModule = _getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId));
        if (stakingModule.status != uint8(StakingModuleStatus.Active)) revert StakingModuleNotActive();

        uint8 withdrawalCredentialsType = stakingModule.withdrawalCredentialsType;
        bytes32 withdrawalCredentials;
        if (withdrawalCredentialsType == LEGACY_WITHDRAWAL_CREDENTIALS_TYPE) {
            withdrawalCredentials = getWithdrawalCredentials(); // ideally pure/view, but still 1 call
        } else if (withdrawalCredentialsType == NEW_WITHDRAWAL_CREDENTIALS_TYPE) {
            withdrawalCredentials = getWithdrawalCredentials02();
        } else {
            revert WrongWithdrawalCredentialsType();
        }

        if (withdrawalCredentials == 0) revert EmptyWithdrawalsCredentials();

        uint256 depositsValue = msg.value;
        address stakingModuleAddress = stakingModule.stakingModuleAddress;

        /// @dev Firstly update the local state of the contract to prevent a reentrancy attack
        /// even though the staking modules are trusted contracts.
        _updateModuleLastDepositState(stakingModule, _stakingModuleId, depositsValue);

        if (depositsValue == 0) return;

        // on previous step should have exact amount of
        if (depositsValue % INITIAL_DEPOSIT_SIZE != 0) revert DepositValueNotMultipleOfInitialDeposit();

        uint256 etherBalanceBeforeDeposits = address(this).balance;

        uint256 depositsCount = depositsValue / INITIAL_DEPOSIT_SIZE;

        (bytes memory publicKeysBatch, bytes memory signaturesBatch) = _getOperatorAvailableKeys(
            withdrawalCredentialsType,
            stakingModuleAddress,
            depositsCount,
            _depositCalldata
        );

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
            _getStakingModuleTrackerPosition(_stakingModuleId),
            _getCurrentSlot(),
            depositsValue
        );

        // TODO: notify module about deposits

        uint256 etherBalanceAfterDeposits = address(this).balance;

        /// @dev All sent ETH must be deposited and self balance stay the same.
        assert(etherBalanceBeforeDeposits - etherBalanceAfterDeposits == depositsValue);
    }

    function _getOperatorAvailableKeys(
        uint8 withdrawalCredentialsType,
        address stakingModuleAddress,
        uint256 depositsCount,
        bytes calldata depositCalldata
    ) internal returns (bytes memory keys, bytes memory signatures) {
        if (withdrawalCredentialsType == LEGACY_WITHDRAWAL_CREDENTIALS_TYPE) {
            return IStakingModule(stakingModuleAddress).obtainDepositData(depositsCount, depositCalldata);
        } else {
            // TODO: clean temp storage after read

            (keys, signatures) = IStakingModuleV2(stakingModuleAddress).getOperatorAvailableKeys(
                DepositsTempStorage.getOperators(),
                DepositsTempStorage.getCounts()
            );

            DepositsTempStorage.clearOperators();
            DepositsTempStorage.clearCounts();
        }
    }

    // TODO: This part about accounting was made just like and example of cleaning depositTracker eth counter in SR
    // and should be replaced/changed in case inconsistency
    // report contain also Effective balance of all validators per operator
    // maybe in some tightly packed data
    // Does it bring actual sr module balance too ?
    struct AccountingOracleReport {
        /// Actual balance of all validators in Lido
        uint256 validatorsActualBalance;
        /// Effective balance of all validators in Lido
        uint256 validatorsEffectiveBalance;
        /// Number of all active validators in Lido
        uint256 activeValidators;
        /// Effective balance of all validators per Staking Module
        uint256 validatorsEffectiveBalanceStakingModule;
        /// Number of all active validators per Staking Module
        uint256 activeValidatorsStakingModule;
    }

    /// @notice Trigger on accounting report
    function onAccountingOracleReport(
        uint256 stakingModuleId,
        AccountingOracleReport memory report,
        uint256 refSlot
    ) external {
        // Here can clean  tracker
        // AO has it is own tracker , that incremented by lido contract in case of deposits
        // and used to check ao report data
        // if data is correct, ao will notify SR and maybe other contracts about report
        // SR will clean data in tracker
        // AO brings report on refSlot, so data after refSlot is should be still stored in tracker
        DepositsTracker.cleanAndGetDepositedEthBefore(_getStakingModuleTrackerPosition(stakingModuleId), refSlot); //and update range beginning
    }

    /// @notice Set 0x01 credentials to withdraw ETH on Consensus Layer side.
    /// @param _withdrawalCredentials 0x01 withdrawal credentials field as defined in the Consensus Layer specs.
    /// @dev Note that setWithdrawalCredentials discards all unused deposits data as the signatures are invalidated.
    /// @dev The function is restricted to the `MANAGE_WITHDRAWAL_CREDENTIALS_ROLE` role.
    function setWithdrawalCredentials(
        bytes32 _withdrawalCredentials
    ) external onlyRole(MANAGE_WITHDRAWAL_CREDENTIALS_ROLE) {
        _getRouterStorage().withdrawalCredentials = _withdrawalCredentials;
        _notifyStakingModulesOfWithdrawalCredentialsChange();
        emit WithdrawalCredentialsSet(_withdrawalCredentials, msg.sender);
    }

    /// @notice Set 0x02 credentials to withdraw ETH on Consensus Layer side.
    /// @param _withdrawalCredentials 0x02 withdrawal credentials field as defined in the Consensus Layer specs.
    /// @dev Note that setWithdrawalCredentials discards all unused deposits data as the signatures are invalidated.
    /// @dev The function is restricted to the `MANAGE_WITHDRAWAL_CREDENTIALS_ROLE` role.
    function setWithdrawalCredentials02(
        bytes32 _withdrawalCredentials
    ) external onlyRole(MANAGE_WITHDRAWAL_CREDENTIALS_ROLE) {
        _getRouterStorage().withdrawalCredentials = _withdrawalCredentials;
        _notifyStakingModulesOfWithdrawalCredentialsChange();
        emit WithdrawalCredentials02Set(_withdrawalCredentials, msg.sender);
    }

    /// @notice Returns current credentials to withdraw ETH on Consensus Layer side.
    /// @return Withdrawal credentials.
    function getWithdrawalCredentials() public view returns (bytes32) {
        return _getRouterStorage().withdrawalCredentials;
    }

    /// @notice Returns current 0x02 credentials to withdraw ETH on Consensus Layer side.
    /// @return Withdrawal credentials.
    function getWithdrawalCredentials02() public view returns (bytes32) {
        return _getRouterStorage().withdrawalCredentials02;
    }

    function _notifyStakingModulesOfWithdrawalCredentialsChange() internal {
        uint256 stakingModulesCount = getStakingModulesCount();
        for (uint256 i; i < stakingModulesCount; ) {
            StakingModule storage stakingModule = _getStakingModuleByIndex(i);

            unchecked {
                ++i;
            }

            try IStakingModule(stakingModule.stakingModuleAddress).onWithdrawalCredentialsChanged() {} catch (
                bytes memory lowLevelRevertData
            ) {
                if (lowLevelRevertData.length == 0) revert UnrecoverableModuleError();
                _setStakingModuleStatus(stakingModule, StakingModuleStatus.DepositsPaused);
                emit WithdrawalsCredentialsChangeFailed(stakingModule.id, lowLevelRevertData);
            }
        }
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

    /// @dev Save the last deposit state for the staking module and emit the event
    /// @param stakingModule staking module storage ref
    /// @param stakingModuleId id of the staking module to be deposited
    /// @param depositsValue value to deposit
    function _updateModuleLastDepositState(
        StakingModule storage stakingModule,
        uint256 stakingModuleId,
        uint256 depositsValue
    ) internal {
        stakingModule.lastDepositAt = uint64(block.timestamp);
        stakingModule.lastDepositBlock = block.number;
        emit StakingRouterETHDeposited(stakingModuleId, depositsValue);
    }

    /// @dev Loads modules into a memory cache.
    /// @return totalActiveValidators Total active validators across all modules.
    /// @return stakingModulesCache Array of StakingModuleCache structs.
    function _loadStakingModulesCache()
        internal
        view
        returns (uint256 totalActiveValidators, StakingModuleCache[] memory stakingModulesCache)
    {
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

    function _loadStakingModulesCacheItem(
        uint256 _stakingModuleIndex
    ) internal view returns (StakingModuleCache memory cacheItem) {
        StakingModule storage stakingModuleData = _getStakingModuleByIndex(_stakingModuleIndex);

        cacheItem.stakingModuleAddress = stakingModuleData.stakingModuleAddress;
        cacheItem.stakingModuleId = stakingModuleData.id;
        cacheItem.stakingModuleFee = stakingModuleData.stakingModuleFee;
        cacheItem.treasuryFee = stakingModuleData.treasuryFee;
        cacheItem.stakeShareLimit = stakingModuleData.stakeShareLimit;
        cacheItem.status = StakingModuleStatus(stakingModuleData.status);

        (
            uint256 totalExitedValidators,
            uint256 totalDepositedValidators,
            uint256 depositableValidatorsCount
        ) = _getStakingModuleSummary(IStakingModule(cacheItem.stakingModuleAddress));

        cacheItem.availableValidatorsCount = cacheItem.status == StakingModuleStatus.Active
            ? depositableValidatorsCount
            : 0;

        // The module might not receive all exited validators data yet => we need to replacing
        // the exitedValidatorsCount with the one that the staking router is aware of.
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

    /// @notice Allocation for module based on target share
    /// @param stakingModuleId - Id of staking module
    /// @param  _depositsToAllocate - Eth amount that can be deposited in module
    function _getTargetDepositsAllocation(
        uint256 stakingModuleId,
        uint256 _depositsToAllocate
    ) internal view returns (uint256 allocation) {
        // TODO: implementation based on Share Limits allocation strategy tbd
        return _depositsToAllocate;
    }

    // [depreacted method]
    //  logic for legacy modules should be fetched
    // function _getDepositsAllocation(
    //     uint256 _depositsToAllocate
    // )
    //     internal
    //     view
    //     returns (uint256 allocated, uint256[] memory allocations, StakingModuleCache[] memory stakingModulesCache)
    // {
    //     // Calculate total used validators for operators.
    //     uint256 totalActiveValidators;

    //     (totalActiveValidators, stakingModulesCache) = _loadStakingModulesCache();

    //     uint256 stakingModulesCount = stakingModulesCache.length;
    //     allocations = new uint256[](stakingModulesCount);
    //     if (stakingModulesCount > 0) {
    //         /// @dev New estimated active validators count.
    //         totalActiveValidators += _depositsToAllocate;
    //         uint256[] memory capacities = new uint256[](stakingModulesCount);
    //         uint256 targetValidators;

    //         for (uint256 i; i < stakingModulesCount; ) {
    //             allocations[i] = stakingModulesCache[i].activeValidatorsCount;
    //             targetValidators =
    //                 (stakingModulesCache[i].stakeShareLimit * totalActiveValidators) /
    //                 TOTAL_BASIS_POINTS;
    //             capacities[i] = Math256.min(
    //                 targetValidators,
    //                 stakingModulesCache[i].activeValidatorsCount + stakingModulesCache[i].availableValidatorsCount
    //             );

    //             unchecked {
    //                 ++i;
    //             }
    //         }

    //         (allocated, allocations) = MinFirstAllocationStrategy.allocate(
    //             allocations,
    //             capacities,
    //             _depositsToAllocate
    //         );
    //     }
    // }

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

    function _getIStakingModuleById(uint256 _stakingModuleId) internal view returns (IStakingModule) {
        return IStakingModule(_getStakingModuleAddressById(_stakingModuleId));
    }

    function _getStakingModuleByIndex(uint256 _stakingModuleIndex) internal view returns (StakingModule storage) {
        mapping(uint256 => StakingModule) storage _stakingModules = _getStorageStakingModulesMapping();
        return _stakingModules[_stakingModuleIndex];
    }

    function _getStakingModuleAddressById(uint256 _stakingModuleId) internal view returns (address) {
        return _getStakingModuleByIndex(_getStakingModuleIndexById(_stakingModuleId)).stakingModuleAddress;
    }

    function _getStorageStakingModulesMapping()
        internal
        pure
        returns (mapping(uint256 => StakingModule) storage result)
    {
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

    function _getRouterStorage() internal pure returns (RouterStorage storage $) {
        bytes32 position = ROUTER_STORAGE_POSITION;
        assembly {
            $.slot := position
        }
    }

    function _getStakingModuleTrackerPosition(uint256 stakingModuleId) internal pure returns (bytes32) {
        // Mirrors mapping slot formula: keccak256(abi.encode(key, baseSlot))
        return keccak256(abi.encode(stakingModuleId, DEPOSITS_TRACKER));
    }

    function _toE4Precision(uint256 _value, uint256 _precision) internal pure returns (uint16) {
        return uint16((_value * TOTAL_BASIS_POINTS) / _precision);
    }

    function _validateEqualArrayLengths(uint256 firstArrayLength, uint256 secondArrayLength) internal pure {
        if (firstArrayLength != secondArrayLength) {
            revert ArraysLengthMismatch(firstArrayLength, secondArrayLength);
        }
    }

    /// @dev Optimizes contract deployment size by wrapping the 'stakingModule.getStakingModuleSummary' function.
    function _getStakingModuleSummary(IStakingModule stakingModule) internal view returns (uint256, uint256, uint256) {
        return stakingModule.getStakingModuleSummary();
    }

    function _getCurrentSlot() internal view returns (uint256) {
        return (block.timestamp - GENESIS_TIME) / SECONDS_PER_SLOT;
    }

    /// @notice Handles tracking and penalization logic for a node operator who failed to exit their validator within the defined exit window.
    /// @dev This function is called to report the current exit-related status of a validator belonging to a specific node operator.
    ///      It accepts a validator's public key, associated with the duration (in seconds) it was eligible to exit but has not exited.
    ///      This data could be used to trigger penalties for the node operator if the validator has been non-exiting for too long.
    /// @param _stakingModuleId The ID of the staking module.
    /// @param _nodeOperatorId The ID of the node operator whose validator status is being delivered.
    /// @param _proofSlotTimestamp The timestamp (slot time) when the validator was last known to be in an active ongoing state.
    /// @param _publicKey The public key of the validator being reported.
    /// @param _eligibleToExitInSec The duration (in seconds) indicating how long the validator has been eligible to exit after request but has not exited.
    function reportValidatorExitDelay(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        uint256 _proofSlotTimestamp,
        bytes calldata _publicKey,
        uint256 _eligibleToExitInSec
    ) external onlyRole(REPORT_VALIDATOR_EXITING_STATUS_ROLE) {
        _getIStakingModuleById(_stakingModuleId).reportValidatorExitDelay(
            _nodeOperatorId,
            _proofSlotTimestamp,
            _publicKey,
            _eligibleToExitInSec
        );
    }

    /// @notice Handles the triggerable exit event for a set of validators.
    /// @dev This function is called when validators are exited using triggerable exit requests on the Execution Layer.
    /// @param validatorExitData An array of `ValidatorExitData` structs, each representing a validator
    ///        for which a triggerable exit was requested. Each entry includes:
    ///        - `stakingModuleId`: ID of the staking module.
    ///        - `nodeOperatorId`: ID of the node operator.
    ///        - `pubkey`: Validator public key, 48 bytes length.
    /// @param _withdrawalRequestPaidFee Fee amount paid to send a withdrawal request on the Execution Layer (EL).
    /// @param _exitType The type of exit being performed.
    ///        This parameter may be interpreted differently across various staking modules depending on their specific implementation.
    function onValidatorExitTriggered(
        ValidatorExitData[] calldata validatorExitData,
        uint256 _withdrawalRequestPaidFee,
        uint256 _exitType
    ) external onlyRole(REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE) {
        ValidatorExitData calldata data;
        for (uint256 i = 0; i < validatorExitData.length; ++i) {
            data = validatorExitData[i];

            try
                _getIStakingModuleById(data.stakingModuleId).onValidatorExitTriggered(
                    data.nodeOperatorId,
                    data.pubkey,
                    _withdrawalRequestPaidFee,
                    _exitType
                )
            {} catch (bytes memory lowLevelRevertData) {
                /// @dev This check is required to prevent incorrect gas estimation of the method.
                ///      Without it, Ethereum nodes that use binary search for gas estimation may
                ///      return an invalid value when the onValidatorExitTriggered()
                ///      reverts because of the "out of gas" error. Here we assume that the
                ///      onValidatorExitTriggered() method doesn't have reverts with
                ///      empty error data except "out of gas".
                if (lowLevelRevertData.length == 0) revert UnrecoverableModuleError();
                emit StakingModuleExitNotificationFailed(data.stakingModuleId, data.nodeOperatorId, data.pubkey);
            }
        }
    }
}
