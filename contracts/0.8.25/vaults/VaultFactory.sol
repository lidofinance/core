// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";
import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {Delegation} from "./Delegation.sol";

struct DelegationConfig {
    address defaultAdmin;
    address funder;
    address withdrawer;
    address minter;
    address burner;
    address rebalancer;
    address depositPauser;
    address depositResumer;
    address exitRequester;
    address disconnecter;
    address curator;
    address nodeOperatorManager;
    address nodeOperatorFeeClaimer;
    uint16 curatorFeeBP;
    uint16 nodeOperatorFeeBP;
}

contract VaultFactory {
    address public immutable BEACON;
    address public immutable PREDEPOSIT_GUARANTEE;
    address public immutable DELEGATION_IMPL;

    /// @param _beacon The address of the beacon contract
    /// @param _delegationImpl The address of the Delegation implementation
    /// @param _predeposit_guarantee The address of the PredepositGuarantee contract
    constructor(address _beacon, address _delegationImpl, address _predeposit_guarantee) {
        if (_beacon == address(0)) revert ZeroArgument("_beacon");
        if (_delegationImpl == address(0)) revert ZeroArgument("_delegation");
        if (_predeposit_guarantee == address(0)) revert ZeroArgument("_predeposit_guarantee");

        BEACON = _beacon;
        DELEGATION_IMPL = _delegationImpl;
        PREDEPOSIT_GUARANTEE = _predeposit_guarantee;
    }

    /// @notice Creates a new StakingVault and Delegation contracts
    /// @param _delegationConfig The params of delegation initialization
    /// @param _stakingVaultInitializerExtraParams The params of vault initialization
    function createVaultWithDelegation(
        DelegationConfig calldata _delegationConfig,
        bytes calldata _stakingVaultInitializerExtraParams
    ) external returns (IStakingVault vault, Delegation delegation) {
        if (_delegationConfig.curator == address(0)) revert ZeroArgument("curator");

        // create StakingVault
        vault = IStakingVault(address(new BeaconProxy(BEACON, "")));

        // create Delegation
        bytes memory immutableArgs = abi.encode(vault);
        delegation = Delegation(payable(Clones.cloneWithImmutableArgs(DELEGATION_IMPL, immutableArgs)));

        // initialize StakingVault
        vault.initialize(
            address(delegation),
            _delegationConfig.nodeOperatorManager,
            PREDEPOSIT_GUARANTEE,
            _stakingVaultInitializerExtraParams
        );

        // initialize Delegation
        delegation.initialize(address(this));

        // setup roles
        delegation.grantRole(delegation.DEFAULT_ADMIN_ROLE(), _delegationConfig.defaultAdmin);
        delegation.grantRole(delegation.FUND_ROLE(), _delegationConfig.funder);
        delegation.grantRole(delegation.WITHDRAW_ROLE(), _delegationConfig.withdrawer);
        delegation.grantRole(delegation.MINT_ROLE(), _delegationConfig.minter);
        delegation.grantRole(delegation.BURN_ROLE(), _delegationConfig.burner);
        delegation.grantRole(delegation.REBALANCE_ROLE(), _delegationConfig.rebalancer);
        delegation.grantRole(delegation.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(), _delegationConfig.depositPauser);
        delegation.grantRole(delegation.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(), _delegationConfig.depositResumer);
        delegation.grantRole(delegation.REQUEST_VALIDATOR_EXIT_ROLE(), _delegationConfig.exitRequester);
        delegation.grantRole(delegation.VOLUNTARY_DISCONNECT_ROLE(), _delegationConfig.disconnecter);
        delegation.grantRole(delegation.CURATOR_ROLE(), _delegationConfig.curator);
        delegation.grantRole(delegation.NODE_OPERATOR_MANAGER_ROLE(), _delegationConfig.nodeOperatorManager);
        delegation.grantRole(delegation.NODE_OPERATOR_FEE_CLAIMER_ROLE(), _delegationConfig.nodeOperatorFeeClaimer);

        // grant temporary roles to factory
        delegation.grantRole(delegation.CURATOR_ROLE(), address(this));
        delegation.grantRole(delegation.NODE_OPERATOR_MANAGER_ROLE(), address(this));

        // set fees
        delegation.setCuratorFeeBP(_delegationConfig.curatorFeeBP);
        delegation.setNodeOperatorFeeBP(_delegationConfig.nodeOperatorFeeBP);

        // revoke temporary roles from factory
        delegation.revokeRole(delegation.CURATOR_ROLE(), address(this));
        delegation.revokeRole(delegation.NODE_OPERATOR_MANAGER_ROLE(), address(this));
        delegation.revokeRole(delegation.DEFAULT_ADMIN_ROLE(), address(this));

        emit VaultCreated(address(delegation), address(vault));
        emit DelegationCreated(_delegationConfig.defaultAdmin, address(delegation));
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

    /**
     * @notice Error thrown for when a given value cannot be zero
     * @param argument Name of the argument
     */
    error ZeroArgument(string argument);
}
