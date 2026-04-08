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
    IEasyTrack,
    IWithdrawalVault
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
    uint256 public constant EXPECTED_FINAL_WITHDRAWAL_VAULT_VERSION = 3;

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
    uint256 initialBufferedEther;
    uint256 initialDepositedValidators;
    uint256 initialBeaconValidators;
    uint256 initialBeaconBalance;

    //
    // Slots for transient storage
    //

    // Slot for the upgrade started flag
    // / keccak256("UpgradeTemplate.upgradeStartedFlag");
    bytes32 public constant UPGRADE_STARTED_SLOT = 0x058d69f67a3d86c424c516d23a070ff8bed34431617274caa2049bd702675e3f;

    bytes32 internal constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 internal constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 internal constant ALLOW_PAIR_ROLE = keccak256("ALLOW_PAIR_ROLE");
    bytes32 internal constant DISALLOW_PAIR_ROLE = keccak256("DISALLOW_PAIR_ROLE");
    bytes32 internal constant TOP_UP_ROLE = keccak256("TOP_UP_ROLE");
    bytes32 internal constant ADD_CONSOLIDATION_REQUEST_ROLE = keccak256("ADD_CONSOLIDATION_REQUEST_ROLE");
    bytes32 internal constant PUBLISH_ROLE = keccak256("PUBLISH_ROLE");
    bytes32 internal constant EXECUTE_ROLE = keccak256("EXECUTE_ROLE");
    bytes32 internal constant REMOVE_ROLE = keccak256("REMOVE_ROLE");
    bytes32 internal constant REPORT_REWARDS_MINTED_ROLE = keccak256("REPORT_REWARDS_MINTED_ROLE");
    bytes32 internal constant STAKING_MODULE_SHARE_MANAGE_ROLE = keccak256("STAKING_MODULE_SHARE_MANAGE_ROLE");

    /// @param _params Params required to initialize the addresses contract
    /// @param _expireSinceInclusive Unix timestamp after which upgrade actions revert
    constructor(UpgradeParameters memory _params, uint256 _expireSinceInclusive) UpgradeConfig(_params) {
        EXPIRE_SINCE_INCLUSIVE = _expireSinceInclusive;
    }

    /// @notice Must be called before LidoLocator is upgraded
    function startUpgrade() external {
        if (msg.sender != AGENT) revert OnlyAgentCanUpgrade();
        if (block.timestamp >= EXPIRE_SINCE_INCLUSIVE) revert Expired();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();
        if (_isStartCalledInThisTx()) revert StartAlreadyCalledInThisTx();
        if (upgradeBlockNumber != UPGRADE_NOT_STARTED) revert UpgradeAlreadyStarted();

        assembly { tstore(UPGRADE_STARTED_SLOT, 1) }
        upgradeBlockNumber = block.number;

        initialBufferedEther = ILidoWithFinalizeUpgrade(LIDO).getBufferedEther();
        (initialDepositedValidators, initialBeaconValidators, initialBeaconBalance) =
            ILidoWithFinalizeUpgrade(LIDO).getBeaconStat();

        _assertPreUpgradeState();

        emit UpgradeStarted();
    }

    function finishUpgrade() external {
        if (msg.sender != AGENT) revert OnlyAgentCanUpgrade();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();
        if (!_isStartCalledInThisTx()) revert StartAndFinishMustBeInSameTx();

        isUpgradeFinished = true;

        ILidoWithFinalizeUpgrade(LIDO).finalizeUpgrade_v4();
        IWithdrawalVault(WITHDRAWAL_VAULT).finalizeUpgrade_v3();
        IAccountingOracle(ACCOUNTING_ORACLE).finalizeUpgrade_v5(EXPECTED_FINAL_ACCOUNTING_ORACLE_CONSENSUS_VERSION);

        _assertPostUpgradeState();

        emit UpgradeFinished();
    }

    //
    // Assertions
    //

    function _assertPreUpgradeState() internal view {
        // Check initial implementations of the proxies to be upgraded
        _assertAragonKernelImplementation(IKernel(KERNEL), OLD_LIDO_IMPL);

        _assertProxyImplementation(IOssifiableProxy(LOCATOR), OLD_LOCATOR_IMPL);
        _assertProxyImplementation(IOssifiableProxy(ACCOUNTING), OLD_ACCOUNTING_IMPL);
        _assertProxyImplementation(IOssifiableProxy(ACCOUNTING_ORACLE), OLD_ACCOUNTING_ORACLE_IMPL);
        _assertProxyImplementation(IOssifiableProxy(STAKING_ROUTER), OLD_STAKING_ROUTER_IMPL);
        _assertProxyImplementation(IOssifiableProxy(WITHDRAWAL_VAULT), OLD_WITHDRAWAL_VAULT_IMPL);
        _assertProxyImplementation(IOssifiableProxy(VALIDATORS_EXIT_BUS_ORACLE), OLD_VALIDATORS_EXIT_BUS_ORACLE_IMPL);
    }

    function _assertPostUpgradeState() internal view {
        // if (
        //     ILidoWithFinalizeUpgrade(LIDO).getTotalShares() != initialTotalShares
        //         || ILidoWithFinalizeUpgrade(LIDO).getTotalPooledEther() != initialTotalPooledEther
        // ) {
        //     revert TotalSharesOrPooledEtherChanged();
        // }

        _assertAragonKernelImplementation(IKernel(KERNEL), NEW_LIDO_IMPL);

        _assertProxyImplementation(IOssifiableProxy(LOCATOR), NEW_LOCATOR_IMPL);
        _assertProxyImplementation(IOssifiableProxy(ACCOUNTING), NEW_ACCOUNTING_IMPL);
        _assertProxyImplementation(IOssifiableProxy(ACCOUNTING_ORACLE), NEW_ACCOUNTING_ORACLE_IMPL);
        _assertProxyImplementation(IOssifiableProxy(STAKING_ROUTER), NEW_STAKING_ROUTER_IMPL);
        _assertProxyImplementation(IOssifiableProxy(WITHDRAWAL_VAULT), NEW_WITHDRAWAL_VAULT_IMPL);
        _assertProxyImplementation(IOssifiableProxy(VALIDATORS_EXIT_BUS_ORACLE), NEW_VALIDATORS_EXIT_BUS_ORACLE_IMPL);

        _assertProxyImplementation(IOssifiableProxy(CONSOLIDATION_BUS), CONSOLIDATION_BUS_IMPL);
        _assertProxyImplementation(IOssifiableProxy(CONSOLIDATION_MIGRATOR), CONSOLIDATION_MIGRATOR_IMPL);
        _assertProxyImplementation(IOssifiableProxy(TOP_UP_GATEWAY), TOP_UP_GATEWAY_IMPL);

        _assertContractVersion(IVersioned(LIDO), EXPECTED_FINAL_LIDO_VERSION);
        _assertContractVersion(IVersioned(ACCOUNTING_ORACLE), EXPECTED_FINAL_ACCOUNTING_ORACLE_VERSION);
        _assertContractVersion(IVersioned(WITHDRAWAL_VAULT), EXPECTED_FINAL_WITHDRAWAL_VAULT_VERSION);

        _assertFinalACL();

        _checkStakingRouterMigratedCorrectly();
        _checkLidoMigratedCorrectly();

    }

    function _assertFinalACL() internal view {
        // Accounting
        _assertProxyAdmin(IOssifiableProxy(ACCOUNTING), AGENT);
        _assertSingleOZRoleHolder(ACCOUNTING, DEFAULT_ADMIN_ROLE, AGENT);

        // AccountingOracle
        _assertProxyAdmin(IOssifiableProxy(ACCOUNTING_ORACLE), AGENT);
        _assertSingleOZRoleHolder(ACCOUNTING_ORACLE, DEFAULT_ADMIN_ROLE, AGENT);


        // StakingRouter
        _assertProxyAdmin(IOssifiableProxy(STAKING_ROUTER), AGENT);
        _assertSingleOZRoleHolder(STAKING_ROUTER, DEFAULT_ADMIN_ROLE, AGENT);
        _assertSingleOZRoleHolder(STAKING_ROUTER, REPORT_REWARDS_MINTED_ROLE, ACCOUNTING);
        _assertSingleOZRoleHolder(STAKING_ROUTER, STAKING_MODULE_SHARE_MANAGE_ROLE, EASY_TRACK_EVM_SCRIPT_EXECUTOR);


        _assertProxyAdmin(IOssifiableProxy(VALIDATORS_EXIT_BUS_ORACLE), AGENT);
        _assertSingleOZRoleHolder(VALIDATORS_EXIT_BUS_ORACLE, DEFAULT_ADMIN_ROLE, AGENT);

        // address internal immutable NEW_ORACLE_REPORT_SANITY_CHECKER;
        // address internal immutable NEW_DEPOSIT_SECURITY_MODULE;



        // WithdrawalVault
        if (IWithdrawalsManagerProxy(WITHDRAWAL_VAULT).proxy_getAdmin() != AGENT) {
            revert IncorrectProxyAdmin(WITHDRAWAL_VAULT);
        }
        if (IWithdrawalsManagerProxy(WITHDRAWAL_VAULT).implementation() != NEW_WITHDRAWAL_VAULT_IMPL) {
            revert IncorrectProxyImplementation(WITHDRAWAL_VAULT, IWithdrawalsManagerProxy(WITHDRAWAL_VAULT).implementation());
        }

        // Consolidation rollout

        _assertSingleOZRoleHolder(CONSOLIDATION_GATEWAY, DEFAULT_ADMIN_ROLE, AGENT);
        _assertTwoOZRoleHolders(CONSOLIDATION_GATEWAY, PAUSE_ROLE, CONSOLIDATION_GATEWAY_GATE_SEAL, RESEAL_MANAGER);
        _assertSingleOZRoleHolder(CONSOLIDATION_GATEWAY, RESUME_ROLE, RESEAL_MANAGER);

        _assertSingleOZRoleHolder(CONSOLIDATION_GATEWAY, ADD_CONSOLIDATION_REQUEST_ROLE, CONSOLIDATION_BUS);
        _assertSingleOZRoleHolder(CONSOLIDATION_GATEWAY, PAUSE_ROLE, CONSOLIDATION_GATEWAY_GATE_SEAL);

        _assertProxyAdmin(IOssifiableProxy(CONSOLIDATION_BUS), AGENT);
        _assertSingleOZRoleHolder(CONSOLIDATION_BUS, DEFAULT_ADMIN_ROLE, AGENT);
        _assertSingleOZRoleHolder(CONSOLIDATION_BUS, PUBLISH_ROLE, CONSOLIDATION_MIGRATOR);
        _assertTwoOZRoleHolders(CONSOLIDATION_BUS, REMOVE_ROLE, AGENT, CONSOLIDATION_BUS_EXECUTOR);

        _assertProxyAdmin(IOssifiableProxy(CONSOLIDATION_MIGRATOR), AGENT);
        _assertSingleOZRoleHolder(CONSOLIDATION_MIGRATOR, DEFAULT_ADMIN_ROLE, AGENT);
        _assertSingleOZRoleHolder(CONSOLIDATION_MIGRATOR, ALLOW_PAIR_ROLE, EASY_TRACK_EVM_SCRIPT_EXECUTOR);
        _assertSingleOZRoleHolder(CONSOLIDATION_MIGRATOR, DISALLOW_PAIR_ROLE, CONSOLIDATION_MANAGER_COMMITTEE);

        // TopUps
        _assertProxyAdmin(IOssifiableProxy(TOP_UP_GATEWAY), AGENT);
        _assertSingleOZRoleHolder(TOP_UP_GATEWAY, DEFAULT_ADMIN_ROLE, AGENT);
        _assertSingleOZRoleHolder(TOP_UP_GATEWAY, TOP_UP_ROLE, TOP_UP_GATEWAY_DEPOSITOR);



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

    function _checkStakingRouterMigratedCorrectly() internal view {
        // TODO
    }

    function _checkLidoMigratedCorrectly() internal view {
        uint256 bufferedEther = ILidoWithFinalizeUpgrade(LIDO).getBufferedEther();
        if (bufferedEther != initialBufferedEther) {
            revert IncorrectLidoMigration("bufferedEther");
        }

        (uint256 depositedValidators, uint256 clValidators, uint256 beaconBalance) =
            ILidoWithFinalizeUpgrade(LIDO).getBeaconStat();

        if (depositedValidators != initialDepositedValidators || clValidators != depositedValidators) {
            revert IncorrectLidoMigration("depositedValidators");
        }

        (
            uint256 clValidatorsBalanceAtLastReport,
            uint256 clPendingBalanceAtLastReport,
            uint256 depositedSinceLastReport,
            uint256 depositedForCurrentReport
        ) = ILidoWithFinalizeUpgrade(LIDO).getBalanceStats();

        if (clValidatorsBalanceAtLastReport != initialBeaconBalance || clPendingBalanceAtLastReport != 0) {
            revert IncorrectLidoMigration("clValidatorsBalance");
        }

        if (
            depositedSinceLastReport != (initialDepositedValidators - initialBeaconValidators) * 32 ether
                || depositedForCurrentReport != 0
        ) {
            revert IncorrectLidoMigration("depositedSinceLastReport");
        }
    }

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
    error IncorrectLidoMigration(string reason);
    error UnexpectedEasyTrackFactories();
}
