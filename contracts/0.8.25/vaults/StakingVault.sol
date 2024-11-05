// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/OwnableUpgradeable.sol";
import {SafeCast} from "@openzeppelin/contracts-v5.0.2/utils/math/SafeCast.sol";
import {ERC1967Utils} from "@openzeppelin/contracts-v5.0.2/proxy/ERC1967/ERC1967Utils.sol";
import {VaultHub} from "./VaultHub.sol";
import {IReportReceiver} from "./interfaces/IReportReceiver.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {IBeaconProxy} from "./interfaces/IBeaconProxy.sol";
import {VaultBeaconChainDepositor} from "./VaultBeaconChainDepositor.sol";
import {Versioned} from "../utils/Versioned.sol";

// TODO: extract interface and implement it

contract StakingVault is IBeaconProxy, VaultBeaconChainDepositor, OwnableUpgradeable, Versioned {
    /// @custom:storage-location erc7201:StakingVault.Vault
    struct VaultStorage {
        uint128 reportValuation;
        int128 reportInOutDelta;

        uint256 locked;
        int256 inOutDelta;
    }

    uint256 private constant _version = 1;
    address private immutable _SELF;
    VaultHub public immutable vaultHub;

    /// keccak256(abi.encode(uint256(keccak256("StakingVault.Vault")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant VAULT_STORAGE_LOCATION =
        0xe1d42fabaca5dacba3545b34709222773cbdae322fef5b060e1d691bf0169000;

    constructor(
        address _vaultHub,
        address _beaconChainDepositContract
    ) VaultBeaconChainDepositor(_beaconChainDepositContract) {
        if (_vaultHub == address(0)) revert ZeroArgument("_vaultHub");

        _SELF = address(this);
        vaultHub = VaultHub(_vaultHub);
    }

    /// @notice Initialize the contract storage explicitly.
    /// @param _owner owner address that can TBD
    function initialize(address _owner, bytes calldata params) external {
        if (_owner == address(0)) revert ZeroArgument("_owner");

        if (address(this) == _SELF) {
            revert NonProxyCallsForbidden();
        }

        _initializeContractVersionTo(1);

        _transferOwnership(_owner);
    }

    function version() public pure virtual returns(uint256) {
        return _version;
    }

    function getBeacon() public view returns (address) {
        return ERC1967Utils.getBeacon();
    }

    receive() external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        emit ExecutionLayerRewardsReceived(msg.sender, msg.value);
    }

    function valuation() public view returns (uint256) {
        return uint256(
            int128(_getVaultStorage().reportValuation)
            + _getVaultStorage().inOutDelta
            - _getVaultStorage().reportInOutDelta
        );
    }

    function isHealthy() public view returns (bool) {
        return valuation() >= _getVaultStorage().locked;
    }

    function locked() external view returns(uint256) {
        return _getVaultStorage().locked;
    }

    function unlocked() public view returns (uint256) {
        uint256 _valuation = valuation();
        uint256 _locked = _getVaultStorage().locked;

        if (_locked > _valuation) return 0;

        return _valuation - _locked;
    }

    function inOutDelta() external view returns(int256) {
        return _getVaultStorage().inOutDelta;
    }

    function withdrawalCredentials() public view returns (bytes32) {
        return bytes32((0x01 << 248) + uint160(address(this)));
    }

    function fund() external payable onlyOwner {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        VaultStorage storage $ = _getVaultStorage();
        $.inOutDelta += int256(msg.value);

        emit Funded(msg.sender, msg.value);
    }

    function withdraw(address _recipient, uint256 _ether) external onlyOwner {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_ether == 0) revert ZeroArgument("_ether");
        uint256 _unlocked = unlocked();
        if (_ether > _unlocked) revert InsufficientUnlocked(_unlocked);
        if (_ether > address(this).balance) revert InsufficientBalance(address(this).balance);

        VaultStorage storage $ = _getVaultStorage();
        $.inOutDelta -= int256(_ether);

        (bool success, ) = _recipient.call{value: _ether}("");
        if (!success) revert TransferFailed(_recipient, _ether);
        if (!isHealthy()) revert NotHealthy();

        emit Withdrawn(msg.sender, _recipient, _ether);
    }

    function depositToBeaconChain(
        uint256 _numberOfDeposits,
        bytes calldata _pubkeys,
        bytes calldata _signatures
    ) external onlyOwner {
        if (_numberOfDeposits == 0) revert ZeroArgument("_numberOfDeposits");
        if (!isHealthy()) revert NotHealthy();

        _makeBeaconChainDeposits32ETH(_numberOfDeposits, bytes.concat(withdrawalCredentials()), _pubkeys, _signatures);
        emit DepositedToBeaconChain(msg.sender, _numberOfDeposits, _numberOfDeposits * 32 ether);
    }

    function requestValidatorExit(bytes calldata _validatorPublicKey) external onlyOwner {
        emit ValidatorsExitRequest(msg.sender, _validatorPublicKey);
    }

    function lock(uint256 _locked) external {
        if (msg.sender != address(vaultHub)) revert NotAuthorized("lock", msg.sender);

        VaultStorage storage $ = _getVaultStorage();
        if ($.locked > _locked) revert LockedCannotBeDecreased(_locked);

        $.locked = _locked;

        emit Locked(_locked);
    }

    function rebalance(uint256 _ether) external payable {
        if (_ether == 0) revert ZeroArgument("_ether");
        if (_ether > address(this).balance) revert InsufficientBalance(address(this).balance);

        if (owner() == msg.sender || (!isHealthy() && msg.sender == address(vaultHub))) {
            // force rebalance
            // TODO: check rounding here
            // mint some stETH in Lido v2 and burn it on the vault
            VaultStorage storage $ = _getVaultStorage();
            $.inOutDelta -= int256(_ether);

            emit Withdrawn(msg.sender, msg.sender, _ether);

            vaultHub.rebalance{value: _ether}();
        } else {
            revert NotAuthorized("rebalance", msg.sender);
        }
    }

    function latestReport() external view returns (IStakingVault.Report memory) {
        VaultStorage storage $ = _getVaultStorage();
        return IStakingVault.Report({
            valuation: $.reportValuation,
            inOutDelta: $.reportInOutDelta
        });
    }

    function report(uint256 _valuation, int256 _inOutDelta, uint256 _locked) external {
        if (msg.sender != address(vaultHub)) revert NotAuthorized("update", msg.sender);

        VaultStorage storage $ = _getVaultStorage();
        $.reportValuation = SafeCast.toUint128(_valuation);
        $.reportInOutDelta = SafeCast.toInt128(_inOutDelta);
        $.locked = _locked;

        try IReportReceiver(owner()).onReport(_valuation, _inOutDelta, _locked) {} catch (bytes memory reason) {
            emit OnReportFailed(reason);
        }

        emit Reported(_valuation, _inOutDelta, _locked);
    }

    function _getVaultStorage() private pure returns (VaultStorage storage $) {
        assembly {
            $.slot := VAULT_STORAGE_LOCATION
        }
    }

    event Funded(address indexed sender, uint256 amount);
    event Withdrawn(address indexed sender, address indexed recipient, uint256 amount);
    event DepositedToBeaconChain(address indexed sender, uint256 deposits, uint256 amount);
    event ExecutionLayerRewardsReceived(address indexed sender, uint256 amount);
    event ValidatorsExitRequest(address indexed sender, bytes validatorPublicKey);
    event Locked(uint256 locked);
    event Reported(uint256 valuation, int256 inOutDelta, uint256 locked);
    event OnReportFailed(bytes reason);

    error ZeroArgument(string name);
    error InsufficientBalance(uint256 balance);
    error InsufficientUnlocked(uint256 unlocked);
    error TransferFailed(address recipient, uint256 amount);
    error NotHealthy();
    error NotAuthorized(string operation, address sender);
    error LockedCannotBeDecreased(uint256 locked);
    error NonProxyCallsForbidden();
}
