// SPDX-License-Identifier: GPL-3.0
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

        // Existing proxies and contracts
        address kernel;
        address agent;
        address aragonAppLidoRepo;
        address locator;
        address voting;
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
        UPGRADEABLE_BEACON = params.upgradeableBeacon;
        STAKING_VAULT_IMPL = params.stakingVaultImpl;
        DASHBOARD_IMPL = params.dashboardImpl;

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
