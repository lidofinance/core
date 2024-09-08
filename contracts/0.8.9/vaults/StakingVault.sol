// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

import {BeaconChainDepositor} from "../BeaconChainDepositor.sol";
import {IStaking} from "./interfaces/IStaking.sol";

// TODO: add NodeOperator role
// TODO: add depositor whitelist
// TODO: trigger validator exit
// TODO: add recover functions

/// @title StakingVault
/// @author folkyatina
/// @notice Simple vault for staking. Allows to deposit ETH and create validators.
contract StakingVault is IStaking, BeaconChainDepositor {
    address public owner;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAnOwner(msg.sender);
        _;
    }

    constructor(
        address _owner,
        address _depositContract
    ) BeaconChainDepositor(_depositContract) {
        owner = _owner;
    }

    function getWithdrawalCredentials() public view returns (bytes32) {
        return bytes32((0x01 << 248) + uint160(address(this)));
    }

    receive() external payable virtual {
        emit ELRewardsReceived(msg.sender, msg.value);
    }

    /// @notice Deposit ETH to the vault
    function deposit() public payable virtual {
        emit Deposit(msg.sender, msg.value);
    }

    /// @notice Create validators on the Beacon Chain
    function createValidators(
        uint256 _keysCount,
        bytes calldata _publicKeysBatch,
        bytes calldata _signaturesBatch
    ) public virtual onlyOwner {
        // TODO: maxEB + DSM support
        _makeBeaconChainDeposits32ETH(
            _keysCount,
            bytes.concat(getWithdrawalCredentials()),
            _publicKeysBatch,
            _signaturesBatch
        );

        emit ValidatorsCreated(msg.sender, _keysCount);
    }

    /// @notice Withdraw ETH from the vault
    function withdraw(
        address _receiver,
        uint256 _amount
    ) public virtual onlyOwner {
        if (msg.sender == address(0)) revert ZeroAddress();

        (bool success, ) = _receiver.call{value: _amount}("");
        if(!success) revert TransferFailed(_receiver, _amount);

        emit Withdrawal(_receiver, _amount);
    }

    error NotAnOwner(address sender);
    error ZeroAddress();
    error TransferFailed(address receiver, uint256 amount);
}
