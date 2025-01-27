// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";
import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";

/// @notice This interface is strictly intended for connecting to a specific Delegation interface and specific parameters
interface IDelegation {
    struct InitialState {
        address defaultAdmin;
        address curator;
        address minterBurner;
        address funderWithdrawer;
        address nodeOperatorManager;
        address nodeOperatorFeeClaimer;
        uint256 curatorFeeBP;
        uint256 nodeOperatorFeeBP;
    }

    function DEFAULT_ADMIN_ROLE() external view returns (bytes32);

    function CURATOR_ROLE() external view returns (bytes32);

    function FUND_WITHDRAW_ROLE() external view returns (bytes32);

    function MINT_BURN_ROLE() external view returns (bytes32);

    function NODE_OPERATOR_MANAGER_ROLE() external view returns (bytes32);

    function NODE_OPERATOR_FEE_CLAIMER_ROLE() external view returns (bytes32);

    function initialize(address _defaultAdmin) external;

    function setCuratorFeeBP(uint256 _newCuratorFeeBP) external;

    function setNodeOperatorFeeBP(uint256 _newNodeOperatorFee) external;

    function grantRole(bytes32 role, address account) external;

    function revokeRole(bytes32 role, address account) external;
}

contract VaultFactory {
    address public immutable BEACON;
    address public immutable DELEGATION_IMPL;

    /// @param _beacon The address of the beacon contract
    /// @param _delegationImpl The address of the Delegation implementation
    constructor(address _beacon, address _delegationImpl) {
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
            _delegationInitialState.nodeOperatorManager,
            _stakingVaultInitializerExtraParams
        );
        // initialize Delegation
        delegation.initialize(address(this));

        // grant roles to defaultAdmin, owner, manager, operator
        delegation.grantRole(delegation.DEFAULT_ADMIN_ROLE(), _delegationInitialState.defaultAdmin);
        delegation.grantRole(delegation.CURATOR_ROLE(), _delegationInitialState.curator);
        delegation.grantRole(delegation.FUND_WITHDRAW_ROLE(), _delegationInitialState.funderWithdrawer);
        delegation.grantRole(delegation.MINT_BURN_ROLE(), _delegationInitialState.minterBurner);
        delegation.grantRole(delegation.NODE_OPERATOR_MANAGER_ROLE(), _delegationInitialState.nodeOperatorManager);
        delegation.grantRole(
            delegation.NODE_OPERATOR_FEE_CLAIMER_ROLE(),
            _delegationInitialState.nodeOperatorFeeClaimer
        );

        // grant temporary roles to factory
        delegation.grantRole(delegation.CURATOR_ROLE(), address(this));
        delegation.grantRole(delegation.NODE_OPERATOR_MANAGER_ROLE(), address(this));
        // set fees
        delegation.setCuratorFeeBP(_delegationInitialState.curatorFeeBP);
        delegation.setNodeOperatorFeeBP(_delegationInitialState.nodeOperatorFeeBP);

        // revoke temporary roles from factory
        delegation.revokeRole(delegation.CURATOR_ROLE(), address(this));
        delegation.revokeRole(delegation.NODE_OPERATOR_MANAGER_ROLE(), address(this));
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
