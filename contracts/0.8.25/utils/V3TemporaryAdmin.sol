// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IAccessControl} from "@openzeppelin/contracts-v4.4/access/AccessControl.sol";

interface IVaultHub {
    function VAULT_CODEHASH_SET_ROLE() external view returns (bytes32);
    function VAULT_MASTER_ROLE() external view returns (bytes32);
    function REDEMPTION_MASTER_ROLE() external view returns (bytes32);
    function VALIDATOR_EXIT_ROLE() external view returns (bytes32);

    function setAllowedCodehash(bytes32 _codehash, bool _allowed) external;
}

interface IPausableUntil {
    function PAUSE_ROLE() external view returns (bytes32);
}

interface ILazyOracle {
    function UPDATE_SANITY_PARAMS_ROLE() external view returns (bytes32);
}

interface IOperatorGrid {
    function REGISTRY_ROLE() external view returns (bytes32);
}

interface IBurner {
    function REQUEST_BURN_SHARES_ROLE() external view returns (bytes32);
}

/**
 * @title V3TemporaryAdmin
 * @notice Auxiliary contract that serves as temporary admin during deployment
 * @dev Used to perform intermediate admin tasks (like setting PAUSE_ROLE for gateSeal)
 *      and then transfer admin role to the final agent, reducing deployer privileges
 */
