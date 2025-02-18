// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {VaultHub} from "./VaultHub.sol";

import {ILido as IStETH} from "../interfaces/ILido.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";

abstract contract FlashMinter is VaultHub {
    mapping(address => bool) public isRegisteredFlashMintRecipient;

    bytes32 public constant FLASH_MINT_RECIPIENT_REGISTRY_ROLE = keccak256("FlashMinter.RegistryRole");

    constructor(IStETH _stETH) VaultHub(_stETH) {}

    /**
     * @notice Register an address as a recipient for flash minting
     * @param _recipient The address of the recipient to register
     */
    function registerFlashMintRecipient(address _recipient) external onlyRole(FLASH_MINT_RECIPIENT_REGISTRY_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (isRegisteredFlashMintRecipient[_recipient]) revert FlashMintRecipientAlreadyRegistered(_recipient);

        isRegisteredFlashMintRecipient[_recipient] = true;

        emit FlashMintRecipientAdded(msg.sender, _recipient);
    }

    /**
     * @notice Unregister an address as a recipient for flash minting
     * @param _recipient The address of the recipient to unregister
     */
    function unregisterFlashMintRecipient(address _recipient) external onlyRole(FLASH_MINT_RECIPIENT_REGISTRY_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (!isRegisteredFlashMintRecipient[_recipient]) revert FlashMintRecipientNotRegistered(_recipient);

        delete isRegisteredFlashMintRecipient[_recipient];

        emit FlashMintRecipientRemoved(msg.sender, _recipient);
    }

    function flashMintShares(
        address _vault,
        address _recipient,
        uint256 _amountOfShares,
        bytes calldata _data
    ) external whenResumed {
        // basic checks & auth
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (_amountOfShares == 0) revert ZeroArgument("_amountOfShares");
        // allow only registered recipients or the vault owner itself for flash minting
        if (!isRegisteredFlashMintRecipient[_recipient] && _recipient != OwnableUpgradeable(_vault).owner())
            revert FlashMintRecipientInvalid(_recipient);

        _vaultAuth(_vault, "flashMint");

        // cannot result in shares exceeding the share limit
        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 vaultSharesAfterMint = socket.sharesMinted + _amountOfShares;
        uint256 shareLimit = socket.shareLimit;
        if (vaultSharesAfterMint > shareLimit) revert ShareLimitExceeded(_vault, shareLimit);

        // update the locked amount in advance
        socket.sharesMinted = uint96(vaultSharesAfterMint);
        uint256 reserveRatioBP = socket.reserveRatioBP;

        uint256 totalEtherLocked = (STETH.getPooledEthByShares(vaultSharesAfterMint) * TOTAL_BASIS_POINTS) /
            (TOTAL_BASIS_POINTS - reserveRatioBP);

        if (totalEtherLocked > IStakingVault(_vault).locked()) {
            IStakingVault(_vault).lock(totalEtherLocked);
        }

        // mint the shares to the recipient
        STETH.mintExternalShares(_recipient, _amountOfShares);

        // call the recipient with the provided data
        (bool success, ) = _recipient.call(_data);
        if (!success) revert CallbackFailed(_recipient, _data);

        // shares cannot exceed the max mintable amount
        uint256 maxMintableShares = _maxMintableShares(_vault, reserveRatioBP, shareLimit);

        if (vaultSharesAfterMint > maxMintableShares) {
            revert InsufficientValuationToMint(_vault, IStakingVault(_vault).valuation());
        }
    }

    event FlashMintRecipientAdded(address indexed sender, address indexed recipient);
    event FlashMintRecipientRemoved(address indexed sender, address indexed recipient);

    error FlashMintRecipientAlreadyRegistered(address _recipient);
    error FlashMintRecipientNotRegistered(address _recipient);
    error FlashMintRecipientInvalid(address _recipient);
    error CallbackFailed(address _recipient, bytes _data);
}
