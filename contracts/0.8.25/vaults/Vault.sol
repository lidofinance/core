// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable-v5.0.2/access/OwnableUpgradeable.sol";
import {VaultBeaconChainDepositor} from "./VaultBeaconChainDepositor.sol";
import {IVault} from "./interfaces/IVault.sol";

// TODO: trigger validator exit
// TODO: add recover functions
// TODO: max size

/// @title Vault
/// @author folkyatina
/// @notice A basic vault contract for managing Ethereum deposits, withdrawals, and validator operations
///         on the Beacon Chain. It allows the owner to fund the vault, create validators, trigger validator exits,
///         and withdraw ETH. The vault also handles execution layer rewards.
contract Vault is IVault, VaultBeaconChainDepositor, OwnableUpgradeable {
    constructor(address _owner, address _depositContract) VaultBeaconChainDepositor(_depositContract) {
        _transferOwnership(_owner);
    }

    receive() external payable virtual {
        if (msg.value == 0) revert Zero("msg.value");

        emit ExecRewardsReceived(msg.sender, msg.value);
    }

    /// @inheritdoc IVault
    function getWithdrawalCredentials() public view returns (bytes32) {
        return bytes32((0x01 << 248) + uint160(address(this)));
    }

    /// @inheritdoc IVault
    function fund() public payable virtual onlyOwner {
        if (msg.value == 0) revert Zero("msg.value");

        emit Funded(msg.sender, msg.value);
    }

    // TODO: maxEB + DSM support
    /// @inheritdoc IVault
    function deposit(
        uint256 _numberOfDeposits,
        bytes calldata _pubkeys,
        bytes calldata _signatures
    ) public virtual onlyOwner {
        if (_numberOfDeposits == 0) revert Zero("_numberOfDeposits");

        _makeBeaconChainDeposits32ETH(
            _numberOfDeposits,
            bytes.concat(getWithdrawalCredentials()),
            _pubkeys,
            _signatures
        );
        emit Deposited(msg.sender, _numberOfDeposits, _numberOfDeposits * 32 ether);
    }

    /// @inheritdoc IVault
    function triggerValidatorExits(uint256 _numberOfValidators) public virtual onlyOwner {
        // [here will be triggerable exit]

        emit ValidatorExitsTriggered(msg.sender, _numberOfValidators);
    }

    /// @inheritdoc IVault
    function withdraw(address _recipient, uint256 _amount) public virtual onlyOwner {
        if (_recipient == address(0)) revert Zero("receiver");
        if (_amount == 0) revert Zero("amount");
        if (_amount > address(this).balance) revert InsufficientBalance(address(this).balance);

        (bool success, ) = _recipient.call{value: _amount}("");
        if (!success) revert TransferFailed(_recipient, _amount);

        emit Withdrawn(msg.sender, _recipient, _amount);
    }
}
