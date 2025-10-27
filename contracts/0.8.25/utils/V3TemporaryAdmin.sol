// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IAccessControl} from "@openzeppelin/contracts-v4.4/access/AccessControl.sol";

interface IVaultHub {
    function VAULT_MASTER_ROLE() external view returns (bytes32);
    function REDEMPTION_MASTER_ROLE() external view returns (bytes32);
    function VALIDATOR_EXIT_ROLE() external view returns (bytes32);
    function BAD_DEBT_MASTER_ROLE() external view returns (bytes32);
}

interface IPausableUntilWithRoles {
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

interface IUpgradeableBeacon {
    function implementation() external view returns (address);
}

interface IStakingRouter {
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

interface IVaultsAdapter {
    function evmScriptExecutor() external view returns (address);
}

interface ILidoLocator {
    function vaultHub() external view returns (address);
    function predepositGuarantee() external view returns (address);
    function lazyOracle() external view returns (address);
    function operatorGrid() external view returns (address);
    function burner() external view returns (address);
    function accounting() external view returns (address);
    function stakingRouter() external view returns (address);
    function vaultFactory() external view returns (address);
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
    bool public immutable IS_HOODI;

    bool public isSetupComplete;

    constructor(address _agent, bool _isHoodi) {
        if (_agent == address(0)) revert ZeroAddress();
        AGENT = _agent;
        IS_HOODI = _isHoodi;
    }

    /**
     * @notice Get the CSM accounting address from the staking router
     * @param _stakingRouter The StakingRouter contract address
     * @return The address of the CSM accounting contract
     */
    function getCsmAccountingAddress(address _stakingRouter) public view returns (address) {
        if (_stakingRouter == address(0)) revert ZeroStakingRouter();

        IStakingRouter.StakingModule[] memory stakingModules = IStakingRouter(_stakingRouter).getStakingModules();

        // Find the Community Staking module (index 2 or 3 on Hoodi)
        if (stakingModules.length <= 2) revert CsmModuleNotFound();

        IStakingRouter.StakingModule memory csm = stakingModules[IS_HOODI ? 3 : 2];
        if (keccak256(bytes(csm.name)) != keccak256(bytes("Community Staking"))) {
            revert CsmModuleNotFound();
        }

        return ICSModule(csm.stakingModuleAddress).accounting();
    }

    /**
     * @notice Complete setup for all contracts - grants all roles and transfers admin to agent
     * @dev This is the main external function that should be called after deployment
     * @param _lidoLocatorImpl The new LidoLocator implementation address
     * @param _vaultsAdapter The vaults' adapter address from easyTrack
     */
    function completeSetup(address _lidoLocatorImpl, address _vaultsAdapter, address _gateSeal) external {
        if (isSetupComplete) revert SetupAlreadyCompleted();
        if (_lidoLocatorImpl == address(0)) revert ZeroLidoLocator();
        if (_vaultsAdapter == address(0)) revert ZeroVaultsAdapter();

        isSetupComplete = true;

        ILidoLocator locator = ILidoLocator(_lidoLocatorImpl);

        address csmAccounting = getCsmAccountingAddress(locator.stakingRouter());

        _setupPredepositGuarantee(locator.predepositGuarantee(), _gateSeal);
        _setupLazyOracle(locator.lazyOracle());
        _setupOperatorGrid(locator.operatorGrid(), IVaultsAdapter(_vaultsAdapter).evmScriptExecutor(), _vaultsAdapter);
        _setupBurner(locator.burner(), locator.accounting(), csmAccounting);
        _setupVaultHub(locator.vaultHub(), _vaultsAdapter, _gateSeal);
    }


    /**
     * @notice Setup VaultHub with all required roles and transfer admin to agent
     * @param _vaultHub The VaultHub contract address
     * @param _vaultsAdapter The vaults' adapter address
     */
    function _setupVaultHub(address _vaultHub, address _vaultsAdapter, address _gateSeal) private {
        // Get roles from the contract
        bytes32 pauseRole = IPausableUntilWithRoles(_vaultHub).PAUSE_ROLE();
        bytes32 vaultMasterRole = IVaultHub(_vaultHub).VAULT_MASTER_ROLE();
        bytes32 redemptionMasterRole = IVaultHub(_vaultHub).REDEMPTION_MASTER_ROLE();
        bytes32 validatorExitRole = IVaultHub(_vaultHub).VALIDATOR_EXIT_ROLE();
        bytes32 badDebtMasterRole = IVaultHub(_vaultHub).BAD_DEBT_MASTER_ROLE();

        IAccessControl(_vaultHub).grantRole(pauseRole, _gateSeal);

        IAccessControl(_vaultHub).grantRole(vaultMasterRole, AGENT);
        IAccessControl(_vaultHub).grantRole(redemptionMasterRole, AGENT);

        IAccessControl(_vaultHub).grantRole(validatorExitRole, _vaultsAdapter);
        IAccessControl(_vaultHub).grantRole(badDebtMasterRole, _vaultsAdapter);
        IAccessControl(_vaultHub).grantRole(redemptionMasterRole, _vaultsAdapter);

        _transferAdminToAgent(_vaultHub);
    }

    /**
     * @notice Setup PredepositGuarantee with PAUSE_ROLE for gateSeal and transfer admin to agent
     * @param _predepositGuarantee The PredepositGuarantee contract address
     */
    function _setupPredepositGuarantee(address _predepositGuarantee, address _gateSeal) private {
        bytes32 pauseRole = IPausableUntilWithRoles(_predepositGuarantee).PAUSE_ROLE();
        IAccessControl(_predepositGuarantee).grantRole(pauseRole, _gateSeal);
        _transferAdminToAgent(_predepositGuarantee);
    }

    /**
     * @notice Setup LazyOracle with required roles and transfer admin to agent
     * @param _lazyOracle The LazyOracle contract address
     */
    function _setupLazyOracle(address _lazyOracle) private {
        bytes32 updateSanityParamsRole = ILazyOracle(_lazyOracle).UPDATE_SANITY_PARAMS_ROLE();
        IAccessControl(_lazyOracle).grantRole(updateSanityParamsRole, AGENT);
        _transferAdminToAgent(_lazyOracle);
    }

    /**
     * @notice Setup OperatorGrid with required roles and transfer admin to agent
     * @param _operatorGrid The OperatorGrid contract address
     * @param _evmScriptExecutor The EVM script executor address
     * @param _vaultsAdapter The vaults' adapter address
     */
    function _setupOperatorGrid(address _operatorGrid, address _evmScriptExecutor, address _vaultsAdapter) private {
        bytes32 registryRole = IOperatorGrid(_operatorGrid).REGISTRY_ROLE();
        IAccessControl(_operatorGrid).grantRole(registryRole, AGENT);
        IAccessControl(_operatorGrid).grantRole(registryRole, _evmScriptExecutor);
        IAccessControl(_operatorGrid).grantRole(registryRole, _vaultsAdapter);
        _transferAdminToAgent(_operatorGrid);
    }

    /**
     * @notice Setup Burner with required roles and transfer admin to agent
     * @param _burner The Burner contract address
     * @param _accounting The Accounting contract address
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
    error ZeroLidoLocator();
    error ZeroStakingRouter();
    error ZeroEvmScriptExecutor();
    error ZeroVaultsAdapter();
    error CsmModuleNotFound();
    error SetupAlreadyCompleted();
}
