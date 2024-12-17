// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {BeaconProxy} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/BeaconProxy.sol";
import {Clones} from "@openzeppelin/contracts-v5.0.2/proxy/Clones.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";

/// @notice This interface is strictly intended for connecting to a specific Delegation interface and specific parameters
interface IDelegation {
    struct InitialState {
        uint256 managementFeeBP;
        uint256 performanceFeeBP;
        address defaultAdmin;
        address manager;
        address operator;
    }

    function DEFAULT_ADMIN_ROLE() external view returns (bytes32);

    function MANAGER_ROLE() external view returns (bytes32);

    function OPERATOR_ROLE() external view returns (bytes32);

    function initialize(address _stakingVault) external;

    function setManagementFee(uint256 _newManagementFee) external;

    function setPerformanceFee(uint256 _newPerformanceFee) external;

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
        if (_delegationInitialState.manager == address(0)) revert ZeroArgument("manager");

        vault = IStakingVault(address(new BeaconProxy(BEACON, "")));
        delegation = IDelegation(Clones.clone(DELEGATION_IMPL));

        delegation.initialize(address(vault));

        delegation.grantRole(delegation.DEFAULT_ADMIN_ROLE(), _delegationInitialState.defaultAdmin);
        delegation.grantRole(delegation.MANAGER_ROLE(), _delegationInitialState.manager);
        delegation.grantRole(delegation.OPERATOR_ROLE(), _delegationInitialState.operator);

        delegation.grantRole(delegation.MANAGER_ROLE(), address(this));
        delegation.grantRole(delegation.OPERATOR_ROLE(), address(this));
        delegation.setManagementFee(_delegationInitialState.managementFeeBP);
        delegation.setPerformanceFee(_delegationInitialState.performanceFeeBP);

        //revoke roles from factory
        delegation.revokeRole(delegation.MANAGER_ROLE(), address(this));
        delegation.revokeRole(delegation.OPERATOR_ROLE(), address(this));
        delegation.revokeRole(delegation.DEFAULT_ADMIN_ROLE(), address(this));

        vault.initialize(
            address(this),
            address(delegation),
            _delegationInitialState.operator,
            _stakingVaultInitializerExtraParams
        );

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
