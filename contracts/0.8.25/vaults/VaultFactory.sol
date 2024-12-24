// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/BeaconProxy.sol";
import {Clones} from "@openzeppelin/contracts-v5.0.2/proxy/Clones.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";

pragma solidity 0.8.25;

interface IDelegation {
    struct InitialState {
        address curator;
        address staker;
        address tokenMaster;
        address operator;
        address claimOperatorDueRole;
        uint256 curatorFee;
        uint256 operatorFee;
    }

    function DEFAULT_ADMIN_ROLE() external view returns (bytes32);

    function CURATOR_ROLE() external view returns (bytes32);

    function STAKER_ROLE() external view returns (bytes32);

    function TOKEN_MASTER_ROLE() external view returns (bytes32);

    function OPERATOR_ROLE() external view returns (bytes32);

    function CLAIM_OPERATOR_DUE_ROLE() external view returns (bytes32);

    function initialize(address _stakingVault) external;

    function setCuratorFee(uint256 _newCuratorFee) external;

    function setOperatorFee(uint256 _newOperatorFee) external;

    function grantRole(bytes32 role, address account) external;

    function revokeRole(bytes32 role, address account) external;
}

contract VaultFactory is UpgradeableBeacon {
    address public immutable delegationImpl;

    /// @param _owner The address of the VaultFactory owner
    /// @param _stakingVaultImpl The address of the StakingVault implementation
    /// @param _delegationImpl The address of the Delegation implementation
    constructor(
        address _owner,
        address _stakingVaultImpl,
        address _delegationImpl
    ) UpgradeableBeacon(_stakingVaultImpl, _owner) {
        if (_delegationImpl == address(0)) revert ZeroArgument("_delegation");

        delegationImpl = _delegationImpl;
    }

    /// @notice Creates a new StakingVault and Delegation contracts
    /// @param _delegationInitialState The params of vault initialization
    /// @param _stakingVaultInitializerExtraParams The params of vault initialization
    function createVault(
        IDelegation.InitialState calldata _delegationInitialState,
        bytes calldata _stakingVaultInitializerExtraParams
    ) external returns (IStakingVault vault, IDelegation delegation) {
        if (_delegationInitialState.curator == address(0)) revert ZeroArgument("curator");

        // create StakingVault
        vault = IStakingVault(address(new BeaconProxy(address(this), "")));
        // create Delegation
        delegation = IDelegation(Clones.clone(delegationImpl));

        // initialize StakingVault
        vault.initialize(address(delegation), _delegationInitialState.operator, _stakingVaultInitializerExtraParams);
        // initialize Delegation
        delegation.initialize(address(vault));

        // grant roles to owner, manager, operator
        delegation.grantRole(delegation.DEFAULT_ADMIN_ROLE(), msg.sender);
        delegation.grantRole(delegation.CURATOR_ROLE(), _delegationInitialState.curator);
        delegation.grantRole(delegation.STAKER_ROLE(), _delegationInitialState.staker);
        delegation.grantRole(delegation.TOKEN_MASTER_ROLE(), _delegationInitialState.tokenMaster);
        delegation.grantRole(delegation.OPERATOR_ROLE(), _delegationInitialState.operator);
        delegation.grantRole(delegation.CLAIM_OPERATOR_DUE_ROLE(), _delegationInitialState.claimOperatorDueRole);

        // grant temporary roles to factory
        delegation.grantRole(delegation.CURATOR_ROLE(), address(this));
        delegation.grantRole(delegation.OPERATOR_ROLE(), address(this));
        // set fees
        delegation.setCuratorFee(_delegationInitialState.curatorFee);
        delegation.setOperatorFee(_delegationInitialState.operatorFee);

        // revoke temporary roles from factory
        delegation.revokeRole(delegation.CURATOR_ROLE(), address(this));
        delegation.revokeRole(delegation.OPERATOR_ROLE(), address(this));
        delegation.revokeRole(delegation.DEFAULT_ADMIN_ROLE(), address(this));

        emit VaultCreated(address(delegation), address(vault));
        emit DelegationCreated(msg.sender, address(delegation));
    }

    /**
     * @notice Event emitted on a Vault creation
     * @param owner The address of the Vault owner
     * @param vault The address of the created Vault
     */
    event VaultCreated(address indexed owner, address indexed vault);

    /**
     * @notice Event emitted on a Delegation creation
     * @param admin The address of the Delegation admin
     * @param delegation The address of the created Delegation
     */
    event DelegationCreated(address indexed admin, address indexed delegation);

    error ZeroArgument(string);
}
