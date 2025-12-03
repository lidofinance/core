// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {Dashboard} from "contracts/0.8.25/vaults/dashboard/Dashboard.sol";
import {NodeOperatorFee} from "contracts/0.8.25/vaults/dashboard/NodeOperatorFee.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

 /**
  * @title ValidatorConsolidationRequests
  * @author kovalgek
  * @notice Contract for consolidating validators into staking vaults (EIP-7251)
  *         and adjusting rewards. Built to work with Vault CLI tooling and to
  *         support batched execution (EIP-5792).
  *
  *         This contract is strictly for an account that: 
  *           - has its address as withdrawal credentials for pubkeys to consolidate from
  *           - has the `NODE_OPERATOR_FEE_EXEMPT_ROLE` role assigned in Dashboard.
  */
contract ValidatorConsolidationRequests {
    /// @notice EIP-7251 consolidation requests contract address.
    address public constant CONSOLIDATION_REQUEST_PREDEPLOY_ADDRESS = 0x0000BBdDc7CE488642fb579F8B00f3a590007251;

    uint256 internal constant PUBLIC_KEY_LENGTH = 48;
    uint256 internal constant CONSOLIDATION_REQUEST_CALLDATA_LENGTH = PUBLIC_KEY_LENGTH * 2;
    uint256 internal constant MINIMUM_VALIDATOR_BALANCE = 16 ether;

    /// @notice Lido Locator contract.
    ILidoLocator public immutable LIDO_LOCATOR;

    /// @param _lidoLocator Lido Locator contract.
    constructor(address _lidoLocator) {
        if (_lidoLocator == address(0)) revert ZeroArgument("_lidoLocator");
        LIDO_LOCATOR = ILidoLocator(_lidoLocator);
    }

    /**
     * @notice Return the encoded calls for EIP-7251 consolidation requests and the fee exemption.
     * 
     * Use case:
     * - If your withdrawal credentials are an EOA or multisig and you want to
     *   consolidate validator balances into staking vaults, call this method to
     *   generate the encoded consolidation and fee exemption calls.
     *   These calls can later be submitted via EIP-5792.
     * - Fee exemption calls can only be executed by an account with the
     *   `NODE_OPERATOR_FEE_EXEMPT_ROLE`. The node operator may grant this
     *   role to the withdrawal credentials account.
     * 
     * Recommendations:
     * - It is recommended to call this function via the Vault CLI using WalletConnect signing.
     *   It performs pre-checks of source and target validator states, verifies their withdrawal
     *   credential prefixes, calculates current validator balances, generates the request
     *   calldata using this method, and then submits these call data in batched transactions
     *   via EIP-5792.
     *
     * @param _sourcePubkeys An array of tightly packed arrays of 48-byte public keys corresponding to validators
     *        requesting consolidation.
     *        | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param _targetPubkeys An array of 48-byte public keys corresponding to validators to consolidate to.
     *        | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param _dashboard The address of the dashboard contract.
     * @param _allSourceValidatorBalancesWei The total balance (in wei) of all source validators.
     *        This value is used to exempt the source validator balances from the node operator fee base.
     *
     *        Node operator fee is applied only on rewards, which are defined as
     *        "all external ether that appeared in the vault on top of the initially deposited one".
     *        Without this exemption, consolidated validator balances would incorrectly
     *        be included in the rewards base, which would lead to overcharging.
     *
     *        By passing the sum of all source validator balances, you ensure that these
     *        balances are excluded from the reward calculation, and the node operator fee
     *        is charged only on the actual rewards.
     *
     *        ⚠️ Note: this is not a precise method. It does not account for the future
     *        rewards that the consolidated validators may earn after this call, so in some
     *        setups additional correction may be required.
     * @return feeExemptionEncodedCall The encoded call to increase the fee exemption
     *        (or empty if zero sum of source validator balances passed).
     * @return consolidationRequestEncodedCalls The encoded calls for the consolidation requests.
     */
    function getConsolidationRequestsAndFeeExemptionEncodedCalls(
        bytes[] calldata _sourcePubkeys,
        bytes[] calldata _targetPubkeys,
        address _dashboard,
        uint256 _allSourceValidatorBalancesWei
    ) external view returns (
        bytes memory feeExemptionEncodedCall,
        bytes[] memory consolidationRequestEncodedCalls
    ) {
        if (_sourcePubkeys.length == 0) revert ZeroArgument("sourcePubkeys");
        if (_targetPubkeys.length == 0) revert ZeroArgument("targetPubkeys");
        if (_dashboard == address(0)) revert ZeroArgument("dashboard");
        if (_sourcePubkeys.length != _targetPubkeys.length) {
            revert MismatchingSourceAndTargetPubkeysCount(_sourcePubkeys.length, _targetPubkeys.length);
        }

        VaultHub vaultHub = VaultHub(payable(LIDO_LOCATOR.vaultHub()));
        address stakingVault = address(Dashboard(payable(_dashboard)).stakingVault());
        if (!vaultHub.isVaultConnected(stakingVault) || vaultHub.isPendingDisconnect(stakingVault)) {
            revert VaultNotConnected();
        }

        VaultHub.VaultConnection memory vaultConnection = vaultHub.vaultConnection(stakingVault);
        if (_dashboard != vaultConnection.owner) {
            revert DashboardNotOwnerOfStakingVault();
        }

        uint256 consolidationRequestsCount = _validatePubkeysAndCountConsolidationRequests(
            _sourcePubkeys,
            _targetPubkeys
        );

        if (_allSourceValidatorBalancesWei != 0 && 
            _allSourceValidatorBalancesWei < consolidationRequestsCount * MINIMUM_VALIDATOR_BALANCE) {
            revert InvalidAllSourceValidatorBalancesWei();
        }

        consolidationRequestEncodedCalls = _consolidationCalldatas(
            _sourcePubkeys,
            _targetPubkeys,
            consolidationRequestsCount
        );

        if (_allSourceValidatorBalancesWei > 0) {
            feeExemptionEncodedCall = abi.encodeWithSelector(
                NodeOperatorFee.addFeeExemption.selector,
                _allSourceValidatorBalancesWei
            );
        }
    }

    /**
     * @dev Retrieves the current EIP-7251 consolidation fee. This fee is valid only for the current block and may
     *      change in subsequent blocks.
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

    function _consolidationCalldatas(
        bytes[] calldata _sourcePubkeys,
        bytes[] calldata _targetPubkeys,
        uint256 _consolidationRequestsCount
    ) private pure returns (bytes[] memory consolidationRequestEncodedCalls) {
        consolidationRequestEncodedCalls = new bytes[](_consolidationRequestsCount);

        uint256 k = 0;
        for (uint256 i = 0; i < _sourcePubkeys.length; i++) {
            uint256 sourcePubkeysCount = _sourcePubkeys[i].length / PUBLIC_KEY_LENGTH;
            
            for (uint256 j = 0; j < sourcePubkeysCount; j++) {
                uint256 offset = j * PUBLIC_KEY_LENGTH;
                uint256 end = offset + PUBLIC_KEY_LENGTH;
                
                consolidationRequestEncodedCalls[k] = bytes.concat(_sourcePubkeys[i][offset : end], _targetPubkeys[i]);
                unchecked { k++; }
            }
        }
    }

    function _validateAndCountPubkeysInBatch(bytes calldata _pubkeys) private pure returns (uint256) {
        if (_pubkeys.length % PUBLIC_KEY_LENGTH != 0) {
            revert MalformedSourcePubkeysArray();
        }
        uint256 keysCount = _pubkeys.length / PUBLIC_KEY_LENGTH;
        if (keysCount == 0) {
            revert NoConsolidationRequests();
        }
        return keysCount;
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
            consolidationRequestsCount += _validateAndCountPubkeysInBatch(_sourcePubkeys[i]);
        }
        return consolidationRequestsCount;
    }

    error ZeroArgument(string argName);
    error MalformedSourcePubkeysArray();
    error MalformedTargetPubkey();
    error MismatchingSourceAndTargetPubkeysCount(uint256 sourcePubkeysCount, uint256 targetPubkeysCount);
    error VaultNotConnected();
    error DashboardNotOwnerOfStakingVault();
    error NoConsolidationRequests();
    error InvalidAllSourceValidatorBalancesWei();
    error ConsolidationFeeReadFailed();
    error ConsolidationFeeInvalidData();
}
