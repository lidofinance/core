// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {VaultBeaconChainDepositor} from "./VaultBeaconChainDepositor.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable-v5.0.2/access/OwnableUpgradeable.sol";
import {IStaking} from "./interfaces/IStaking.sol";

// TODO: trigger validator exit
// TODO: add recover functions
// TODO: max size
// TODO: move roles to the external contract

/// @title StakingVault
/// @author folkyatina
/// @notice Basic ownable vault for staking. Allows to deposit ETH, create
/// batches of validators withdrawal credentials set to the vault, receive
/// various rewards and withdraw ETH.
contract StakingVault is IStaking, VaultBeaconChainDepositor, OwnableUpgradeable {
    constructor(address _owner, address _depositContract) VaultBeaconChainDepositor(_depositContract) {
        _transferOwnership(_owner);
    }

    function getWithdrawalCredentials() public view returns (bytes32) {
        return bytes32((0x01 << 248) + uint160(address(this)));
    }

    receive() external payable virtual {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        emit ELRewards(msg.sender, msg.value);
    }

    /// @notice Deposit ETH to the vault
    function deposit() public payable virtual onlyOwner {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        emit Deposit(msg.sender, msg.value);
    }

    /// @notice Create validators on the Beacon Chain
    function topupValidators(
        uint256 _keysCount,
        bytes calldata _publicKeysBatch,
        bytes calldata _signaturesBatch
    ) public virtual onlyOwner {
        if (_keysCount == 0) revert ZeroArgument("keysCount");
        // TODO: maxEB + DSM support
        _makeBeaconChainDeposits32ETH(
            _keysCount,
            bytes.concat(getWithdrawalCredentials()),
            _publicKeysBatch,
            _signaturesBatch
        );
        emit ValidatorsTopup(msg.sender, _keysCount, _keysCount * 32 ether);
    }

    function triggerValidatorExit(uint256 _numberOfKeys) public virtual onlyOwner {
        // [here will be triggerable exit]

        emit ValidatorExitTriggered(msg.sender, _numberOfKeys);
    }

    /// @notice Withdraw ETH from the vault
    function withdraw(address _receiver, uint256 _amount) public virtual onlyOwner {
        if (_receiver == address(0)) revert ZeroArgument("receiver");
        if (_amount == 0) revert ZeroArgument("amount");
        if (_amount > address(this).balance) revert NotEnoughBalance(address(this).balance);

        (bool success, ) = _receiver.call{value: _amount}("");
        if (!success) revert TransferFailed(_receiver, _amount);

        emit Withdrawal(_receiver, _amount);
    }

    error ZeroArgument(string argument);
    error TransferFailed(address receiver, uint256 amount);
    error NotEnoughBalance(uint256 balance);
    error NotAuthorized(string operation, address addr);
}
