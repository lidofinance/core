// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IAccessControl} from "@openzeppelin/contracts-v4.4/access/AccessControl.sol";
import {PinnedBeaconProxy} from "../vaults/PinnedBeaconProxy.sol";

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

interface IUpgradeableBeacon {
    function implementation() external view returns (address);
}

interface IStakingRouter {
    struct StakingModule {
        uint24 id;
        address stakingModuleAddress;
        uint16 stakingModuleFee;
        uint16 treasuryFee;
        uint16 targetShare;
        uint8 status;
        string name;
        uint64 lastDepositAt;
        uint256 lastDepositBlock;
        uint256 exitedValidatorsCount;
    }
    
    function getStakingModules() external view returns (StakingModule[] memory);
}

interface ICSModule {
    function accounting() external view returns (address);
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
    address public immutable GATE_SEAL;

    bool public isSetupComplete;

    constructor(address _agent, address _gateSeal) {
        if (_agent == address(0)) revert ZeroAddress();
        if (_gateSeal == address(0)) revert ZeroAddress();
        AGENT = _agent;
        GATE_SEAL = _gateSeal;
    }

    /**
     * @notice Get the CSM accounting address from the staking router
     * @param _stakingRouter The StakingRouter contract address
     * @return The address of the CSM accounting contract
     */
    function getCsmAccountingAddress(address _stakingRouter) public view returns (address) {
        if (_stakingRouter == address(0)) revert ZeroStakingRouter();
        
        IStakingRouter.StakingModule[] memory stakingModules = IStakingRouter(_stakingRouter).getStakingModules();
        
        // Find the Community Staking module (index 2)
        if (stakingModules.length <= 2) revert CsmModuleNotFound();
        
        IStakingRouter.StakingModule memory csm = stakingModules[2];
        if (keccak256(bytes(csm.name)) != keccak256(bytes("Community Staking"))) {
            revert CsmModuleNotFound();
        }
        
        return ICSModule(csm.stakingModuleAddress).accounting();
    }

    /**
     * @notice Complete setup for all contracts - grants all roles and transfers admin to agent
     * @dev This is the main external function that should be called after deployment
     * @param _lidoLocator The new LidoLocator implementation address
     * @param _beacon The UpgradeableBeacon address for computing codehash
     */
    function completeSetup(address _lidoLocator, address _beacon) external {
        if (isSetupComplete) revert SetupAlreadyCompleted();
        if (_lidoLocator == address(0)) revert ZeroLidoLocator();
        if (_beacon == address(0)) revert ZeroBeacon();

        isSetupComplete = true;

        // Get all contract addresses from the LidoLocator
        ILidoLocator locator = ILidoLocator(_lidoLocator);
        address vaultHub = locator.vaultHub();
        address predepositGuarantee = locator.predepositGuarantee();
        address lazyOracle = locator.lazyOracle();
        address operatorGrid = locator.operatorGrid();
        address burner = locator.burner();
        address accounting = locator.accounting();
        address stakingRouter = locator.stakingRouter();

        // Get CSM accounting address from staking router
        address csmAccounting = getCsmAccountingAddress(stakingRouter);

        bytes32 codehash = _computeCodehash(_beacon);
        _setupVaultHub(vaultHub, codehash);
        _setupPredepositGuarantee(predepositGuarantee);
        _setupLazyOracle(lazyOracle);
        _setupOperatorGrid(operatorGrid);
        _setupBurner(burner, accounting, csmAccounting);
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

    /**
     * @notice Public function to compute the codehash of PinnedBeaconProxy using the beacon implementation  
     * @dev This function deploys a temporary proxy to get its runtime bytecode hash
     * @param _beacon The UpgradeableBeacon address
     * @return The keccak256 hash of the PinnedBeaconProxy bytecode
     */
    function computeCodehash(address _beacon) external returns (bytes32) {
        return _computeCodehash(_beacon);
    }


    /**
     * @notice Compute the codehash of PinnedBeaconProxy using the beacon implementation
     * @param _beacon The UpgradeableBeacon address
     * @return The keccak256 hash of the PinnedBeaconProxy bytecode
     */
    function _computeCodehash(address _beacon) private returns (bytes32) {
        // Deploy a temporary PinnedBeaconProxy to get its runtime bytecode
        PinnedBeaconProxy tempProxy = new PinnedBeaconProxy(_beacon, "");

        bytes memory deployedCode;
        address proxyAddress = address(tempProxy);

        assembly {
            let size := extcodesize(proxyAddress)
            deployedCode := mload(0x40)
            mstore(0x40, add(deployedCode, add(size, 0x20)))
            mstore(deployedCode, size)
            extcodecopy(proxyAddress, add(deployedCode, 0x20), 0, size)
        }

        return keccak256(deployedCode);
    }

    function _transferAdminToAgent(address _contract) private {
        IAccessControl(_contract).grantRole(DEFAULT_ADMIN_ROLE, AGENT);
        IAccessControl(_contract).renounceRole(DEFAULT_ADMIN_ROLE, address(this));
    }

    error ZeroAddress();
    error ZeroLidoLocator();
    error ZeroBeacon();
    error ZeroStakingRouter();
    error CsmModuleNotFound();
    error SetupAlreadyCompleted();
}