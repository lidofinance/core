// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/BeaconProxy.sol";
import {Clones} from "@openzeppelin/contracts-v5.0.2/proxy/Clones.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";

pragma solidity 0.8.25;

interface IStVaultOwnerWithDelegation {
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
    address public immutable stVaultOwnerWithDelegationImpl;

    /// @param _owner The address of the VaultFactory owner
    /// @param _stakingVaultImpl The address of the StakingVault implementation
    /// @param _stVaultOwnerWithDelegationImpl The address of the StVaultOwnerWithDelegation implementation
    constructor(
        address _owner,
        address _stakingVaultImpl,
        address _stVaultOwnerWithDelegationImpl
    ) UpgradeableBeacon(_stakingVaultImpl, _owner) {
        if (_stVaultOwnerWithDelegationImpl == address(0)) revert ZeroArgument("_stVaultOwnerWithDelegation");

        stVaultOwnerWithDelegationImpl = _stVaultOwnerWithDelegationImpl;
    }

    /// @notice Creates a new StakingVault and StVaultOwnerWithDelegation contracts
    /// @param _stakingVaultParams The params of vault initialization
    /// @param _initializationParams The params of vault initialization
    function createVault(
        bytes calldata _stakingVaultParams,
        IStVaultOwnerWithDelegation.InitializationParams calldata _initializationParams,
        address _lidoAgent
    ) external returns (IStakingVault vault, IStVaultOwnerWithDelegation stVaultOwnerWithDelegation) {
        if (_initializationParams.manager == address(0)) revert ZeroArgument("manager");
        if (_initializationParams.operator == address(0)) revert ZeroArgument("operator");

        vault = IStakingVault(address(new BeaconProxy(address(this), "")));

        stVaultOwnerWithDelegation = IStVaultOwnerWithDelegation(Clones.clone(stVaultOwnerWithDelegationImpl));

        stVaultOwnerWithDelegation.initialize(address(this), address(vault));

        stVaultOwnerWithDelegation.grantRole(stVaultOwnerWithDelegation.LIDO_DAO_ROLE(), _lidoAgent);
        stVaultOwnerWithDelegation.grantRole(stVaultOwnerWithDelegation.MANAGER_ROLE(), _initializationParams.manager);
        stVaultOwnerWithDelegation.grantRole(
            stVaultOwnerWithDelegation.OPERATOR_ROLE(),
            _initializationParams.operator
        );
        stVaultOwnerWithDelegation.grantRole(stVaultOwnerWithDelegation.DEFAULT_ADMIN_ROLE(), msg.sender);

        stVaultOwnerWithDelegation.grantRole(stVaultOwnerWithDelegation.MANAGER_ROLE(), address(this));
        stVaultOwnerWithDelegation.setManagementFee(_initializationParams.managementFee);
        stVaultOwnerWithDelegation.setPerformanceFee(_initializationParams.performanceFee);

        //revoke roles from factory
        stVaultOwnerWithDelegation.revokeRole(stVaultOwnerWithDelegation.MANAGER_ROLE(), address(this));
        stVaultOwnerWithDelegation.revokeRole(stVaultOwnerWithDelegation.DEFAULT_ADMIN_ROLE(), address(this));
        stVaultOwnerWithDelegation.revokeRole(stVaultOwnerWithDelegation.LIDO_DAO_ROLE(), address(this));

        vault.initialize(address(stVaultOwnerWithDelegation), _stakingVaultParams);

        emit VaultCreated(address(stVaultOwnerWithDelegation), address(vault));
        emit StVaultOwnerWithDelegationCreated(msg.sender, address(stVaultOwnerWithDelegation));
    }

    /**
     * @notice Event emitted on a Vault creation
     * @param owner The address of the Vault owner
     * @param vault The address of the created Vault
     */
    event VaultCreated(address indexed owner, address indexed vault);

    /**
     * @notice Event emitted on a StVaultOwnerWithDelegation creation
     * @param admin The address of the StVaultOwnerWithDelegation admin
     * @param stVaultOwnerWithDelegation The address of the created StVaultOwnerWithDelegation
     */
    event StVaultOwnerWithDelegationCreated(address indexed admin, address indexed stVaultOwnerWithDelegation);

    error ZeroArgument(string);
}
