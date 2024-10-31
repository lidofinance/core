// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/OwnableUpgradeable.sol";
import {SafeCast} from "@openzeppelin/contracts-v5.0.2/utils/math/SafeCast.sol";
import {IERC20} from "@openzeppelin/contracts-v5.0.2/token/ERC20/IERC20.sol";
import {VaultHub} from "./VaultHub.sol";
import {IReportReceiver} from "./interfaces/IReportReceiver.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {VaultBeaconChainDepositor} from "./VaultBeaconChainDepositor.sol";

contract StakingVault is VaultBeaconChainDepositor, OwnableUpgradeable {
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

    struct Report {
        uint128 valuation;
        int128 inOutDelta;
    }

    VaultHub public immutable vaultHub;
    IERC20 public immutable stETH;
    Report public latestReport;
    uint256 public locked;
    int256 public inOutDelta;

    constructor(
        address _vaultHub,
        address _stETH,
        address _owner,
        address _beaconChainDepositContract
    ) VaultBeaconChainDepositor(_beaconChainDepositContract) {
        if (_vaultHub == address(0)) revert ZeroArgument("_vaultHub");
        if (_stETH == address(0)) revert ZeroArgument("_stETH");
        if (_owner == address(0)) revert ZeroArgument("_owner");

        vaultHub = VaultHub(_vaultHub);
        stETH = IERC20(_stETH);
        _transferOwnership(_owner);
    }

    receive() external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        emit ExecutionLayerRewardsReceived(msg.sender, msg.value);
    }

    function valuation() public view returns (uint256) {
        return uint256(int128(latestReport.valuation) + inOutDelta - latestReport.inOutDelta);
    }

    function isHealthy() public view returns (bool) {
        return valuation() >= locked;
    }

    function unlocked() public view returns (uint256) {
        uint256 _valuation = valuation();
        uint256 _locked = locked;

        if (_locked > _valuation) return 0;

        return _valuation - _locked;
    }

    function withdrawalCredentials() public view returns (bytes32) {
        return bytes32((0x01 << 248) + uint160(address(this)));
    }

    function fund() external payable onlyOwner {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        inOutDelta += int256(msg.value);

        emit Funded(msg.sender, msg.value);
    }

    function withdraw(address _recipient, uint256 _ether) external onlyOwner {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_ether == 0) revert ZeroArgument("_ether");
        uint256 _unlocked = unlocked();
        if (_ether > _unlocked) revert InsufficientUnlocked(_unlocked);
        if (_ether > address(this).balance) revert InsufficientBalance(address(this).balance);

        inOutDelta -= int256(_ether);
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

    function mint(address _recipient, uint256 _tokens) external payable onlyOwner {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_tokens == 0) revert ZeroArgument("_tokens");

        uint256 newlyLocked = vaultHub.mintStethBackedByVault(_recipient, _tokens);

        if (newlyLocked > locked) {
            locked = newlyLocked;

            emit Locked(newlyLocked);
        }
    }

    function burn(uint256 _tokens) external onlyOwner {
        if (_tokens == 0) revert ZeroArgument("_tokens");

        stETH.transferFrom(msg.sender, address(vaultHub), _tokens);
        vaultHub.burnStethBackedByVault(_tokens);
    }

    function rebalance(uint256 _ether) external payable {
        if (_ether == 0) revert ZeroArgument("_ether");
        if (_ether > address(this).balance) revert InsufficientBalance(address(this).balance);

        if (owner() == msg.sender || (!isHealthy() && msg.sender == address(vaultHub))) {
            // force rebalance
            // TODO: check rounding here
            // mint some stETH in Lido v2 and burn it on the vault
            inOutDelta -= int256(_ether);
            emit Withdrawn(msg.sender, msg.sender, _ether);

            vaultHub.rebalance{value: _ether}();
        } else {
            revert NotAuthorized("rebalance", msg.sender);
        }
    }

    function report(uint256 _valuation, int256 _inOutDelta, uint256 _locked) external {
        if (msg.sender != address(vaultHub)) revert NotAuthorized("update", msg.sender);

        latestReport = Report(SafeCast.toUint128(_valuation), SafeCast.toInt128(_inOutDelta));
        locked = _locked;

        try IReportReceiver(owner()).onReport(_valuation, _inOutDelta, _locked) {} catch (bytes memory reason) {
            emit OnReportFailed(reason);
        }

        emit Reported(_valuation, _inOutDelta, _locked);
    }

    function disconnectFromHub() external payable onlyOwner {
        vaultHub.disconnectVault();
    }
}
