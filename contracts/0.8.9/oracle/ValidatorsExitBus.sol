// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "../utils/access/AccessControlEnumerable.sol";
import {UnstructuredStorage} from "../lib/UnstructuredStorage.sol";
import {ILidoLocator} from "../../common/interfaces/ILidoLocator.sol";
import {Versioned} from "../utils/Versioned.sol";
import {ReportExitLimitUtils, ReportExitLimitUtilsStorage, ExitRequestLimitData} from "../lib/ReportExitLimitUtils.sol";
import {PausableUntil} from "../utils/PausableUntil.sol";
import {IValidatorsExitBus} from "../interfaces/IValidatorExitBus.sol";

interface IWithdrawalVault {
    function addFullWithdrawalRequests(bytes calldata pubkeys) external payable;

    function getWithdrawalRequestFee() external view returns (uint256);
}

interface IStakingRouter {
    function onValidatorExitTriggered(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        bytes calldata _publicKey,
        uint256 _withdrawalRequestPaidFee,
        uint256 _exitType
    ) external;
}

contract ValidatorsExitBus is IValidatorsExitBus, AccessControlEnumerable, PausableUntil, Versioned {
    using UnstructuredStorage for bytes32;
    using ReportExitLimitUtilsStorage for bytes32;
    using ReportExitLimitUtils for ExitRequestLimitData;

    /// @dev Errors
    error KeyWasNotDelivered(uint256 keyIndex, uint256 lastDeliveredKeyIndex);
    error ZeroAddress();
    error InsufficientPayment(uint256 withdrawalFeePerRequest, uint256 requestCount, uint256 msgValue);
    error TriggerableWithdrawalRefundFailed();
    error ExitHashWasNotSubmitted();
    error KeyIndexOutOfRange(uint256 keyIndex, uint256 totalItemsCount);
    error UnsupportedRequestsDataFormat(uint256 format);
    error InvalidRequestsDataLength();
    error InvalidRequestsData();
    error RequestsAlreadyDelivered();
    error ExitRequestsLimit();
    error InvalidPubkeysArray();
    error NoExitRequestProvided();
    error InvalidRequestsDataSortOrder();

    /// @dev Events
    event MadeRefund(address sender, uint256 refundValue);
    event StoredExitRequestHash(bytes32 exitRequestHash);
    event ValidatorExitRequest(
        uint256 indexed stakingModuleId,
        uint256 indexed nodeOperatorId,
        uint256 indexed validatorIndex,
        bytes validatorPubkey,
        uint256 timestamp
    );
    event ExitRequestsLimitSet(
        uint256 maxExitRequestsLimit,
        uint256 exitRequestsLimitIncreasePerBlock,
        uint256 maxTWExitRequestsLimit,
        uint256 twExitRequestsLimitIncreasePerBlock
    );

    event DirectExitRequest(
        uint256 indexed stakingModuleId,
        uint256 indexed nodeOperatorId,
        bytes validatoPubkey,
        uint256 timestamp
    );
    struct RequestStatus {
        // Total items count in report (by default type(uint32).max, update on first report delivery)
        uint256 totalItemsCount;
        // Total processed items in report (by default 0)
        uint256 deliveredItemsCount;
        // Vebo contract version at the time of hash submission
        uint256 contractVersion;
        DeliveryHistory[] deliverHistory;
    }

    bytes32 public constant SUBMIT_REPORT_HASH_ROLE = keccak256("SUBMIT_REPORT_HASH_ROLE");
    bytes32 public constant DIRECT_EXIT_ROLE = keccak256("DIRECT_EXIT_ROLE");
    bytes32 public constant EXIT_REPORT_LIMIT_ROLE = keccak256("EXIT_REPORT_LIMIT_ROLE");
    /// @notice An ACL role granting the permission to pause accepting validator exit requests
    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    /// @notice An ACL role granting the permission to resume accepting validator exit requests
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");

    /// Length in bytes of packed request
    uint256 internal constant PACKED_REQUEST_LENGTH = 64;

    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    ILidoLocator internal immutable LOCATOR;

    /// @notice The list format of the validator exit requests data. Used when all
    /// requests fit into a single transaction.
    ///
    /// Each validator exit request is described by the following 64-byte array:
    ///
    /// MSB <------------------------------------------------------- LSB
    /// |  3 bytes   |  5 bytes   |     8 bytes      |    48 bytes     |
    /// |  moduleId  |  nodeOpId  |  validatorIndex  | validatorPubkey |
    ///
    /// All requests are tightly packed into a byte array where requests follow
    /// one another without any separator or padding, and passed to the `data`
    /// field of the report structure.
    ///
    /// Requests must be sorted in the ascending order by the following compound
    /// key: (moduleId, nodeOpId, validatorIndex).
    ///
    uint256 public constant DATA_FORMAT_LIST = 1;

    /// Hash constant for mapping exit requests storage
    bytes32 internal constant EXIT_REQUESTS_HASHES_POSITION = keccak256("lido.ValidatorsExitBus.reportHashes");
    bytes32 public constant EXIT_REQUEST_LIMIT_POSITION =
        keccak256("lido.ValidatorsExitBus.maxExitRequestsLimit");
    bytes32 public constant TW_EXIT_REQUEST_LIMIT_POSITION =
        keccak256("lido.ValidatorsExitBus.maxTWExitRequestsLimit");

    /// @dev Ensures the contract’s ETH balance is unchanged.
    modifier preservesEthBalance() {
        uint256 balanceBeforeCall = address(this).balance - msg.value;
        _;
        assert(address(this).balance == balanceBeforeCall);
    }

    constructor(address lidoLocator) {
        LOCATOR = ILidoLocator(lidoLocator);
    }

    function submitReportHash(bytes32 exitReportHash) external whenResumed onlyRole(SUBMIT_REPORT_HASH_ROLE) {
        uint256 contractVersion = getContractVersion();
        _storeExitRequestHash(exitReportHash, type(uint256).max, 0, contractVersion, DeliveryHistory(0, 0));
    }

    function emitExitEvents(ExitRequestData calldata request) external whenResumed {
        bytes calldata data = request.data;

        RequestStatus storage requestStatus = _storageExitRequestsHashes()[
            keccak256(abi.encode(data, request.dataFormat))
        ];

        if (requestStatus.contractVersion == 0) {
            revert ExitHashWasNotSubmitted();
        }

        if (request.dataFormat != DATA_FORMAT_LIST) {
            revert UnsupportedRequestsDataFormat(request.dataFormat);
        }

        if (request.data.length % PACKED_REQUEST_LENGTH != 0) {
            revert InvalidRequestsDataLength();
        }

        _checkContractVersion(requestStatus.contractVersion);

        // By default, totalItemsCount is set to type(uint256).max.
        // If an exit is emitted for the request for the first time, the default value is used for totalItemsCount.
        if (requestStatus.totalItemsCount == type(uint256).max) {
            requestStatus.totalItemsCount = request.data.length / PACKED_REQUEST_LENGTH;
        }

        uint256 deliveredItemsCount = requestStatus.deliveredItemsCount;
        uint256 undeliveredItemsCount = requestStatus.totalItemsCount - deliveredItemsCount;

        if (undeliveredItemsCount == 0) {
            revert RequestsAlreadyDelivered();
        }

        ExitRequestLimitData memory exitRequestLimitData = EXIT_REQUEST_LIMIT_POSITION.getStorageExitRequestLimit();
        uint256 toDeliver;

        if (exitRequestLimitData.isExitRequestLimitSet()) {
            uint256 limit = exitRequestLimitData.calculateCurrentExitRequestLimit();
            if (limit == 0) {
                revert ExitRequestsLimit();
            }

            toDeliver = undeliveredItemsCount > limit ? limit : undeliveredItemsCount;

            EXIT_REQUEST_LIMIT_POSITION.setStorageExitRequestLimit(
                exitRequestLimitData.updatePrevExitRequestsLimit(limit - toDeliver)
            );
        } else {
            toDeliver = undeliveredItemsCount;
        }
        _processExitRequestsList(request.data, deliveredItemsCount, toDeliver);

        requestStatus.deliverHistory.push(DeliveryHistory(deliveredItemsCount + toDeliver - 1, _getTimestamp()));
        requestStatus.deliveredItemsCount += toDeliver;
    }

    /// @notice Triggers exits on the EL via the Withdrawal Vault contract after
    /// @dev This function verifies that the hash of the provided exit request data exists in storage
    // and ensures that the events for the requests specified in the `keyIndexes` array have already been delivered.
    function triggerExits(
        ExitRequestData calldata request,
        uint256[] calldata keyIndexes
    ) external payable whenResumed preservesEthBalance {
        bytes calldata data = request.data;
        RequestStatus storage requestStatus = _storageExitRequestsHashes()[
            keccak256(abi.encode(data, request.dataFormat))
        ];

        if (requestStatus.contractVersion == 0) {
            revert ExitHashWasNotSubmitted();
        }

        if (request.dataFormat != DATA_FORMAT_LIST) {
            revert UnsupportedRequestsDataFormat(request.dataFormat);
        }

        if (request.data.length % PACKED_REQUEST_LENGTH != 0) {
            revert InvalidRequestsDataLength();
        }

        _checkContractVersion(requestStatus.contractVersion);

        // limit check
        ExitRequestLimitData memory exitRequestLimitData = TW_EXIT_REQUEST_LIMIT_POSITION.getStorageExitRequestLimit();

        if (exitRequestLimitData.isExitRequestLimitSet()) {
            uint256 limit = exitRequestLimitData.calculateCurrentExitRequestLimit();

            if (keyIndexes.length > limit) {
                revert ExitRequestsLimit();
            }

            EXIT_REQUEST_LIMIT_POSITION.setStorageExitRequestLimit(
                exitRequestLimitData.updatePrevExitRequestsLimit(limit - keyIndexes.length)
            );
        }

        address withdrawalVaultAddr = LOCATOR.withdrawalVault();
        uint256 withdrawalFee = IWithdrawalVault(withdrawalVaultAddr).getWithdrawalRequestFee();

        if (msg.value < keyIndexes.length * withdrawalFee) {
            revert InsufficientPayment(withdrawalFee, keyIndexes.length, msg.value);
        }

        uint256 lastDeliveredKeyIndex = requestStatus.deliveredItemsCount - 1;

        bytes memory pubkeys = new bytes(keyIndexes.length * PUBLIC_KEY_LENGTH);
        bytes memory pubkey = new bytes(PUBLIC_KEY_LENGTH);

        // TODO: create library for reading DATA
        for (uint256 i = 0; i < keyIndexes.length; i++) {
            if (keyIndexes[i] >= requestStatus.totalItemsCount) {
                revert KeyIndexOutOfRange(keyIndexes[i], requestStatus.totalItemsCount);
            }

            if (keyIndexes[i] > lastDeliveredKeyIndex) {
                revert KeyWasNotDelivered(keyIndexes[i], lastDeliveredKeyIndex);
            }

            uint256 itemOffset;
            uint256 dataWithoutPubkey;
            uint256 index = keyIndexes[i];

            assembly {
                // Compute the start of this packed request (item)
                itemOffset := add(data.offset, mul(PACKED_REQUEST_LENGTH, index))

                // Load the first 16 bytes which contain moduleId (24 bits),
                // nodeOpId (40 bits), and valIndex (64 bits).
                dataWithoutPubkey := shr(128, calldataload(itemOffset))
            }

            // dataWithoutPubkey format (128 bits total):
            // MSB <-------------------- 128 bits --------------------> LSB
            // |   128 bits: zeros  | 24 bits: moduleId | 40 bits: nodeOpId | 64 bits: valIndex |

            uint256 nodeOpId = uint40(dataWithoutPubkey >> 64);
            uint256 moduleId = uint24(dataWithoutPubkey >> (64 + 40));

            if (moduleId == 0) {
                revert InvalidRequestsData();
            }

            assembly {
                let pubkeyCalldataOffset := add(itemOffset, 16)
                let pubkeyMemPtr := add(pubkey, 32)
                let dest := add(pubkeys, add(32, mul(PUBLIC_KEY_LENGTH, i)))

                calldatacopy(dest, pubkeyCalldataOffset, PUBLIC_KEY_LENGTH)
                calldatacopy(pubkeyMemPtr, pubkeyCalldataOffset, PUBLIC_KEY_LENGTH)
            }

            IStakingRouter(LOCATOR.stakingRouter()).onValidatorExitTriggered(
                moduleId,
                nodeOpId,
                pubkey,
                withdrawalFee,
                0
            );
        }

        IWithdrawalVault(withdrawalVaultAddr).addFullWithdrawalRequests{value: keyIndexes.length * withdrawalFee}(
            pubkeys
        );

        _refundFee(keyIndexes.length * withdrawalFee);
    }

    function triggerExitsDirectly(
        DirectExitData calldata exitData
    ) external payable whenResumed onlyRole(DIRECT_EXIT_ROLE) preservesEthBalance returns (uint256) {
        address withdrawalVault = LOCATOR.withdrawalVault();
        uint256 withdrawalFee = IWithdrawalVault(withdrawalVault).getWithdrawalRequestFee();

        if (exitData.validatorsPubkeys.length == 0) {
            revert NoExitRequestProvided();
        }

        if (exitData.validatorsPubkeys.length % PUBLIC_KEY_LENGTH != 0) {
            revert InvalidPubkeysArray();
        }

        uint256 requestsCount = exitData.validatorsPubkeys.length / PUBLIC_KEY_LENGTH;

        ExitRequestLimitData memory twExitRequestLimitData = TW_EXIT_REQUEST_LIMIT_POSITION
            .getStorageExitRequestLimit();

        if (twExitRequestLimitData.isExitRequestLimitSet()) {
            uint256 limit = twExitRequestLimitData.calculateCurrentExitRequestLimit();

            if (requestsCount > limit) {
                revert ExitRequestsLimit();
            }

            TW_EXIT_REQUEST_LIMIT_POSITION.setStorageExitRequestLimit(
                twExitRequestLimitData.updatePrevExitRequestsLimit(limit - requestsCount)
            );
        }

        if (msg.value < withdrawalFee * requestsCount) {
            revert InsufficientPayment(withdrawalFee, requestsCount, msg.value);
        }

        uint256 timestamp = _getTimestamp();

        bytes calldata data = exitData.validatorsPubkeys;

        for (uint256 i = 0; i < requestsCount; i++) {
            bytes memory pubkey = new bytes(PUBLIC_KEY_LENGTH);

            assembly {
                let offset := add(data.offset, mul(i, PUBLIC_KEY_LENGTH))
                let dest := add(pubkey, 0x20)
                calldatacopy(dest, offset, PUBLIC_KEY_LENGTH)
            }

            IStakingRouter(LOCATOR.stakingRouter()).onValidatorExitTriggered(
                exitData.stakingModuleId,
                exitData.nodeOperatorId,
                pubkey,
                withdrawalFee,
                0
            );

            emit DirectExitRequest(exitData.stakingModuleId, exitData.nodeOperatorId, pubkey, timestamp);
        }

        IWithdrawalVault(withdrawalVault).addFullWithdrawalRequests{value: withdrawalFee * requestsCount}(
            exitData.validatorsPubkeys
        );

        return _refundFee(requestsCount * withdrawalFee);
    }

    function setExitRequestLimit(ExitLimits calldata limits) external onlyRole(EXIT_REPORT_LIMIT_ROLE) {
        require(limits.maxExitRequestsLimit != 0, "ZERO_MAX_EXIT_REQUEST_LIMIT");
        require(limits.maxTWExitRequestsLimit != 0, "ZERO_MAX_TW_EXIT_REQUEST_LIMIT");
        require(
            limits.maxExitRequestsLimit >= limits.exitRequestsLimitIncreasePerBlock,
            "TOO_LARGE_EXIT_LIMIT_INCREASE"
        );
        require(
            limits.maxTWExitRequestsLimit >= limits.twExitRequestsLimitIncreasePerBlock,
            "TOO_LARGE_TW_EXIT_LIMIT_INCREASE"
        );
        // TODO: what maximum value for block distance to replenish limits we can set here? limits.maxExitRequestsLimit / limits.exitRequestsLimitIncreasePerBlock

        EXIT_REQUEST_LIMIT_POSITION.setStorageExitRequestLimit(
            EXIT_REQUEST_LIMIT_POSITION.getStorageExitRequestLimit().setExitRequestLimit(
                limits.maxExitRequestsLimit,
                limits.exitRequestsLimitIncreasePerBlock
            )
        );

        TW_EXIT_REQUEST_LIMIT_POSITION.setStorageExitRequestLimit(
            TW_EXIT_REQUEST_LIMIT_POSITION.getStorageExitRequestLimit().setExitRequestLimit(
                limits.maxTWExitRequestsLimit,
                limits.twExitRequestsLimitIncreasePerBlock
            )
        );

        emit ExitRequestsLimitSet(
            limits.maxExitRequestsLimit,
            limits.exitRequestsLimitIncreasePerBlock,
            limits.maxTWExitRequestsLimit,
            limits.twExitRequestsLimitIncreasePerBlock
        );
    }

    function getExitRequestsDeliveryHistory(
        bytes32 exitRequestsHash
    ) external view returns (uint256 totalItemsCount, uint256 deliveredItemsCount, DeliveryHistory[] memory history) {
        RequestStatus storage requestStatus = _storageExitRequestsHashes()[exitRequestsHash];

        if (requestStatus.contractVersion == 0) {
            revert ExitHashWasNotSubmitted();
        }

        return (requestStatus.totalItemsCount, requestStatus.deliveredItemsCount, requestStatus.deliverHistory);
    }

    function unpackExitRequest(
        bytes calldata exitRequests,
        uint256 dataFormat,
        uint256 index
    ) external pure returns (bytes memory pubkey, uint256 nodeOpId, uint256 moduleId, uint256 valIndex) {
        if (dataFormat != DATA_FORMAT_LIST) {
            revert UnsupportedRequestsDataFormat(dataFormat);
        }

        if (exitRequests.length % PACKED_REQUEST_LENGTH != 0) {
            revert InvalidRequestsDataLength();
        }

        if (index >= exitRequests.length / PACKED_REQUEST_LENGTH) {
            revert KeyIndexOutOfRange(index, exitRequests.length / PACKED_REQUEST_LENGTH);
        }

        uint256 itemOffset;
        uint256 dataWithoutPubkey;

        assembly {
            // Compute the start of this packed request (item)
            itemOffset := add(exitRequests.offset, mul(PACKED_REQUEST_LENGTH, index))

            // Load the first 16 bytes which contain moduleId (24 bits),
            // nodeOpId (40 bits), and valIndex (64 bits).
            dataWithoutPubkey := shr(128, calldataload(itemOffset))
        }

        // dataWithoutPubkey format (128 bits total):
        // MSB <-------------------- 128 bits --------------------> LSB
        // |   128 bits: zeros  | 24 bits: moduleId | 40 bits: nodeOpId | 64 bits: valIndex |

        valIndex = uint64(dataWithoutPubkey);
        nodeOpId = uint40(dataWithoutPubkey >> 64);
        moduleId = uint24(dataWithoutPubkey >> (64 + 40));

        // Allocate a new bytes array in memory for the pubkey
        pubkey = new bytes(PUBLIC_KEY_LENGTH);

        assembly {
            // Starting offset in calldata for the pubkey part
            let pubkeyCalldataOffset := add(itemOffset, 16)

            // Memory location of the 'pubkey' bytes array data
            let pubkeyMemPtr := add(pubkey, 32)

            // Copy the 48 bytes of the pubkey from calldata into memory
            calldatacopy(pubkeyMemPtr, pubkeyCalldataOffset, PUBLIC_KEY_LENGTH)
        }

        return (pubkey, nodeOpId, moduleId, valIndex);
    }

    /// @notice Resume accepting validator exit requests
    ///
    /// @dev Reverts with `PausedExpected()` if contract is already resumed
    /// @dev Reverts with `AccessControl:...` reason if sender has no `RESUME_ROLE`
    ///
    function resume() external whenPaused onlyRole(RESUME_ROLE) {
        _resume();
    }

    /// @notice Pause accepting validator exit requests util in after duration
    ///
    /// @param _duration pause duration, seconds (use `PAUSE_INFINITELY` for unlimited)
    /// @dev Reverts with `ResumedExpected()` if contract is already paused
    /// @dev Reverts with `AccessControl:...` reason if sender has no `PAUSE_ROLE`
    /// @dev Reverts with `ZeroPauseDuration()` if zero duration is passed
    ///
    function pauseFor(uint256 _duration) external onlyRole(PAUSE_ROLE) {
        _pauseFor(_duration);
    }

    /// @notice Pause accepting report data
    /// @param _pauseUntilInclusive the last second to pause until
    /// @dev Reverts with `ResumeSinceInPast()` if the timestamp is in the past
    /// @dev Reverts with `AccessControl:...` reason if sender has no `PAUSE_ROLE`
    /// @dev Reverts with `ResumedExpected()` if contract is already paused
    function pauseUntil(uint256 _pauseUntilInclusive) external onlyRole(PAUSE_ROLE) {
        _pauseUntil(_pauseUntilInclusive);
    }

    /// Internal functions

    function _processExitRequestsList(bytes calldata data, uint256 startIndex, uint256 count) internal {
        uint256 offset;
        uint256 offsetPastEnd;
        uint256 lastDataWithoutPubkey = 0;
        uint256 timestamp = _getTimestamp();

        assembly {
            offset := add(data.offset, mul(startIndex, PACKED_REQUEST_LENGTH))
            offsetPastEnd := add(offset, mul(count, PACKED_REQUEST_LENGTH))
        }

        bytes calldata pubkey;

        assembly {
            pubkey.length := 48
        }

        while (offset < offsetPastEnd) {
            uint256 dataWithoutPubkey;
            assembly {
                // 16 most significant bytes are taken by module id, node op id, and val index
                dataWithoutPubkey := shr(128, calldataload(offset))
                // the next 48 bytes are taken by the pubkey
                pubkey.offset := add(offset, 16)
                // totalling to 64 bytes
                offset := add(offset, 64)
            }
            //                              dataWithoutPubkey
            // MSB <---------------------------------------------------------------------- LSB
            // | 128 bits: zeros | 24 bits: moduleId | 40 bits: nodeOpId | 64 bits: valIndex |
            if (dataWithoutPubkey <= lastDataWithoutPubkey) {
                revert InvalidRequestsDataSortOrder();
            }

            uint64 valIndex = uint64(dataWithoutPubkey);
            uint256 nodeOpId = uint40(dataWithoutPubkey >> 64);
            uint256 moduleId = uint24(dataWithoutPubkey >> (64 + 40));

            if (moduleId == 0) {
                revert InvalidRequestsData();
            }

            lastDataWithoutPubkey = dataWithoutPubkey;
            emit ValidatorExitRequest(moduleId, nodeOpId, valIndex, pubkey, timestamp);
        }
    }

    function _refundFee(uint256 fee) internal returns (uint256) {
        uint256 refund = msg.value - fee;

        if (refund > 0) {
            (bool success, ) = msg.sender.call{value: refund}("");

            if (!success) {
                revert TriggerableWithdrawalRefundFailed();
            }

            emit MadeRefund(msg.sender, refund);
        }

        return refund;
    }

    function _getTimestamp() internal view virtual returns (uint256) {
        return block.timestamp; // solhint-disable-line not-rely-on-time
    }

    // this method
    function _storeExitRequestHash(
        bytes32 exitRequestHash,
        uint256 totalItemsCount,
        uint256 deliveredItemsCount,
        uint256 contractVersion,
        DeliveryHistory memory history
    ) internal {
        mapping(bytes32 => RequestStatus) storage hashes = _storageExitRequestsHashes();
        RequestStatus storage request = hashes[exitRequestHash];

        require(request.contractVersion == 0, "Hash already exists");

        request.totalItemsCount = totalItemsCount;
        request.deliveredItemsCount = deliveredItemsCount;
        request.contractVersion = contractVersion;
        if (history.timestamp != 0) {
            request.deliverHistory.push(history);
        }

        emit StoredExitRequestHash(exitRequestHash);
    }

    /// Storage helpers
    function _storageExitRequestsHashes() internal pure returns (mapping(bytes32 => RequestStatus) storage r) {
        bytes32 position = EXIT_REQUESTS_HASHES_POSITION;
        assembly {
            r.slot := position
        }
    }
}
