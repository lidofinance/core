// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

import {IStaking} from "./interfaces/IStaking.sol";
import {BeaconChainDepositor} from "../BeaconChainDepositor.sol";
import {AccessControlEnumerable} from "../utils/access/AccessControlEnumerable.sol";
import {Versioned} from "../utils/Versioned.sol";

// TODO: trigger validator exit
// TODO: add recover functions
// TODO: max size
// TODO: move roles to the external contract

/// @title StakingVault
/// @author folkyatina
/// @notice Basic ownable vault for staking. Allows to deposit ETH, create
/// batches of validators withdrawal credentials set to the vault, receive
/// various rewards and withdraw ETH.
contract StakingVault is IStaking, BeaconChainDepositor, AccessControlEnumerable, Versioned {

    uint8 private constant _version = 1;

    address public constant EVERYONE = address(0x4242424242424242424242424242424242424242);

    bytes32 public constant NODE_OPERATOR_ROLE = keccak256("NODE_OPERATOR_ROLE");
    bytes32 public constant VAULT_MANAGER_ROLE = keccak256("VAULT_MANAGER_ROLE");
    bytes32 public constant DEPOSITOR_ROLE = keccak256("DEPOSITOR_ROLE");

    error ZeroAddress(string field);

    constructor(address _depositContract) BeaconChainDepositor(_depositContract) {}

    /// @notice Initialize the contract storage explicitly.
    /// @param _admin admin address that can TBD
    function initialize(address _admin) public {
        if (_admin == address(0)) revert ZeroAddress("_admin");

        _initializeContractVersionTo(1);

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(VAULT_MANAGER_ROLE, _admin);
        _grantRole(DEPOSITOR_ROLE, EVERYONE);
    }

    function version() public pure virtual returns(uint8) {
        return _version;
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

    function triggerValidatorExit(
        uint256 _numberOfKeys
    ) public virtual onlyRole(VAULT_MANAGER_ROLE) {
        // [here will be triggerable exit]

        emit ValidatorExitTriggered(msg.sender, _numberOfKeys);
    }

    /// @notice Withdraw ETH from the vault
    function withdraw(
        address _receiver,
        uint256 _amount
    ) public virtual onlyRole(VAULT_MANAGER_ROLE) {
        if (_receiver == address(0)) revert ZeroArgument("receiver");
        if (_amount == 0) revert ZeroArgument("amount");
        if (_amount > address(this).balance) revert NotEnoughBalance(address(this).balance);

        (bool success,) = _receiver.call{value: _amount}("");
        if (!success) revert TransferFailed(_receiver, _amount);

        emit Withdrawal(_receiver, _amount);
    }

    error ZeroArgument(string argument);
    error TransferFailed(address receiver, uint256 amount);
    error NotEnoughBalance(uint256 balance);
    error NotAuthorized(string operation, address addr);
}
