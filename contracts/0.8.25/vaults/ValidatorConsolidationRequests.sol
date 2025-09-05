// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {Dashboard} from "contracts/0.8.25/vaults/dashboard/Dashboard.sol";
import {NodeOperatorFee} from "contracts/0.8.25/vaults/dashboard/NodeOperatorFee.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

/**
 * @title A contract for EIP-7251: Increase the MAX_EFFECTIVE_BALANCE.
 * Allow validators to have larger effective balances, while maintaining the 32 ETH lower bound.
 */
contract ValidatorConsolidationRequests {
    /// @notice EIP-7251 consolidation requests contract address.
    address public constant CONSOLIDATION_REQUEST_PREDEPLOY_ADDRESS = 0x0000BBdDc7CE488642fb579F8B00f3a590007251;

    uint256 internal constant PUBLIC_KEY_LENGTH = 48;
    uint256 internal constant CONSOLIDATION_REQUEST_CALLDATA_LENGTH = PUBLIC_KEY_LENGTH * 2;

    /// @notice Lido Locator contract.
    ILidoLocator public immutable LIDO_LOCATOR;

    /// @param _lidoLocator Lido Locator contract.
    constructor(address _lidoLocator) {
        if (_lidoLocator == address(0)) revert ZeroArgument("_lidoLocator");
        LIDO_LOCATOR = ILidoLocator(_lidoLocator);
    }

    /**
     * @notice Send EIP-7251 consolidation requests for the specified public keys.
     *      Each request instructs a validator to consolidate its stake to the target validator.
     *
     * Requirements:
     *  - The caller must have the `NODE_OPERATOR_REWARDS_ADJUST_ROLE` to perform reward adjustment.
     *  - The vault into which consolidation occurs must be connected to the vault hub.
     *  - The function must be called with a non-zero msg.value that is sufficient to cover all consolidation fees.
     *  - The required amount can be obtained by calling `getConsolidationRequestFee()`, but note that this value is only
     *    valid for the current block and may change. It is therefore advised to provide a slightly higher amount;
     *    any excess will be refunded to the `_refundRecipient` address.
     *  - The `_sourcePubkeys` and `_targetPubkeys` must be valid and belong to registered validators.
     *  - `_adjustmentIncrease` must match the total balance of source validators on the Consensus Layer.
     *
     * Execution Flows:
     *  This function designed to be called by Vault-CLI using EIP-7702 delegation.
     *
     * Notes:
     *  Consolidation requests are asynchronous and handled on the Consensus Layer. The function optimistically
     *  assumes that the consolidation will succeed and immediately increases the node operator's reward adjustment
     *  via the Dashboard contract. However, if the consolidation fails, the function does not take
     *  responsibility for rolling back the adjustment. It is the responsibility of the Node Operator and Vault Owner to call
     *  `setRewardsAdjustment` on the Dashboard contract to correct the adjustment value in such cases.
     *
     *  Additionally, this function assumes that the provided source and target pubkeys are valid, and that the reward
     *  adjustment value is appropriate. Because of this, it is highly recommended to use the `Vault CLI` tool to interact
     *  with this function. `Vault CLI` performs pre-checks to ensure the correctness of public keys and the adjustment value,
     *  and also monitors post-execution state on the CL to verify that the consolidation was successful.
     *
     * @param _sourcePubkeys An array of tightly packed arrays of 48-byte public keys corresponding to validators requesting consolidation.
     *      | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param _targetPubkeys An array of 48-byte public keys corresponding to validators to consolidate to.
     *      | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param _refundRecipient The address to refund the excess consolidation fee to.
     * @param _dashboard The address of the dashboard contract.
     * @param _adjustmentIncrease The sum of the balances of the source validators to increase the rewards adjustment by.
     */
    function addConsolidationRequestsAndIncreaseRewardsAdjustment(
        bytes[] calldata _sourcePubkeys,
        bytes[] calldata _targetPubkeys,
        address _refundRecipient,
        address _dashboard,
        uint256 _adjustmentIncrease
    ) external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        if (_sourcePubkeys.length == 0) revert ZeroArgument("sourcePubkeys");
        if (_targetPubkeys.length == 0) revert ZeroArgument("targetPubkeys");
        if (_dashboard == address(0)) revert ZeroArgument("dashboard");
        if (_sourcePubkeys.length != _targetPubkeys.length) revert MismatchingSourceAndTargetPubkeysCount(_sourcePubkeys.length, _targetPubkeys.length);
        
        // If the refund recipient is not set, use the sender as the refund recipient
        if (_refundRecipient == address(0)) {
            _refundRecipient = msg.sender;
        }

        VaultHub.VaultConnection memory vaultConnection = Dashboard(payable(_dashboard)).vaultConnection();
        if(vaultConnection.vaultIndex == 0 || vaultConnection.pendingDisconnect == true) {
            revert VaultNotConnected();
        }

        uint256 consolidationRequestsCount = _validatePubkeysAndCountConsolidationRequests(_sourcePubkeys, _targetPubkeys);

        uint256 feePerRequest = _getConsolidationRequestFee();
        uint256 totalFee = consolidationRequestsCount * feePerRequest;
        if (msg.value < totalFee) revert InsufficientValidatorConsolidationFee(msg.value, totalFee);

        bytes[] memory consolidationRequestEncodedCalls = _consolidationCalldatas(_sourcePubkeys, _targetPubkeys, consolidationRequestsCount);

        for (uint256 i = 0; i < consolidationRequestEncodedCalls.length; i++) {
            (bool success, ) = CONSOLIDATION_REQUEST_PREDEPLOY_ADDRESS.call{value: feePerRequest}(consolidationRequestEncodedCalls[i]);
            if (!success) {
                revert ConsolidationRequestFailed(consolidationRequestEncodedCalls[i]);
            }
        }

        uint256 excess = msg.value - totalFee;
        if (excess > 0) {
            (bool success, ) = _refundRecipient.call{value: excess}("");
            if (!success) {
                revert ConsolidationFeeRefundFailed(_refundRecipient, excess);
            }
        }

        if(_adjustmentIncrease > 0) {
            Dashboard(payable(_dashboard)).increaseRewardsAdjustment(_adjustmentIncrease);
        }

        emit ConsolidationRequestsAndRewardsAdjustmentIncreased(msg.sender, _sourcePubkeys, _targetPubkeys, _refundRecipient, excess, _adjustmentIncrease);
    }

    /**
     * @notice Returns the encoded calls for EIP-7251 consolidation requests and the rewards adjustment increase.
     * This is part of the Vault-CLI flow that validates input parameters and creates calldatas for consolidation requests and reward adjustment increases.
     * Later, the Vault-CLI sends these calldatas using EIP-5792
     *
     * @param _sourcePubkeys An array of tightly packed arrays of 48-byte public keys corresponding to validators requesting consolidation.
     *      | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param _targetPubkeys An array of 48-byte public keys corresponding to validators to consolidate to.
     *      | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param _dashboard The address of the dashboard contract.
     * @param _adjustmentIncrease The sum of the balances of the source validators to increase the rewards adjustment by.
     */
    function getConsolidationRequestsAndAdjustmentIncreaseEncodedCalls(
        bytes[] calldata _sourcePubkeys,
        bytes[] calldata _targetPubkeys,
        address _dashboard,
        uint256 _adjustmentIncrease
    ) external view returns (bytes[] memory consolidationRequestEncodedCalls, bytes memory adjustmentIncreaseEncodedCall) {
        if (_sourcePubkeys.length == 0) revert ZeroArgument("sourcePubkeys");
        if (_targetPubkeys.length == 0) revert ZeroArgument("targetPubkeys");
        if (_dashboard == address(0)) revert ZeroArgument("dashboard");
        if (_sourcePubkeys.length != _targetPubkeys.length) revert MismatchingSourceAndTargetPubkeysCount(_sourcePubkeys.length, _targetPubkeys.length);
        
        VaultHub.VaultConnection memory vaultConnection = Dashboard(payable(_dashboard)).vaultConnection();
        if(vaultConnection.vaultIndex == 0 || vaultConnection.pendingDisconnect == true) {
            revert VaultNotConnected();
        }

        uint256 consolidationRequestsCount = _validatePubkeysAndCountConsolidationRequests(_sourcePubkeys, _targetPubkeys);
        consolidationRequestEncodedCalls = _consolidationCalldatas(_sourcePubkeys, _targetPubkeys, consolidationRequestsCount);

        if(_adjustmentIncrease > 0) {
            adjustmentIncreaseEncodedCall = abi.encodeWithSelector(NodeOperatorFee.increaseRewardsAdjustment.selector, _adjustmentIncrease);
        }

        return (consolidationRequestEncodedCalls, adjustmentIncreaseEncodedCall);
    }

    /**
     * @dev Retrieves the current EIP-7251 consolidation fee. This fee is valid only for the current block and may change in subsequent blocks.
     * @return The minimum fee required per consolidation request.
     */
    function getConsolidationRequestFee() external view returns (uint256) {
        return _getConsolidationRequestFee();
    }

    function _getConsolidationRequestFee() private view returns (uint256) {
        (bool success, bytes memory feeData) = CONSOLIDATION_REQUEST_PREDEPLOY_ADDRESS.staticcall("");

        if (!success) {
            revert ConsolidationFeeReadFailed();
        }

        if (feeData.length != 32) {
            revert ConsolidationFeeInvalidData();
        }

        return abi.decode(feeData, (uint256));
    }

    function _copyPubkeysToMemory(
        bytes memory _target,
        uint256 _targetIndex,
        bytes calldata _source,
        uint256 _sourceIndex
    ) private pure {
        assembly {
            calldatacopy(
                add(_target, add(32, mul(_targetIndex, PUBLIC_KEY_LENGTH))),
                add(_source.offset, mul(_sourceIndex, PUBLIC_KEY_LENGTH)),
                PUBLIC_KEY_LENGTH
            )
        }
    }

    function _consolidationCalldatas(
        bytes[] calldata _sourcePubkeys,
        bytes[] calldata _targetPubkeys,
        uint256 _consolidationRequestsCount
    ) private pure returns (bytes[] memory) {
        bytes[] memory consolidationRequestEncodedCalls = new bytes[](_consolidationRequestsCount);

        uint256 k = 0;
        for (uint256 i = 0; i < _sourcePubkeys.length; i++) {
            uint256 sourcePubkeysCount = _sourcePubkeys[i].length / PUBLIC_KEY_LENGTH;
            
            for (uint256 j = 0; j < sourcePubkeysCount; j++) {
                consolidationRequestEncodedCalls[k] = new bytes(CONSOLIDATION_REQUEST_CALLDATA_LENGTH);

                _copyPubkeysToMemory(consolidationRequestEncodedCalls[k], 0, _sourcePubkeys[i], j);
                _copyPubkeysToMemory(consolidationRequestEncodedCalls[k], 1, _targetPubkeys[i], 0);

                unchecked { k++; }
            }
        }

        return consolidationRequestEncodedCalls;
    }

    function _validatePubkeysAndCountConsolidationRequests(
        bytes[] calldata _sourcePubkeys,
        bytes[] calldata _targetPubkeys
    ) private pure returns (uint256) {
        uint256 consolidationRequestsCount = 0;
        for (uint256 i = 0; i < _sourcePubkeys.length; i++) {
            if (_targetPubkeys[i].length != PUBLIC_KEY_LENGTH) {
                revert MalformedTargetPubkey();
            }
            if (_sourcePubkeys[i].length % PUBLIC_KEY_LENGTH != 0) {
                revert MalformedSourcePubkeysArray();
            }

            uint256 keysCount = _sourcePubkeys[i].length / PUBLIC_KEY_LENGTH;
            if (keysCount == 0) {
                revert NoConsolidationRequests();
            }

            consolidationRequestsCount += keysCount;
        }
        return consolidationRequestsCount;
    }

    /**
     * @notice Emitted when the consolidation requests are added
     * @param sender The address of the sender
     * @param sourcePubkeys The source pubkeys
     * @param targetPubkeys The target pubkeys
     * @param refundRecipient The address of the refund recipient
     * @param excess The excess consolidation fee
     * @param adjustmentIncrease The adjustment increase amount
     */
    event ConsolidationRequestsAndRewardsAdjustmentIncreased(
        address indexed sender,
        bytes[] sourcePubkeys,
        bytes[] targetPubkeys,
        address indexed refundRecipient,
        uint256 excess,
        uint256 adjustmentIncrease
    );

    error ZeroArgument(string argName);
    error MalformedSourcePubkeysArray();
    error MalformedTargetPubkey();
    error MismatchingSourceAndTargetPubkeysCount(uint256 sourcePubkeysCount, uint256 targetPubkeysCount);
    error VaultNotConnected();
    error NoConsolidationRequests();
    error InsufficientValidatorConsolidationFee(uint256 provided, uint256 required);
    error ConsolidationFeeReadFailed();
    error ConsolidationFeeInvalidData();
    error ConsolidationFeeRefundFailed(address recipient, uint256 amount);
    error ConsolidationRequestFailed(bytes callData);
}