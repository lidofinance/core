// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {IERC20}  from "@openzeppelin/contracts-v4.4/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts-v4.4/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts-v4.4/token/ERC20/utils/SafeERC20.sol";
import {Versioned} from "./utils/Versioned.sol";
import {WithdrawalVaultEIP7002} from "./WithdrawalVaultEIP7002.sol";

interface ILido {
    /**
     * @notice A payable function supposed to be called only by WithdrawalVault contract
     * @dev We need a dedicated function because funds received by the default payable function
     * are treated as a user deposit
     */
    function receiveWithdrawals() external payable;
}

/**
 * @title A vault for temporary storage of withdrawals
 */
contract WithdrawalVault is Versioned, WithdrawalVaultEIP7002 {
    using SafeERC20 for IERC20;

    ILido public immutable LIDO;
    address public immutable TREASURY;
    address public immutable TRIGGERABLE_WITHDRAWALS_GATEWAY;

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
    error NotTriggerableWithdrawalsGateway();
    error NotEnoughEther(uint256 requested, uint256 balance);
    error ZeroAmount();

    /**
     * @param _lido the Lido token (stETH) address
     * @param _treasury the Lido treasury address (see ERC20/ERC721-recovery interfaces)
     */
    constructor(address _lido, address _treasury, address _triggerableWithdrawalsGateway) {
        _onlyNonZeroAddress(_lido);
        _onlyNonZeroAddress(_treasury);
        _onlyNonZeroAddress(_triggerableWithdrawalsGateway);

        LIDO = ILido(_lido);
        TREASURY = _treasury;
        TRIGGERABLE_WITHDRAWALS_GATEWAY = _triggerableWithdrawalsGateway;
    }

    /// @dev Ensures the contract’s ETH balance is unchanged.
    modifier preservesEthBalance() {
        uint256 balanceBeforeCall = address(this).balance - msg.value;
        _;
        assert(address(this).balance == balanceBeforeCall);
    }

    /// @notice Initializes the contract. Can be called only once.
    /// @dev Proxy initialization method.
    function initialize() external {
        // Initializations for v0 --> v2
        _checkContractVersion(0);
        _initializeContractVersionTo(2);
    }

    /// @notice Finalizes upgrade to v2 (from v1). Can be called only once.
    function finalizeUpgrade_v2() external {
        // Finalization for v1 --> v2
        _checkContractVersion(1);
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

    function _onlyNonZeroAddress(address _address) internal pure {
        if (_address == address(0)) revert ZeroAddress();
    }

    /**
     * @dev Submits EIP-7002 full or partial withdrawal requests for the specified public keys.
     *      Each full withdrawal request instructs a validator to fully withdraw its stake and exit its duties as a validator.
     *      Each partial withdrawal request instructs a validator to withdraw a specified amount of ETH.
     *
     * @param pubkeys A tightly packed array of 48-byte public keys corresponding to validators requesting partial withdrawals.
     *                | ----- public key (48 bytes) ----- || ----- public key (48 bytes) ----- | ...
     *
     * @param amounts An array of 8-byte unsigned integers that represent the amounts, denominated in Gwei,
     *                to be withdrawn for each corresponding public key.
     *                For full withdrawal requests, the amount should be set to 0.
     *                For partial withdrawal requests, the amount should be greater than 0.
     *
     * @notice Reverts if:
     *         - The caller is not TriggerableWithdrawalsGateway.
     *         - The provided public key array is empty.
     *         - The provided public key array malformed.
     *         - The provided public key and amount arrays are not of equal length.
     *         - The provided total withdrawal fee value is invalid.
     */
    function addWithdrawalRequests(bytes[] calldata pubkeys, uint64[] calldata amounts)
        external
        payable
        preservesEthBalance
    {
        if (msg.sender != TRIGGERABLE_WITHDRAWALS_GATEWAY) {
            revert NotTriggerableWithdrawalsGateway();
        }

        _addWithdrawalRequests(pubkeys, amounts);
    }

    /**
     * @dev Retrieves the current EIP-7002 withdrawal fee.
     * @return The minimum fee required per withdrawal request.
     */
    function getWithdrawalRequestFee() public view returns (uint256) {
        return _getWithdrawalRequestFee();
    }
}
