// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {IAccessControlEnumerable} from "@openzeppelin/contracts-v4.4/access/AccessControlEnumerable.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

interface IVaultsAdapter {
    function evmScriptExecutor() external view returns (address);
}

interface IStakingRouter is IAccessControlEnumerable {
    struct StakingModule {
        uint24 id;
        address stakingModuleAddress;
        uint16 stakingModuleFee;
        uint16 treasuryFee;
        uint16 stakeShareLimit;
        uint8 status;
        string name;
        uint64 lastDepositAt;
        uint256 lastDepositBlock;
        uint256 exitedValidatorsCount;
        uint16 priorityExitShareThreshold;
        uint64 maxDepositsPerBlock;
        uint64 minDepositBlockDistance;
    }

    function getStakingModules() external view returns (StakingModule[] memory res);
}

interface ICSModule {
    function accounting() external view returns (address);
}

/**
 * @title V3UpgradeAddresses
 * @notice Stores immutable addresses required for the V3 upgrade process.
 * This contract centralizes address management for V3Template and V3VoteScript.
 */
contract V3Addresses {

    struct V3AddressesParams {
        // Old implementations
        address oldLocatorImpl;
        address oldLidoImpl;
        address oldAccountingOracleImpl;

        // New implementations
        address newLocatorImpl;
        address newLidoImpl;
        address newAccountingOracleImpl;

        // New fancy proxy and blueprint contracts
        address upgradeableBeacon;
        address stakingVaultImpl;
        address dashboardImpl;
        address gateSealForVaults;

        // Existing proxies and contracts
        address kernel;
        address agent;
        address aragonAppLidoRepo;
        address locator;
        address voting;
        address dualGovernance;
        address acl;

        // EasyTrack addresses
        address easyTrack;
        address vaultsAdapter;

        // EasyTrack new factories
        address etfAlterTiersInOperatorGrid;
        address etfRegisterGroupsInOperatorGrid;
        address etfRegisterTiersInOperatorGrid;
        address etfUpdateGroupsShareLimitInOperatorGrid;
        address etfSetJailStatusInOperatorGrid;
        address etfUpdateVaultsFeesInOperatorGrid;
        address etfForceValidatorExitsInVaultHub;
        address etfSetLiabilitySharesTargetInVaultHub;
        address etfSocializeBadDebtInVaultHub;
    }

    string public constant CURATED_MODULE_NAME = "curated-onchain-v1";
    string public constant SIMPLE_DVT_MODULE_NAME = "SimpleDVT";
    string public constant CSM_MODULE_NAME = "Community Staking";

    //
    // -------- Pre-upgrade old contracts --------
    //
    address public immutable OLD_LOCATOR_IMPL;
    address public immutable OLD_BURNER;
    address public immutable OLD_ACCOUNTING_ORACLE_IMPL;
    address public immutable OLD_LIDO_IMPL;

    //
    // -------- Upgraded contracts --------
    //
    address public immutable LOCATOR;
    address public immutable NEW_LOCATOR_IMPL;
    address public immutable LIDO;
    address public immutable ACCOUNTING_ORACLE;
    address public immutable BURNER;
    address public immutable ORACLE_REPORT_SANITY_CHECKER;
    address public immutable NEW_LIDO_IMPL;
    address public immutable NEW_ACCOUNTING_ORACLE_IMPL;

    //
    // -------- New V3 contracts --------
    //
    address public immutable ACCOUNTING;
    address payable public immutable VAULT_HUB;
    address public immutable PREDEPOSIT_GUARANTEE;
    address public immutable OPERATOR_GRID;
    address public immutable LAZY_ORACLE;
    address public immutable VAULT_FACTORY;
    address public immutable UPGRADEABLE_BEACON;
    address public immutable STAKING_VAULT_IMPL;
    address public immutable DASHBOARD_IMPL;
    address public immutable GATE_SEAL;

    //
    // -------- EasyTrack addresses --------
    //

    address public immutable EASY_TRACK;

    address public immutable EVM_SCRIPT_EXECUTOR;

    address public immutable VAULTS_ADAPTER;

    // ETF = EasyTrack Factory
    address public immutable ETF_ALTER_TIERS_IN_OPERATOR_GRID;
    address public immutable ETF_REGISTER_GROUPS_IN_OPERATOR_GRID;
    address public immutable ETF_REGISTER_TIERS_IN_OPERATOR_GRID;
    address public immutable ETF_SET_JAIL_STATUS_IN_OPERATOR_GRID;
    address public immutable ETF_SET_LIABILITY_SHARES_TARGET_IN_VAULT_HUB;
    address public immutable ETF_SOCIALIZE_BAD_DEBT_IN_VAULT_HUB;
    address public immutable ETF_UPDATE_GROUPS_SHARE_LIMIT_IN_OPERATOR_GRID;
    address public immutable ETF_UPDATE_VAULTS_FEES_IN_OPERATOR_GRID;
    address public immutable ETF_FORCE_VALIDATOR_EXITS_IN_VAULT_HUB;

    //
    // -------- Unchanged contracts --------
    //
    address public immutable KERNEL;
    address public immutable AGENT;
    address public immutable ARAGON_APP_LIDO_REPO;
    address public immutable VOTING;
    address public immutable DUAL_GOVERNANCE;
    address public immutable ACL;
    address public immutable EL_REWARDS_VAULT;
    address public immutable STAKING_ROUTER;
    address public immutable VALIDATORS_EXIT_BUS_ORACLE;
    address public immutable WITHDRAWAL_QUEUE;
    address public immutable WSTETH;
    address public immutable NODE_OPERATORS_REGISTRY;
    address public immutable SIMPLE_DVT;
    address public immutable CSM_ACCOUNTING;
    address public immutable ORACLE_DAEMON_CONFIG;

    constructor(
        V3AddressesParams memory params
    ) {
        if (params.newLocatorImpl == params.oldLocatorImpl) {
            revert NewAndOldLocatorImplementationsMustBeDifferent();
        }

        //
        // Set directly from passed parameters
        //

        ILidoLocator newLocatorImpl = ILidoLocator(params.newLocatorImpl);
        OLD_LOCATOR_IMPL = params.oldLocatorImpl;
        OLD_ACCOUNTING_ORACLE_IMPL = params.oldAccountingOracleImpl;
        OLD_LIDO_IMPL = params.oldLidoImpl;
        LOCATOR = params.locator;
        NEW_LOCATOR_IMPL = params.newLocatorImpl;
        NEW_LIDO_IMPL = params.newLidoImpl;
        NEW_ACCOUNTING_ORACLE_IMPL = params.newAccountingOracleImpl;
        KERNEL = params.kernel;
        AGENT = params.agent;
        ARAGON_APP_LIDO_REPO = params.aragonAppLidoRepo;
        VOTING = params.voting;
        DUAL_GOVERNANCE = params.dualGovernance;
        ACL = params.acl;
        UPGRADEABLE_BEACON = params.upgradeableBeacon;
        STAKING_VAULT_IMPL = params.stakingVaultImpl;
        DASHBOARD_IMPL = params.dashboardImpl;
        GATE_SEAL = params.gateSealForVaults;
        EVM_SCRIPT_EXECUTOR = IVaultsAdapter(params.vaultsAdapter).evmScriptExecutor();

        EASY_TRACK = params.easyTrack;
        VAULTS_ADAPTER = params.vaultsAdapter;
        ETF_ALTER_TIERS_IN_OPERATOR_GRID = params.etfAlterTiersInOperatorGrid;
        ETF_REGISTER_GROUPS_IN_OPERATOR_GRID = params.etfRegisterGroupsInOperatorGrid;
        ETF_REGISTER_TIERS_IN_OPERATOR_GRID = params.etfRegisterTiersInOperatorGrid;
        ETF_SET_JAIL_STATUS_IN_OPERATOR_GRID = params.etfSetJailStatusInOperatorGrid;
        ETF_SET_LIABILITY_SHARES_TARGET_IN_VAULT_HUB = params.etfSetLiabilitySharesTargetInVaultHub;
        ETF_SOCIALIZE_BAD_DEBT_IN_VAULT_HUB = params.etfSocializeBadDebtInVaultHub;
        ETF_UPDATE_GROUPS_SHARE_LIMIT_IN_OPERATOR_GRID = params.etfUpdateGroupsShareLimitInOperatorGrid;
        ETF_UPDATE_VAULTS_FEES_IN_OPERATOR_GRID = params.etfUpdateVaultsFeesInOperatorGrid;
        ETF_FORCE_VALIDATOR_EXITS_IN_VAULT_HUB = params.etfForceValidatorExitsInVaultHub;

        //
        // Discovered via other contracts
        //

        OLD_BURNER = ILidoLocator(params.oldLocatorImpl).burner();

        LIDO = newLocatorImpl.lido();
        ACCOUNTING_ORACLE = newLocatorImpl.accountingOracle();
        BURNER = newLocatorImpl.burner();
        ORACLE_REPORT_SANITY_CHECKER = newLocatorImpl.oracleReportSanityChecker();

        ACCOUNTING = newLocatorImpl.accounting();
        VAULT_HUB = payable(newLocatorImpl.vaultHub());
        VAULT_FACTORY = newLocatorImpl.vaultFactory();
        PREDEPOSIT_GUARANTEE = newLocatorImpl.predepositGuarantee();
        OPERATOR_GRID = newLocatorImpl.operatorGrid();
        LAZY_ORACLE = newLocatorImpl.lazyOracle();

        EL_REWARDS_VAULT = newLocatorImpl.elRewardsVault();
        STAKING_ROUTER = newLocatorImpl.stakingRouter();
        VALIDATORS_EXIT_BUS_ORACLE = newLocatorImpl.validatorsExitBusOracle();
        WITHDRAWAL_QUEUE = newLocatorImpl.withdrawalQueue();
        WSTETH = newLocatorImpl.wstETH();
        ORACLE_DAEMON_CONFIG = newLocatorImpl.oracleDaemonConfig();

        {
            // Retrieve contracts with burner allowances to migrate: NOR, SDVT and CSM ACCOUNTING
            IStakingRouter.StakingModule[] memory stakingModules = IStakingRouter(STAKING_ROUTER).getStakingModules();
            IStakingRouter.StakingModule memory curated = stakingModules[0];
            if (_hash(curated.name) != _hash(CURATED_MODULE_NAME)) revert IncorrectStakingModuleName(curated.name);
            NODE_OPERATORS_REGISTRY = curated.stakingModuleAddress;
            IStakingRouter.StakingModule memory simpleDvt = stakingModules[1];
            if (_hash(simpleDvt.name) != _hash(SIMPLE_DVT_MODULE_NAME)) revert IncorrectStakingModuleName(simpleDvt.name);
            SIMPLE_DVT = simpleDvt.stakingModuleAddress;
            IStakingRouter.StakingModule memory csm = stakingModules[2];
            if (_hash(csm.name) != _hash(CSM_MODULE_NAME)) revert IncorrectStakingModuleName(csm.name);
            CSM_ACCOUNTING = ICSModule(csm.stakingModuleAddress).accounting();
        }
    }

    function _hash(string memory input) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(input));
    }

    error NewAndOldLocatorImplementationsMustBeDifferent();
    error IncorrectStakingModuleName(string name);
}
