// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.2/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";
import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {Dashboard} from "contracts/0.8.25/vaults/Dashboard.sol";

contract VaultFactory__MockForDashboard is UpgradeableBeacon {
    address public immutable dashboardImpl;

    constructor(
        address _owner,
        address _stakingVaultImpl,
        address _dashboardImpl
    ) UpgradeableBeacon(_stakingVaultImpl, _owner) {
        if (_dashboardImpl == address(0)) revert ZeroArgument("_dashboardImpl");

        dashboardImpl = _dashboardImpl;
    }

    function createVault(address _operator) external returns (IStakingVault vault, Dashboard dashboard) {
        vault = IStakingVault(address(new BeaconProxy(address(this), "")));

        bytes memory immutableArgs = abi.encode(vault);
        dashboard = Dashboard(payable(Clones.cloneWithImmutableArgs(dashboardImpl, immutableArgs)));

        dashboard.initialize(address(this), 7 days);
        dashboard.grantRole(dashboard.DEFAULT_ADMIN_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.FUND_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.WITHDRAW_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.MINT_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.BURN_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.REBALANCE_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.REQUEST_VALIDATOR_EXIT_ROLE(), msg.sender);
        dashboard.grantRole(dashboard.VOLUNTARY_DISCONNECT_ROLE(), msg.sender);

        dashboard.revokeRole(dashboard.DEFAULT_ADMIN_ROLE(), address(this));

        vault.initialize(address(dashboard), _operator, "");

        emit VaultCreated(address(dashboard), address(vault));
        emit DashboardCreated(msg.sender, address(dashboard));
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
     * @param dashboard The address of the created Dashboard
     */
    event DashboardCreated(address indexed admin, address indexed dashboard);

    error ZeroArgument(string);
}
