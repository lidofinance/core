// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {Math} from "@openzeppelin/contracts-v5.2/utils/math/Math.sol";
import {StorageSlot} from "@openzeppelin/contracts-v5.2/utils/StorageSlot.sol";
import {Math256} from "contracts/common/lib/Math256.sol";
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
    ValidatorsCountsCorrection
} from "./SRTypes.sol";

library SRLib {
    using StorageSlot for bytes32;
    using WithdrawalCredentials for bytes32;
    using SRStorage for ModuleState;
    using SRStorage for uint256; // for module IDs

    event ExitedAndStuckValidatorsCountsUpdateFailed(uint256 indexed stakingModuleId, bytes lowLevelRevertData);
    event RewardsMintedReportFailed(uint256 indexed stakingModuleId, bytes lowLevelRevertData);
    event StakingModuleExitedValidatorsIncompleteReporting(
        uint256 indexed stakingModuleId, uint256 unreportedExitedValidatorsCount
    );
    event WithdrawalsCredentialsChangeFailed(uint256 indexed stakingModuleId, bytes lowLevelRevertData);
    event StakingModuleExitNotificationFailed(
        uint256 indexed stakingModuleId, uint256 indexed nodeOperatorId, bytes _publicKey
    );
    event StakingModuleShareLimitSet(
        uint256 indexed stakingModuleId, uint256 stakeShareLimit, uint256 priorityExitShareThreshold, address setBy
    );
    event StakingModuleFeesSet(
        uint256 indexed stakingModuleId, uint256 stakingModuleFee, uint256 treasuryFee, address setBy
    );
    event StakingModuleStatusSet(uint256 indexed stakingModuleId, StakingModuleStatus status, address setBy);
    event StakingModuleMaxDepositsPerBlockSet(
        uint256 indexed stakingModuleId, uint256 maxDepositsPerBlock, address setBy
    );
    event StakingModuleMinDepositBlockDistanceSet(
        uint256 indexed stakingModuleId, uint256 minDepositBlockDistance, address setBy
    );
    /// Emitted when the StakingRouter received ETH
    // event StakingRouterETHDeposited(uint256 indexed stakingModuleId, uint256 amount);

    uint256 public constant FEE_PRECISION_POINTS = 10 ** 20; // 100 * 10 ** 18

    /// @dev [deprecated] old storage slots, remove after 1st migration
    bytes32 internal constant STAKING_MODULES_MAPPING_POSITION = keccak256("lido.StakingRouter.moduleStates");
    /// @dev [deprecated] old storage slots, remove after 1st migration
    bytes32 internal constant STAKING_MODULE_INDICES_MAPPING_POSITION =
        keccak256("lido.StakingRouter.stakingModuleIndicesOneBased");
    /// @dev [deprecated] old storage slots, remove after 1st migration
    bytes32 internal constant LIDO_POSITION = keccak256("lido.StakingRouter.lido");
    /// @dev [deprecated] old storage slots, remove after 1st migration
    bytes32 internal constant WITHDRAWAL_CREDENTIALS_POSITION = keccak256("lido.StakingRouter.withdrawalCredentials");
    /// @dev [deprecated] old storage slots, remove after 1st migration
    bytes32 internal constant STAKING_MODULES_COUNT_POSITION = keccak256("lido.StakingRouter.stakingModulesCount");
    /// @dev [deprecated] old storage slots, remove after 1st migration
    bytes32 internal constant LAST_STAKING_MODULE_ID_POSITION = keccak256("lido.StakingRouter.lastModuleId");

    error WrongInitialMigrationState();
    error StakingModuleAddressExists();
    error BPSOverflow();
    error ArraysLengthMismatch(uint256 firstArrayLength, uint256 secondArrayLength);
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
    error InvalidReportData(uint256 code);
    error InvalidDepositAmount();

    function _migrateStorage() public {
        // revert migration if data is already exists
        if (SRStorage.getModulesCount() > 0) {
            return;
            // revert WrongInitialMigrationState();
        }

        // migrate Lido address
        SRStorage.getRouterStorage().lido = LIDO_POSITION.getAddressSlot().value;
        // cleanup old storage slot fully as bytes32
        delete LIDO_POSITION.getBytes32Slot().value;

        // migrate last staking module ID
        SRStorage.getRouterStorage().lastModuleId = uint24(LAST_STAKING_MODULE_ID_POSITION.getUint256Slot().value);
        delete LAST_STAKING_MODULE_ID_POSITION.getBytes32Slot().value;

        // migrate WC
        SRStorage.getRouterStorage().withdrawalCredentials = WITHDRAWAL_CREDENTIALS_POSITION.getBytes32Slot().value;
        delete WITHDRAWAL_CREDENTIALS_POSITION.getBytes32Slot().value;

        uint256 modulesCount = STAKING_MODULES_COUNT_POSITION.getUint256Slot().value;
        delete STAKING_MODULES_COUNT_POSITION.getBytes32Slot().value;

        // get old storage ref. for staking modules mapping
        mapping(uint256 => StakingModule) storage oldStakingModules = _getStorageStakingModulesMapping();
        // get old storage ref. for staking modules indices mapping
        mapping(uint256 => uint256) storage oldStakingModuleIndices = _getStorageStakingIndicesMapping();
        uint96 totalClBalanceGwei;
        StakingModule memory smOld;

        for (uint256 i; i < modulesCount; ++i) {
            smOld = oldStakingModules[i];

            uint256 _moduleId = smOld.id;
            // push module ID to registry
            SRStorage.addModuleId(_moduleId);

            ModuleState storage moduleState = _moduleId.getModuleState();

            // 1 SSTORE
            moduleState.name = smOld.name;

            // 1 SSTORE
            moduleState.setStateConfig(
                ModuleStateConfig({
                    moduleAddress: smOld.stakingModuleAddress,
                    moduleFee: smOld.stakingModuleFee,
                    treasuryFee: smOld.treasuryFee,
                    depositTargetShare: smOld.stakeShareLimit,
                    withdrawalProtectShare: smOld.priorityExitShareThreshold,
                    status: StakingModuleStatus(smOld.status),
                    withdrawalCredentialsType: SRUtils.WC_TYPE_01
                })
            );

            // 1 SSTORE
            moduleState.setStateDeposits(
                ModuleStateDeposits({
                    lastDepositAt: smOld.lastDepositAt,
                    lastDepositBlock: uint64(smOld.lastDepositBlock),
                    maxDepositsPerBlock: smOld.maxDepositsPerBlock,
                    minDepositBlockDistance: smOld.minDepositBlockDistance
                })
            );

            // 1 SSTORE
            uint96 effBalanceGwei = _calcEffBalanceGwei(smOld.stakingModuleAddress, smOld.exitedValidatorsCount);
            moduleState.setStateAccounting(
                ModuleStateAccounting({
                    clBalanceGwei: effBalanceGwei,
                    activeBalanceGwei: effBalanceGwei,
                    exitedValidatorsCount: uint64(smOld.exitedValidatorsCount)
                })
            );

            totalClBalanceGwei += effBalanceGwei;

            // cleanup old storage for staking module data
            delete oldStakingModules[i];
            delete oldStakingModuleIndices[_moduleId];
        }

        /// @dev use the same value for both CL balance and active balance at migration moment,
        /// next Oracle report will update the both values
        SRStorage.getRouterStorage().totalClBalanceGwei = totalClBalanceGwei;
        SRStorage.getRouterStorage().totalActiveBalanceGwei = totalClBalanceGwei;
    }

    /// @dev calculate module effective balance at the migration moment
    function _calcEffBalanceGwei(address moduleAddress, uint256 routerExitedValidatorsCount)
        private
        view
        returns (uint96)
    {
        IStakingModule stakingModule = IStakingModule(moduleAddress);
        (uint256 exitedValidatorsCount, uint256 depositedValidatorsCount,) = stakingModule.getStakingModuleSummary();
        // The module might not receive all exited validators data yet => we need to replacing
        // the exitedValidatorsCount with the one that the staking router is aware of.
        uint256 activeCount = depositedValidatorsCount - Math.max(routerExitedValidatorsCount, exitedValidatorsCount);

        return SRUtils._toGwei(activeCount * SRUtils.MAX_EFFECTIVE_BALANCE_WC_TYPE_01);
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
        SRUtils._validateModuleAddress(_moduleAddress);
        SRUtils._validateModuleName(_moduleName);
        SRUtils._validateModulesCount();
        SRUtils._validateWithdrawalCredentialsType(_moduleConfig.withdrawalCredentialsType);

        // Check for duplicate module address
        /// @dev due to small number of modules, we can afford to do this check on add
        uint256[] memory moduleIds = SRStorage.getModuleIds();
        for (uint256 i; i < moduleIds.length; ++i) {
            if (_moduleAddress == moduleIds[i].getModuleState().getStateConfig().moduleAddress) {
                revert StakingModuleAddressExists();
            }
        }

        newModuleId = SRStorage.getRouterStorage().lastModuleId + 1;
        // push new module ID to registry
        SRStorage.addModuleId(newModuleId);

        ModuleState storage moduleState = newModuleId.getModuleState();
        moduleState.config.moduleAddress = _moduleAddress;
        moduleState.config.status = StakingModuleStatus.Active;
        moduleState.config.withdrawalCredentialsType = uint8(_moduleConfig.withdrawalCredentialsType);
        moduleState.name = _moduleName;

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
        SRStorage.getRouterStorage().lastModuleId = uint24(newModuleId);
        return newModuleId;
    }

    function _updateModuleParams(
        uint256 _moduleId,
        uint256 _stakeShareLimit,
        uint256 _priorityExitShareThreshold,
        uint256 _stakingModuleFee,
        uint256 _treasuryFee,
        uint256 _maxDepositsPerBlock,
        uint256 _minDepositBlockDistance
    ) public {
        SRUtils._validateModuleShare(_stakeShareLimit, _priorityExitShareThreshold);
        SRUtils._validateModuleFee(_stakingModuleFee, _treasuryFee);
        SRUtils._validateModuleDepositParams(_minDepositBlockDistance, _maxDepositsPerBlock);

        // 1 SLOAD
        ModuleStateConfig memory stateConfig = _moduleId.getModuleState().getStateConfig();
        // forge-lint: disable-start(unsafe-typecast)
        stateConfig.moduleFee = uint16(_stakingModuleFee);
        stateConfig.treasuryFee = uint16(_treasuryFee);
        stateConfig.depositTargetShare = uint16(_stakeShareLimit);
        stateConfig.withdrawalProtectShare = uint16(_priorityExitShareThreshold);
        // 1 SSTORE
        _moduleId.getModuleState().setStateConfig(stateConfig);

        // 1 SLOAD
        ModuleStateDeposits memory stateDeposits = _moduleId.getModuleState().getStateDeposits();
        stateDeposits.maxDepositsPerBlock = uint64(_maxDepositsPerBlock);
        stateDeposits.minDepositBlockDistance = uint64(_minDepositBlockDistance);
        // forge-lint: disable-end(unsafe-typecast)
        // 1 SSTORE
        _moduleId.getModuleState().setStateDeposits(stateDeposits);
    }

    /// @dev module state helpers

    function _setModuleStatus(uint256 _moduleId, StakingModuleStatus _status) public returns (bool isChanged) {
        ModuleStateConfig storage stateConfig = _moduleId.getModuleState().getStateConfig();
        isChanged = stateConfig.status != _status;
        if (isChanged) {
            stateConfig.status = _status;
            emit StakingModuleStatusSet(_moduleId, _status, _msgSender());
        }
    }

    /// @dev mimic OpenZeppelin ContextUpgradeable._msgSender()
    function _msgSender() internal view returns (address) {
        return msg.sender;
    }

    /// @notice Deposit allocation for modules
    /// @dev Allocates deposits to staking modules based on their stake share limits and available capacity.
    ///      The allocation algorithm prioritizes modules with lower validator (WC 0x01 equivalent) counts (MinFirst strategy).
    /// @dev Method uses ugly conversion from/to Ether amounts due to MinFirstAllocationStrategy working with unit values.
    ///      NB: new allocation library was ready, but at the last minute some strong-opinion folks chickened out, so we had to roll it back :)
    /// @param _allocateAmount - Eth amount that should be allocated into modules
    /// @return allocated - amount actually allocated
    /// @return allocations - Array of allocation amounts for each module
    function _getDepositAllocations(uint256 _allocateAmount, bool _isTopUp)
        public
        view
        returns (uint256 allocated, uint256[] memory allocations)
    {
        uint256 modulesCount = SRStorage.getModulesCount();
        if (modulesCount == 0) {
            return (0, new uint256[](0));
        }

        uint256[] memory capacities;
        uint256 depositsToAllocate = _allocateAmount / SRUtils.MAX_EFFECTIVE_BALANCE_WC_TYPE_01;
        (allocations, capacities) = _getModulesAllocationAndCapacity(depositsToAllocate, _isTopUp);

        // If no deposits to allocate, return current state
        if (depositsToAllocate > 0) {
            // Use MinFirstAllocationStrategy to allocate deposits
            (allocated, allocations) = MinFirstAllocationStrategy.allocate(allocations, capacities, depositsToAllocate);
        }

        // Convert allocated validators and allocations per module back to Ether amounts
        allocated *= SRUtils.MAX_EFFECTIVE_BALANCE_WC_TYPE_01;
        for (uint256 i = 0; i < modulesCount; ++i) {
            allocations[i] *= SRUtils.MAX_EFFECTIVE_BALANCE_WC_TYPE_01;
        }
    }

    function _getModuleDepositAllocation(uint256 _moduleId, uint256 _allocateAmount, bool _isTopUp)
        public
        view
        returns (uint256 allocation)
    {
        (, uint256[] memory allocations) = _getDepositAllocations(_allocateAmount, _isTopUp);
        uint256 moduleIdx = SRUtils._getModuleIndexById(_moduleId);
        allocation = allocations[moduleIdx];
    }

    function _getModulesAllocationAndCapacity(uint256 depositsToAllocate, bool _isTopUp)
        internal
        view
        returns (uint256[] memory _allocations, uint256[] memory _capacities)
    {
        uint256[] memory moduleIds = SRStorage.getModuleIds();
        uint256 modulesCount = moduleIds.length;
        uint256 totalValidators;
        _allocations = new uint256[](modulesCount);

        for (uint256 i = 0; i < modulesCount; ++i) {
            uint256 moduleId = moduleIds[i];
            // Calculate equivalent of active WC01 validators count: ceil(balance / MAX_EFFECTIVE_BALANCE_WC_TYPE_01)
            uint256 validatorsCount =
                Math256.ceilDiv(SRUtils._getModuleBalance(moduleId), SRUtils.MAX_EFFECTIVE_BALANCE_WC_TYPE_01);
            _allocations[i] = validatorsCount;
            totalValidators += validatorsCount;
        }
        // new total validators count after allocation
        totalValidators += depositsToAllocate;

        ModuleState storage moduleState;
        _capacities = new uint256[](modulesCount);

        for (uint256 i = 0; i < modulesCount; ++i) {
            uint256 moduleId = moduleIds[i];
            moduleState = moduleId.getModuleState();
            ModuleStateConfig memory stateConfig = moduleState.getStateConfig();

            uint256 validatorsCapacity = _allocations[i];

            if (stateConfig.status == StakingModuleStatus.Active) {
                (uint256 exitedValidators, uint256 depositedValidators, uint256 depositableValidatorsCount) =
                    moduleId.getIStakingModule().getStakingModuleSummary();

                if (_isTopUp) {
                    // The module might not receive all exited validators data yet => we need to replacing
                    // the exitedValidatorsCount with the one that the staking router is aware of.
                    uint256 activeValidators = depositedValidators
                        - Math256.max(exitedValidators, moduleState.getStateAccounting().exitedValidatorsCount);
                    // max eth capacity of active validators = n * 2048ETH,
                    // so capacity in validators equivalent = n * 2048 / 32 = n * 64
                    validatorsCapacity = activeValidators * 64;
                } else {
                    validatorsCapacity = _allocations[i] + depositableValidatorsCount;
                }
                // Calculate target validators for each module based on stake share limits
                // Target validators = (stakeShareLimit * totalValidators) / TOTAL_BASIS_POINTS
                uint256 targetValidators =
                    (stateConfig.depositTargetShare * totalValidators) / SRUtils.TOTAL_BASIS_POINTS;

                // Module capacity is limited by available validators and target share
                validatorsCapacity = Math256.min(targetValidators, validatorsCapacity);
            }

            _capacities[i] = validatorsCapacity;
        }
    }

    /// @dev old storage ref. for staking modules mapping, remove after 1st migration
    function _getStorageStakingModulesMapping()
        internal
        pure
        returns (mapping(uint256 => StakingModule) storage result)
    {
        bytes32 position = STAKING_MODULES_MAPPING_POSITION;
        assembly ("memory-safe") {
            result.slot := position
        }
    }

    /// @dev old storage ref. for staking modules mapping, remove after 1st migration
    function _getStorageStakingIndicesMapping() internal pure returns (mapping(uint256 => uint256) storage result) {
        bytes32 position = STAKING_MODULE_INDICES_MAPPING_POSITION;
        assembly ("memory-safe") {
            result.slot := position
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
        SRUtils._validateModuleId(_stakingModuleId);
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
            SRUtils._validateModuleId(data.stakingModuleId);
            try data.stakingModuleId.getIStakingModule()
                .onValidatorExitTriggered(data.nodeOperatorId, data.pubkey, _withdrawalRequestPaidFee, _exitType) {}
            catch (bytes memory lowLevelRevertData) {
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

    /// @notice Reports the minted rewards to the staking modules with the specified ids.
    /// @param _stakingModuleIds Ids of the staking modules.
    /// @param _totalShares Total shares minted for the staking modules.
    /// @dev The function is restricted to the `REPORT_REWARDS_MINTED_ROLE` role.
    function _reportRewardsMinted(uint256[] calldata _stakingModuleIds, uint256[] calldata _totalShares) public {
        _validateEqualArrayLengths(_stakingModuleIds.length, _totalShares.length);

        for (uint256 i = 0; i < _stakingModuleIds.length; ++i) {
            if (_totalShares[i] == 0) continue;
            SRUtils._validateModuleId(_stakingModuleIds[i]);

            try _stakingModuleIds[i].getIStakingModule().onRewardsMinted(_totalShares[i]) {}
            catch (bytes memory lowLevelRevertData) {
                /// @dev This check is required to prevent incorrect gas estimation of the method.
                ///      Without it, Ethereum nodes that use binary search for gas estimation may
                ///      return an invalid value when the onRewardsMinted() reverts because of the
                ///      "out of gas" error. Here we assume that the onRewardsMinted() method doesn't
                ///      have reverts with empty error data except "out of gas".
                if (lowLevelRevertData.length == 0) revert UnrecoverableModuleError();
                emit RewardsMintedReportFailed(_stakingModuleIds[i], lowLevelRevertData);
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
        uint256[] memory _stakingModuleIds = SRStorage.getModuleIds();

        for (uint256 i; i < _stakingModuleIds.length; ++i) {
            uint256 moduleId = _stakingModuleIds[i];
            ModuleState storage state = moduleId.getModuleState();
            IStakingModule stakingModule = state.getIStakingModule();

            (uint256 exitedValidatorsCount,,) = stakingModule.getStakingModuleSummary();
            if (exitedValidatorsCount != state.getStateAccounting().exitedValidatorsCount) continue;

            // oracle finished updating exited validators for all node ops
            try stakingModule.onExitedAndStuckValidatorsCountsUpdated() {}
            catch (bytes memory lowLevelRevertData) {
                /// @dev This check is required to prevent incorrect gas estimation of the method.
                ///      Without it, Ethereum nodes that use binary search for gas estimation may
                ///      return an invalid value when the onExitedAndStuckValidatorsCountsUpdated()
                ///      reverts because of the "out of gas" error. Here we assume that the
                ///      onExitedAndStuckValidatorsCountsUpdated() method doesn't have reverts with
                ///      empty error data except "out of gas".
                if (lowLevelRevertData.length == 0) revert UnrecoverableModuleError();
                emit ExitedAndStuckValidatorsCountsUpdateFailed(moduleId, lowLevelRevertData);
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
        SRUtils._validateModuleId(_stakingModuleId);
        _checkValidatorsByNodeOperatorReportData(_nodeOperatorIds, _vettedSigningKeysCounts);
        _stakingModuleId.getIStakingModule().decreaseVettedSigningKeysCount(_nodeOperatorIds, _vettedSigningKeysCounts);
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
    function _reportStakingModuleExitedValidatorsCountByNodeOperator(
        uint256 _stakingModuleId,
        bytes calldata _nodeOperatorIds,
        bytes calldata _exitedValidatorsCounts
    ) public {
        SRUtils._validateModuleId(_stakingModuleId);
        _checkValidatorsByNodeOperatorReportData(_nodeOperatorIds, _exitedValidatorsCounts);
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
    function _updateExitedValidatorsCountByStakingModule(
        uint256[] calldata _stakingModuleIds,
        uint256[] calldata _exitedValidatorsCounts
    ) public returns (uint256) {
        _validateEqualArrayLengths(_stakingModuleIds.length, _exitedValidatorsCounts.length);

        uint256 newlyExitedValidatorsCount;

        for (uint256 i = 0; i < _stakingModuleIds.length; ++i) {
            uint256 moduleId = _stakingModuleIds[i];
            SRUtils._validateModuleId(moduleId);
            ModuleState storage state = moduleId.getModuleState();
            ModuleStateAccounting storage stateAccounting = state.getStateAccounting();
            uint64 prevReportedExitedValidatorsCount = stateAccounting.exitedValidatorsCount;
            //todo check max uint64
            uint64 newReportedExitedValidatorsCount = uint64(_exitedValidatorsCounts[i]);

            if (newReportedExitedValidatorsCount < prevReportedExitedValidatorsCount) {
                revert ExitedValidatorsCountCannotDecrease();
            }

            (uint256 totalExitedValidators, uint256 totalDepositedValidators,) =
                state.getIStakingModule().getStakingModuleSummary();

            if (newReportedExitedValidatorsCount > totalDepositedValidators) {
                revert ReportedExitedValidatorsExceedDeposited(
                    newReportedExitedValidatorsCount, totalDepositedValidators
                );
            }

            newlyExitedValidatorsCount += newReportedExitedValidatorsCount - prevReportedExitedValidatorsCount;

            if (totalExitedValidators < prevReportedExitedValidatorsCount) {
                // not all of the exited validators were async reported to the module
                unchecked {
                    emit StakingModuleExitedValidatorsIncompleteReporting(
                        moduleId, prevReportedExitedValidatorsCount - totalExitedValidators
                    );
                }
            }

            // save new value
            stateAccounting.exitedValidatorsCount = newReportedExitedValidatorsCount;
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
    // todo REMOVE?
    function _unsafeSetExitedValidatorsCount(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        bool _triggerUpdateFinish,
        ValidatorsCountsCorrection calldata _correction
    ) public {
        SRUtils._validateModuleId(_stakingModuleId);
        ModuleState storage state = _stakingModuleId.getModuleState();
        ModuleStateAccounting storage stateAccounting = state.getStateAccounting();
        uint64 prevReportedExitedValidatorsCount = stateAccounting.exitedValidatorsCount;
        IStakingModule stakingModule = state.getIStakingModule();

        (,,,,, uint256 totalExitedValidators,,) = stakingModule.getNodeOperatorSummary(_nodeOperatorId);

        if (
            _correction.currentModuleExitedValidatorsCount != prevReportedExitedValidatorsCount
                || _correction.currentNodeOperatorExitedValidatorsCount != totalExitedValidators
        ) {
            revert UnexpectedCurrentValidatorsCount(prevReportedExitedValidatorsCount, totalExitedValidators);
        }
        // todo check max uint64
        stateAccounting.exitedValidatorsCount = uint64(_correction.newModuleExitedValidatorsCount);

        stakingModule.unsafeUpdateValidatorsCount(_nodeOperatorId, _correction.newNodeOperatorExitedValidatorsCount);

        (uint256 moduleTotalExitedValidators, uint256 moduleTotalDepositedValidators,) =
            stakingModule.getStakingModuleSummary();

        if (_correction.newModuleExitedValidatorsCount > moduleTotalDepositedValidators) {
            revert ReportedExitedValidatorsExceedDeposited(
                _correction.newModuleExitedValidatorsCount, moduleTotalDepositedValidators
            );
        }

        if (_triggerUpdateFinish) {
            if (moduleTotalExitedValidators != _correction.newModuleExitedValidatorsCount) {
                revert UnexpectedFinalExitedValidatorsCount(
                    moduleTotalExitedValidators, _correction.newModuleExitedValidatorsCount
                );
            }

            stakingModule.onExitedAndStuckValidatorsCountsUpdated();
        }
    }

    function _reportActiveBalancesByStakingModule(
        uint256[] calldata _stakingModuleIds,
        uint256[] calldata _activeBalancesGwei,
        uint256[] calldata _pendingBalancesGwei
    ) public {
        _validateEqualArrayLengths(_stakingModuleIds.length, _activeBalancesGwei.length);
        _validateEqualArrayLengths(_stakingModuleIds.length, _pendingBalancesGwei.length);

        uint96 totalClBalanceGwei = SRStorage.getRouterStorage().totalClBalanceGwei;
        uint96 totalActiveBalanceGwei = SRStorage.getRouterStorage().totalActiveBalanceGwei;

        for (uint256 i = 0; i < _stakingModuleIds.length; ++i) {
            uint256 moduleId = _stakingModuleIds[i];
            SRUtils._validateModuleId(moduleId);
            SRUtils._validateAmountGwei(_activeBalancesGwei[i]);
            SRUtils._validateAmountGwei(_pendingBalancesGwei[i]);
            uint96 activeBalanceGwei = uint96(_activeBalancesGwei[i]);
            uint96 clBalanceGwei = activeBalanceGwei + uint96(_pendingBalancesGwei[i]);

            ModuleStateAccounting storage stateAccounting = moduleId.getModuleState().getStateAccounting();
            // update totals incrementally as we iterate through the part of modules in general case
            totalClBalanceGwei = totalClBalanceGwei - stateAccounting.clBalanceGwei + clBalanceGwei;
            totalActiveBalanceGwei = totalActiveBalanceGwei - stateAccounting.activeBalanceGwei + activeBalanceGwei;
            stateAccounting.clBalanceGwei = clBalanceGwei;
            stateAccounting.activeBalanceGwei = activeBalanceGwei;
        }
        SRStorage.getRouterStorage().totalClBalanceGwei = totalClBalanceGwei;
        SRStorage.getRouterStorage().totalActiveBalanceGwei = totalActiveBalanceGwei;
    }

    function _notifyStakingModulesOfWithdrawalCredentialsChange() public {
        uint256[] memory _stakingModuleIds = SRStorage.getModuleIds();

        for (uint256 i; i < _stakingModuleIds.length; ++i) {
            uint256 moduleId = _stakingModuleIds[i];

            try moduleId.getIStakingModule().onWithdrawalCredentialsChanged() {}
            catch (bytes memory lowLevelRevertData) {
                if (lowLevelRevertData.length == 0) revert UnrecoverableModuleError();
                _setModuleStatus(moduleId, StakingModuleStatus.DepositsPaused);
                emit WithdrawalsCredentialsChangeFailed(moduleId, lowLevelRevertData);
            }
        }
    }

    function _checkValidatorsByNodeOperatorReportData(bytes calldata _nodeOperatorIds, bytes calldata _validatorsCounts)
        internal
        pure
    {
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

    function _validateEqualArrayLengths(uint256 firstArrayLength, uint256 secondArrayLength) internal pure {
        if (firstArrayLength != secondArrayLength) {
            revert ArraysLengthMismatch(firstArrayLength, secondArrayLength);
        }
    }

    function _asSingletonArray(uint256 element) private pure returns (uint256[] memory) {
        uint256[] memory array = new uint256[](1);
        array[0] = element;

        return array;
    }
}
