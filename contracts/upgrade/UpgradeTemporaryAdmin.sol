// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/IAccessControl.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IEasyTrack, IDepositSecurityModule} from "./UpgradeTypes.sol";

/**
 * @title UpgradeTemporaryAdmin
 * @notice Auxiliary contract that serves as temporary admin during upgrade deployment
 * @dev Used to perform intermediate admin tasks (like setting roles)
 *      and then transfer admin role to the final agent, reducing deployer privileges
 */
contract UpgradeTemporaryAdmin {
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    bytes32 internal constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 internal constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 internal constant ALLOW_PAIR_ROLE = keccak256("ALLOW_PAIR_ROLE");
    bytes32 internal constant DISALLOW_PAIR_ROLE = keccak256("DISALLOW_PAIR_ROLE");
    bytes32 internal constant PUBLISH_ROLE = keccak256("PUBLISH_ROLE");
    bytes32 internal constant MANAGE_ROLE = keccak256("MANAGE_ROLE");
    bytes32 internal constant REMOVE_ROLE = keccak256("REMOVE_ROLE");
    bytes32 internal constant ADD_CONSOLIDATION_REQUEST_ROLE = keccak256("ADD_CONSOLIDATION_REQUEST_ROLE");
    bytes32 internal constant TOP_UP_ROLE = keccak256("TOP_UP_ROLE");

    address public immutable AGENT;

    bool public isSetupComplete;

    constructor(address _agent) {
        if (_agent == address(0)) revert ZeroAddress();
        AGENT = _agent;
    }

    /**
     * @notice Complete setup for all contracts - grants all roles and transfers admin to agent
     * @dev This is the main external function that should be called after deployment
     */
    function completeSetup(
        address _lidoLocatorImpl,
        address _easyTrack,
        address _resealManager,
        address _circuitBreaker,
        address _consolidationMigrator,
        address _consolidationMigratorCommittee,
        address _consolidationBus,
        address _topUpGatewayDepositor,
        address _oldDepositSecurityModule
    ) external {
        if (isSetupComplete) revert SetupAlreadyCompleted();
        if (_lidoLocatorImpl == address(0)) revert ZeroLidoLocator();
        if (_easyTrack == address(0)) revert ZeroEasyTrack();

        isSetupComplete = true;

        ILidoLocator locator = ILidoLocator(_lidoLocatorImpl);
        address evmScriptExecutor = IEasyTrack(_easyTrack).evmScriptExecutor();
        address consolidationGateway = locator.consolidationGateway();
        address topUpGateway = locator.topUpGateway();
        address depositSecurityModule = locator.depositSecurityModule();

        _setupDSM(depositSecurityModule, _oldDepositSecurityModule);
        _setupConsolidationMigrator(_consolidationMigrator, evmScriptExecutor, _consolidationMigratorCommittee);
        _setupConsolidationBus(_consolidationBus, _consolidationMigrator);
        _setupConsolidationGateway(consolidationGateway, _consolidationBus, _circuitBreaker, _resealManager);
        _setupTopUpGateway(topUpGateway, _topUpGatewayDepositor);

        emit SetupCompleted(_consolidationMigrator, _consolidationBus, consolidationGateway, topUpGateway);
    }

    function _setupDSM(address _dsm, address _oldDsm) private {
        IDepositSecurityModule dsm = IDepositSecurityModule(_dsm);
        IDepositSecurityModule oldDsm = IDepositSecurityModule(_oldDsm);

        dsm.addGuardians(oldDsm.getGuardians(), oldDsm.getGuardianQuorum());
        dsm.setOwner(AGENT);
    }

    function _setupConsolidationMigrator(address _migrator, address _evmScriptExecutor, address _committee) private {
        IAccessControl(_migrator).grantRole(ALLOW_PAIR_ROLE, _evmScriptExecutor);
        IAccessControl(_migrator).grantRole(DISALLOW_PAIR_ROLE, _committee);

        _transferAdminToAgent(_migrator);
    }

    function _setupConsolidationBus(address _bus, address _migrator) private {
        IAccessControl(_bus).grantRole(PUBLISH_ROLE, _migrator);
        IAccessControl(_bus).renounceRole(MANAGE_ROLE, address(this));
        IAccessControl(_bus).renounceRole(REMOVE_ROLE, address(this));

        _transferAdminToAgent(_bus);
    }

    function _setupConsolidationGateway(address _gateway, address _bus, address _cb, address _resealManager) private {
        IAccessControl(_gateway).grantRole(PAUSE_ROLE, _cb);
        IAccessControl(_gateway).grantRole(PAUSE_ROLE, _resealManager);
        IAccessControl(_gateway).grantRole(RESUME_ROLE, _resealManager);
        IAccessControl(_gateway).grantRole(ADD_CONSOLIDATION_REQUEST_ROLE, _bus);

        _transferAdminToAgent(_gateway);
    }

    function _setupTopUpGateway(address _gateway, address _depositor) private {
        IAccessControl(_gateway).grantRole(TOP_UP_ROLE, _depositor);

        _transferAdminToAgent(_gateway);
    }

    function _transferAdminToAgent(address _contract) private {
        IAccessControl(_contract).grantRole(DEFAULT_ADMIN_ROLE, AGENT);
        IAccessControl(_contract).renounceRole(DEFAULT_ADMIN_ROLE, address(this));
    }

    error ZeroAddress();
    error ZeroLidoLocator();
    error ZeroEasyTrack();
    error SetupAlreadyCompleted();

    event SetupCompleted(
        address consolidationMigrator, address consolidationBus, address consolidationGateway, address topUpGateway
    );
}
