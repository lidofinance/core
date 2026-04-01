// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {
    IAccessControl,
    IAccessControlEnumerable
} from "@openzeppelin/contracts-v5.2/access/extensions/IAccessControlEnumerable.sol";

import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";
import {
    UpgradeParameters,
    ILidoWithFinalizeUpgrade,
    IAccountingOracle,
    IOracleReportSanityChecker,
    IWithdrawalsManagerProxy,
    IKernel,
    IVersioned,
    IEasyTrack
} from "./UpgradeTypes.sol";

import {UpgradeConfig} from "./UpgradeConfig.sol";

/**
 * @title Lido Upgrade Template
 *
 * @dev Must be used by means of two calls:
 *   - `startUpgrade()` before upgrading LidoLocator and before everything else
 *   - `finishUpgrade()` as the last step of the upgrade
 */
contract UpgradeTemplate is UpgradeConfig {
    //
    // Events
    //

    event UpgradeStarted();
    event UpgradeFinished();

    //
    // -------- Constants --------
    //

    uint256 public constant EXPECTED_FINAL_LIDO_VERSION = 4;
    uint256 public constant EXPECTED_FINAL_STAKING_ROUTER_VERSION = 4;
    uint256 public constant EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION = 4;
    uint256 public constant EXPECTED_FINAL_ACCOUNTING_ORACLE_CONSENSUS_VERSION = 5;

    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    // Timestamp since which startUpgrade()
    // This behavior is introduced to disarm the template if the upgrade voting creation or enactment
    // didn't happen in proper time period
    uint256 public immutable EXPIRE_SINCE_INCLUSIVE;

    // Initial value of upgradeBlockNumber storage variable
    uint256 public constant UPGRADE_NOT_STARTED = 0;

    uint256 public constant INFINITE_ALLOWANCE = type(uint256).max;

    //
    // Structured storage
    //

    uint256 public upgradeBlockNumber = UPGRADE_NOT_STARTED;
    bool public isUpgradeFinished;

    // uint256 public initialOldBurnerStethSharesBalance;
    // uint256 public initialTotalShares;
    // uint256 public initialTotalPooledEther;
    // mapping(bytes32 => address[]) public initialStakingRouterRoleMembers;

    //
    // Slots for transient storage
    //

    // Slot for the upgrade started flag
    // / keccak256("UpgradeTemplate.upgradeStartedFlag");
    bytes32 public constant UPGRADE_STARTED_SLOT = 0x058d69f67a3d86c424c516d23a070ff8bed34431617274caa2049bd702675e3f;

    bytes32 internal constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 internal constant ALLOW_PAIR_ROLE = keccak256("ALLOW_PAIR_ROLE");
    bytes32 internal constant TOP_UP_ROLE = keccak256("TOP_UP_ROLE");
    bytes32 internal constant ADD_CONSOLIDATION_REQUEST_ROLE = keccak256("ADD_CONSOLIDATION_REQUEST_ROLE");
    bytes32 internal constant PUBLISH_ROLE = keccak256("PUBLISH_ROLE");
    bytes32 internal constant EXECUTE_ROLE = keccak256("EXECUTE_ROLE");
    bytes32 internal constant REMOVE_ROLE = keccak256("REMOVE_ROLE");
    bytes32 internal constant REPORT_REWARDS_MINTED_ROLE = keccak256("REPORT_REWARDS_MINTED_ROLE");

    //
    // Intermediate setup's completion status
    //
    mapping(bytes32 => bool) public setupComplete;

    /// @param _params Params required to initialize the addresses contract
    /// @param _expireSinceInclusive Unix timestamp after which upgrade actions revert
    constructor(UpgradeParameters memory _params, uint256 _expireSinceInclusive) UpgradeConfig(_params) {
        EXPIRE_SINCE_INCLUSIVE = _expireSinceInclusive;
    }

    modifier requireUpgradeStarted() {
        if (msg.sender != AGENT) revert OnlyAgentCanUpgrade();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();
        if (!_isStartCalledInThisTx()) revert StartAndFinishMustBeInSameTx();
        _;
    }

    // modifier requireSetupOnlyOnce(string memory itemName) {
    //     bytes32 item = keccak256(abi.encodePacked(itemName));
    //     if (setupComplete[item]) revert SetupAlreadyCompleted(itemName);
    //     setupComplete[item] = true;
    //     _;
    // }

    /// @notice Must be called before LidoLocator is upgraded
    function startUpgrade() external {
        if (msg.sender != AGENT) revert OnlyAgentCanUpgrade();
        if (block.timestamp >= EXPIRE_SINCE_INCLUSIVE) revert Expired();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();
        if (_isStartCalledInThisTx()) revert StartAlreadyCalledInThisTx();
        if (upgradeBlockNumber != UPGRADE_NOT_STARTED) revert UpgradeAlreadyStarted();

        assembly { tstore(UPGRADE_STARTED_SLOT, 1) }
        upgradeBlockNumber = block.number;

        // initialTotalShares = ILidoWithFinalizeUpgrade(LIDO).getTotalShares();
        // initialTotalPooledEther = ILidoWithFinalizeUpgrade(LIDO).getTotalPooledEther();

        _assertPreUpgradeState();

        // Save initial state for the check after burner migration
        // initialOldBurnerStethSharesBalance = ILidoWithFinalizeUpgrade(LIDO).sharesOf(OLD_BURNER);

        emit UpgradeStarted();
    }

    function finishUpgrade() external requireUpgradeStarted {
        isUpgradeFinished = true;

        ILidoWithFinalizeUpgrade(LIDO).finalizeUpgrade_v4();
        IAccountingOracle(ACCOUNTING_ORACLE).finalizeUpgrade_v4(EXPECTED_FINAL_ACCOUNTING_ORACLE_CONSENSUS_VERSION);

        _assertPostUpgradeState();

        emit UpgradeFinished();
    }

    //
    // StakingRouter
    //

    /// @notice Save all StakingRouter existing ACL role members from OZ v4 AccessControlEnumerable
    ///         to migrate OZ v5.2 AccessControlEnumerableUpgradeable.
    // function _preUpgradeStakingRouter() internal {
    //     // save existing role members
    //     IStakingRouter sr = IStakingRouter(STAKING_ROUTER);
    //     bytes32[6] memory roles = [
    //         sr.STAKING_MODULE_MANAGE_ROLE(),
    //         sr.STAKING_MODULE_UNVETTING_ROLE(),
    //         sr.REPORT_EXITED_VALIDATORS_ROLE(),
    //         sr.REPORT_VALIDATOR_EXITING_STATUS_ROLE(),
    //         sr.REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE(),
    //         REPORT_REWARDS_MINTED_ROLE,
    //         sr.UNSAFE_SET_EXITED_VALIDATORS_ROLE(),
    //         sr.MANAGE_WITHDRAWAL_CREDENTIALS_ROLE()
    //     ];
    //     for (uint256 i = 0; i < roles.length; ++i) {
    //         bytes32 role = roles[i];
    //         address[] storage members = initialStakingRouterRoleMembers[role];
    //         for (uint256 j; j < sr.getRoleMemberCount(role); ++j) {
    //             members.push(sr.getRoleMember(role, j));
    //         }
    //     }
    // }

    /// @notice Setup StakingRouter with required roles and transfer admin to agent
    // function _postUpgradeStakingRouter() internal {
    //     IStakingRouter sr = IStakingRouter(STAKING_ROUTER);
    //     // restore existing role members
    //     bytes32[6] memory roles = [
    //         sr.STAKING_MODULE_MANAGE_ROLE(),
    //         sr.STAKING_MODULE_UNVETTING_ROLE(),
    //         sr.REPORT_EXITED_VALIDATORS_ROLE(),
    //         sr.REPORT_VALIDATOR_EXITING_STATUS_ROLE(),
    //         sr.REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE(),
    //         REPORT_REWARDS_MINTED_ROLE,
    //         sr.UNSAFE_SET_EXITED_VALIDATORS_ROLE(),
    //         sr.MANAGE_WITHDRAWAL_CREDENTIALS_ROLE()
    //     ];

    //     for (uint256 i = 0; i < roles.length; ++i) {
    //         bytes32 role = roles[i];
    //         address[] storage members = initialStakingRouterRoleMembers[role];
    //         for (uint256 j; j < members.length; ++j) {
    //             sr.grantRole(role, members[j]);
    //         }
    //     }

    //     _transferAdminToAgent(STAKING_ROUTER);
    // }

    /// @notice Method should be called after the StakingRouter is upgraded to the new implementation in the same transaction
    // function setupStakingRouter() external requireUpgradeStarted requireSetupOnlyOnce("stakingRouter") {
    //     _postUpgradeStakingRouter();
    // }

    //
    // Assertions
    //

    function _assertPreUpgradeState() internal view {
        // Check initial implementations of the proxies to be upgraded
        _assertProxyImplementation(IOssifiableProxy(LOCATOR), OLD_LOCATOR_IMPL);
        _assertProxyImplementation(IOssifiableProxy(ACCOUNTING_ORACLE), OLD_ACCOUNTING_ORACLE_IMPL);
        _assertProxyImplementation(IOssifiableProxy(STAKING_ROUTER), OLD_STAKING_ROUTER_IMPL);
        _assertAragonKernelImplementation(IKernel(KERNEL), OLD_LIDO_IMPL);

        // Check allowances of the old burner
        // address[] memory contractsWithBurnerAllowances_ = contractsWithBurnerAllowances;
        // for (uint256 i = 0; i < contractsWithBurnerAllowances_.length; ++i) {
        //     if (
        //         ILidoWithFinalizeUpgrade(LIDO).allowance(contractsWithBurnerAllowances_[i], OLD_BURNER)
        //             != INFINITE_ALLOWANCE
        //     ) {
        //         revert IncorrectBurnerAllowance(contractsWithBurnerAllowances_[i], OLD_BURNER);
        //     }
        // }
        // if (ILidoWithFinalizeUpgrade(LIDO).allowance(NODE_OPERATORS_REGISTRY, OLD_BURNER) != 0) {
        //     revert IncorrectBurnerAllowance(NODE_OPERATORS_REGISTRY, OLD_BURNER);
        // }
        // if (ILidoWithFinalizeUpgrade(LIDO).allowance(SIMPLE_DVT, OLD_BURNER) != 0) {
        //     revert IncorrectBurnerAllowance(SIMPLE_DVT, OLD_BURNER);
        // }

        // if (!IBurner(BURNER).isMigrationAllowed()) revert BurnerMigrationNotAllowed();
    }

    function _assertPostUpgradeState() internal view {
        // if (
        //     ILidoWithFinalizeUpgrade(LIDO).getTotalShares() != initialTotalShares
        //         || ILidoWithFinalizeUpgrade(LIDO).getTotalPooledEther() != initialTotalPooledEther
        // ) {
        //     revert TotalSharesOrPooledEtherChanged();
        // }

        _assertProxyImplementation(IOssifiableProxy(LOCATOR), NEW_LOCATOR_IMPL);
        _assertProxyImplementation(IOssifiableProxy(ACCOUNTING_ORACLE), NEW_ACCOUNTING_ORACLE_IMPL);
        _assertProxyImplementation(IOssifiableProxy(STAKING_ROUTER), NEW_STAKING_ROUTER_IMPL);
        _assertProxyImplementation(IOssifiableProxy(ACCOUNTING), NEW_ACCOUNTING_IMPL);
        _assertProxyImplementation(IOssifiableProxy(TOP_UP_GATEWAY), TOP_UP_GATEWAY_IMPL);

        _assertAragonKernelImplementation(IKernel(KERNEL), NEW_LIDO_IMPL);

        _assertContractVersion(IVersioned(LIDO), EXPECTED_FINAL_LIDO_VERSION);
        _assertContractVersion(IVersioned(ACCOUNTING_ORACLE), EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION);

        _assertFinalACL();

        // _checkTokenRateNotifierMigratedCorrectly();
        // _checkBurnerMigratedCorrectly();

        // if (VaultFactory(VAULT_FACTORY).BEACON() != UPGRADEABLE_BEACON) {
        //     revert IncorrectVaultFactoryBeacon(VAULT_FACTORY, UPGRADEABLE_BEACON);
        // }
        // if (VaultFactory(VAULT_FACTORY).DASHBOARD_IMPL() != DASHBOARD_IMPL) {
        //     revert IncorrectVaultFactoryDashboardImplementation(VAULT_FACTORY, DASHBOARD_IMPL);
        // }
        // if (UpgradeableBeacon(UPGRADEABLE_BEACON).owner() != AGENT) {
        //     revert IncorrectUpgradeableBeaconOwner(UPGRADEABLE_BEACON, AGENT);
        // }
        // if (UpgradeableBeacon(UPGRADEABLE_BEACON).implementation() != STAKING_VAULT_IMPL) {
        //     revert IncorrectUpgradeableBeaconImplementation(UPGRADEABLE_BEACON, STAKING_VAULT_IMPL);
        // }
    }

    function _assertFinalACL() internal view {
        // Burner
        // bytes32 requestBurnSharesRole = IBurner(BURNER).REQUEST_BURN_SHARES_ROLE();
        // _assertZeroOZRoleHolders(OLD_BURNER, requestBurnSharesRole);

        // _assertProxyAdmin(IOssifiableProxy(BURNER), AGENT);
        // _assertSingleOZRoleHolder(BURNER, DEFAULT_ADMIN_ROLE, AGENT);
        // {
        //     address[] memory holders = new address[](2);
        //     holders[0] = ACCOUNTING;
        //     holders[1] = CSM_ACCOUNTING;
        //     _assertOZRoleHolders(BURNER, requestBurnSharesRole, holders);
        // }

        // // VaultHub
        // _assertProxyAdmin(IOssifiableProxy(VAULT_HUB), AGENT);
        // _assertSingleOZRoleHolder(VAULT_HUB, DEFAULT_ADMIN_ROLE, AGENT);

        // _assertSingleOZRoleHolder(VAULT_HUB, VaultHub(VAULT_HUB).VALIDATOR_EXIT_ROLE(), VAULTS_ADAPTER);
        // _assertSingleOZRoleHolder(VAULT_HUB, VaultHub(VAULT_HUB).BAD_DEBT_MASTER_ROLE(), VAULTS_ADAPTER);
        // _assertZeroOZRoleHolders(VAULT_HUB, VaultHub(VAULT_HUB).REDEMPTION_MASTER_ROLE());
        // _assertZeroOZRoleHolders(VAULT_HUB, VaultHub(VAULT_HUB).VAULT_MASTER_ROLE());
        // _assertTwoOZRoleHolders(VAULT_HUB, PausableUntilWithRoles(VAULT_HUB).PAUSE_ROLE(), GATE_SEAL, RESEAL_MANAGER);
        // _assertSingleOZRoleHolder(VAULT_HUB, PausableUntilWithRoles(VAULT_HUB).RESUME_ROLE(), RESEAL_MANAGER);

        // // OperatorGrid
        // _assertProxyAdmin(IOssifiableProxy(OPERATOR_GRID), AGENT);
        // _assertSingleOZRoleHolder(OPERATOR_GRID, DEFAULT_ADMIN_ROLE, AGENT);
        // _assertTwoOZRoleHolders(
        //     OPERATOR_GRID, OperatorGrid(OPERATOR_GRID).REGISTRY_ROLE(), EVM_SCRIPT_EXECUTOR, VAULTS_ADAPTER
        // );

        // // LazyOracle
        // _assertProxyAdmin(IOssifiableProxy(LAZY_ORACLE), AGENT);
        // _assertSingleOZRoleHolder(LAZY_ORACLE, DEFAULT_ADMIN_ROLE, AGENT);
        // _assertZeroOZRoleHolders(LAZY_ORACLE, ILazyOracle(LAZY_ORACLE).UPDATE_SANITY_PARAMS_ROLE());

        // AccountingOracle
        _assertProxyAdmin(IOssifiableProxy(ACCOUNTING_ORACLE), AGENT);
        _assertSingleOZRoleHolder(ACCOUNTING_ORACLE, DEFAULT_ADMIN_ROLE, AGENT);

        _assertProxyAdmin(IOssifiableProxy(STAKING_ROUTER), AGENT);

        // OracleReportSanityChecker
        IOracleReportSanityChecker checker = IOracleReportSanityChecker(ORACLE_REPORT_SANITY_CHECKER);
        _assertSingleOZRoleHolder(ORACLE_REPORT_SANITY_CHECKER, DEFAULT_ADMIN_ROLE, AGENT);
        bytes32[12] memory roles = [
            checker.ALL_LIMITS_MANAGER_ROLE(),
            checker.EXITED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE(),
            checker.APPEARED_VALIDATORS_PER_DAY_LIMIT_MANAGER_ROLE(),
            checker.ANNUAL_BALANCE_INCREASE_LIMIT_MANAGER_ROLE(),
            checker.SHARE_RATE_DEVIATION_LIMIT_MANAGER_ROLE(),
            checker.MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT_ROLE(),
            checker.MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION_ROLE(),
            checker.MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM_ROLE(),
            checker.REQUEST_TIMESTAMP_MARGIN_MANAGER_ROLE(),
            checker.MAX_POSITIVE_TOKEN_REBASE_MANAGER_ROLE(),
            checker.SECOND_OPINION_MANAGER_ROLE(),
            checker.INITIAL_SLASHING_AND_PENALTIES_MANAGER_ROLE()
        ];
        for (uint256 i = 0; i < roles.length; ++i) {
            _assertZeroOZRoleHolders(ORACLE_REPORT_SANITY_CHECKER, roles[i]);
        }

        // Accounting
        _assertProxyAdmin(IOssifiableProxy(ACCOUNTING), AGENT);
        _assertProxyAdmin(IOssifiableProxy(TOP_UP_GATEWAY), AGENT);

        // WithdrawalVault
        if (IWithdrawalsManagerProxy(WITHDRAWAL_VAULT).proxy_getAdmin() != AGENT) {
            revert IncorrectProxyAdmin(WITHDRAWAL_VAULT);
        }
        if (IWithdrawalsManagerProxy(WITHDRAWAL_VAULT).implementation() != NEW_WITHDRAWAL_VAULT_IMPL) {
            revert IncorrectProxyImplementation(
                WITHDRAWAL_VAULT, IWithdrawalsManagerProxy(WITHDRAWAL_VAULT).implementation()
            );
        }

        // Consolidation rollout
        _assertSingleOZRoleHolder(CONSOLIDATION_GATEWAY, ADD_CONSOLIDATION_REQUEST_ROLE, CONSOLIDATION_BUS);
        _assertSingleOZRoleHolder(CONSOLIDATION_BUS, PUBLISH_ROLE, CONSOLIDATION_MIGRATOR);
        _assertTwoOZRoleHolders(
            CONSOLIDATION_GATEWAY, PAUSE_ROLE, CONSOLIDATION_COMMITTEE, CONSOLIDATION_GATEWAY_GATE_SEAL
        );
        _assertSingleOZRoleHolder(CONSOLIDATION_BUS, EXECUTE_ROLE, CONSOLIDATION_BUS_BOT);
        _assertTwoOZRoleHolders(CONSOLIDATION_BUS, REMOVE_ROLE, AGENT, CONSOLIDATION_BUS_BOT);
        _assertSingleOZRoleHolder(CONSOLIDATION_MIGRATOR, ALLOW_PAIR_ROLE, EASY_TRACK_EVM_SCRIPT_EXECUTOR);
        _assertSingleOZRoleHolder(TOP_UP_GATEWAY, TOP_UP_ROLE, TOP_UP_DEPOSITOR_BOT);

        // // PredepositGuarantee
        // _assertProxyAdmin(IOssifiableProxy(PREDEPOSIT_GUARANTEE), AGENT);
        // _assertSingleOZRoleHolder(PREDEPOSIT_GUARANTEE, DEFAULT_ADMIN_ROLE, AGENT);
        // _assertTwoOZRoleHolders(
        //     PREDEPOSIT_GUARANTEE, PausableUntilWithRoles(PREDEPOSIT_GUARANTEE).PAUSE_ROLE(), GATE_SEAL, RESEAL_MANAGER
        // );
        // _assertSingleOZRoleHolder(
        //     PREDEPOSIT_GUARANTEE, PausableUntilWithRoles(PREDEPOSIT_GUARANTEE).RESUME_ROLE(), RESEAL_MANAGER
        // );

        // StakingRouter
        _assertSingleOZRoleHolder(STAKING_ROUTER, REPORT_REWARDS_MINTED_ROLE, ACCOUNTING);

        _assertEasyTrackFactoriesAdded();
    }

    function _assertEasyTrackFactoriesAdded() internal view {
        IEasyTrack easyTrack = IEasyTrack(EASY_TRACK);
        address[] memory factories = easyTrack.getEVMScriptFactories();

        address[2] memory expectedFactories = [ETF_UPDATE_STAKING_MODULE_SHARE_LIMITS, ETF_ALLOW_CONSOLIDATION_PAIR];

        uint256 numFactories = factories.length;
        if (numFactories < expectedFactories.length) {
            revert UnexpectedEasyTrackFactories();
        }

        for (uint256 i = 0; i < expectedFactories.length; ++i) {
            if (factories[numFactories - expectedFactories.length + i] != expectedFactories[i]) {
                revert UnexpectedEasyTrackFactories();
            }
        }
    }

    // function _checkTokenRateNotifierMigratedCorrectly() internal view {
    //     ITokenRateNotifier oldNotifier = ITokenRateNotifier(OLD_TOKEN_RATE_NOTIFIER);
    //     ITokenRateNotifier newNotifier = ITokenRateNotifier(NEW_TOKEN_RATE_NOTIFIER);

    //     if (newNotifier.owner() != AGENT) {
    //         revert IncorrectTokenRateNotifierOwnerMigration(NEW_TOKEN_RATE_NOTIFIER, AGENT);
    //     }

    //     if (oldNotifier.observersLength() != newNotifier.observersLength()) {
    //         revert IncorrectTokenRateNotifierObserversLengthMigration();
    //     }

    //     for (uint256 i = 0; i < oldNotifier.observersLength(); i++) {
    //         if (oldNotifier.observers(i) != newNotifier.observers(i)) {
    //             revert IncorrectTokenRateNotifierObserversMigration();
    //         }
    //     }
    // }

    // function _checkBurnerMigratedCorrectly() internal view {
    //     if (IBurner(OLD_BURNER).getCoverSharesBurnt() != IBurner(BURNER).getCoverSharesBurnt()) {
    //         revert IncorrectBurnerSharesMigration("Cover shares burnt mismatch");
    //     }

    //     if (IBurner(OLD_BURNER).getNonCoverSharesBurnt() != IBurner(BURNER).getNonCoverSharesBurnt()) {
    //         revert IncorrectBurnerSharesMigration("Non-cover shares burnt mismatch");
    //     }

    //     (uint256 oldCoverShares, uint256 oldNonCoverShares) = IBurner(OLD_BURNER).getSharesRequestedToBurn();
    //     (uint256 newCoverShares, uint256 newNonCoverShares) = IBurner(BURNER).getSharesRequestedToBurn();
    //     if (oldCoverShares != newCoverShares) {
    //         revert IncorrectBurnerSharesMigration("Cover shares requested to burn mismatch");
    //     }

    //     if (oldNonCoverShares != newNonCoverShares) {
    //         revert IncorrectBurnerSharesMigration("Non-cover shares requested to burn mismatch");
    //     }

    //     if (ILidoWithFinalizeUpgrade(LIDO).balanceOf(OLD_BURNER) != 0) {
    //         revert IncorrectBurnerSharesMigration("Old burner stETH balance is not zero");
    //     }

    //     if (ILidoWithFinalizeUpgrade(LIDO).sharesOf(BURNER) != initialOldBurnerStethSharesBalance) {
    //         revert IncorrectBurnerSharesMigration("New burner stETH balance mismatch");
    //     }

    //     if (IBurner(BURNER).isMigrationAllowed()) {
    //         revert IncorrectBurnerSharesMigration("Burner migration is still allowed");
    //     }

    //     // address[] memory contractsWithBurnerAllowances_ = contractsWithBurnerAllowances;
    //     // for (uint256 i = 0; i < contractsWithBurnerAllowances_.length; i++) {
    //     //     if (ILidoWithFinalizeUpgrade(LIDO).allowance(contractsWithBurnerAllowances_[i], OLD_BURNER) != 0) {
    //     //         revert IncorrectBurnerAllowance(contractsWithBurnerAllowances_[i], OLD_BURNER);
    //     //     }
    //     //     if (
    //     //         ILidoWithFinalizeUpgrade(LIDO).allowance(contractsWithBurnerAllowances_[i], BURNER)
    //     //             != INFINITE_ALLOWANCE
    //     //     ) {
    //     //         revert IncorrectBurnerAllowance(contractsWithBurnerAllowances_[i], BURNER);
    //     //     }
    //     // }

    // }

    function _assertProxyAdmin(IOssifiableProxy _proxy, address _admin) internal view {
        if (_proxy.proxy__getAdmin() != _admin) revert IncorrectProxyAdmin(address(_proxy));
    }

    function _assertProxyImplementation(IOssifiableProxy _proxy, address _implementation) internal view {
        address actualImplementation = _proxy.proxy__getImplementation();
        if (actualImplementation != _implementation) {
            revert IncorrectProxyImplementation(address(_proxy), actualImplementation);
        }
    }

    function _assertZeroOZRoleHolders(address _accessControlled, bytes32 _role) internal view {
        IAccessControlEnumerable accessControlled = IAccessControlEnumerable(_accessControlled);
        if (accessControlled.getRoleMemberCount(_role) != 0) {
            revert NonZeroRoleHolders(address(accessControlled), _role);
        }
    }

    function _assertSingleOZRoleHolder(address _accessControlled, bytes32 _role, address _holder) internal view {
        IAccessControlEnumerable accessControlled = IAccessControlEnumerable(_accessControlled);
        if (accessControlled.getRoleMemberCount(_role) != 1 || accessControlled.getRoleMember(_role, 0) != _holder) {
            revert IncorrectOZAccessControlRoleHolders(address(accessControlled), _role);
        }
    }

    function _assertTwoOZRoleHolders(address _accessControlled, bytes32 _role, address _holder1, address _holder2)
        internal
        view
    {
        address[] memory holders = new address[](2);
        holders[0] = _holder1;
        holders[1] = _holder2;
        _assertOZRoleHolders(_accessControlled, _role, holders);
    }

    function _assertOZRoleHolders(address _accessControlled, bytes32 _role, address[] memory _holders) internal view {
        IAccessControlEnumerable accessControlled = IAccessControlEnumerable(_accessControlled);
        if (accessControlled.getRoleMemberCount(_role) != _holders.length) {
            revert IncorrectOZAccessControlRoleHolders(address(accessControlled), _role);
        }
        for (uint256 i = 0; i < _holders.length; i++) {
            if (accessControlled.getRoleMember(_role, i) != _holders[i]) {
                revert IncorrectOZAccessControlRoleHolders(address(accessControlled), _role);
            }
        }
    }

    function _assertAragonKernelImplementation(IKernel _kernel, address _implementation) internal view {
        if (_kernel.getApp(_kernel.APP_BASES_NAMESPACE(), LIDO_APP_ID) != _implementation) {
            revert IncorrectAragonKernelImplementation(address(_kernel), _implementation);
        }
    }

    function _assertContractVersion(IVersioned _versioned, uint256 _expectedVersion) internal view {
        if (_versioned.getContractVersion() != _expectedVersion) {
            revert InvalidContractVersion(address(_versioned), _expectedVersion);
        }
    }

    function _isStartCalledInThisTx() internal view returns (bool isStartCalledInThisTx) {
        assembly {
            isStartCalledInThisTx := tload(UPGRADE_STARTED_SLOT)
        }
    }

    function _transferAdminToAgent(address _contract) private {
        IAccessControl(_contract).grantRole(DEFAULT_ADMIN_ROLE, AGENT);
        IAccessControl(_contract).renounceRole(DEFAULT_ADMIN_ROLE, address(this));
    }

    error OnlyAgentCanUpgrade();
    error UpgradeAlreadyStarted();
    error UpgradeAlreadyFinished();
    error IncorrectProxyAdmin(address proxy);
    error IncorrectProxyImplementation(address proxy, address implementation);
    error InvalidContractVersion(address contractAddress, uint256 actualVersion);
    error IncorrectOZAccessControlRoleHolders(address contractAddress, bytes32 role);
    error NonZeroRoleHolders(address contractAddress, bytes32 role);
    error IncorrectAragonKernelImplementation(address kernel, address implementation);
    error StartAndFinishMustBeInSameTx();
    error StartAlreadyCalledInThisTx();
    error SetupAlreadyCompleted(string itemName);
    error Expired();
    error IncorrectBurnerSharesMigration(string reason);
    error IncorrectBurnerAllowance(address contractAddress, address burner);
    error BurnerMigrationNotAllowed();
    error IncorrectVaultFactoryBeacon(address factory, address beacon);
    error IncorrectVaultFactoryDashboardImplementation(address factory, address delegation);
    error IncorrectUpgradeableBeaconOwner(address beacon, address owner);
    error IncorrectUpgradeableBeaconImplementation(address beacon, address implementation);
    error TotalSharesOrPooledEtherChanged();
    error UnexpectedEasyTrackFactories();
    error IncorrectTokenRateNotifierOwnerMigration(address notifier, address owner);
    error IncorrectTokenRateNotifierObserversLengthMigration();
    error IncorrectTokenRateNotifierObserversMigration();
}
