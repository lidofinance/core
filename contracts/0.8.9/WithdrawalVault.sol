// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import "@openzeppelin/contracts-v4.4/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-v4.4/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts-v4.4/token/ERC20/utils/SafeERC20.sol";

import {Versioned} from "./utils/Versioned.sol";
import {WithdrawalRequests} from "./lib/WithdrawalRequests.sol";

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
contract WithdrawalVault is Versioned {
    using SafeERC20 for IERC20;

    ILido public immutable LIDO;
    address public immutable TREASURY;
    address public immutable VALIDATORS_EXIT_BUS;

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
    error NotValidatorExitBus();
    error NotEnoughEther(uint256 requested, uint256 balance);
    error ZeroAmount();

    /**
     * @param _lido the Lido token (stETH) address
     * @param _treasury the Lido treasury address (see ERC20/ERC721-recovery interfaces)
     */
    constructor(address _lido, address _treasury, address _validatorsExitBus) {
        _assertNonZero(_lido);
        _assertNonZero(_treasury);
        _assertNonZero(_validatorsExitBus);

        LIDO = ILido(_lido);
        TREASURY = _treasury;
        VALIDATORS_EXIT_BUS = _validatorsExitBus;
    }

    /**
     * @notice Initialize the contract explicitly.
     * Sets the contract version to '1'.
     */
    function initialize() external {
        _initializeContractVersionTo(1);
        _updateContractVersion(2);
    }

    function finalizeUpgrade_v2() external {
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

    /**
     * @dev Adds full withdrawal requests for the provided public keys.
     *      The validator will fully withdraw and exit its duties as a validator.
     * @param pubkeys An array of public keys for the validators requesting full withdrawals.
     */
    function addFullWithdrawalRequests(
        bytes[] calldata pubkeys
    ) external payable {
        if(msg.sender != address(VALIDATORS_EXIT_BUS)) {
            revert NotValidatorExitBus();
        }

        WithdrawalRequests.addFullWithdrawalRequests(pubkeys);
    }

    function getWithdrawalRequestFee() external view returns (uint256) {
        return WithdrawalRequests.getWithdrawalRequestFee();
    }

    function _assertNonZero(address _address) internal pure {
        if (_address == address(0)) revert ZeroAddress();
    }
}
