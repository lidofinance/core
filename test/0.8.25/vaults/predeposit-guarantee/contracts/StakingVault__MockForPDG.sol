// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract StakingVault__MockForPDG {
    event Mock_depositToBeaconChain(address indexed _depositor, uint256 _depositCount, uint256 _totalDepositAmount);

    uint256 private constant WC_0X02_PREFIX = 0x02 << 248;

    address private nodeOperator_;
    address private owner_;
    bytes32 private withdrawalCredentials_;

    constructor(address _owner, address _nodeOperator) {
        owner_ = _owner;
        nodeOperator_ = _nodeOperator;
    }

    function totalValue() external view returns (uint256) {
        return address(this).balance;
    }

    function fund() external payable {}

    function setNodeOperator(address _nodeOperator) external {
        nodeOperator_ = _nodeOperator;
    }

    function setOwner(address _owner) external {
        owner_ = _owner;
    }

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

    function depositToBeaconChain(IStakingVault.Deposit[] calldata _deposits) external {
        uint256 totalDepositAmount = 0;
        for (uint256 i = 0; i < _deposits.length; i++) {
            totalDepositAmount += _deposits[i].amount;
        }

        emit Mock_depositToBeaconChain(msg.sender, _deposits.length, totalDepositAmount);
    }

    function mock__setWithdrawalCredentials(bytes32 _withdrawalCredentials) external {
        withdrawalCredentials_ = _withdrawalCredentials;
    }
}
