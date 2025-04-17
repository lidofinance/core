// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import {IStakingVault, StakingVaultDeposit} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract StakingVault__MockForVaultHub {
    address public immutable VAULT_HUB;
    address public depositContract;

    address public owner;
    address public nodeOperator;
    address public depositor_;
    bool public vaultHubAuthorized;

    uint256 public $locked;
    uint256 public $totalValue;
    int256 public $inOutDelta;
    uint64 public $timestamp;

    bytes32 public withdrawalCredentials;

    constructor(address _vaultHub, address _depositContract) {
        VAULT_HUB = _vaultHub;
        depositContract = _depositContract;
        withdrawalCredentials = bytes32((0x02 << 248) | uint160(address(this)));
    }

    function initialize(address _owner, address _nodeOperator, address _depositor, bytes calldata) external {
        owner = _owner;
        nodeOperator = _nodeOperator;
        depositor_ = _depositor;
    }

    function vaultHub() external view returns (address) {
        return VAULT_HUB;
    }

    function lock(uint256 amount) external {
        $locked += amount;
    }

    function locked() external view returns (uint256) {
        return $locked;
    }

    function totalValue() external view returns (uint256) {
        return $totalValue;
    }

    function mock__setWithdrawalCredentials(bytes32 _wc) external {
        withdrawalCredentials = _wc;
    }

    function mock__setNo(address _no) external {
        nodeOperator = _no;
    }

    function inOutDelta() external view returns (int256) {
        return $inOutDelta;
    }

    function fund() external payable {
        $totalValue += msg.value;
        $inOutDelta += int256(msg.value);
    }

    function withdraw(address, uint256 amount) external {
        $totalValue -= amount;
        $inOutDelta -= int256(amount);
    }

    function report(uint64 _timestamp, uint256 _totalValue, int256 _inOutDelta, uint256 _locked) external {
        $timestamp = _timestamp;
        $totalValue = _totalValue;
        $inOutDelta = _inOutDelta;
        $locked = _locked;
    }

    function depositor() external view returns (address) {
        return depositor_;
    }

    function triggerValidatorWithdrawal(
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable {
        if ($totalValue > $locked) {
            revert Mock__HealthyVault();
        }

        emit ValidatorWithdrawalTriggered(_pubkeys, _amounts, _refundRecipient);
    }

    function mock__decreaseTotalValue(uint256 amount) external {
        $totalValue -= amount;
    }

    function mock__increaseTotalValue(uint256 amount) external {
        $totalValue += amount;
    }

    function depositToBeaconChain(StakingVaultDeposit[] calldata _deposits) external {}

    function ossified() external pure returns (bool) {
        return false;
    }

    function authorizeLidoVaultHub() external {
        vaultHubAuthorized = true;
    }

    function deauthorizeLidoVaultHub() external {
        vaultHubAuthorized = false;
    }

    function isReportFresh() external pure returns (bool) {
        return true;
    }

    event ValidatorWithdrawalTriggered(bytes pubkeys, uint64[] amounts, address refundRecipient);

    error Mock__HealthyVault();
}
