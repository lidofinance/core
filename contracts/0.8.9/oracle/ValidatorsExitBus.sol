// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {SafeCast} from "@openzeppelin/contracts-v4.4/utils/math/SafeCast.sol";

import {AccessControlEnumerable} from "../utils/access/AccessControlEnumerable.sol";
import {UnstructuredStorage} from "../lib/UnstructuredStorage.sol";
import {Versioned} from "../utils/Versioned.sol";
import {PausableUntil} from "../utils/PausableUntil.sol";
import {WithdrawalCredentials} from "../../common/lib/WithdrawalCredentials.sol";
import {WithdrawalIntent, MAX_PWR_AMOUNT_GWEI} from "../../common/interfaces/WithdrawalIntent.sol";
import {ITriggerableWithdrawalsBus} from "../../common/interfaces/ITriggerableWithdrawalsBus.sol";

/// @notice New interface for staking modules (CSM, CuratedV2)
/// @dev Returns only pubkeys
interface IUnifiedStakingModule {
    /// @dev It also works for legacy staking modules (NOR, SDVT) where `getSigningKeys` returns different
    ///      tuple `(bytes memory pubkeys, bytes memory signatures, bool[] memory used)`.
    ///      The trick: `abi.decode(returndata, (bytes))` will decode only the first tuple element.
    ///      This is safe as long as the first returned value really is `bytes pubkeys` in that position.
    function getSigningKeys(
        uint256 nodeOperatorId,
        uint256 startIndex,
        uint256 keysCount
    ) external view returns (bytes memory);
}

interface IStakingRouter {
    struct ModuleStateConfig {
        address moduleAddress;
        uint16 moduleFee;
        uint16 treasuryFee;
        uint16 stakeShareLimit;
        uint16 priorityExitShareThreshold;
        uint8 status;
        uint8 withdrawalCredentialsType;
        bool partialWithdrawalsAllowed;
    }

    function getStakingModuleStateConfig(uint256 _stakingModuleId)
        external
        view
        returns (ModuleStateConfig memory stateConfig);
}

interface ILidoLocator {
    function triggerableWithdrawalsBus() external view returns (address);
    function oracleReportSanityChecker() external view returns (address);
    function stakingRouter() external view returns (address);
}

interface IOracleReportSanityCheckerForExitBus {
    function getMaxEffectiveBalanceWeightWCType01() external view returns (uint256);
    function getMaxEffectiveBalanceWeightWCType02() external view returns (uint256);
}

/**
 * @title ValidatorsExitBus
 * @notice Decodes oracle report records into withdrawal request intents (EIP-7002 partial and full
 * withdrawals) and appends them to the TriggerableWithdrawalsBus queue.
 */
