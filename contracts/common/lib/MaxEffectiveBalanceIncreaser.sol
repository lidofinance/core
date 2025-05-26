// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9 <0.9.0;

/**
 * @title A lib for EIP-7251: Increase the MAX_EFFECTIVE_BALANCE.
 * Allow validators to have larger effective balances, while maintaining the 32 ETH lower bound.
 */
contract MaxEffectiveBalanceIncreaser {
    address public constant CONSOLIDATION_REQUEST_PREDEPLOY_ADDRESS = 0x0000BBdDc7CE488642fb579F8B00f3a590007251;

    uint256 internal constant PUBLIC_KEY_LENGTH = 48;
    uint256 internal constant CONSOLIDATION_REQUEST_CALLDATA_LENGTH = PUBLIC_KEY_LENGTH * 2;

    error ConsolidationFeeReadFailed();
    error ConsolidationFeeInvalidData();
    error ConsolidationFeeRefundFailed(address recipient, uint256 amount);
    error ConsolidationRequestAdditionFailed(bytes callData);
    error NoConsolidationRequests();
    error MalformedPubkeysArray();
    error MalformedTargetPubkey();
    error MismatchingSourceAndTargetPubkeysCount(uint256 sourcePubkeysCount, uint256 targetPubkeysCount);
    error InsufficientValidatorConsolidationFee(uint256 provided, uint256 required);
    error ZeroArgument(string argName);

    event ConsolidationRequestsTriggered(address indexed sender, bytes[] sourcePubkeys, bytes[] targetPubkeys, address indexed refundRecipient, uint256 excess);

    /**
     * @dev Send EIP-7251 consolidation requests for the specified public keys.
     *      Each request instructs a validator to consolidate its stake to the target validator.
     *
     * @param _sourcePubkeys An array of tightly packed arrays of 48-byte public keys corresponding to validators requesting consolidation.
     *      | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *      | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *      | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param _targetPubkeys An array of 48-byte public keys corresponding to validators to consolidate to.
     *      | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param _refundRecipient The address to refund the excess consolidation fee to.
     *
     */
    function addConsolidationRequests(bytes[] calldata _sourcePubkeys, bytes[] calldata _targetPubkeys, address _refundRecipient) external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        if (_sourcePubkeys.length == 0) revert ZeroArgument("sourcePubkeys");
        if (_targetPubkeys.length == 0) revert ZeroArgument("targetPubkeys");

        // If the refund recipient is not set, use the sender as the refund recipient
        if (_refundRecipient == address(0)) {
            _refundRecipient = msg.sender;
        }

        if (_sourcePubkeys.length != _targetPubkeys.length) {
            revert MismatchingSourceAndTargetPubkeysCount(_sourcePubkeys.length, _targetPubkeys.length);
        }

        uint256 totalPubkeysCount = 0;
        for (uint256 i = 0; i < _sourcePubkeys.length; i++) {
            totalPubkeysCount += _validateAndCountPubkeys(_sourcePubkeys[i]);
            if (_targetPubkeys[i].length != PUBLIC_KEY_LENGTH) {
                revert MalformedTargetPubkey();
            }
        }

        uint256 feePerRequest = _getConsolidationRequestFee();
        uint256 totalFee = totalPubkeysCount * feePerRequest;
        if (msg.value < totalFee) revert InsufficientValidatorConsolidationFee(msg.value, totalFee);

        bytes memory callData = new bytes(CONSOLIDATION_REQUEST_CALLDATA_LENGTH);

        for (uint256 i = 0; i < _sourcePubkeys.length; i++) {
            uint256 sourcePubkeysCount = _validateAndCountPubkeys(_sourcePubkeys[i]);
            
            for (uint256 j = 0; j < sourcePubkeysCount; j++) {
                _copyPubkeysToMemory(callData, 0, _sourcePubkeys[i], j);
                _copyPubkeysToMemory(callData, 1, _targetPubkeys[i], 0);

                (bool success, ) = CONSOLIDATION_REQUEST_PREDEPLOY_ADDRESS.call{value: feePerRequest}(callData);

                if (!success) {
                    revert ConsolidationRequestAdditionFailed(callData);
                }
            }
        }

        uint256 excess = msg.value - totalFee;
        if (excess > 0) {
            (bool success, ) = _refundRecipient.call{value: excess}("");
            if (!success) revert ConsolidationFeeRefundFailed(_refundRecipient, excess);
        }

        emit ConsolidationRequestsTriggered(msg.sender, _sourcePubkeys, _targetPubkeys, _refundRecipient, excess);
    }

    /**
     * @dev Retrieves the current EIP-7251 consolidation fee.
     * @return The minimum fee required per consolidation request.
     */
    function getConsolidationRequestFee() external view returns (uint256) {
        return _getConsolidationRequestFee();
    }

    function _getConsolidationRequestFee() internal view returns (uint256) {
        (bool success, bytes memory feeData) = CONSOLIDATION_REQUEST_PREDEPLOY_ADDRESS.staticcall("");

        if (!success) {
            revert ConsolidationFeeReadFailed();
        }

        if (feeData.length != 32) {
            revert ConsolidationFeeInvalidData();
        }

        return abi.decode(feeData, (uint256));
    }

    function _copyPubkeysToMemory(bytes memory _target, uint256 _targetIndex, bytes calldata _source, uint256 _sourceIndex) private pure {
        assembly {
            calldatacopy(add(_target, add(32, mul(_targetIndex, PUBLIC_KEY_LENGTH))), add(_source.offset, mul(_sourceIndex, PUBLIC_KEY_LENGTH)), PUBLIC_KEY_LENGTH)
        }
    }

    function _validateAndCountPubkeys(bytes calldata _pubkeys) private pure returns (uint256) {
        if (_pubkeys.length % PUBLIC_KEY_LENGTH != 0) {
            revert MalformedPubkeysArray();
        }

        uint256 keysCount = _pubkeys.length / PUBLIC_KEY_LENGTH;
        if (keysCount == 0) {
            revert NoConsolidationRequests();
        }

        return keysCount;
    }
}
