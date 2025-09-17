// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {IDepositContract} from "contracts/common/interfaces/IDepositContract.sol";

contract StakingVault__MockForPDG is IStakingVault {
    event Mock_depositToBeaconChain(address indexed _depositor, uint256 _totalDepositAmount);
    event Mock_depositFromStaged(address indexed _depositor, uint256 _totalDepositAmount);

    uint256 private constant WC_0X02_PREFIX = 0x02 << 248;

    address private nodeOperator_;
    address private owner_;
    address private depositor_;
    bytes32 private withdrawalCredentials_;

    uint256 staged;

    constructor(address _owner, address _nodeOperator, address _depositor) {
        owner_ = _owner;
        nodeOperator_ = _nodeOperator;
        depositor_ = _depositor;
    }

    receive() external payable {}

    function fund() external payable {}

    function withdrawalCredentials() public view returns (bytes32) {
        return
            withdrawalCredentials_ == bytes32(0)
                ? bytes32(WC_0X02_PREFIX | uint160(address(this)))
                : withdrawalCredentials_;
    }

    function nodeOperator() external view returns (address) {
        return nodeOperator_;
    }

    function owner() external view returns (address) {
        return owner_;
    }

    function depositToBeaconChain(Deposit calldata _deposit) external override {
        emit Mock_depositToBeaconChain(msg.sender, _deposit.amount);
    }

    function mock__setWithdrawalCredentials(bytes32 _withdrawalCredentials) external {
        withdrawalCredentials_ = _withdrawalCredentials;
    }

    function DEPOSIT_CONTRACT() external view override returns (IDepositContract) {}

    function initialize(address _owner, address _nodeOperator, address _depositor) external override {}

    function version() external pure override returns (uint64) {}

    function getInitializedVersion() external view override returns (uint64) {}

    function pendingOwner() external view override returns (address) {}

    function acceptOwnership() external override {}

    function transferOwnership(address _newOwner) external override {}

    function depositor() external view override returns (address) {
        return depositor_;
    }

    function calculateValidatorWithdrawalFee(uint256 _keysCount) external view override returns (uint256) {}

    function withdraw(address _recipient, uint256 _ether) external override {}

    function beaconChainDepositsPaused() external view override returns (bool) {}

    function pauseBeaconChainDeposits() external override {}

    function resumeBeaconChainDeposits() external override {}

    function requestValidatorExit(bytes calldata _pubkeys) external override {}

    function triggerValidatorWithdrawals(
        bytes calldata _pubkeys,
        uint64[] calldata _amountsInGwei,
        address _refundRecipient
    ) external payable override {}

    function ejectValidators(bytes calldata _pubkeys, address _refundRecipient) external payable override {}

    function setDepositor(address _depositor) external override {}

    function ossify() external override {}

    function collectERC20(address _token, address _recipient, uint256 _amount) external override {}

    function availableBalance() external view override returns (uint256) {
        return address(this).balance;
    }

    function stagedBalance() external view override returns (uint256) {
        return staged;
    }

    function stage(uint256 _ether) external override {
        staged += _ether;
    }

    function unstage(uint256 _ether) external override {
        staged -= _ether;
    }

    function depositFromStaged(Deposit calldata _deposit, uint256) external override {
        emit Mock_depositFromStaged(msg.sender, _deposit.amount);
    }
}