contract V3TemporaryAdmin {
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    address public immutable AGENT;
    address public immutable GATE_SEAL;

    constructor(address _agent, address _gateSeal) {
        if (_agent == address(0)) revert ZeroAddress();
        if (_gateSeal == address(0)) revert ZeroAddress();
        AGENT = _agent;
        GATE_SEAL = _gateSeal;
    }


    /**
     * @notice Complete setup for all contracts - grants all roles and transfers admin to agent
     * @dev This is the main external function that should be called after deployment
     * @param _vaultHub The VaultHub contract address
     * @param _predepositGuarantee The PredepositGuarantee contract address
     * @param _lazyOracle The LazyOracle contract address
     * @param _operatorGrid The OperatorGrid contract address
     * @param _burner The Burner contract address
     * @param _csmAccounting The CSM Accounting contract address
     * @param _codehash The allowed codehash to set on VaultHub
     */
    function completeSetup(
        address _vaultHub,
        address _predepositGuarantee,
        address _lazyOracle,
        address _operatorGrid,
        address _burner,
        address _accounting,
        address _csmAccounting,
        bytes32 _codehash
    ) external {
        if (_vaultHub == address(0)) revert ZeroVaultHub();
        if (_predepositGuarantee == address(0)) revert ZeroPredepositGuarantee();
        if (_lazyOracle == address(0)) revert ZeroLazyOracle();
        if (_operatorGrid == address(0)) revert ZeroOperatorGrid();
        if (_burner == address(0)) revert ZeroBurner();
        if (_accounting == address(0)) revert ZeroAccounting();
        if (_csmAccounting == address(0)) revert ZeroCsmAccounting();

        // Setup VaultHub with all roles and transfer admin
        _setupVaultHub(_vaultHub, _codehash);

        // Setup PredepositGuarantee and transfer admin
        _setupPredepositGuarantee(_predepositGuarantee);

        // Setup LazyOracle and transfer admin
        _setupLazyOracle(_lazyOracle);

        // Setup OperatorGrid and transfer admin
        _setupOperatorGrid(_operatorGrid);

        // Setup Burner and transfer admin
        _setupBurner(_burner, _accounting, _csmAccounting);
    }


    /**
     * @notice Setup VaultHub with all required roles and transfer admin to agent
     * @param _vaultHub The VaultHub contract address
     */
    function _setupVaultHub(address _vaultHub, bytes32 _codehash) private {
        // Get roles from the contract
        bytes32 pauseRole = IPausableUntil(_vaultHub).PAUSE_ROLE();
        bytes32 vaultMasterRole = IVaultHub(_vaultHub).VAULT_MASTER_ROLE();
        bytes32 vaultCodehashSetRole = IVaultHub(_vaultHub).VAULT_CODEHASH_SET_ROLE();
        bytes32 redemptionMasterRole = IVaultHub(_vaultHub).REDEMPTION_MASTER_ROLE();
        bytes32 validatorExitRole = IVaultHub(_vaultHub).VALIDATOR_EXIT_ROLE();

        IAccessControl(_vaultHub).grantRole(vaultCodehashSetRole, address(this));
        IVaultHub(_vaultHub).setAllowedCodehash(_codehash, true);
        IAccessControl(_vaultHub).revokeRole(vaultCodehashSetRole, address(this));

        // Grant PAUSE_ROLE to gateSeal
        IAccessControl(_vaultHub).grantRole(pauseRole, GATE_SEAL);

        // Grant other roles to agent
        // TODO: does agent need all these roles?
        IAccessControl(_vaultHub).grantRole(vaultMasterRole, AGENT);
        IAccessControl(_vaultHub).grantRole(vaultCodehashSetRole, AGENT);
        IAccessControl(_vaultHub).grantRole(redemptionMasterRole, AGENT);
        IAccessControl(_vaultHub).grantRole(validatorExitRole, AGENT);

        _transferAdminToAgent(_vaultHub);
    }

    /**
     * @notice Setup PredepositGuarantee with PAUSE_ROLE for gateSeal and transfer admin to agent
     * @param _predepositGuarantee The PredepositGuarantee contract address
     */
    function _setupPredepositGuarantee(address _predepositGuarantee) private {
        // Get role from the contract
        bytes32 pauseRole = IPausableUntil(_predepositGuarantee).PAUSE_ROLE();

        // Grant PAUSE_ROLE to gateSeal
        IAccessControl(_predepositGuarantee).grantRole(pauseRole, GATE_SEAL);

        _transferAdminToAgent(_predepositGuarantee);
    }

    /**
     * @notice Setup LazyOracle with required roles and transfer admin to agent
     * @param _lazyOracle The LazyOracle contract address
     */
    function _setupLazyOracle(address _lazyOracle) private {
        // Get role from the contract
        bytes32 updateSanityParamsRole = ILazyOracle(_lazyOracle).UPDATE_SANITY_PARAMS_ROLE();

        // Grant UPDATE_SANITY_PARAMS_ROLE to agent
        IAccessControl(_lazyOracle).grantRole(updateSanityParamsRole, AGENT);

        _transferAdminToAgent(_lazyOracle);
    }

    /**
     * @notice Setup OperatorGrid with required roles and transfer admin to agent
     * @param _operatorGrid The OperatorGrid contract address
     */
    function _setupOperatorGrid(address _operatorGrid) private {
        bytes32 registryRole = IOperatorGrid(_operatorGrid).REGISTRY_ROLE();
        IAccessControl(_operatorGrid).grantRole(registryRole, AGENT);
        _transferAdminToAgent(_operatorGrid);
    }

    /**
     * @notice Setup Burner with required roles and transfer admin to agent
     * @param _burner The Burner contract address
     * @param _csmAccounting The CSM Accounting contract address
     */
    function _setupBurner(
        address _burner,
        address _accounting,
        address _csmAccounting
    ) private {
        // Get role from the contract
        bytes32 requestBurnSharesRole = IBurner(_burner).REQUEST_BURN_SHARES_ROLE();

        IAccessControl(_burner).grantRole(requestBurnSharesRole, _accounting);
        IAccessControl(_burner).grantRole(requestBurnSharesRole, _csmAccounting);

        _transferAdminToAgent(_burner);
    }

    function _transferAdminToAgent(address _contract) private {
        IAccessControl(_contract).grantRole(DEFAULT_ADMIN_ROLE, AGENT);
        IAccessControl(_contract).renounceRole(DEFAULT_ADMIN_ROLE, address(this));
    }

    error ZeroAddress();
    error ZeroVaultHub();
    error ZeroPredepositGuarantee();
    error ZeroLazyOracle();
    error ZeroOperatorGrid();
    error ZeroBurner();
    error ZeroAccounting();
    error ZeroNodeOperatorsRegistry();
    error ZeroSimpleDvt();
    error ZeroCsmAccounting();
}