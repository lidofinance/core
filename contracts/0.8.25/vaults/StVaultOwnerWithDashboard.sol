// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.0.2/access/extensions/AccessControlEnumerable.sol";
import {IERC20} from "@openzeppelin/contracts-v5.0.2/token/ERC20/IERC20.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/OwnableUpgradeable.sol";
import {VaultHub} from "./VaultHub.sol";

contract StVaultOwnerWithDashboard is AccessControlEnumerable {
    address private immutable _SELF;
    bool public isInitialized;

    IERC20 public immutable stETH;
    IStakingVault public stakingVault;
    VaultHub public vaultHub;

    constructor(address _stETH) {
        if (_stETH == address(0)) revert ZeroArgument("_stETH");

        _SELF = address(this);
        stETH = IERC20(_stETH);
    }

    /// INITIALIZATION ///

    function initialize(address _defaultAdmin, address _stakingVault) external virtual {
        _initialize(_defaultAdmin, _stakingVault);
    }

    function _initialize(address _defaultAdmin, address _stakingVault) internal {
        if (_defaultAdmin == address(0)) revert ZeroArgument("_defaultAdmin");
        if (_stakingVault == address(0)) revert ZeroArgument("_stakingVault");
        if (isInitialized) revert AlreadyInitialized();
        if (address(this) == _SELF) revert NonProxyCallsForbidden();

        isInitialized = true;

        _grantRole(DEFAULT_ADMIN_ROLE, _defaultAdmin);

        stakingVault = IStakingVault(_stakingVault);
        vaultHub = VaultHub(stakingVault.vaultHub());

        emit Initialized();
    }

    /// VIEW FUNCTIONS ///

    function vaultSocket() public view returns (VaultHub.VaultSocket memory) {
        return vaultHub.vaultSocket(address(stakingVault));
    }

    function shareLimit() external view returns (uint96) {
        return vaultSocket().shareLimit;
    }

    function sharesMinted() external view returns (uint96) {
        return vaultSocket().sharesMinted;
    }

    function reserveRatio() external view returns (uint16) {
        return vaultSocket().reserveRatio;
    }

    function thresholdReserveRatio() external view returns (uint16) {
        return vaultSocket().reserveRatioThreshold;
    }

    function treasuryFee() external view returns (uint16) {
        return vaultSocket().treasuryFeeBP;
    }

    /// VAULT MANAGEMENT ///

    function transferStVaultOwnership(address _newOwner) external virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        _transferStVaultOwnership(_newOwner);
    }

    function disconnectFromVaultHub() external payable virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        _disconnectFromVaultHub();
    }

    function fund() external payable virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        _fund();
    }

    function withdraw(address _recipient, uint256 _ether) external virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        _withdraw(_recipient, _ether);
    }

    function requestValidatorExit(bytes calldata _validatorPublicKey) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _requestValidatorExit(_validatorPublicKey);
    }

    function depositToBeaconChain(
        uint256 _numberOfDeposits,
        bytes calldata _pubkeys,
        bytes calldata _signatures
    ) external virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        _depositToBeaconChain(_numberOfDeposits, _pubkeys, _signatures);
    }

    function mint(
        address _recipient,
        uint256 _tokens
    ) external payable virtual onlyRole(DEFAULT_ADMIN_ROLE) fundAndProceed {
        _mint(_recipient, _tokens);
    }

    function burn(uint256 _tokens) external virtual onlyRole(DEFAULT_ADMIN_ROLE) {
        _burn(_tokens);
    }

    function rebalanceVault(uint256 _ether) external payable virtual onlyRole(DEFAULT_ADMIN_ROLE) fundAndProceed {
        _rebalanceVault(_ether);
    }

    /// INTERNAL ///

    modifier fundAndProceed() {
        if (msg.value > 0) {
            _fund();
        }
        _;
    }

    function _transferStVaultOwnership(address _newOwner) internal {
        OwnableUpgradeable(address(stakingVault)).transferOwnership(_newOwner);
    }

    function _disconnectFromVaultHub() internal {
        vaultHub.disconnectVault(address(stakingVault));
    }

    function _fund() internal {
        stakingVault.fund{value: msg.value}();
    }

    function _withdraw(address _recipient, uint256 _ether) internal {
        stakingVault.withdraw(_recipient, _ether);
    }

    function _requestValidatorExit(bytes calldata _validatorPublicKey) internal {
        stakingVault.requestValidatorExit(_validatorPublicKey);
    }

    function _depositToBeaconChain(
        uint256 _numberOfDeposits,
        bytes calldata _pubkeys,
        bytes calldata _signatures
    ) internal {
        stakingVault.depositToBeaconChain(_numberOfDeposits, _pubkeys, _signatures);
    }

    function _mint(address _recipient, uint256 _tokens) internal {
        vaultHub.mintStethBackedByVault(address(stakingVault), _recipient, _tokens);
    }

    function _burn(uint256 _tokens) internal {
        stETH.transferFrom(msg.sender, address(vaultHub), _tokens);
        vaultHub.burnStethBackedByVault(address(stakingVault), _tokens);
    }

    function _rebalanceVault(uint256 _ether) internal {
        stakingVault.rebalance(_ether);
    }

    /// EVENTS ///
    event Initialized();

    /// ERRORS ///

    error ZeroArgument(string);
    error InsufficientWithdrawableAmount(uint256 withdrawable, uint256 requested);
    error NonProxyCallsForbidden();
    error AlreadyInitialized();
}
