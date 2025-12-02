// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/Ownable2StepUpgradeable.sol";

contract StakingVault__MockForVaultHub is Ownable2StepUpgradeable {
    address public depositContract;

    address public nodeOperator;
    address public depositor;
    bool public beaconChainDepositsPaused;

    bytes32 public withdrawalCredentials;

    constructor(address _depositContract) {
        depositContract = _depositContract;
        withdrawalCredentials = bytes32((0x02 << 248) | uint160(address(this)));
    }

    function initialize(address _owner, address _nodeOperator, address _depositor) external initializer {
        __Ownable_init(_owner);
        __Ownable2Step_init();
        nodeOperator = _nodeOperator;
        depositor = _depositor;
    }

    function mock__setWithdrawalCredentials(bytes32 _wc) external {
        withdrawalCredentials = _wc;
    }

    function mock__setNo(address _no) external {
        nodeOperator = _no;
    }

    function fund() external payable {
        emit Mock__Funded();
    }

    function withdraw(address recipient, uint256 amount) external {
        payable(recipient).transfer(amount);
        emit Mock__Withdrawn(recipient, amount);
    }

    function isOssified() external pure returns (bool) {
        return false;
    }

    function triggerValidatorWithdrawals(
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable {
        emit ValidatorWithdrawalsTriggered(_pubkeys, _amounts, _refundRecipient);
    }

    function depositToBeaconChain(IStakingVault.Deposit[] calldata _deposits) external {}

    function requestValidatorExit(bytes calldata _pubkeys) external {
        emit Mock__ValidatorExitRequested(_pubkeys);
    }

    function ossified() external pure returns (bool) {
        return false;
    }

    function pauseBeaconChainDeposits() external {
        beaconChainDepositsPaused = true;
        emit Mock__BeaconChainDepositsPaused();
    }

    function resumeBeaconChainDeposits() external {
        beaconChainDepositsPaused = false;
        emit Mock__BeaconChainDepositsResumed();
    }

    function collectERC20(address _token, address _recipient, uint256 _amount) external {
        emit Mock_Collected(_token, _recipient, _amount);
    }

    function availableBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function stagedBalance() external view returns (uint256) {}

    event ValidatorWithdrawalsTriggered(bytes pubkeys, uint64[] amounts, address refundRecipient);

    // Mock events for VaultHub forwarding operations
    event Mock__Funded();
    event Mock__Withdrawn(address recipient, uint256 amount);
    event Mock__BeaconChainDepositsPaused();
    event Mock__BeaconChainDepositsResumed();
    event Mock__ValidatorExitRequested(bytes pubkeys);
    event Mock_Collected(address token, address recipient, uint256 amount);

    error Mock__HealthyVault();
}
