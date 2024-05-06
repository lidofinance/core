// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import "@openzeppelin/contracts-v4.4/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-v4.4/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts-v4.4/token/ERC20/utils/SafeERC20.sol";

import {ILidoLocator} from "../common/interfaces/ILidoLocator.sol";
import {Versioned} from "./utils/Versioned.sol";

interface ILido {
    /**
     * @notice A payable function supposed to be called only by WithdrawalVault contract
     * @dev We need a dedicated function because funds received by the default payable function
     * are treated as a user deposit
     */
    function receiveWithdrawals() external payable;
}

interface ITriggerableExit {
    function addWithdrawalRequest(bytes memory validatorPubkey, uint256 amount) external payable;
    function getFee() external view returns (uint256);
}


/**
 * @title A vault for temporary storage of withdrawals
 */
contract WithdrawalVault is Versioned {
    using SafeERC20 for IERC20;

    ILido public immutable LIDO;
    address public immutable TREASURY;
    address public immutable VALIDATORS_EXIT_BUS;
    ITriggerableExit public immutable TRIGGERABLE_EXIT;

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

    event LidoContractSet(address lido);
    event TreasuryContractSet(address treasury);
    event ValidatorsExitBusContractSet(address validatorsExitBusOracle);
    event TriggerableExitContractSet(address triggerableExit);

    // Errors
    error NotLido();
    error SenderIsNotVEBOContract();
    error NotEnoughEther(uint256 requested, uint256 balance);
    error ZeroAmount();
    error ZeroAddress();
    error ExitFeeNotEnought();
    error UnexpectedItemsCount(uint256 keysCount, uint256 amountsCount);

    /**
     * @param _lido the Lido token (stETH) address
     * @param _treasury the Lido treasury address (see ERC20/ERC721-recovery interfaces)
     * @param _validatorsExitBus the ValidatorsExitBus contract
     * @param _triggerableExit the address of the TriggerableExit contracts from EIP-7002
     */
    constructor(address _lido, address _treasury, address _validatorsExitBus, address _triggerableExit) {
        _assertNonZero(_lido);
        _assertNonZero(_treasury);
        _assertNonZero(_validatorsExitBus);
        _assertNonZero(_triggerableExit);

        LIDO = ILido(_lido);
        TREASURY = _treasury;
        VALIDATORS_EXIT_BUS = _validatorsExitBus;
        TRIGGERABLE_EXIT = ITriggerableExit(_triggerableExit);

        emit LidoContractSet(_lido);
        emit TreasuryContractSet(_treasury);
        emit ValidatorsExitBusContractSet(_validatorsExitBus);
        emit TriggerableExitContractSet(_triggerableExit);
    }

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
     * The exit request consists of two parts - the keys and the amount requested for the exit,
     * i.e partial withdrawals.
     *
     * @notice The fee will be the same for all keys, because it is updated using a system call
     *         at the very end of block processing.
     *
     * @param _pubkeys the keys requested to exit
     * @param _amounts the amounts requested to exit for each key
     */
    function triggerELValidatorExit(bytes[] calldata _pubkeys, uint256[] calldata _amounts) external payable {
        if (msg.sender != VALIDATORS_EXIT_BUS) {
            revert SenderIsNotVEBOContract();
        }

        uint256 keysCount = _pubkeys.length;
        uint256 amountsCount = _amounts.length;
        if (keysCount != amountsCount) {
            revert UnexpectedItemsCount(keysCount, amountsCount);
        }

        if (TRIGGERABLE_EXIT.getFee() * keysCount > msg.value) {
            revert ExitFeeNotEnought();
        }

        uint256 prevVaultBalance = address(this).balance - msg.value;
        uint256 fee = msg.value / keysCount;

        for(uint256 i = 0; i < keysCount; ++i) {
            TRIGGERABLE_EXIT.addWithdrawalRequest{value: fee}(_pubkeys[i], _amounts[i]);
        }

        assert(address(this).balance == prevVaultBalance);
    }

    function _assertNonZero(address _address) internal pure {
        if (_address == address(0)) revert ZeroAddress();
    }
}
