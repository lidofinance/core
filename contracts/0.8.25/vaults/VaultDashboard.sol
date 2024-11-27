// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.0.2/access/extensions/AccessControlEnumerable.sol";
import {IERC20} from "@openzeppelin/contracts-v5.0.2/token/ERC20/IERC20.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/OwnableUpgradeable.sol";
import {VaultHub} from "./VaultHub.sol";

// TODO: natspec
// TODO: think about the name

contract VaultDashboard is AccessControlEnumerable {
    bytes32 public constant OWNER = DEFAULT_ADMIN_ROLE;
    bytes32 public constant MANAGER_ROLE = keccak256("Vault.VaultDashboard.ManagerRole");

    IERC20 public immutable stETH;
    address private immutable _SELF;

    bool public isInitialized;
    IStakingVault public stakingVault;
    VaultHub public vaultHub;

    constructor(address _stETH) {
        if (_stETH == address(0)) revert ZeroArgument("_stETH");

        _SELF = address(this);
        stETH = IERC20(_stETH);
    }

    function initialize(address _defaultAdmin, address _stakingVault) external virtual {
        _initialize(_defaultAdmin, _stakingVault);
    }

    function _initialize(address _defaultAdmin, address _stakingVault) internal {
        if (_defaultAdmin == address(0)) revert ZeroArgument("_defaultAdmin");
        if (_stakingVault == address(0)) revert ZeroArgument("_stakingVault");
        if (isInitialized) revert AlreadyInitialized();

        if (address(this) == _SELF) {
            revert NonProxyCallsForbidden();
        }

        isInitialized = true;

        _grantRole(OWNER, _defaultAdmin);

        stakingVault = IStakingVault(_stakingVault);
        vaultHub = VaultHub(stakingVault.vaultHub());

        emit Initialized();
    }

    /// GETTERS ///

    function vaultSocket() external view returns (VaultHub.VaultSocket memory) {
        return vaultHub.vaultSocket(address(stakingVault));
    }

    function shareLimit() external view returns (uint96) {
        return vaultHub.vaultSocket(address(stakingVault)).shareLimit;
    }

    function sharesMinted() external view returns (uint96) {
        return vaultHub.vaultSocket(address(stakingVault)).sharesMinted;
    }

    function reserveRatio() external view returns (uint16) {
        return vaultHub.vaultSocket(address(stakingVault)).reserveRatio;
    }

    function thresholdReserveRatioBP() external view returns (uint16) {
        return vaultHub.vaultSocket(address(stakingVault)).reserveRatioThreshold;
    }

    function treasuryFeeBP() external view returns (uint16) {
        return vaultHub.vaultSocket(address(stakingVault)).treasuryFeeBP;
    }

    /// VAULT MANAGEMENT ///

    function transferStakingVaultOwnership(address _newOwner) external onlyRole(OWNER) {
        OwnableUpgradeable(address(stakingVault)).transferOwnership(_newOwner);
    }

    function disconnectFromHub() external payable onlyRole(MANAGER_ROLE) {
        vaultHub.disconnectVault(address(stakingVault));
    }

    /// OPERATION ///

    function fund() external payable virtual onlyRole(MANAGER_ROLE) {
        stakingVault.fund{value: msg.value}();
    }

    function withdraw(address _recipient, uint256 _ether) external virtual onlyRole(MANAGER_ROLE) {
        stakingVault.withdraw(_recipient, _ether);
    }

    function requestValidatorExit(bytes calldata _validatorPublicKey) external onlyRole(MANAGER_ROLE) {
        stakingVault.requestValidatorExit(_validatorPublicKey);
    }

    function depositToBeaconChain(
        uint256 _numberOfDeposits,
        bytes calldata _pubkeys,
        bytes calldata _signatures
    ) external virtual onlyRole(MANAGER_ROLE) {
        stakingVault.depositToBeaconChain(_numberOfDeposits, _pubkeys, _signatures);
    }

    /// LIQUIDITY ///

    function mint(address _recipient, uint256 _tokens) external payable virtual onlyRole(MANAGER_ROLE) fundAndProceed {
        vaultHub.mintStethBackedByVault(address(stakingVault), _recipient, _tokens);
    }

    function burn(uint256 _tokens) external virtual onlyRole(MANAGER_ROLE) {
        stETH.transferFrom(msg.sender, address(vaultHub), _tokens);
        vaultHub.burnStethBackedByVault(address(stakingVault), _tokens);
    }

    /// REBALANCE ///

    function rebalanceVault(uint256 _ether) external payable virtual onlyRole(MANAGER_ROLE) fundAndProceed {
        stakingVault.rebalance(_ether);
    }

    /// MODIFIERS ///

    modifier fundAndProceed() {
        if (msg.value > 0) {
            stakingVault.fund{value: msg.value}();
        }
        _;
    }

    /// EVENTS //
    event Initialized();

    /// ERRORS ///

    error ZeroArgument(string);
    error InsufficientWithdrawableAmount(uint256 withdrawable, uint256 requested);
    error NonProxyCallsForbidden();
    error AlreadyInitialized();
}