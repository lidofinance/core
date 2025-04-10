// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import "@openzeppelin/contracts-v4.4/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-v4.4/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts-v4.4/token/ERC20/utils/SafeERC20.sol";

import {Versioned} from "./utils/Versioned.sol";
import {AccessControlEnumerable} from "./utils/access/AccessControlEnumerable.sol";
import {TriggerableWithdrawals} from "../common/lib/TriggerableWithdrawals.sol";
import {ILidoLocator} from "../common/interfaces/ILidoLocator.sol";

interface ILido {
    /**
     * @notice A payable function supposed to be called only by WithdrawalVault contract
     * @dev We need a dedicated function because funds received by the default payable function
     * are treated as a user deposit
     */
    function receiveWithdrawals() external payable;
}

contract Consolidation {
    error InvalidPubkeyArrayLength();
    error PubkeyArraysLengthMismatch();
    error ConsolidationFeeReadFailed();
    error ConsolidationFeeInvalidData();
    error ConsolidationRequestAdditionFailed(bytes callData);

    address constant CONSOLIDATION_REQUEST = 0x0000BBdDc7CE488642fb579F8B00f3a590007251;
    uint256 internal constant PUBLIC_KEY_LENGTH = 48;

    function _getConsolidationRequestFee() internal view returns (uint256) {
        (bool success, bytes memory feeData) = CONSOLIDATION_REQUEST.staticcall("");

        if (!success) {
            revert ConsolidationFeeReadFailed();
        }

        if (feeData.length != 32) {
            revert ConsolidationFeeInvalidData();
        }

        return abi.decode(feeData, (uint256));
    }

    function _addConsolidationRequest(
        bytes calldata sourcePubkeys,
        bytes calldata targetPubkeys,
        uint256 feePerRequest
    ) internal {
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

    function _validatePubkeyArrays(bytes calldata sourcePubkeys, bytes calldata targetPubkeys) internal pure {
        if (sourcePubkeys.length != targetPubkeys.length) {
            revert PubkeyArraysLengthMismatch();
        }
        if (sourcePubkeys.length % PUBLIC_KEY_LENGTH != 0) {
            revert InvalidPubkeyArrayLength();
        }
    }
}

/**
 * @title A vault for temporary storage of withdrawals
 */
contract WithdrawalVault is AccessControlEnumerable, Versioned, Consolidation {
    using SafeERC20 for IERC20;

    ILido public immutable LIDO;
    address public immutable TREASURY;

    bytes32 public constant ADD_FULL_WITHDRAWAL_REQUEST_ROLE = keccak256("ADD_FULL_WITHDRAWAL_REQUEST_ROLE");
    bytes32 public constant ADD_CONSOLIDATION_REQUEST_ROLE = keccak256("ADD_CONSOLIDATION_REQUEST_ROLE");

    // Events
    /**
     * Emitted when the ERC20 `token` recovered (i.e. transferred)
     * to the Lido treasury address by `requestedBy` sender.
     */
    event ERC20Recovered(address indexed requestedBy, address indexed token, uint256 amount);

    /**
     * Emitted when the ERC721-compatible `token` (NFT) recovered (i.e. transferred)
     * to the Lido treasury address by `requestedBy` sender.
     */
    event ERC721Recovered(address indexed requestedBy, address indexed token, uint256 tokenId);

    // Errors
    error ZeroAddress();
    error NotLido();
    error NotEnoughEther(uint256 requested, uint256 balance);
    error ZeroAmount();
    error InsufficientFee(uint256 providedFee, uint256 requiredFee);
    error ExcessFeeRefundFailed();

    /**
     * @param _lido the Lido token (stETH) address
     * @param _treasury the Lido treasury address (see ERC20/ERC721-recovery interfaces)
     */
    constructor(address _lido, address _treasury) {
        _onlyNonZeroAddress(_lido);
        _onlyNonZeroAddress(_treasury);

        LIDO = ILido(_lido);
        TREASURY = _treasury;
    }

    /// @dev Ensures the contract’s ETH balance is unchanged.
    modifier preservesEthBalance() {
        uint256 balanceBeforeCall = address(this).balance - msg.value;
        _;
        assert(address(this).balance == balanceBeforeCall);
    }

    /// @notice Initializes the contract. Can be called only once.
    /// @param _admin Lido DAO Aragon agent contract address.
    /// @dev Proxy initialization method.
    function initialize(address _admin) external {
        // Initializations for v0 --> v2
        _checkContractVersion(0);

        _initialize_v2(_admin);
        _initializeContractVersionTo(2);
    }

    /// @notice Finalizes upgrade to v2 (from v1). Can be called only once.
    /// @param _admin Lido DAO Aragon agent contract address.
    function finalizeUpgrade_v2(address _admin) external {
        // Finalization for v1 --> v2
        _checkContractVersion(1);

        _initialize_v2(_admin);
        _updateContractVersion(2);
    }

    /**
     * @notice Withdraw `_amount` of accumulated withdrawals to Lido contract
     * @dev Can be called only by the Lido contract
     * @param _amount amount of ETH to withdraw
     */
    function withdrawWithdrawals(uint256 _amount) external {
        if (msg.sender != address(LIDO)) {
            revert NotLido();
        }
        if (_amount == 0) {
            revert ZeroAmount();
        }

        uint256 balance = address(this).balance;
        if (_amount > balance) {
            revert NotEnoughEther(_amount, balance);
        }

        LIDO.receiveWithdrawals{value: _amount}();
    }

    /**
     * Transfers a given `_amount` of an ERC20-token (defined by the `_token` contract address)
     * currently belonging to the burner contract address to the Lido treasury address.
     *
     * @param _token an ERC20-compatible token
     * @param _amount token amount
     */
    function recoverERC20(IERC20 _token, uint256 _amount) external {
        if (_amount == 0) {
            revert ZeroAmount();
        }

        emit ERC20Recovered(msg.sender, address(_token), _amount);

        _token.safeTransfer(TREASURY, _amount);
    }

    /**
     * Transfers a given token_id of an ERC721-compatible NFT (defined by the token contract address)
     * currently belonging to the burner contract address to the Lido treasury address.
     *
     * @param _token an ERC721-compatible token
     * @param _tokenId minted token id
     */
    function recoverERC721(IERC721 _token, uint256 _tokenId) external {
        emit ERC721Recovered(msg.sender, address(_token), _tokenId);

        _token.transferFrom(address(this), TREASURY, _tokenId);
    }

    /**
     * @dev Submits EIP-7002 full withdrawal requests for the specified public keys.
     *      Each request instructs a validator to fully withdraw its stake and exit its duties as a validator.
     *      Refunds any excess fee to the caller after deducting the total fees,
     *      which are calculated based on the number of public keys and the current minimum fee per withdrawal request.
     *
     * @param pubkeys A tightly packed array of 48-byte public keys corresponding to validators requesting full withdrawals.
     *                | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @notice Reverts if:
     *         - The caller does not have the `ADD_FULL_WITHDRAWAL_REQUEST_ROLE`.
     *         - Validation of any of the provided public keys fails.
     *         - The provided total withdrawal fee is insufficient to cover all requests.
     *         - Refund of the excess fee fails.
     */
    function addFullWithdrawalRequests(
        bytes calldata pubkeys
    ) external payable onlyRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE) preservesEthBalance {
        uint256 feePerRequest = TriggerableWithdrawals.getWithdrawalRequestFee();
        uint256 totalFee = (pubkeys.length / TriggerableWithdrawals.PUBLIC_KEY_LENGTH) * feePerRequest;

        _requireSufficientFee(totalFee);

        TriggerableWithdrawals.addFullWithdrawalRequests(pubkeys, feePerRequest);

        _refundExcessFee(totalFee);
    }

    function addConsolidationRequest(
        bytes calldata sourcePubkeys,
        bytes calldata targetPubkeys
    ) external payable onlyRole(ADD_CONSOLIDATION_REQUEST_ROLE) preservesEthBalance {
        _validatePubkeyArrays(sourcePubkeys, targetPubkeys);

        uint256 feePerRequest = _getConsolidationRequestFee();
        uint256 totalFee = (sourcePubkeys.length / PUBLIC_KEY_LENGTH) * feePerRequest;

        _requireSufficientFee(totalFee);

        _addConsolidationRequest(sourcePubkeys, targetPubkeys, feePerRequest);

        _refundExcessFee(totalFee);
    }

    /**
     * @dev Retrieves the current EIP-7002 withdrawal fee.
     * @return The minimum fee required per withdrawal request.
     */
    function getWithdrawalRequestFee() external view returns (uint256) {
        return TriggerableWithdrawals.getWithdrawalRequestFee();
    }

    function _requireSufficientFee(uint256 requiredFee) internal view {
        if (requiredFee > msg.value) {
            revert InsufficientFee(msg.value, requiredFee);
        }
    }

    function _refundExcessFee(uint256 fee) internal {
        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool success, ) = msg.sender.call{value: refund}("");

            if (!success) {
                revert ExcessFeeRefundFailed();
            }
        }
    }

    function _onlyNonZeroAddress(address _address) internal pure {
        if (_address == address(0)) revert ZeroAddress();
    }

    function _initialize_v2(address _admin) internal {
        _onlyNonZeroAddress(_admin);
        _setupRole(DEFAULT_ADMIN_ROLE, _admin);
    }
}
