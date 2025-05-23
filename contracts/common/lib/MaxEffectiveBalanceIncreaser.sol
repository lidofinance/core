// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9 <0.9.0;

/**
 * @title A lib for EIP-7251: Increase the MAX_EFFECTIVE_BALANCE.
 * Allow validators to have larger effective balances, while maintaining the 32 ETH lower bound.
 */
library MaxEffectiveBalanceIncreaser {
    address constant CONSOLIDATION_REQUEST_PREDEPLOY_ADDRESS = 0x0000BBdDc7CE488642fb579F8B00f3a590007251;

    uint256 internal constant PUBLIC_KEY_LENGTH = 48;
    uint256 internal constant CONSOLIDATION_REQUEST_CALLDATA_LENGTH = 48 * 2;

    error ConsolidationFeeReadFailed();
    error ConsolidationFeeInvalidData();
    error MalformedPubkeysArray();
    error NoConsolidationRequests();
    error ConsolidationRequestAdditionFailed(bytes callData);
    error MalformedTargetPubkey();

    /**
     * @dev Send EIP-7251 consolidation requests for the specified public keys.
     *      Each request instructs a validator to consolidate its stake to the target validator.
     *
     * @param sourcePubkeys A tightly packed array of 48-byte public keys corresponding to validators requesting consolidation.
     *      | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param targetPubkey A 48-byte public key corresponding to the validator to consolidate to.
     *
     * @param feePerRequest The consolidation fee for each consolidation request.
     *        - Must be greater than or equal to the current minimal consolidation fee.
     *
     * @notice Reverts if:
     *         - Validation of the public keys fails.
     *         - The provided fee per request is insufficient.
     *         - The contract has an insufficient balance to cover the total fees.
     */
    function addConsolidationRequest(bytes calldata sourcePubkeys, bytes calldata targetPubkey, uint256 feePerRequest) internal {
        uint256 sourcePubkeysCount = _validateAndCountPubkeys(sourcePubkeys);

        if (targetPubkey.length != PUBLIC_KEY_LENGTH) {
            revert MalformedTargetPubkey();
        }

        bytes memory callData = new bytes(CONSOLIDATION_REQUEST_CALLDATA_LENGTH);

        for (uint256 i = 0; i < sourcePubkeysCount; i++) {
            _copyPubkeyToMemory(sourcePubkeys, callData, i);
            _copyPubkeyToMemory(targetPubkey, callData, 0);

            (bool success, ) = CONSOLIDATION_REQUEST_PREDEPLOY_ADDRESS.call{value: feePerRequest}(callData);

            if (!success) {
                revert ConsolidationRequestAdditionFailed(callData);
            }
        }
    }
    /**
     * @dev Retrieves the current EIP-7251 consolidation fee.
     * @return The minimum fee required per consolidation request.
     */
    function getConsolidationRequestFee() internal view returns (uint256) {
        (bool success, bytes memory feeData) = CONSOLIDATION_REQUEST_PREDEPLOY_ADDRESS.staticcall("");

        if (!success) {
            revert ConsolidationFeeReadFailed();
        }

        if (feeData.length != 32) {
            revert ConsolidationFeeInvalidData();
        }

        return abi.decode(feeData, (uint256));
    }

    function _copyPubkeyToMemory(bytes calldata pubkeys, bytes memory target, uint256 keyIndex) private pure {
        assembly {
            calldatacopy(add(target, 32), add(pubkeys.offset, mul(keyIndex, PUBLIC_KEY_LENGTH)), PUBLIC_KEY_LENGTH)
        }
    }

    function _validateAndCountPubkeys(bytes calldata pubkeys) private pure returns (uint256) {
        if (pubkeys.length % PUBLIC_KEY_LENGTH != 0) {
            revert MalformedPubkeysArray();
        }

        uint256 keysCount = pubkeys.length / PUBLIC_KEY_LENGTH;
        if (keysCount == 0) {
            revert NoConsolidationRequests();
        }

        return keysCount;
    }
}
