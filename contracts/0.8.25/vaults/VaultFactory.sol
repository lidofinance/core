// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/BeaconProxy.sol";
import {Clones} from "@openzeppelin/contracts-v5.0.2/proxy/Clones.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";

pragma solidity 0.8.25;

interface IDelegation {
    struct InitializationParams {
        uint256 managementFee;
        uint256 performanceFee;
        address manager;
        address operator;
    }

    function DEFAULT_ADMIN_ROLE() external view returns (bytes32);

    function MANAGER_ROLE() external view returns (bytes32);

    function OPERATOR_ROLE() external view returns (bytes32);

    function LIDO_DAO_ROLE() external view returns (bytes32);

    function initialize(address admin, address stakingVault) external;

    function setManagementFee(uint256 _newManagementFee) external;

    function setPerformanceFee(uint256 _newPerformanceFee) external;

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
    /// @param _stakingVaultParams The params of vault initialization
    /// @param _initializationParams The params of vault initialization
    function createVault(
        bytes calldata _stakingVaultParams,
        IDelegation.InitializationParams calldata _initializationParams,
        address _lidoAgent
    ) external returns (IStakingVault vault, IDelegation delegation) {
        if (_initializationParams.manager == address(0)) revert ZeroArgument("manager");
        if (_initializationParams.operator == address(0)) revert ZeroArgument("operator");

        vault = IStakingVault(address(new BeaconProxy(address(this), "")));

        delegation = IDelegation(Clones.clone(delegationImpl));

        delegation.initialize(address(this), address(vault));

        delegation.grantRole(delegation.LIDO_DAO_ROLE(), _lidoAgent);
        delegation.grantRole(delegation.MANAGER_ROLE(), _initializationParams.manager);
        delegation.grantRole(delegation.OPERATOR_ROLE(), _initializationParams.operator);
        delegation.grantRole(delegation.DEFAULT_ADMIN_ROLE(), msg.sender);

        delegation.grantRole(delegation.OPERATOR_ROLE(), address(this));
        delegation.grantRole(delegation.MANAGER_ROLE(), address(this));
        delegation.setManagementFee(_initializationParams.managementFee);
        delegation.setPerformanceFee(_initializationParams.performanceFee);

        //revoke roles from factory
        delegation.revokeRole(delegation.MANAGER_ROLE(), address(this));
        delegation.revokeRole(delegation.OPERATOR_ROLE(), address(this));
        delegation.revokeRole(delegation.DEFAULT_ADMIN_ROLE(), address(this));
        delegation.revokeRole(delegation.LIDO_DAO_ROLE(), address(this));

        vault.initialize(address(delegation), _stakingVaultParams);

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