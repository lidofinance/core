// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract StakingVault__MockForVaultHub {
    address public depositContract;

    address public owner;
    address public nodeOperator;
    address public depositor_;

    bytes32 public withdrawalCredentials;

    constructor(address _depositContract) {
        depositContract = _depositContract;
        withdrawalCredentials = bytes32((0x02 << 248) | uint160(address(this)));
    }

    function initialize(address _owner, address _nodeOperator, address _depositor) external {
        owner = _owner;
        nodeOperator = _nodeOperator;
        depositor_ = _depositor;
    }

    function mock__setWithdrawalCredentials(bytes32 _wc) external {
        withdrawalCredentials = _wc;
    }

    function mock__setNo(address _no) external {
        nodeOperator = _no;
    }

    function fund() external payable {}

    function withdraw(address, uint256 amount) external {}

    function depositor() external view returns (address) {
        return depositor_;
    }

    function triggerValidatorWithdrawals(
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable {
        emit ValidatorWithdrawalTriggered(_pubkeys, _amounts, _refundRecipient);
    }

    function depositToBeaconChain(IStakingVault.Deposit[] calldata _deposits) external {}

    function ossified() external pure returns (bool) {
        return false;
    }

    event ValidatorWithdrawalTriggered(bytes pubkeys, uint64[] amounts, address refundRecipient);

    error Mock__HealthyVault();
}
