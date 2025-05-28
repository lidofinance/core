// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IAccessControlEnumerable} from "@openzeppelin/contracts-v4.4/access/AccessControlEnumerable.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

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
 * This contract centralizes address management for UpgradeTemplateV3 and UpgradeV3VoteScript.
 */
contract V3Addresses {

    struct V3AddressesParams {
        // Old implementations
        address oldLocatorImplementation;
        address oldLidoImplementation;
        address oldAccountingOracleImplementation;

        // New implementations
        address newLocatorImplementation;

        // New non-proxy contracts
        address vaultFactory;

        // New fancy proxy and blueprint contracts
        address upgradeableBeacon;
        address stakingVaultImplementation;
        address dashboardImplementation;

        // Existing proxies and contracts
        address kernel;
        address agent;
        address aragonAppLidoRepo;
        address locator;
        address voting;
    }

    //
    // -------- Pre-upgrade old contracts --------
    //
    address public immutable OLD_LOCATOR_IMPLEMENTATION;
    address public immutable OLD_BURNER;
    address public immutable OLD_ACCOUNTING_ORACLE_IMPLEMENTATION;
    address public immutable OLD_LIDO_IMPLEMENTATION;

    //
    // -------- Upgraded contracts --------
    //
    address public immutable LOCATOR;
    address public immutable NEW_LOCATOR_IMPLEMENTATION;
    address public immutable LIDO;
    address public immutable ACCOUNTING_ORACLE;
    address public immutable BURNER;
    address public immutable ORACLE_REPORT_SANITY_CHECKER;

    //
    // -------- New V3 contracts --------
    //
    address public immutable ACCOUNTING;
    address payable public immutable VAULT_HUB;
    address public immutable PREDEPOSIT_GUARANTEE;
    address public immutable OPERATOR_GRID;
    address public immutable VAULT_FACTORY;
    address public immutable UPGRADEABLE_BEACON;
    address public immutable STAKING_VAULT_IMPLEMENTATION;
    address public immutable DASHBOARD_IMPLEMENTATION;

    //
    // -------- Unchanged contracts --------
    //
    address public immutable KERNEL;
    address public immutable AGENT;
    address public immutable ARAGON_APP_LIDO_REPO;
    address public immutable VOTING;
    address public immutable EL_REWARDS_VAULT;
    address public immutable STAKING_ROUTER;
    address public immutable VALIDATORS_EXIT_BUS_ORACLE;
    address public immutable WITHDRAWAL_QUEUE;
    address public immutable WSTETH;
    address public immutable NODE_OPERATORS_REGISTRY;
    address public immutable SIMPLE_DVT;
    address public immutable CSM_ACCOUNTING;

    constructor(
        V3AddressesParams memory params
    ) {
        if (params.newLocatorImplementation == params.oldLocatorImplementation) {
            revert NewAndOldLocatorImplementationsMustBeDifferent();
        }

        //
        // Set directly from passed parameters
        //

        ILidoLocator newLocatorImpl = ILidoLocator(params.newLocatorImplementation);
        OLD_LOCATOR_IMPLEMENTATION = params.oldLocatorImplementation;
        OLD_ACCOUNTING_ORACLE_IMPLEMENTATION = params.oldAccountingOracleImplementation;
        OLD_LIDO_IMPLEMENTATION = params.oldLidoImplementation;
        LOCATOR = params.locator;
        NEW_LOCATOR_IMPLEMENTATION = params.newLocatorImplementation;
        KERNEL = params.kernel;
        AGENT = params.agent;
        ARAGON_APP_LIDO_REPO = params.aragonAppLidoRepo;
        VOTING = params.voting;
        VAULT_FACTORY = params.vaultFactory;
        UPGRADEABLE_BEACON = params.upgradeableBeacon;
        STAKING_VAULT_IMPLEMENTATION = params.stakingVaultImplementation;
        DASHBOARD_IMPLEMENTATION = params.dashboardImplementation;

        //
        // Discovered via other contracts
        //

        OLD_BURNER = ILidoLocator(params.oldLocatorImplementation).burner();

        LIDO = newLocatorImpl.lido();
        ACCOUNTING_ORACLE = newLocatorImpl.accountingOracle();
        BURNER = newLocatorImpl.burner();
        ORACLE_REPORT_SANITY_CHECKER = newLocatorImpl.oracleReportSanityChecker();

        ACCOUNTING = newLocatorImpl.accounting();
        VAULT_HUB = payable(newLocatorImpl.vaultHub());
        PREDEPOSIT_GUARANTEE = newLocatorImpl.predepositGuarantee();
        OPERATOR_GRID = newLocatorImpl.operatorGrid();

        EL_REWARDS_VAULT = newLocatorImpl.elRewardsVault();
        STAKING_ROUTER = newLocatorImpl.stakingRouter();
        VALIDATORS_EXIT_BUS_ORACLE = newLocatorImpl.validatorsExitBusOracle();
        WITHDRAWAL_QUEUE = newLocatorImpl.withdrawalQueue();
        WSTETH = newLocatorImpl.wstETH();

        {
            // Retrieve contracts with burner allowances to migrate: NOR, SDVT and CSM ACCOUNTING
            IStakingRouter.StakingModule[] memory stakingModules = IStakingRouter(STAKING_ROUTER).getStakingModules();
            IStakingRouter.StakingModule memory curated = stakingModules[0];
            if (keccak256(abi.encodePacked(curated.name)) != keccak256("curated-onchain-v1")) revert IncorrectStakingModuleName(curated.name);
            NODE_OPERATORS_REGISTRY = curated.stakingModuleAddress;
            IStakingRouter.StakingModule memory simpleDvt = stakingModules[1];
            if (keccak256(abi.encodePacked(simpleDvt.name)) != keccak256("SimpleDVT")) revert IncorrectStakingModuleName(simpleDvt.name);
            SIMPLE_DVT = simpleDvt.stakingModuleAddress;
            IStakingRouter.StakingModule memory csm = stakingModules[2];
            if (keccak256(abi.encodePacked(csm.name)) != keccak256("Community Staking")) revert IncorrectStakingModuleName(csm.name);
            CSM_ACCOUNTING = ICSModule(csm.stakingModuleAddress).accounting();
        }
    }

    error NewAndOldLocatorImplementationsMustBeDifferent();
    error IncorrectStakingModuleName(string name);
}
