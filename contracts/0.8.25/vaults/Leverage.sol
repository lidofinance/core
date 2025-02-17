// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {VaultHub} from "./VaultHub.sol";

import {ILido as IStETH} from "../interfaces/ILido.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";

contract Leverage is VaultHub {
    mapping(address => bool) public isAllowedFlashMintRecipient;

    bytes32 public constant FLASH_MINT_RECIPIENT_MANAGE_ROLE = keccak256("Leverage.FlashMintRecipientManageRole");

    constructor(IStETH _stETH) VaultHub(_stETH) {}

    function initialize(address _admin) external initializer {
        if (_admin == address(0)) revert ZeroArgument("_admin");

        __VaultHub_init(_admin);
    }

    function allowFlashMintRecipient(address _recipient) external onlyRole(FLASH_MINT_RECIPIENT_MANAGE_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (isAllowedFlashMintRecipient[_recipient]) revert FlashMintRecipientAlreadyAllowed(_recipient);

        isAllowedFlashMintRecipient[_recipient] = true;

        emit FlashMintRecipientAllowed(_recipient);
    }

    function disallowFlashMintRecipient(address _recipient) external onlyRole(FLASH_MINT_RECIPIENT_MANAGE_ROLE) {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (!isAllowedFlashMintRecipient[_recipient]) revert FlashMintRecipientNotAllowed(_recipient);

        isAllowedFlashMintRecipient[_recipient] = false;

        emit FlashMintRecipientDisallowed(_recipient);
    }

    function mintSharesRetrobackedByVault(
        address _vault,
        address _recipient,
        uint256 _amountOfShares,
        bytes calldata _data
    ) external {
        // checks
        if (_vault == address(0)) revert ZeroArgument("_vault");
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_amountOfShares == 0) revert ZeroArgument("_amountOfShares");
        if (!isAllowedFlashMintRecipient[_recipient]) revert FlashMintRecipientNotAllowed(_recipient);

        _vaultAuth(_vault, "flashMint");

        VaultSocket storage socket = _connectedSocket(_vault);

        uint256 vaultSharesAfterMint = socket.sharesMinted + _amountOfShares;
        uint256 shareLimit = socket.shareLimit;
        if (vaultSharesAfterMint > shareLimit) revert ShareLimitExceeded(_vault, shareLimit);

        // effects
        socket.sharesMinted = uint96(vaultSharesAfterMint);

        uint256 reserveRatioBP = socket.reserveRatioBP;

        uint256 totalEtherLocked = (STETH.getPooledEthByShares(vaultSharesAfterMint) * TOTAL_BASIS_POINTS) /
            (TOTAL_BASIS_POINTS - reserveRatioBP);

        if (totalEtherLocked > IStakingVault(_vault).locked()) {
            IStakingVault(_vault).lock(totalEtherLocked);
        }

        // interactions
        STETH.mintExternalShares(_recipient, _amountOfShares);

        (bool success, ) = _recipient.call(_data);
        if (!success) revert FlashMintFailed(_vault, _recipient, _amountOfShares);

        // post-mint checks
        uint256 maxMintableShares = _maxMintableShares(_vault, reserveRatioBP, shareLimit);

        if (vaultSharesAfterMint > maxMintableShares) {
            revert InsufficientValuationToMint(_vault, IStakingVault(_vault).valuation());
        }
    }

    event FlashMintRecipientAllowed(address _recipient);
    event FlashMintRecipientDisallowed(address _recipient);

    error FlashMintRecipientAlreadyAllowed(address _recipient);
    error FlashMintFailed(address _vault, address _recipient, uint256 _amountOfShares);
    error FlashMintRecipientNotAllowed(address _recipient);
}
