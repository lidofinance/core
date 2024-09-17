// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

import {BeaconChainDepositor} from "../BeaconChainDepositor.sol";
import {AccessControlEnumerable} from "../utils/access/AccessControlEnumerable.sol";
import {IStaking} from "./interfaces/IStaking.sol";

// TODO: trigger validator exit
// TODO: add recover functions

/// @title StakingVault
/// @author folkyatina
/// @notice Simple vault for staking. Allows to deposit ETH and create validators.
contract StakingVault is IStaking, BeaconChainDepositor, AccessControlEnumerable {
    address public constant EVERYONE = address(0x4242424242424242424242424242424242424242);

    bytes32 public constant NODE_OPERATOR_ROLE = keccak256("NODE_OPERATOR_ROLE");
    bytes32 public constant VAULT_MANAGER_ROLE = keccak256("VAULT_MANAGER_ROLE");
    bytes32 public constant DEPOSITOR_ROLE = keccak256("DEPOSITOR_ROLE");

    constructor(
        address _owner,
        address _depositContract
    ) BeaconChainDepositor(_depositContract) {
        _grantRole(DEFAULT_ADMIN_ROLE, _owner);
        _grantRole(VAULT_MANAGER_ROLE, _owner);
        _grantRole(DEPOSITOR_ROLE, EVERYONE);
    }

    function getWithdrawalCredentials() public view returns (bytes32) {
        return bytes32((0x01 << 248) + uint160(address(this)));
    }

    receive() external payable virtual {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        emit ELRewards(msg.sender, msg.value);
    }

    /// @notice Deposit ETH to the vault
    function deposit() public payable virtual {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        if (hasRole(DEPOSITOR_ROLE, EVERYONE) || hasRole(DEPOSITOR_ROLE, msg.sender)) {
            emit Deposit(msg.sender, msg.value);
        } else {
            revert NotAuthorized("deposit", msg.sender);
        }
    }

    /// @notice Create validators on the Beacon Chain
    function topupValidators(
        uint256 _keysCount,
        bytes calldata _publicKeysBatch,
        bytes calldata _signaturesBatch
    ) public virtual onlyRole(NODE_OPERATOR_ROLE) {
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

    /// @notice Withdraw ETH from the vault
    function withdraw(
        address _receiver,
        uint256 _amount
    ) public virtual onlyRole(VAULT_MANAGER_ROLE) {
        if (_receiver == address(0)) revert ZeroArgument("receiver");
        if (_amount == 0) revert ZeroArgument("amount");
        if (_amount > address(this).balance) revert NotEnoughBalance(address(this).balance);

        (bool success, ) = _receiver.call{value: _amount}("");
        if(!success) revert TransferFailed(_receiver, _amount);

        emit Withdrawal(_receiver, _amount);
    }

    error ZeroArgument(string argument);
    error TransferFailed(address receiver, uint256 amount);
    error NotEnoughBalance(uint256 balance);
    error NotAuthorized(string operation, address addr);
}