abstract contract ValidatorsExitBus is AccessControlEnumerable, PausableUntil, Versioned {
    using UnstructuredStorage for bytes32;
    using SafeCast for uint256;

    /**
     * @notice Thrown when an invalid zero value is passed
     * @param name Name of the argument that was zero
     */
    error ZeroArgument(string name);

    /**
     * @notice Thrown when exit request has wrong length
     */
    error InvalidRequestsDataLength();

    /**
     * @notice Thrown when module id equal to zero
     */
    error InvalidModuleId();

    /**
     * @notice Thrown when retrieved pubkey length is invalid
     */
    error InvalidRetrievedKeyLength();

    /**
     * @notice Thrown when a report contains more records than MAX_REQUESTS_PER_REPORT
     * @param requestsCount Number of records in the report
     * @param maxRequestsPerReport Maximum number of records allowed per report
     */
    error TooManyRequestsInReport(uint256 requestsCount, uint256 maxRequestsPerReport);

    /**
     * @notice Thrown when a partial withdrawal is requested for a module that does not allow it
     * @param moduleId Staking module ID
     */
    error PartialWithdrawalsNotAllowed(uint256 moduleId);

    /**
     * @notice Thrown when a partial withdrawal amount exceeds MAX_PWR_AMOUNT_GWEI
     * @param index Index of the record in the report
     * @param amount Requested amount in gwei
     */
    error WithdrawalAmountTooLarge(uint256 index, uint256 amount);

    error InvalidMaxEBWeight();
    error UnexpectedWCType();

    /**
     * @notice Emitted for every withdrawal request intent added to the TriggerableWithdrawalsBus queue
     * @param moduleId Staking module ID
     * @param nodeOperatorId Node operator ID
     * @param pubkey Validator public key
     * @param amountGwei Withdrawal amount in gwei: `0` is a full withdrawal, `> 0` is a partial one
     */
    event WithdrawalRequested(
        uint256 indexed moduleId,
        uint256 indexed nodeOperatorId,
        bytes pubkey,
        uint256 amountGwei
    );

    // /**
    //  * @notice Emitted when exit requests were delivered
    //  * @param exitRequestsHash keccak256 hash of the encoded validators list
    //  */
    // event ExitDataProcessing(bytes32 exitRequestsHash);

    /// @dev Staking module data cached while iterating over report records
    struct ModuleCache {
        uint256 moduleId;
        address moduleAddress;
        bool partialWithdrawalsAllowed;
        uint256 fwrWeightEth; // sanity weight of one FWR: max effective balance for the module's WC type
    }

    /// @notice An ACL role granting the permission to pause accepting validator exit requests
    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    /// @notice An ACL role granting the permission to resume accepting validator exit requests
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");

    /// Length in bytes of packed request
    uint256 internal constant PACKED_REQUEST_LENGTH = 24;

    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    /// @notice Maximum number of records in a single report
    uint256 public immutable MAX_REQUESTS_PER_REPORT;

    /// @notice Format of the report `data` field.
    ///
    /// Each withdrawal request is described by the following 24-byte record:
    ///
    /// MSB <------------------------------------------------ LSB
    /// |  3 bytes   |  5 bytes   |  8 bytes   |  8 bytes        |
    /// |  moduleId  |  nodeOpId  |  keyIndex  |  amount (gwei)  |
    ///
    ///  `amount == 0` is a full withdrawal request (FWR), `amount > 0` is a partial
    /// withdrawal request (PWR). The validator pubkey is read from the staking module by `keyIndex`.
    /// All records are tightly packed into a byte array without any separator or padding.
    /// Records are not sorted: their order is the execution priority and is kept in the
    /// TriggerableWithdrawalsBus queue.

    ILidoLocator internal immutable LOCATOR;

    /// @dev Storage slot: uint256 totalRequestsProcessed
    bytes32 internal constant TOTAL_REQUESTS_PROCESSED_POSITION =
        keccak256("lido.ValidatorsExitBusOracle.totalRequestsProcessed");

    /// @dev [DEPRECATED] Storage slot: uint256 at keccak256("lido.ValidatorsExitBus.maxExitRequestLimit")
    /// Exit request limit by validators count (v2), replaced by the exit balance limit in v3.
    /// @dev [DEPRECATED] Storage slot: LimitData at keccak256("lido.ValidatorsExitBus.exitBalanceLimitEth")
    /// Exit balance rate limit (in ETH) for the exit requests hash-delivery path.
    /// @dev [DEPRECATED] Storage slot: uint256 at keccak256("lido.ValidatorsExitBus.maxValidatorsPerReport")
    /// Maximum number of exit requests per report.
    /// This code was removed from the contract, but slots can still contain data.

    /// @dev [DEPRECATED] Storage slot: mapping(bytes32 => RequestStatus) at keccak256("lido.ValidatorsExitBus.requestStatus")
    /// This mapping was previously used for storing the delivery timestamp and contract version per exit requests hash.
    /// This code was removed from the contract, but slots can still contain data.

    constructor(address lidoLocator, uint256 maxRequestsPerReport) {
        if (maxRequestsPerReport == 0) revert ZeroArgument("maxRequestsPerReport");
        LOCATOR = ILidoLocator(lidoLocator);
        MAX_REQUESTS_PER_REPORT = maxRequestsPerReport;
    }

    function MAX_EFFECTIVE_BALANCE_WEIGHT_WC_TYPE_01() public view returns (uint16) {
        (uint16 maxEBWeightType1, ) = _getMaxEffectiveBalanceWeights();
        return maxEBWeightType1;
    }

    function MAX_EFFECTIVE_BALANCE_WEIGHT_WC_TYPE_02() public view returns (uint16) {
        (, uint16 maxEBWeightType2) = _getMaxEffectiveBalanceWeights();
        return maxEBWeightType2;
    }

    /// @notice Resume accepting validator exit requests
    ///
    /// @dev Reverts with `PausedExpected()` if contract is already resumed
    /// @dev Reverts with `AccessControl:...` reason if sender has no `RESUME_ROLE`
    ///
    function resume() external whenPaused onlyRole(RESUME_ROLE) {
        _resume();
    }

    /// @notice Pause accepting validator exit requests util in after duration.
    ///
    /// @param _duration Pause duration, seconds (use `PAUSE_INFINITELY` for unlimited).
    /// @dev Reverts with `ResumedExpected()` if contract is already paused.
    /// @dev Reverts with `AccessControl:...` reason if sender has no `PAUSE_ROLE`.
    /// @dev Reverts with `ZeroPauseDuration()` if zero duration is passed.
    ///
    function pauseFor(uint256 _duration) external onlyRole(PAUSE_ROLE) {
        _pauseFor(_duration);
    }

    /// @notice Pause accepting report data.
    /// @param _pauseUntilInclusive The last second to pause until.
    /// @dev Reverts with `ResumeSinceInPast()` if the timestamp is in the past.
    /// @dev Reverts with `AccessControl:...` reason if sender has no `PAUSE_ROLE`.
    /// @dev Reverts with `ResumedExpected()` if contract is already paused.
    function pauseUntil(uint256 _pauseUntilInclusive) external onlyRole(PAUSE_ROLE) {
        _pauseUntil(_pauseUntilInclusive);
    }

    /// @notice Returns the total number of validator exit requests ever processed
    /// across all received reports.
    ///
    function getTotalRequestsProcessed() external view returns (uint256) {
        return TOTAL_REQUESTS_PROCESSED_POSITION.getStorageUint256();
    }

    /// Internal functions


    function _getMaxEffectiveBalanceWeights() internal view returns (uint16 maxEBWeightType1, uint16 maxEBWeightType2) {
        IOracleReportSanityCheckerForExitBus sanityChecker =
            IOracleReportSanityCheckerForExitBus(LOCATOR.oracleReportSanityChecker());

        uint256 maxEBWeightType1Raw = sanityChecker.getMaxEffectiveBalanceWeightWCType01();
        uint256 maxEBWeightType2Raw = sanityChecker.getMaxEffectiveBalanceWeightWCType02();
        if (
            maxEBWeightType1Raw == 0 || maxEBWeightType2Raw == 0 || maxEBWeightType1Raw > type(uint16).max
                || maxEBWeightType2Raw > type(uint16).max
        ) {
            revert InvalidMaxEBWeight();
        }

        maxEBWeightType1 = maxEBWeightType1Raw.toUint16();
        maxEBWeightType2 = maxEBWeightType2Raw.toUint16();
    }

    function _getModuleMaxEBWeight(
        uint256 wcType,
        uint16 maxEBWeightType1,
        uint16 maxEBWeightType2
    ) internal pure returns (uint16) {
        if (WithdrawalCredentials.isType1(wcType)) {
            return maxEBWeightType1;
        } else if (WithdrawalCredentials.isType2(wcType)) {
            return maxEBWeightType2;
        }
        revert UnexpectedWCType();
    }

    /**
     * @notice Returns the validator pubkey registered in the staking module
     * @param moduleAddress Staking module address
     * @param nodeOpId Node operator ID
     * @param keyIndex Index of the node operator's key in the module
     * @return pubkey Validator public key (48 bytes)
     */
    function _getKey(
        address moduleAddress,
        uint256 nodeOpId,
        uint256 keyIndex
    ) internal view returns (bytes memory pubkey) {
        pubkey = IUnifiedStakingModule(moduleAddress)
            .getSigningKeys(
                nodeOpId,
                keyIndex, // startIndex
                1 // keysCount: get only 1 key
            );

        if (pubkey.length != PUBLIC_KEY_LENGTH) {
            revert InvalidRetrievedKeyLength();
        }
    }

    /**
     * @notice Decodes report records into withdrawal request intents and computes the report's
     *         total exit balance for the sanity check
     * @dev Records are processed in the report order, which is the execution priority, so no sorting is checked.
     *      Emits `WithdrawalRequested` for every record.
     * @param data Packed report records, see the data format above
     * @return intents Withdrawal request intents to append to the TriggerableWithdrawalsBus queue, in report order
     * @return totalExitBalanceEth Total exit balance in ETH: a PWR is weighed at its amount (rounded up to ETH
     *         for the whole report), an FWR at the max effective balance for the module's WC type
     */
    function _processWithdrawalRequests(bytes calldata data)
        internal
        returns (WithdrawalIntent[] memory intents, uint256 totalExitBalanceEth)
    {
        uint256 requestsCount = data.length / PACKED_REQUEST_LENGTH;
        intents = new WithdrawalIntent[](requestsCount);

        (uint16 maxEBWeightType1, uint16 maxEBWeightType2) = _getMaxEffectiveBalanceWeights();
        // Cache module data to avoid repeated external calls for the same module
        ModuleCache memory module;
        uint256 totalPwrGwei;

        for (uint256 i = 0; i < requestsCount; ++i) {
            (uint256 moduleId, uint256 nodeOpId, uint256 keyIndex, uint256 amount) = _decodeRequest(data, i);

            if (moduleId == 0) {
                revert InvalidModuleId();
            }

            if (moduleId != module.moduleId) {
                module = _getModuleCache(moduleId, maxEBWeightType1, maxEBWeightType2);
            }

            bytes memory pubkey = _getKey(module.moduleAddress, nodeOpId, keyIndex);

            if (amount > 0) {
                if (!module.partialWithdrawalsAllowed) revert PartialWithdrawalsNotAllowed(moduleId);
                if (amount > MAX_PWR_AMOUNT_GWEI) revert WithdrawalAmountTooLarge(i, amount);
                totalPwrGwei += amount;
            } else {
                totalExitBalanceEth += module.fwrWeightEth;
            }

            intents[i] = WithdrawalIntent({amount: uint64(amount), pubkey: pubkey});

            emit WithdrawalRequested(moduleId, nodeOpId, pubkey, amount);
        }

        // PWR amounts are summed in gwei and converted to ETH once, rounding up
        totalExitBalanceEth += (totalPwrGwei + 1e9 - 1) / 1e9;
    }

    /**
     * @notice Decodes the record at `index` from the packed report data
     * @param data Packed report records
     * @param index Index of the record
     */
    function _decodeRequest(bytes calldata data, uint256 index)
        internal
        pure
        returns (uint256 moduleId, uint256 nodeOpId, uint256 keyIndex, uint256 amount)
    {
        uint256 record;
        assembly {
            // the record takes the 24 most significant bytes of the loaded 32-byte word
            record := shr(64, calldataload(add(data.offset, mul(index, PACKED_REQUEST_LENGTH))))
        }

        //                                  record (192 bits)
        // MSB <-------------------------------------------------------------------------- LSB
        // | 24 bits: moduleId | 40 bits: nodeOpId | 64 bits: keyIndex | 64 bits: amount (gwei) |
        moduleId = record >> 168;
        nodeOpId = uint40(record >> 128);
        keyIndex = uint64(record >> 64);
        amount = uint64(record);
    }

    /**
     * @notice Reads the staking module data needed to process its records
     * @param moduleId Staking module ID
     * @param maxEBWeightType1 Max effective balance weight in ETH for 0x01 withdrawal credentials
     * @param maxEBWeightType2 Max effective balance weight in ETH for 0x02 withdrawal credentials
     */
    function _getModuleCache(
        uint256 moduleId,
        uint16 maxEBWeightType1,
        uint16 maxEBWeightType2
    ) internal view returns (ModuleCache memory module) {
        IStakingRouter.ModuleStateConfig memory config =
            IStakingRouter(LOCATOR.stakingRouter()).getStakingModuleStateConfig(moduleId);

        module.moduleId = moduleId;
        module.moduleAddress = config.moduleAddress;
        module.partialWithdrawalsAllowed = config.partialWithdrawalsAllowed;
        module.fwrWeightEth = _getModuleMaxEBWeight(config.withdrawalCredentialsType, maxEBWeightType1, maxEBWeightType2);
    }

    /**
     * @notice Appends withdrawal request intents to the TriggerableWithdrawalsBus queue
     * @param intents Withdrawal request intents, in report order
     */
    function _addWithdrawalIntents(WithdrawalIntent[] memory intents) internal {
        ITriggerableWithdrawalsBus(LOCATOR.triggerableWithdrawalsBus()).addWithdrawalIntents(intents);
    }
}
