// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

/// @title A part of Dashboard interface for increasing rewards adjustment
interface INodeOperatorFee {
     /**
      * @notice Increases rewards adjustment to correct fee calculation due to non-rewards ether on CL
      * @param _adjustmentIncrease amount to increase adjustment by
      * @dev will revert if final adjustment is more than `MANUAL_REWARDS_ADJUSTMENT_LIMIT`
      */
    function increaseRewardsAdjustment(
        uint256 _adjustmentIncrease
    ) external;
}

/**
 * @title A contract for EIP-7251: Increase the MAX_EFFECTIVE_BALANCE.
 * Allow validators to have larger effective balances, while maintaining the 32 ETH lower bound.
 */
contract ValidatorConsolidationRequests {
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
    error MismatchingAdjustmentIncreasesCount(uint256 adjustmentIncreasesCount, uint256 targetPubkeysCount);
    error InsufficientValidatorConsolidationFee(uint256 provided, uint256 required);
    error ZeroArgument(string argName);

    event ConsolidationRequestsAdded(
        address indexed sender,
        bytes[] sourcePubkeys,
        bytes[] targetPubkeys,
        address indexed refundRecipient,
        uint256 excess,
        uint256[] adjustmentIncreases
    );

    /**
     * @dev Send EIP-7251 consolidation requests for the specified public keys.
     *      Each request instructs a validator to consolidate its stake to the target validator.
     *
     * @notice Requirements:
     * - The caller must have the NODE_OPERATOR_REWARDS_ADJUST_ROLE to perform reward adjustment.
     * - The function must be called with a non-zero `msg.value` sufficient to cover all consolidation fees.
     *
     * @notice Notes:
     * Consolidation requests are asynchronous and handled on the Consensus Layer. The function optimistically 
     * assumes that the consolidation will succeed and immediately increases the node operator's reward adjustment
     * via the Dashboard contract. However, if the consolidation fails, the function does not take
     * responsibility for rolling back the adjustment. It is the responsibility of the Node Operator and Vault Owner to call 
     * `setRewardsAdjustment` on the Dashboard contract to correct the adjustment value in such cases.
     *
     * Additionally, this function assumes that the provided source and target pubkeys are valid, and that the reward
     * adjustment value is appropriate. Because of this, it is highly recommended to use the `Vault CLI` tool to interact
     * with this function. `Vault CLI` performs pre-checks to ensure the correctness of public keys and the adjustment value,
     * and also monitors post-execution state on the CL to verify that the consolidation was successful.
     *
     * @param _sourcePubkeys An array of tightly packed arrays of 48-byte public keys corresponding to validators requesting consolidation.
     *      | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param _targetPubkeys An array of 48-byte public keys corresponding to validators to consolidate to.
     *      | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param _refundRecipient The address to refund the excess consolidation fee to.
     * @param _dashboardAddress The address of the dashboard contract.
     * @param _adjustmentIncreases The amounts to increase the rewards adjustment by for each target validator.
     *
     */
    function addConsolidationRequests(
        bytes[] calldata _sourcePubkeys,
        bytes[] calldata _targetPubkeys,
        address _refundRecipient,
        address _dashboardAddress,
        uint256[] calldata _adjustmentIncreases
    ) external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        if (_sourcePubkeys.length == 0) revert ZeroArgument("sourcePubkeys");
        if (_targetPubkeys.length == 0) revert ZeroArgument("targetPubkeys");
        if (_dashboardAddress == address(0)) revert ZeroArgument("dashboardAddress");
        if (_adjustmentIncreases.length == 0) revert ZeroArgument("adjustmentIncreases");

        // If the refund recipient is not set, use the sender as the refund recipient
        if (_refundRecipient == address(0)) {
            _refundRecipient = msg.sender;
        }

        if (_sourcePubkeys.length != _targetPubkeys.length) {
            revert MismatchingSourceAndTargetPubkeysCount(_sourcePubkeys.length, _targetPubkeys.length);
        }

        if (_adjustmentIncreases.length != _sourcePubkeys.length) {
            revert MismatchingAdjustmentIncreasesCount(_adjustmentIncreases.length, _sourcePubkeys.length);
        }

        uint256 totalSourcePubkeysCount = 0;
        for (uint256 i = 0; i < _sourcePubkeys.length; i++) {
            totalSourcePubkeysCount += _validateAndCountPubkeys(_sourcePubkeys[i]);
            if (_targetPubkeys[i].length != PUBLIC_KEY_LENGTH) {
                revert MalformedTargetPubkey();
            }
        }

        uint256 feePerRequest = _getConsolidationRequestFee();
        uint256 totalFee = totalSourcePubkeysCount * feePerRequest;
        if (msg.value < totalFee) revert InsufficientValidatorConsolidationFee(msg.value, totalFee);

        for (uint256 i = 0; i < _sourcePubkeys.length; i++) {
            _processConsolidationRequest(
                _sourcePubkeys[i],
                _targetPubkeys[i],
                feePerRequest
            );
        }

        uint256 excess = msg.value - totalFee;
        if (excess > 0) {
            (bool success, ) = _refundRecipient.call{value: excess}("");
            if (!success) revert ConsolidationFeeRefundFailed(_refundRecipient, excess);
        }

        for (uint256 i = 0; i < _sourcePubkeys.length; i++) {
            INodeOperatorFee(_dashboardAddress).increaseRewardsAdjustment(_adjustmentIncreases[i]);
        }

        emit ConsolidationRequestsAdded(msg.sender, _sourcePubkeys, _targetPubkeys, _refundRecipient, excess, _adjustmentIncreases);
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

    function _processConsolidationRequest(
        bytes calldata _sourcePubkeys,
        bytes calldata _targetPubkey,
        uint256 _feePerRequest
    ) private {
        uint256 sourcePubkeysCount = _validateAndCountPubkeys(_sourcePubkeys);
        bytes memory callData = new bytes(CONSOLIDATION_REQUEST_CALLDATA_LENGTH);

        for (uint256 j = 0; j < sourcePubkeysCount; j++) {
            _copyPubkeysToMemory(callData, 0, _sourcePubkeys, j);
            _copyPubkeysToMemory(callData, 1, _targetPubkey, 0);

            (bool success, ) = CONSOLIDATION_REQUEST_PREDEPLOY_ADDRESS.call{value: _feePerRequest}(callData);
            if (!success) {
                revert ConsolidationRequestAdditionFailed(callData);
            }
        }
    }
}
