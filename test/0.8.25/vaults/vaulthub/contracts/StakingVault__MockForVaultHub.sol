// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract StakingVault__MockForVaultHub {
    address public vaultHub;
    address public depositContract;

    address public owner;
    address public nodeOperator;
    address immutable DEPOSITOR;
    uint256 public $locked;
    uint256 public $valuation;
    int256 public $inOutDelta;
    bytes32 public $withdrawalCredentials;

    constructor(address _vaultHub, address _depositor, address _depositContract) {
        vaultHub = _vaultHub;
        depositContract = _depositContract;
        DEPOSITOR = _depositor;
        $withdrawalCredentials = bytes32((0x02 << 248) | uint160(address(this)));
    }

    function initialize(address _owner, address _nodeOperator, bytes calldata) external {
        owner = _owner;
        nodeOperator = _nodeOperator;
    }

    function lock(uint256 amount) external {
        $locked += amount;
    }

    function locked() external view returns (uint256) {
        return $locked;
    }

    function valuation() external view returns (uint256) {
        return $valuation;
    }

    function withdrawalCredentials() public view returns (bytes32) {
        return $withdrawalCredentials;
    }

    function mock__setWithdrawalCredentials(bytes32 _wc) external {
        $withdrawalCredentials = _wc;
    }

    function mock__setNo(address _no) external {
        nodeOperator = _no;
    }

    function inOutDelta() external view returns (int256) {
        return $inOutDelta;
    }

    function fund() external payable {
        $valuation += msg.value;
        $inOutDelta += int256(msg.value);
    }

    function withdraw(address, uint256 amount) external {
        $valuation -= amount;
        $inOutDelta -= int256(amount);
    }

    function report(uint256 _valuation, int256 _inOutDelta, uint256 _locked) external {
        $valuation = _valuation;
        $inOutDelta = _inOutDelta;
        $locked = _locked;
    }

    function depositor() external view returns (address) {
        return DEPOSITOR;
    }

    function triggerValidatorWithdrawal(
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable {
        if ($valuation > $locked) {
            revert Mock__HealthyVault();
        }

        emit ValidatorWithdrawalTriggered(_pubkeys, _amounts, _refundRecipient);
    }

    function mock__decreaseValuation(uint256 amount) external {
        $valuation -= amount;
    }

    function mock__increaseValuation(uint256 amount) external {
        $valuation += amount;
    }

    function depositToBeaconChain(IStakingVault.Deposit[] calldata _deposits) external {}

    event ValidatorWithdrawalTriggered(bytes pubkeys, uint64[] amounts, address refundRecipient);

    error Mock__HealthyVault();
}
