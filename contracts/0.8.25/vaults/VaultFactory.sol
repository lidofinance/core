// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";
import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {Delegation} from "./Delegation.sol";

struct DelegationConfig {
    address defaultAdmin;
    address nodeOperatorManager;
    address assetRecoverer;
    uint256 confirmExpiry;
    uint16 nodeOperatorFeeBP;
    address[] funders;
    address[] withdrawers;
    address[] minters;
    address[] burners;
    address[] rebalancers;
    address[] depositPausers;
    address[] depositResumers;
    address[] validatorExitRequesters;
    address[] validatorWithdrawalTriggerers;
    address[] disconnecters;
    address[] nodeOperatorFeeClaimers;
}

contract VaultFactory {
    uint256 public constant VAULTHUB_CONNECT_DEPOSIT = 1 ether;

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
    /// @param _delegationConfig The params of delegation initialization
    /// @param _stakingVaultInitializerExtraParams The params of vault initialization
    function createVaultWithDelegation(
        DelegationConfig calldata _delegationConfig,
        bytes calldata _stakingVaultInitializerExtraParams
    ) external payable returns (IStakingVault vault, Delegation delegation) {
        if (msg.value < VAULTHUB_CONNECT_DEPOSIT) revert InsufficientMsgValueForConnectDeposit();

        // create StakingVault
        vault = IStakingVault(address(new BeaconProxy(BEACON, "")));

        // create Delegation
        bytes memory immutableArgs = abi.encode(vault);
        delegation = Delegation(payable(Clones.cloneWithImmutableArgs(DELEGATION_IMPL, immutableArgs)));

        // initialize StakingVault
        vault.initialize(
            address(this),
            _delegationConfig.nodeOperatorManager,
            _stakingVaultInitializerExtraParams
        );

        vault.fund{value: msg.value}();
        vault.lock(VAULTHUB_CONNECT_DEPOSIT);
        OwnableUpgradeable(address(vault)).transferOwnership(address(delegation));

        // initialize Delegation
        delegation.initialize(address(this), _delegationConfig.confirmExpiry);

        // setup roles from config
        // basic permissions to the staking vault
        delegation.grantRole(delegation.DEFAULT_ADMIN_ROLE(), _delegationConfig.defaultAdmin);
        delegation.grantRole(delegation.NODE_OPERATOR_MANAGER_ROLE(), _delegationConfig.nodeOperatorManager);
        delegation.grantRole(delegation.ASSET_RECOVERY_ROLE(), _delegationConfig.assetRecoverer);

        for (uint256 i = 0; i < _delegationConfig.funders.length; i++) {
            delegation.grantRole(delegation.FUND_ROLE(), _delegationConfig.funders[i]);
        }
        for (uint256 i = 0; i < _delegationConfig.withdrawers.length; i++) {
            delegation.grantRole(delegation.WITHDRAW_ROLE(), _delegationConfig.withdrawers[i]);
        }
        for (uint256 i = 0; i < _delegationConfig.minters.length; i++) {
            delegation.grantRole(delegation.MINT_ROLE(), _delegationConfig.minters[i]);
        }
        for (uint256 i = 0; i < _delegationConfig.burners.length; i++) {
            delegation.grantRole(delegation.BURN_ROLE(), _delegationConfig.burners[i]);
        }
        for (uint256 i = 0; i < _delegationConfig.rebalancers.length; i++) {
            delegation.grantRole(delegation.REBALANCE_ROLE(), _delegationConfig.rebalancers[i]);
        }
        for (uint256 i = 0; i < _delegationConfig.depositPausers.length; i++) {
            delegation.grantRole(delegation.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(), _delegationConfig.depositPausers[i]);
        }
        for (uint256 i = 0; i < _delegationConfig.depositResumers.length; i++) {
            delegation.grantRole(delegation.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(), _delegationConfig.depositResumers[i]);
        }
        for (uint256 i = 0; i < _delegationConfig.validatorExitRequesters.length; i++) {
            delegation.grantRole(
                delegation.REQUEST_VALIDATOR_EXIT_ROLE(),
                _delegationConfig.validatorExitRequesters[i]
            );
        }
        for (uint256 i = 0; i < _delegationConfig.validatorWithdrawalTriggerers.length; i++) {
            delegation.grantRole(
                delegation.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(),
                _delegationConfig.validatorWithdrawalTriggerers[i]
            );
        }
        for (uint256 i = 0; i < _delegationConfig.disconnecters.length; i++) {
            delegation.grantRole(delegation.VOLUNTARY_DISCONNECT_ROLE(), _delegationConfig.disconnecters[i]);
        }
        for (uint256 i = 0; i < _delegationConfig.nodeOperatorFeeClaimers.length; i++) {
            delegation.grantRole(
                delegation.NODE_OPERATOR_FEE_CLAIM_ROLE(),
                _delegationConfig.nodeOperatorFeeClaimers[i]
            );
        }

        // set fees
        delegation.setNodeOperatorFeeBP(_delegationConfig.nodeOperatorFeeBP);

        // revoke temporary roles from factory
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

    /**
     * @notice Error thrown for when insufficient msg.value is provided for the connect deposit
     */
    error InsufficientMsgValueForConnectDeposit();
}
