// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9 <0.9.0;

/**
 * @title A lib for EIP-7251: Increase the MAX_EFFECTIVE_BALANCE.
 * Allow to send consolidation and compound requests for validators.
 */
library Eip7251MaxEffectiveBalance {
    error NoConsolidationRequests();
    error MalformedPubkeysArray();
    error PubkeyArraysLengthMismatch();
    error ConsolidationFeeReadFailed();
    error ConsolidationFeeInvalidData();
    error ConsolidationRequestAdditionFailed(bytes callData);

    address constant CONSOLIDATION_REQUEST = 0x0000BBdDc7CE488642fb579F8B00f3a590007251;
    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    function getConsolidationRequestFee() internal view returns (uint256) {
        (bool success, bytes memory feeData) = CONSOLIDATION_REQUEST.staticcall("");

        if (!success) {
            revert ConsolidationFeeReadFailed();
        }

        if (feeData.length != 32) {
            revert ConsolidationFeeInvalidData();
        }

        return abi.decode(feeData, (uint256));
    }

    function addConsolidationRequests(
        bytes calldata sourcePubkeys,
        bytes calldata targetPubkeys,
        uint256 feePerRequest
    ) internal {
        if (sourcePubkeys.length == 0) {
            revert NoConsolidationRequests();
        }
        if (sourcePubkeys.length != targetPubkeys.length) {
            revert PubkeyArraysLengthMismatch();
        }
        if (sourcePubkeys.length % PUBLIC_KEY_LENGTH != 0) {
            revert MalformedPubkeysArray();
        }

        uint256 requestsCount = sourcePubkeys.length / PUBLIC_KEY_LENGTH;
        bytes memory request = new bytes(96);

        for (uint256 i = 0; i < requestsCount; i++) {
            assembly {
                calldatacopy(add(request, 32), add(sourcePubkeys.offset, mul(i, PUBLIC_KEY_LENGTH)), PUBLIC_KEY_LENGTH)
                calldatacopy(add(request, 80), add(targetPubkeys.offset, mul(i, PUBLIC_KEY_LENGTH)), PUBLIC_KEY_LENGTH)
            }

            (bool success, ) = CONSOLIDATION_REQUEST.call{value: feePerRequest}(request);

            if (!success) {
                revert ConsolidationRequestAdditionFailed(request);
            }
        }
    }
}
