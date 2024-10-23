// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/OwnableUpgradeable.sol";
import {VaultBeaconChainDepositor} from "./VaultBeaconChainDepositor.sol";
import {IVaultHub} from "./interfaces/IHub.sol";

interface ReportHook {
    function onReport(uint256 _valuation) external;
}

contract Vault is VaultBeaconChainDepositor, OwnableUpgradeable {
    event Funded(address indexed sender, uint256 amount);
    event Withdrawn(address indexed sender, address indexed recipient, uint256 amount);
    event DepositedToBeaconChain(address indexed sender, uint256 numberOfDeposits, uint256 amount);
    event ExecutionLayerRewardsReceived(address indexed sender, uint256 amount);
    event ValidatorsExited(address indexed sender, uint256 numberOfValidators);
    event Locked(uint256 locked);
    event Reported(uint256 valuation, int256 inOutDelta, uint256 locked);

    error ZeroInvalid(string name);
    error InsufficientBalance(uint256 balance);
    error InsufficientUnlocked(uint256 unlocked);
    error TransferFailed(address recipient, uint256 amount);
    error NotHealthy();
    error NotAuthorized(string operation, address sender);

    struct Report {
        uint128 valuation;
        int128 inOutDelta;
    }

    uint256 private constant MAX_FEE = 100_00;

    IVaultHub public immutable hub;
    Report public latestReport;
    uint256 public locked;
    int256 public inOutDelta;

    constructor(
        address _owner,
        address _hub,
        address _beaconChainDepositContract
    ) VaultBeaconChainDepositor(_beaconChainDepositContract) {
        hub = IVaultHub(_hub);

        _transferOwnership(_owner);
    }

    receive() external payable {
        if (msg.value == 0) revert ZeroInvalid("msg.value");

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

    function fund() public payable onlyOwner {
        if (msg.value == 0) revert ZeroInvalid("msg.value");

        inOutDelta += int256(msg.value);

        emit Funded(msg.sender, msg.value);
    }

    function withdraw(address _recipient, uint256 _ether) public onlyOwner {
        if (_recipient == address(0)) revert ZeroInvalid("_recipient");
        if (_ether == 0) revert ZeroInvalid("_ether");
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
    ) public onlyOwner {
        if (_numberOfDeposits == 0) revert ZeroInvalid("_numberOfDeposits");
        if (!isHealthy()) revert NotHealthy();

        _makeBeaconChainDeposits32ETH(_numberOfDeposits, bytes.concat(withdrawalCredentials()), _pubkeys, _signatures);
        emit DepositedToBeaconChain(msg.sender, _numberOfDeposits, _numberOfDeposits * 32 ether);
    }

    function exitValidators(uint256 _numberOfValidators) public virtual onlyOwner {
        // [here will be triggerable exit]

        emit ValidatorsExited(msg.sender, _numberOfValidators);
    }

    function mint(address _recipient, uint256 _tokens) external payable onlyOwner {
        if (_recipient == address(0)) revert ZeroInvalid("_recipient");
        if (_tokens == 0) revert ZeroInvalid("_tokens");

        uint256 newlyLocked = hub.mintStethBackedByVault(_recipient, _tokens);

        if (newlyLocked > locked) {
            locked = newlyLocked;

            emit Locked(newlyLocked);
        }
    }

    function burn(uint256 _tokens) external onlyOwner {
        if (_tokens == 0) revert ZeroInvalid("_tokens");

        hub.burnStethBackedByVault(_tokens);
    }

    function rebalance(uint256 _ether) external payable {
        if (_ether == 0) revert ZeroInvalid("_ether");
        if (_ether > address(this).balance) revert InsufficientBalance(address(this).balance);

        if (owner() == msg.sender || (!isHealthy() && msg.sender == address(hub))) {
            // force rebalance
            // TODO: check rounding here
            // mint some stETH in Lido v2 and burn it on the vault
            inOutDelta -= int256(_ether);
            emit Withdrawn(msg.sender, msg.sender, _ether);

            hub.rebalance{value: _ether}();
        } else {
            revert NotAuthorized("rebalance", msg.sender);
        }
    }

    function update(uint256 _valuation, int256 _inOutDelta, uint256 _locked) external {
        if (msg.sender != address(hub)) revert NotAuthorized("update", msg.sender);

        latestReport = Report(uint128(_valuation), int128(_inOutDelta)); //TODO: safecast
        locked = _locked;

        ReportHook(owner()).onReport(_valuation);

        emit Reported(_valuation, _inOutDelta, _locked);
    }
}
