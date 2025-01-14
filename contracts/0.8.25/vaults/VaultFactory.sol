// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {BeaconProxy} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/BeaconProxy.sol";
import {Clones} from "contracts/openzeppelin/5.2.0/proxy/Clones.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";

/// @notice This interface is strictly intended for connecting to a specific Delegation interface and specific parameters
interface IDelegation {
    struct InitialState {
        address defaultAdmin;
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

    function initialize() external;

    function setCuratorFee(uint256 _newCuratorFee) external;

    function setOperatorFee(uint256 _newOperatorFee) external;

    function grantRole(bytes32 role, address account) external;

    function revokeRole(bytes32 role, address account) external;
}

contract VaultFactory {
    address public immutable BEACON;
    address public immutable DELEGATION_IMPL;

    /// @param _beacon The address of the beacon contract
    /// @param _delegationImpl The address of the Delegation implementation
    constructor(
        address _beacon,
        address _delegationImpl
    ) {
        if (_beacon == address(0)) revert ZeroArgument("_beacon");
        if (_delegationImpl == address(0)) revert ZeroArgument("_delegation");

        BEACON = _beacon;
        DELEGATION_IMPL = _delegationImpl;
    }

    /// @notice Creates a new StakingVault and Delegation contracts
    /// @param _delegationInitialState The params of vault initialization
    /// @param _stakingVaultInitializerExtraParams The params of vault initialization
    function createVaultWithDelegation(
        IDelegation.InitialState calldata _delegationInitialState,
        bytes calldata _stakingVaultInitializerExtraParams
    ) external returns (IStakingVault vault, IDelegation delegation) {
        if (_delegationInitialState.curator == address(0)) revert ZeroArgument("curator");

        // create StakingVault
        vault = IStakingVault(address(new BeaconProxy(BEACON, "")));
        // create Delegation
        bytes memory immutableArgs = abi.encode(vault);
        delegation = IDelegation(Clones.cloneWithImmutableArgs(DELEGATION_IMPL, immutableArgs));

        // initialize StakingVault
        vault.initialize(
            address(delegation),
            _delegationInitialState.operator,
            _stakingVaultInitializerExtraParams
        );
        // initialize Delegation
        delegation.initialize();

        // grant roles to defaultAdmin, owner, manager, operator
        delegation.grantRole(delegation.DEFAULT_ADMIN_ROLE(), _delegationInitialState.defaultAdmin);
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
        emit DelegationCreated(_delegationInitialState.defaultAdmin, address(delegation));
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
