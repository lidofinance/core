// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "./utils/access/AccessControlEnumerable.sol";
import {PausableUntil} from "./utils/PausableUntil.sol";

/**
 * @title A base contract for a withdrawal vault implementing EIP-7685: General Purpose Execution Layer Requests
 * @dev This contract enables validators to submit EIP-7002 withdrawal requests
 *      and manages the associated fees.
 */
abstract contract WithdrawalVaultEIP7685 is AccessControlEnumerable, PausableUntil {
    address constant CONSOLIDATION_REQUEST = 0x0000BBdDc7CE488642fb579F8B00f3a590007251;
    address constant WITHDRAWAL_REQUEST = 0x00000961Ef480Eb55e80D19ad83579A64c007002;

    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 public constant ADD_WITHDRAWAL_REQUEST_ROLE = keccak256("ADD_WITHDRAWAL_REQUEST_ROLE");
    bytes32 public constant ADD_CONSOLIDATION_REQUEST_ROLE = keccak256("ADD_CONSOLIDATION_REQUEST_ROLE");

    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    event WithdrawalRequestAdded(bytes request);
    event ConsolidationRequestAdded(bytes request);

    error ZeroArgument(string name);
    error MalformedPubkeysArray();
    error ArraysLengthMismatch(uint256 firstArrayLength, uint256 secondArrayLength);

    error FeeReadFailed();
    error FeeInvalidData();
    error IncorrectFee(uint256 providedFee, uint256 requiredFee);

    error RequestAdditionFailed(bytes callData);

    /// @dev Ensures the contract’s ETH balance is unchanged.
    modifier preservesEthBalance() {
        uint256 balanceBeforeCall = address(this).balance - msg.value;
        _;
        assert(address(this).balance == balanceBeforeCall);
    }

    /**
     * @dev Resumes the general purpose execution layer requests.
     * @notice Reverts if:
     *         - The contract is not paused.
     *         - The sender does not have the `RESUME_ROLE`.
     */
    function resume() external onlyRole(RESUME_ROLE) {
        _resume();
    }

    /**
     * @notice Pauses the general purpose execution layer requests placement for a specified duration.
     * @param _duration The pause duration in seconds (use `PAUSE_INFINITELY` for unlimited).
     * @dev Reverts if:
     *         - The contract is already paused.
     *         - The sender does not have the `PAUSE_ROLE`.
     *         - A zero duration is passed.
     */
    function pauseFor(uint256 _duration) external onlyRole(PAUSE_ROLE) {
        _pauseFor(_duration);
    }

    /**
     * @notice Pauses the general purpose execution layer requests placement until a specified timestamp.
     * @param _pauseUntilInclusive The last second to pause until (inclusive).
     * @dev Reverts if:
     *         - The timestamp is in the past.
     *         - The sender does not have the `PAUSE_ROLE`.
     *         - The contract is already paused.
     */
    function pauseUntil(uint256 _pauseUntilInclusive) external onlyRole(PAUSE_ROLE) {
        _pauseUntil(_pauseUntilInclusive);
    }

    /**
     * @dev Submits EIP-7002 full or partial withdrawal requests for the specified public keys.
     *      Each full withdrawal request instructs a validator to fully withdraw its stake and exit its duties as a validator.
     *      Each partial withdrawal request instructs a validator to withdraw a specified amount of ETH.
     *
     * @param pubkeys A tightly packed array of 48-byte public keys corresponding to validators requesting partial withdrawals.
     *                | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param amounts An array of 8-byte unsigned integers representing the amounts to be withdrawn for each corresponding public key.
     *                For full withdrawal requests, the amount should be set to 0.
     *                For partial withdrawal requests, the amount should be greater than 0.
     *
     * @notice Reverts if:
     *         - The caller does not have the `ADD_WITHDRAWAL_REQUEST_ROLE`.
     *         - The provided public key array is empty.
     *         - The provided public key array malformed.
     *         - The provided public key and amount arrays are not of equal length.
     *         - The provided total withdrawal fee value is invalid.
     */
    function addWithdrawalRequests(
        bytes calldata pubkeys,
        uint64[] calldata amounts
    ) external payable onlyRole(ADD_WITHDRAWAL_REQUEST_ROLE) whenResumed preservesEthBalance {
        if (pubkeys.length == 0) revert ZeroArgument("pubkeys");
        if (pubkeys.length % PUBLIC_KEY_LENGTH != 0) revert MalformedPubkeysArray();

        uint256 requestsCount = _countPubkeys(pubkeys);
        if (requestsCount != amounts.length) revert ArraysLengthMismatch(requestsCount, amounts.length);

        uint256 feePerRequest = _getRequestFee(WITHDRAWAL_REQUEST);
        uint256 totalFee = requestsCount * feePerRequest;

        _requireExactFee(totalFee);

        bytes memory request = new bytes(56);
        for (uint256 i = 0; i < requestsCount; i++) {
            uint64 amount = amounts[i];
            assembly {
                calldatacopy(add(request, 32), add(pubkeys.offset, mul(i, PUBLIC_KEY_LENGTH)), PUBLIC_KEY_LENGTH)
                mstore(add(request, 80), shl(192, amount))
            }

            (bool success, ) = WITHDRAWAL_REQUEST.call{value: feePerRequest}(request);

            if (!success) {
                revert RequestAdditionFailed(request);
            }

            emit WithdrawalRequestAdded(request);
        }
    }

    /**
     * @dev Retrieves the current EIP-7002 withdrawal fee.
     * @return The minimum fee required per withdrawal request.
     */
    function getWithdrawalRequestFee() external view returns (uint256) {
        return _getRequestFee(WITHDRAWAL_REQUEST);
    }

    /**
     * @dev Submits EIP-7251 consolidation requests for the specified public keys.
     *
     * @param sourcePubkeys A tightly packed array of 48-byte source public keys corresponding to validators requesting consolidation.
     *                | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param targetPubkeys A tightly packed array of 48-byte target public keys corresponding to validators requesting consolidation.
     *                | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @notice Reverts if:
     *         - The caller does not have the `ADD_CONSOLIDATION_REQUEST_ROLE`.
     *         - The provided public key array is empty.
     *         - The provided public key array malformed.
     *         - The provided source public key and target public key arrays are not of equal length.
     *         - The provided total withdrawal fee value is invalid.
     */
    function addConsolidationRequests(
        bytes calldata sourcePubkeys,
        bytes calldata targetPubkeys
    ) external payable onlyRole(ADD_CONSOLIDATION_REQUEST_ROLE) whenResumed preservesEthBalance {
        if (sourcePubkeys.length == 0) revert ZeroArgument("sourcePubkeys");
        if (sourcePubkeys.length % PUBLIC_KEY_LENGTH != 0) revert MalformedPubkeysArray();
        if (sourcePubkeys.length != targetPubkeys.length)
            revert ArraysLengthMismatch(sourcePubkeys.length, sourcePubkeys.length);

        uint256 requestsCount = _countPubkeys(sourcePubkeys);
        uint256 feePerRequest = _getRequestFee(CONSOLIDATION_REQUEST);

        _requireExactFee(requestsCount * feePerRequest);

        bytes memory request = new bytes(96);
        for (uint256 i = 0; i < requestsCount; i++) {
            assembly {
                calldatacopy(add(request, 32), add(sourcePubkeys.offset, mul(i, PUBLIC_KEY_LENGTH)), PUBLIC_KEY_LENGTH)
                calldatacopy(add(request, 80), add(targetPubkeys.offset, mul(i, PUBLIC_KEY_LENGTH)), PUBLIC_KEY_LENGTH)
            }

            (bool success, ) = CONSOLIDATION_REQUEST.call{value: feePerRequest}(request);

            if (!success) {
                revert RequestAdditionFailed(request);
            }

            emit ConsolidationRequestAdded(request);
        }
    }

    /**
     * @dev Retrieves the current EIP-7251 consolidation fee.
     * @return The minimum fee required per consolidation request.
     */
    function getConsolidationRequestFee() external view returns (uint256) {
        return _getRequestFee(CONSOLIDATION_REQUEST);
    }

    function _getRequestFee(address requestedContract) internal view returns (uint256) {
        (bool success, bytes memory feeData) = requestedContract.staticcall("");

        if (!success) {
            revert FeeReadFailed();
        }

        if (feeData.length != 32) {
            revert FeeInvalidData();
        }

        return abi.decode(feeData, (uint256));
    }

    function _countPubkeys(bytes calldata pubkeys) internal pure returns (uint256) {
        return (pubkeys.length / PUBLIC_KEY_LENGTH);
    }

    function _requireExactFee(uint256 requiredFee) internal view {
        if (requiredFee != msg.value) {
            revert IncorrectFee(msg.value, requiredFee);
        }
    }
}
