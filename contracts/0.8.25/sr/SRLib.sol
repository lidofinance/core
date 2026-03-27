// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {Math, SafeCast} from "@openzeppelin/contracts-v5.2/utils/math/Math.sol";
import {StorageSlot} from "@openzeppelin/contracts-v5.2/utils/StorageSlot.sol";
import {MinFirstAllocationStrategy} from "contracts/common/lib/MinFirstAllocationStrategy.sol";
import {WithdrawalCredentials} from "contracts/common/lib/WithdrawalCredentials.sol";
import {IStakingModule} from "contracts/common/interfaces/IStakingModule.sol";
import {SRStorage} from "./SRStorage.sol";
import {SRUtils} from "./SRUtils.sol";
import {
    ModuleState,
    StakingModuleConfig,
    StakingModuleStatus,
    StakingModule,
    ModuleStateConfig,
    ModuleStateDeposits,
    ModuleStateAccounting,
    ValidatorExitData,
    ValidatorsCountsCorrection,
    RouterStateAccounting
} from "./SRTypes.sol";
import {ISRBase} from "./ISRBase.sol";

/**
 * @title StakingRouter helper external library
 * @author KRogLA
 */

library SRLib {
    using StorageSlot for bytes32;
    using WithdrawalCredentials for bytes32;
    using SRStorage for ModuleState;
    using SRStorage for uint256; // for module IDs

    /// @dev Protocol-level constants, built once per tx from immutables
    /// @dev Due to SRLib is external library, we can't access immutable variables here, so we pass them as parameters
    struct Config {
        uint256 maxEBType1;
        uint256 maxEBType2;
    }

    struct ModuleParamsCache {
        uint256 depositableCount;
        uint256 activeCount;
        uint16 shareLimit;
        StakingModuleStatus status;
        uint8 wcType;
    }

    /// @notice One-time migration from old storage layout to new RouterState struct.
    /// @dev Storage slot positions are computed inline for migration-only use.
    ///      After migration, this function can be removed.
    function _migrateStorage(uint256 maxEBType1) public {
        // skip migration if data already exists
        if (SRStorage.getModulesCount() > 0) {
            return;
        }

        // Old storage slot positions (computed inline for migration-only use)
        bytes32 LIDO_POS = keccak256("lido.StakingRouter.lido");
        bytes32 WITHDRAWAL_CREDENTIALS_POS = keccak256("lido.StakingRouter.withdrawalCredentials");
        bytes32 STAKING_MODULES_COUNT_POS = keccak256("lido.StakingRouter.stakingModulesCount");
        bytes32 LAST_STAKING_MODULE_ID_POS = keccak256("lido.StakingRouter.lastStakingModuleId");
        bytes32 CONTRACT_VERSION_POS = keccak256("lido.Versioned.contractVersion");
        bytes32 STAKING_MODULES_MAPPING_POS = keccak256("lido.StakingRouter.stakingModules");
        bytes32 STAKING_MODULE_INDICES_POS = keccak256("lido.StakingRouter.stakingModuleIndicesOneBased");

        // cleanup old storage slots
        delete LIDO_POS.getBytes32Slot().value;
        delete CONTRACT_VERSION_POS.getBytes32Slot().value;

        // migrate last staking module ID
        SRStorage.getRouterState().lastModuleId = uint24(LAST_STAKING_MODULE_ID_POS.getUint256Slot().value);
        delete LAST_STAKING_MODULE_ID_POS.getBytes32Slot().value;

        // migrate WC
        SRStorage.getRouterState().withdrawalCredentials = WITHDRAWAL_CREDENTIALS_POS.getBytes32Slot().value;
        delete WITHDRAWAL_CREDENTIALS_POS.getBytes32Slot().value;

        uint256 modulesCount = STAKING_MODULES_COUNT_POS.getUint256Slot().value;
        delete STAKING_MODULES_COUNT_POS.getBytes32Slot().value;

        // get old storage ref. for staking modules mapping
        mapping(uint256 => StakingModule) storage oldStakingModules =
            _getStorageStakingModulesMapping(STAKING_MODULES_MAPPING_POS);
        // get old storage ref. for staking modules indices mapping
        mapping(uint256 => uint256) storage oldStakingModuleIndices =
            _getStorageStakingIndicesMapping(STAKING_MODULE_INDICES_POS);

        uint64 totalValidatorsBalanceGwei;
        StakingModule memory smOld;

        for (uint256 i; i < modulesCount; ++i) {
            smOld = oldStakingModules[i];

            uint256 _moduleId = smOld.id;
            // push module ID to EnumerableSet
            SRStorage.addModuleId(_moduleId);

            ModuleState storage moduleState = _moduleId.getModuleState();

            // 1 SSTORE
            moduleState.name = smOld.name;

            // 1 SSTORE
            moduleState.config = ModuleStateConfig({
                moduleAddress: smOld.stakingModuleAddress,
                moduleFee: smOld.stakingModuleFee,
                treasuryFee: smOld.treasuryFee,
                stakeShareLimit: smOld.stakeShareLimit,
                priorityExitShareThreshold: smOld.priorityExitShareThreshold,
                status: StakingModuleStatus(smOld.status),
                withdrawalCredentialsType: WithdrawalCredentials.WC_TYPE_01
            });

            // 1 SSTORE
            moduleState.deposits = ModuleStateDeposits({
                lastDepositAt: smOld.lastDepositAt,
                lastDepositBlock: SafeCast.toUint64(smOld.lastDepositBlock),
                maxDepositsPerBlock: smOld.maxDepositsPerBlock,
                minDepositBlockDistance: smOld.minDepositBlockDistance
            });

            /// @dev calculate module effective balance at the migration moment
            (uint256 exitedValidatorsCount, uint256 depositedValidatorsCount,) =
                _getStakingModuleSummary(IStakingModule(smOld.stakingModuleAddress));
            // The module might not receive all exited validators data yet => we need to replacing
            // the exitedValidatorsCount with the one that the staking router is aware of.
            uint256 activeCount =
                depositedValidatorsCount - Math.max(smOld.exitedValidatorsCount, exitedValidatorsCount);
            uint64 validatorsBalanceGwei = SRUtils._toGwei(activeCount * maxEBType1);

            // 1 SSTORE
            moduleState.accounting = ModuleStateAccounting({
                validatorsBalanceGwei: validatorsBalanceGwei,
                exitedValidatorsCount: SafeCast.toUint64(smOld.exitedValidatorsCount)
            });

            totalValidatorsBalanceGwei += validatorsBalanceGwei;

            // cleanup old storage for staking module data
            delete oldStakingModules[i];
            delete oldStakingModuleIndices[_moduleId];
        }

        // cleanup old mapping storage slots
        delete STAKING_MODULES_MAPPING_POS.getBytes32Slot().value;
        delete STAKING_MODULE_INDICES_POS.getBytes32Slot().value;

        /// @dev use the same value for both CL balance and active balance at migration moment,
        /// next Oracle report will update the both values
        SRStorage.getRouterState().accounting =
            RouterStateAccounting({validatorsBalanceGwei: totalValidatorsBalanceGwei});
    }

    /// @dev Helper for migration - returns old staking modules mapping storage reference
    function _getStorageStakingModulesMapping(bytes32 _position)
        internal
        pure
        returns (mapping(uint256 => StakingModule) storage $)
    {
        assembly ("memory-safe") {
            $.slot := _position
        }
    }

    /// @dev Helper for migration - returns old staking module indices mapping storage reference
    function _getStorageStakingIndicesMapping(bytes32 _position)
        internal
        pure
        returns (mapping(uint256 => uint256) storage $)
    {
        assembly ("memory-safe") {
            $.slot := _position
        }
    }

    /// @notice Registers a new staking module.
    /// @param _moduleAddress Address of staking module.
    /// @param _moduleName Name of staking module.
    /// @param _moduleConfig Staking module config
    /// @dev The function is restricted to the `STAKING_MODULE_MANAGE_ROLE` role.
    function _addModule(address _moduleAddress, string calldata _moduleName, StakingModuleConfig calldata _moduleConfig)
        public
        returns (uint256 newModuleId)
    {
        SRUtils._requireNotZero(_moduleAddress);

        if (bytes(_moduleName).length == 0 || bytes(_moduleName).length > SRUtils.MAX_STAKING_MODULE_NAME_LENGTH) {
            revert ISRBase.StakingModuleWrongName();
        }
        if (SRStorage.getModulesCount() >= SRUtils.MAX_STAKING_MODULES_COUNT) {
            revert ISRBase.StakingModulesLimitExceeded();
        }

        SRUtils._requireWCTypeValid(_moduleConfig.withdrawalCredentialsType);

        // Check for duplicate module address
        /// @dev due to small number of modules, we can afford to do this check on add
        uint256 modulesCount = SRStorage.getModulesCount();
        for (uint256 i; i < modulesCount; ++i) {
            uint256 moduleId = SRStorage.getModuleIdAt(i);
            if (_moduleAddress == moduleId.getModuleState().config.moduleAddress) {
                revert ISRBase.StakingModuleAddressExists();
            }
        }

        newModuleId = SRStorage.getRouterState().lastModuleId + 1;
        // push new module ID to EnumerableSet
        SRStorage.addModuleId(newModuleId);

        ModuleState storage moduleState = newModuleId.getModuleState();
        moduleState.config.moduleAddress = _moduleAddress;
        moduleState.config.status = StakingModuleStatus.Active;
        moduleState.config.withdrawalCredentialsType = uint8(_moduleConfig.withdrawalCredentialsType);
        moduleState.name = _moduleName;

        emit ISRBase.StakingModuleAdded(newModuleId, _moduleAddress, _moduleName, msg.sender);

        _updateModuleParams(
            newModuleId,
            _moduleConfig.stakeShareLimit,
            _moduleConfig.priorityExitShareThreshold,
            _moduleConfig.stakingModuleFee,
            _moduleConfig.treasuryFee,
            _moduleConfig.maxDepositsPerBlock,
            _moduleConfig.minDepositBlockDistance
        );

        // save last module ID
        SRStorage.getRouterState().lastModuleId = uint24(newModuleId);
        return newModuleId;
    }

    /// @notice Validates share-related parameters.
    /// @param _stakeShareLimit Stake share limit to validate (in basis points).
    /// @param _priorityExitShareThreshold Priority exit share threshold to validate (in basis points).
    function _validateShareParams(uint256 _stakeShareLimit, uint256 _priorityExitShareThreshold) private pure {
        if (_stakeShareLimit > SRUtils.TOTAL_BASIS_POINTS) {
            revert ISRBase.InvalidStakeShareLimit();
        }
        if (_priorityExitShareThreshold > SRUtils.TOTAL_BASIS_POINTS) {
            revert ISRBase.InvalidPriorityExitShareThreshold();
        }
        if (_stakeShareLimit > _priorityExitShareThreshold) revert ISRBase.InvalidPriorityExitShareThreshold();
    }

    function _updateModuleParams(
        uint256 _moduleId,
        uint256 _stakeShareLimit,
        uint256 _priorityExitShareThreshold,
        uint256 _moduleFee,
        uint256 _treasuryFee,
        uint256 _maxDepositsPerBlock,
        uint256 _minDepositBlockDistance
    ) public {
        _validateShareParams(_stakeShareLimit, _priorityExitShareThreshold);
        if (_moduleFee + _treasuryFee > SRUtils.TOTAL_BASIS_POINTS) revert ISRBase.InvalidFeeSum();
        _requireConsistentFeeSum(_moduleId, _moduleFee, _treasuryFee);
        if (_minDepositBlockDistance == 0 || _minDepositBlockDistance > type(uint64).max) {
            revert ISRBase.InvalidMinDepositBlockDistance();
        }
        if (_maxDepositsPerBlock > type(uint64).max) revert ISRBase.InvalidMaxDepositPerBlockValue();

        // 1 SLOAD
        ModuleStateConfig memory stateConfig = _moduleId.getModuleState().config;
        // forge-lint: disable-start(unsafe-typecast)
        stateConfig.moduleFee = uint16(_moduleFee);
        stateConfig.treasuryFee = uint16(_treasuryFee);
        stateConfig.stakeShareLimit = uint16(_stakeShareLimit);
        stateConfig.priorityExitShareThreshold = uint16(_priorityExitShareThreshold);
        // 1 SSTORE
        _moduleId.getModuleState().config = stateConfig;

        // 1 SLOAD
        ModuleStateDeposits memory stateDeposits = _moduleId.getModuleState().deposits;
        stateDeposits.maxDepositsPerBlock = SafeCast.toUint64(_maxDepositsPerBlock);
        stateDeposits.minDepositBlockDistance = SafeCast.toUint64(_minDepositBlockDistance);
        // forge-lint: disable-end(unsafe-typecast)
        // 1 SSTORE
        _moduleId.getModuleState().deposits = stateDeposits;

        address setBy = msg.sender;
        emit ISRBase.StakingModuleShareLimitSet(_moduleId, _stakeShareLimit, _priorityExitShareThreshold, setBy);
        emit ISRBase.StakingModuleFeesSet(_moduleId, _moduleFee, _treasuryFee, setBy);
        emit ISRBase.StakingModuleMaxDepositsPerBlockSet(_moduleId, _maxDepositsPerBlock, setBy);
        emit ISRBase.StakingModuleMinDepositBlockDistanceSet(_moduleId, _minDepositBlockDistance, setBy);
    }

    function _requireConsistentFeeSum(uint256 _moduleId, uint256 _moduleFee, uint256 _treasuryFee) internal view {
        uint256 feeSum = _moduleFee + _treasuryFee;
        uint256 modulesCount = SRStorage.getModulesCount();

        for (uint256 i; i < modulesCount; ++i) {
            uint256 moduleId = SRStorage.getModuleIdAt(i);
            if (moduleId == _moduleId) continue;

            ModuleStateConfig memory stateConfig = moduleId.getModuleState().config;
            if (uint256(stateConfig.moduleFee) + uint256(stateConfig.treasuryFee) != feeSum) {
                revert ISRBase.InconsistentFeeSum();
            }
        }
    }

    function _updateAllModuleFees(uint256[] calldata _moduleFees, uint256[] calldata _treasuryFees) public {
        uint256 modulesCount = SRStorage.getModulesCount();
        if (_moduleFees.length != modulesCount || _treasuryFees.length != modulesCount) {
            revert ISRBase.ArraysLengthMismatch();
        }
        if (modulesCount == 0) {
            return;
        }

        uint256 expectedFeeSum = _moduleFees[0] + _treasuryFees[0];
        if (expectedFeeSum > SRUtils.TOTAL_BASIS_POINTS) revert ISRBase.InvalidFeeSum();

        for (uint256 i = 1; i < modulesCount; ++i) {
            uint256 feeSum = _moduleFees[i] + _treasuryFees[i];
            if (feeSum > SRUtils.TOTAL_BASIS_POINTS) revert ISRBase.InvalidFeeSum();
            if (feeSum != expectedFeeSum) revert ISRBase.InconsistentFeeSum();
        }

        address setBy = msg.sender;
        for (uint256 i; i < modulesCount; ++i) {
            uint256 moduleId = SRStorage.getModuleIdAt(i);
            ModuleStateConfig memory stateConfig = moduleId.getModuleState().config;
            // forge-lint: disable-start(unsafe-typecast)
            stateConfig.moduleFee = uint16(_moduleFees[i]);
            stateConfig.treasuryFee = uint16(_treasuryFees[i]);
            // forge-lint: disable-end(unsafe-typecast)
            moduleId.getModuleState().config = stateConfig;
            emit ISRBase.StakingModuleFeesSet(moduleId, _moduleFees[i], _treasuryFees[i], setBy);
        }
    }

    /// @notice Updates only the share-related params of a staking module.
    /// @param _moduleId Id of the staking module.
    /// @param _stakeShareLimit New stake share limit (in basis points).
    /// @param _priorityExitShareThreshold New priority exit share threshold (in basis points).
    function _updateModuleShares(uint256 _moduleId, uint256 _stakeShareLimit, uint256 _priorityExitShareThreshold)
        public
    {
        _validateShareParams(_stakeShareLimit, _priorityExitShareThreshold);

        // 1 SLOAD
        ModuleStateConfig memory stateConfig = _moduleId.getModuleState().config;

        // forge-lint: disable-start(unsafe-typecast)
        stateConfig.stakeShareLimit = uint16(_stakeShareLimit);
        stateConfig.priorityExitShareThreshold = uint16(_priorityExitShareThreshold);
        // forge-lint: disable-end(unsafe-typecast)

        // 1 SSTORE
        _moduleId.getModuleState().config = stateConfig;

        emit ISRBase.StakingModuleShareLimitSet(_moduleId, _stakeShareLimit, _priorityExitShareThreshold, msg.sender);
    }

    /// @dev module state helpers

    function _setModuleStatus(uint256 _moduleId, StakingModuleStatus _status) public returns (bool isChanged) {
        ModuleStateConfig storage stateConfig = _moduleId.getModuleState().config;
        isChanged = stateConfig.status != _status;
        if (isChanged) {
            stateConfig.status = _status;
            emit ISRBase.StakingModuleStatusSet(_moduleId, _status, msg.sender);
        }
    }

    /// @dev Optimizes contract deployment size by wrapping the 'stakingModule.getStakingModuleSummary' function.
    function _getStakingModuleSummary(IStakingModule module)
        internal
        view
        returns (uint256 exitedValidators, uint256 depositedValidators, uint256 depositableValidators)
    {
        return module.getStakingModuleSummary();
    }

    /// @notice Deposit allocation for modules
    /// @dev Allocates deposits to staking modules based on their stake share limits and available capacity.
    ///      The allocation algorithm prioritizes modules with lower validator (WC 0x01 equivalent) counts (MinFirst strategy).
    /// @dev Method uses conversion from/to Ether amounts due to MinFirstAllocationStrategy working with unit values.
    /// @param _cfg - protocol-level constants
    /// @param _allocateAmount - Eth amount that should be allocated into modules
    /// @param _isTopUp - flag indicating whether the allocation is for top-up deposits
    /// @return totalAllocated - amount actually allocated
    /// @return allocated - Array of newly allocated amounts for each module
    /// @return newAllocations - Array of new allocation amounts for each module
    function _getDepositAllocations(Config calldata _cfg, uint256 _allocateAmount, bool _isTopUp)
        public
        view
        returns (uint256 totalAllocated, uint256[] memory allocated, uint256[] memory newAllocations)
    {
        uint256 modulesCount = SRStorage.getModulesCount();
        if (modulesCount == 0) {
            return (0, new uint256[](0), new uint256[](0));
        }

        // put calldata var to stack
        uint256 initialDeposit = _cfg.maxEBType1;
        // convert to validators equivalent
        uint256 depositsToAllocate = _allocateAmount / initialDeposit;
        // get current allocations and capacities in validators equivalent
        uint256[] memory capacities;
        // @dev using output parameter as temporary storage for current allocations
        (allocated, capacities) = _getModulesAllocationAndCapacity(_cfg, depositsToAllocate, _isTopUp);

        // If no deposits to allocate, return current state
        if (depositsToAllocate > 0) {
            // Use MinFirstAllocationStrategy to allocate deposits
            /// @dev due to library is external, the `allocated` array is not mutated
            (totalAllocated, newAllocations) =
                MinFirstAllocationStrategy.allocate(allocated, capacities, depositsToAllocate);
            // Convert allocated validators and allocations per module back to Ether amounts
            totalAllocated *= initialDeposit;
            for (uint256 i = 0; i < modulesCount; ++i) {
                // get allocation delta only: new - current
                allocated[i] = (newAllocations[i] - allocated[i]) * initialDeposit;
                newAllocations[i] *= initialDeposit;
            }
        } else {
            newAllocations = new uint256[](modulesCount);
            // Convert allocations per module back to Ether amounts
            for (uint256 i = 0; i < modulesCount; ++i) {
                newAllocations[i] = allocated[i] * initialDeposit;
                allocated[i] = 0;
            }
        }
    }

    /// @notice calculate allocation amount for single module
    function _getModuleDepositAllocation(
        Config calldata _cfg,
        uint256 _moduleId,
        uint256 _allocateAmount,
        bool _isTopUp
    ) public view returns (uint256 allocation) {
        (, uint256[] memory allocated,) = _getDepositAllocations(_cfg, _allocateAmount, _isTopUp);
        uint256 moduleIdx = SRUtils._getModuleIndexById(_moduleId);
        allocation = allocated[moduleIdx];
    }

    /**
     * @notice calculate allocation amounts for all modules
     * @dev If `_isTopUp` is `true`, allocation is performed for top-up deposits targeting
     *      WC type `0x02` validators. In this case, `_cfg.maxEBType2` used
     *      to correctly calculate the module's capacity.
     *
     * @dev The Allocation logic must preserve the same priority between modules
     *      regardless of the allocation type or amount (initial seed deposits or top-ups).
     *
     *      For seed deposits this is straightforward. Both regular modules (0x01)
     *      and modules with keys 0x02 use the same depositableValidatorsCount metric,
     *      so the allocation priority is naturally consistent.
     *
     *      Top-up allocation is less obvious and requires additional considerations.
     *
     *      Important facts:
     *
     *      1. Top-ups are only possible for modules with keys type 0x02.
     *      2. The total top-up amount is limited by the unused capacity of already active keys.
     *      3. The method call with the flag `isTopUp = true` is used only when calculating
     *         top-up allocations. In other words, the values returned for modules 0x01
     *         are ignored by the caller.
     *
     *      Since allocation uses the MinFirstAllocationStrategy, we must not exclude
     *      modules 0x01 from the selection during top-up calculations (for example,
     *      by setting their capacity to zero). If we did, the algorithm would attempt
     *      to distribute the entire available amount only across modules 0x02.
     *
     *      This would incorrectly increase the priority of deposits into modules 0x02
     *      relative to modules 0x01.
     *
     *      Therefore the following approach is used:
     *
     *      - For modules 0x01 we keep the same capacity as for regular seed deposits.
     *        Formally, these modules cannot receive top-ups, but they must remain
     *        visible to the allocation strategy to preserve priority ordering.
     *
     *      - For modules 0x02 the capacity is set only to the remaining unused capacity
     *        of already active keys.
     *
     *      At first glance this may appear to prioritize deposits into modules 0x01.
     *      However, taking fact #3 into account, the returned allocations for modules
     *      0x01 are never used. They are only an artifact of the MinFirstAllocationStrategy.
     *
     *      This design preserves the correct global priority between modules while
     *      still allowing the system to fully utilize the available top-up capacity
     *      of modules with keys type 0x02.
     */
    function _getModulesAllocationAndCapacity(Config calldata _cfg, uint256 depositsToAllocate, bool _isTopUp)
        internal
        view
        returns (uint256[] memory _allocations, uint256[] memory _capacities)
    {
        uint256 modulesCount = SRStorage.getModulesCount();
        _allocations = new uint256[](modulesCount);

        ModuleParamsCache[] memory cache = new ModuleParamsCache[](modulesCount);
        ModuleState storage moduleState;
        ModuleStateConfig memory stateConfig;

        uint256 totalValidators;
        uint256 maxEBType1 = _cfg.maxEBType1;
        for (uint256 i = 0; i < modulesCount; ++i) {
            uint256 moduleId = SRStorage.getModuleIdAt(i);
            moduleState = moduleId.getModuleState();
            stateConfig = moduleState.config;
            // caching config
            cache[i].shareLimit = stateConfig.stakeShareLimit;
            cache[i].status = stateConfig.status;
            cache[i].wcType = stateConfig.withdrawalCredentialsType;
            (uint256 exitedValidatorsCount, uint256 depositedValidatorsCount, uint256 depositableValidatorsCount) =
                _getStakingModuleSummary(moduleId.getIStakingModule());
            cache[i].depositableCount = depositableValidatorsCount;

            // get active validators count
            uint256 validatorsCount = depositedValidatorsCount
                - Math.max(exitedValidatorsCount, moduleState.accounting.exitedValidatorsCount);

            // save to cache
            cache[i].activeCount = validatorsCount;

            if (WithdrawalCredentials.isType2(stateConfig.withdrawalCredentialsType)) {
                // Calculate equivalent of WC01 validators count rounded up: ceil(balance / maxEBType1)
                validatorsCount = Math.ceilDiv(moduleId.getIStakingModuleV2().getTotalModuleStake(), maxEBType1);
            }
            _allocations[i] = validatorsCount;
            totalValidators += validatorsCount;
        }
        // new total validators count after allocation
        totalValidators += depositsToAllocate;
        _capacities = new uint256[](modulesCount);

        // put calldata msxEBType2 to stack
        uint256 maxEBType2 = _cfg.maxEBType2;

        for (uint256 i = 0; i < modulesCount; ++i) {
            // module initial capacity = current allocation
            uint256 validatorsCapacity = _allocations[i];
            if (cache[i].status == StakingModuleStatus.Active) {
                if (_isTopUp && WithdrawalCredentials.isType2(cache[i].wcType)) {
                    // max eth capacity of active validators = n * maxEB,
                    // so capacity in validators equivalent = n * maxEBType2 / msxEBType1
                    validatorsCapacity = cache[i].activeCount * maxEBType2 / maxEBType1;
                } else {
                    validatorsCapacity = _allocations[i] + cache[i].depositableCount;
                }
                // Calculate target validators for each module based on stake share limits
                // Target validators = (stakeShareLimit * totalValidators) / TOTAL_BASIS_POINTS
                uint256 targetValidators = (cache[i].shareLimit * totalValidators) / SRUtils.TOTAL_BASIS_POINTS;
                // Module capacity is limited by available validators and target share
                validatorsCapacity = Math.min(targetValidators, validatorsCapacity);
            }

            _capacities[i] = validatorsCapacity;
        }
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
    function _reportValidatorExitDelay(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        uint256 _proofSlotTimestamp,
        bytes calldata _publicKey,
        uint256 _eligibleToExitInSec
    ) public {
        SRUtils._requireModuleIdExists(_stakingModuleId);
        _stakingModuleId.getIStakingModule()
            .reportValidatorExitDelay(_nodeOperatorId, _proofSlotTimestamp, _publicKey, _eligibleToExitInSec);
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
    function _onValidatorExitTriggered(
        ValidatorExitData[] calldata validatorExitData,
        uint256 _withdrawalRequestPaidFee,
        uint256 _exitType
    ) public {
        ValidatorExitData calldata data;
        for (uint256 i = 0; i < validatorExitData.length; ++i) {
            data = validatorExitData[i];
            SRUtils._requireModuleIdExists(data.stakingModuleId);
            try data.stakingModuleId.getIStakingModule()
                .onValidatorExitTriggered(data.nodeOperatorId, data.pubkey, _withdrawalRequestPaidFee, _exitType) {}
            catch (bytes memory lowLevelRevertData) {
                /// @dev This check is required to prevent incorrect gas estimation of the method.
                ///      Without it, Ethereum nodes that use binary search for gas estimation may
                ///      return an invalid value when the onValidatorExitTriggered()
                ///      reverts because of the "out of gas" error. Here we assume that the
                ///      onValidatorExitTriggered() method doesn't have reverts with
                ///      empty error data except "out of gas".
                if (lowLevelRevertData.length == 0) revert ISRBase.UnrecoverableModuleError();
                emit ISRBase.StakingModuleExitNotificationFailed(data.stakingModuleId, data.nodeOperatorId, data.pubkey);
            }
        }
    }

    /// @notice Reports the minted rewards to the staking modules with the specified ids.
    /// @param _stakingModuleIds Ids of the staking modules.
    /// @param _totalShares Total shares minted for the staking modules.
    /// @dev The function is restricted to the `REPORT_REWARDS_MINTED_ROLE` role.
    function _reportRewardsMinted(uint256[] calldata _stakingModuleIds, uint256[] calldata _totalShares) public {
        uint256 n = _stakingModuleIds.length;
        if (_totalShares.length != n) revert ISRBase.ArraysLengthMismatch();

        for (uint256 i = 0; i < n; ++i) {
            if (_totalShares[i] == 0) continue;
            SRUtils._requireModuleIdExists(_stakingModuleIds[i]);

            try _stakingModuleIds[i].getIStakingModule().onRewardsMinted(_totalShares[i]) {}
            catch (bytes memory lowLevelRevertData) {
                /// @dev This check is required to prevent incorrect gas estimation of the method.
                ///      Without it, Ethereum nodes that use binary search for gas estimation may
                ///      return an invalid value when the onRewardsMinted() reverts because of the
                ///      "out of gas" error. Here we assume that the onRewardsMinted() method doesn't
                ///      have reverts with empty error data except "out of gas".
                if (lowLevelRevertData.length == 0) revert ISRBase.UnrecoverableModuleError();
                emit ISRBase.RewardsMintedReportFailed(_stakingModuleIds[i], lowLevelRevertData);
            }
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
    function _onValidatorsCountsByNodeOperatorReportingFinished() public {
        uint256 modulesCount = SRStorage.getModulesCount();

        for (uint256 i; i < modulesCount; ++i) {
            uint256 moduleId = SRStorage.getModuleIdAt(i);
            ModuleState storage state = moduleId.getModuleState();
            IStakingModule stakingModule = state.getIStakingModule();

            (uint256 exitedValidatorsCount,,) = _getStakingModuleSummary(stakingModule);
            if (exitedValidatorsCount != state.accounting.exitedValidatorsCount) continue;

            // oracle finished updating exited validators for all node ops
            try stakingModule.onExitedAndStuckValidatorsCountsUpdated() {}
            catch (bytes memory lowLevelRevertData) {
                /// @dev This check is required to prevent incorrect gas estimation of the method.
                ///      Without it, Ethereum nodes that use binary search for gas estimation may
                ///      return an invalid value when the onExitedAndStuckValidatorsCountsUpdated()
                ///      reverts because of the "out of gas" error. Here we assume that the
                ///      onExitedAndStuckValidatorsCountsUpdated() method doesn't have reverts with
                ///      empty error data except "out of gas".
                if (lowLevelRevertData.length == 0) revert ISRBase.UnrecoverableModuleError();
                emit ISRBase.ExitedAndStuckValidatorsCountsUpdateFailed(moduleId, lowLevelRevertData);
            }
        }
    }

    /// @notice Decreases vetted signing keys counts per node operator for the staking module with
    /// the specified id.
    /// @param _stakingModuleId The id of the staking module to be updated.
    /// @param _nodeOperatorIds Ids of the node operators to be updated.
    /// @param _vettedSigningKeysCounts New counts of vetted signing keys for the specified node operators.
    /// @dev The function is restricted to the `STAKING_MODULE_UNVETTING_ROLE` role.
    function _decreaseStakingModuleVettedKeysCountByNodeOperator(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _vettedSigningKeysCounts
    ) public {
        SRUtils._requireModuleIdExists(_stakingModuleId);
        _checkOperatorsReportData(_nodeOperatorIds, _vettedSigningKeysCounts);
        _stakingModuleId.getIStakingModule().decreaseVettedSigningKeysCount(_nodeOperatorIds, _vettedSigningKeysCounts);
    }

    /// @notice Updates exited validators counts per node operator for the staking module with
    /// the specified id. See the docs for `updateExitedValidatorsCountByStakingModule` for the
    /// description of the overall update process.
    ///
    /// @param _stakingModuleId The id of the staking modules to be updated.
    /// @param _nodeOperatorIds Ids of the node operators to be updated.
    /// @param _exitedValidatorsCounts New counts of exited validators for the specified node operators.
    function _reportStakingModuleOperatorExitedValidators(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _exitedValidatorsCounts
    ) public {
        SRUtils._requireModuleIdExists(_stakingModuleId);
        _checkOperatorsReportData(_nodeOperatorIds, _exitedValidatorsCounts);
        _stakingModuleId.getIStakingModule().updateExitedValidatorsCount(_nodeOperatorIds, _exitedValidatorsCounts);
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
    ///    finish until the new oracle reporting frame is started, in which case staking router will emit ISRBase.a warning
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
    function _updateExitedValidatorsCountByStakingModule(
        uint256[] calldata _stakingModuleIds,
        uint256[] calldata _exitedValidatorsCounts
    ) public returns (uint256) {
        uint256 n = _stakingModuleIds.length;
        if (_exitedValidatorsCounts.length != n) revert ISRBase.ArraysLengthMismatch();

        uint256 newlyExitedValidatorsCount;

        for (uint256 i = 0; i < n; ++i) {
            uint256 moduleId = _stakingModuleIds[i];
            SRUtils._requireModuleIdExists(moduleId);
            ModuleState storage state = moduleId.getModuleState();
            ModuleStateAccounting storage moduleAcc = state.accounting;
            uint64 prevReportedExitedValidatorsCount = moduleAcc.exitedValidatorsCount;

            uint64 newReportedExitedValidatorsCount = SafeCast.toUint64(_exitedValidatorsCounts[i]);

            if (newReportedExitedValidatorsCount < prevReportedExitedValidatorsCount) {
                revert ISRBase.ExitedValidatorsCountCannotDecrease();
            }

            (uint256 totalExitedValidators, uint256 totalDepositedValidators,) =
                _getStakingModuleSummary(state.getIStakingModule());

            if (newReportedExitedValidatorsCount > totalDepositedValidators) {
                revert ISRBase.ReportedExitedValidatorsExceedDeposited(
                    newReportedExitedValidatorsCount, totalDepositedValidators
                );
            }

            newlyExitedValidatorsCount += newReportedExitedValidatorsCount - prevReportedExitedValidatorsCount;

            if (totalExitedValidators < prevReportedExitedValidatorsCount) {
                // not all of the exited validators were async reported to the module
                unchecked {
                    emit ISRBase.StakingModuleExitedValidatorsIncompleteReporting(
                        moduleId, prevReportedExitedValidatorsCount - totalExitedValidators
                    );
                }
            }

            // save new value
            moduleAcc.exitedValidatorsCount = newReportedExitedValidatorsCount;
        }

        return newlyExitedValidatorsCount;
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
    function _unsafeSetExitedValidatorsCount(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        bool _triggerUpdateFinish,
        ValidatorsCountsCorrection calldata _correction
    ) public {
        SRUtils._requireModuleIdExists(_stakingModuleId);
        ModuleState storage state = _stakingModuleId.getModuleState();
        ModuleStateAccounting storage moduleAcc = state.accounting;
        uint64 prevReportedExitedValidatorsCount = moduleAcc.exitedValidatorsCount;
        IStakingModule stakingModule = state.getIStakingModule();

        (,,,,, uint256 totalExitedValidators,,) = stakingModule.getNodeOperatorSummary(_nodeOperatorId);

        if (
            _correction.currentModuleExitedValidatorsCount != prevReportedExitedValidatorsCount
                || _correction.currentNodeOperatorExitedValidatorsCount != totalExitedValidators
        ) {
            revert ISRBase.UnexpectedCurrentValidatorsCount(prevReportedExitedValidatorsCount, totalExitedValidators);
        }

        moduleAcc.exitedValidatorsCount = SafeCast.toUint64(_correction.newModuleExitedValidatorsCount);

        stakingModule.unsafeUpdateValidatorsCount(_nodeOperatorId, _correction.newNodeOperatorExitedValidatorsCount);

        (uint256 moduleTotalExitedValidators, uint256 moduleTotalDepositedValidators,) =
            _getStakingModuleSummary(stakingModule);

        if (_correction.newModuleExitedValidatorsCount > moduleTotalDepositedValidators) {
            revert ISRBase.ReportedExitedValidatorsExceedDeposited(
                _correction.newModuleExitedValidatorsCount, moduleTotalDepositedValidators
            );
        }

        if (_triggerUpdateFinish) {
            if (moduleTotalExitedValidators != _correction.newModuleExitedValidatorsCount) {
                revert ISRBase.UnexpectedFinalExitedValidatorsCount(
                    moduleTotalExitedValidators, _correction.newModuleExitedValidatorsCount
                );
            }

            stakingModule.onExitedAndStuckValidatorsCountsUpdated();
        }
    }

    /// @dev report MUST include all modules in the same order as they are registered in the SR
    function _validateReportValidatorBalancesByStakingModule(
        uint256[] calldata _stakingModuleIds,
        uint256[] calldata _validatorBalancesGwei
    ) public view {
        uint256 n = SRStorage.getModulesCount();

        if (_stakingModuleIds.length != n || _validatorBalancesGwei.length != n) {
            revert ISRBase.ArraysLengthMismatch();
        }

        for (uint256 i = 0; i < n; ++i) {
            uint256 moduleId = SRStorage.getModuleIdAt(i);
            if (moduleId != _stakingModuleIds[i]) revert ISRBase.UnexpectedModuleId(moduleId, _stakingModuleIds[i]);

            SRUtils._ensureAmountGwei(_validatorBalancesGwei[i]);
        }
    }

    /// @dev report MUST include all modules in the same order as they are registered in the SR
    function _reportValidatorBalancesByStakingModule(
        uint256[] calldata _stakingModuleIds,
        uint256[] calldata _validatorBalancesGwei
    ) public {
        _validateReportValidatorBalancesByStakingModule(_stakingModuleIds, _validatorBalancesGwei);

        uint256 n = _stakingModuleIds.length;
        uint64 totalValidatorsBalanceGwei;
        for (uint256 i = 0; i < n; ++i) {
            uint256 moduleId = _stakingModuleIds[i];
            ModuleStateAccounting storage moduleAcc = moduleId.getModuleState().accounting;
            uint64 validatorsBalanceGwei = uint64(_validatorBalancesGwei[i]);

            moduleAcc.validatorsBalanceGwei = validatorsBalanceGwei;

            totalValidatorsBalanceGwei += validatorsBalanceGwei;
        }
        RouterStateAccounting storage routerAcc = SRStorage.getRouterState().accounting;
        routerAcc.validatorsBalanceGwei = totalValidatorsBalanceGwei;
    }

    /// @dev Save the last deposit state for the staking module
    /// @param _moduleId id of the staking module to be deposited
    function _updateModuleLastDepositState(uint256 _moduleId) public {
        ModuleStateDeposits storage stateDeposits = _moduleId.getModuleState().deposits;

        stateDeposits.lastDepositAt = uint64(block.timestamp);
        stateDeposits.lastDepositBlock = uint64(block.number);
    }

    function _notifyStakingModulesOfWithdrawalCredentialsChange() public {
        uint256 modulesCount = SRStorage.getModulesCount();

        for (uint256 i; i < modulesCount; ++i) {
            uint256 moduleId = SRStorage.getModuleIdAt(i);

            try moduleId.getIStakingModule().onWithdrawalCredentialsChanged() {}
            catch (bytes memory lowLevelRevertData) {
                if (lowLevelRevertData.length == 0) revert ISRBase.UnrecoverableModuleError();
                if (moduleId.getModuleState().config.status == StakingModuleStatus.Active) {
                    _setModuleStatus(moduleId, StakingModuleStatus.DepositsPaused);
                }
                emit ISRBase.WithdrawalsCredentialsChangeFailed(moduleId, lowLevelRevertData);
            }
        }
    }

    function _checkOperatorsReportData(bytes calldata _ids, bytes calldata _values) internal pure {
        if (_ids.length % 8 != 0 || _values.length % 16 != 0) {
            revert ISRBase.InvalidReportData(3);
        }
        uint256 count = _ids.length / 8;
        if (_values.length / 16 != count) {
            revert ISRBase.InvalidReportData(2);
        }
        if (count == 0) {
            revert ISRBase.InvalidReportData(1);
        }
    }
}
