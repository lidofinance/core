// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {Ownable} from "@openzeppelin/contracts-v5.2/access/Ownable.sol";

contract StakingVault__MockForPermissions is Ownable {
    event MockFunded(address sender, uint256 amount);
    event MockWithdrawn(address sender, address recipient, uint256 amount);
    event MockRebalanced(address sender, uint256 amount);
    event MockPausedBeaconChainDeposits(address sender);
    event MockResumedBeaconChainDeposits(address sender);
    event MockValidatorExitRequested(address sender, bytes pubkeys);
    event MockValidatorWithdrawalTriggered(
        bytes pubkeys,
        uint64[] amounts,
        address refundRecipient,
        address sender,
        uint256 value
    );

    address public immutable depositor;
    address public immutable vaultHub;

    constructor(address _owner, address _depositor, address _vaultHub) Ownable(_owner) {
        depositor = _depositor;
        vaultHub = _vaultHub;
    }

    function fund() public payable onlyOwner {
        emit MockFunded(msg.sender, msg.value);
    }

    function withdraw(address _recipient, uint256 _ether) public onlyOwner {
        emit MockWithdrawn(msg.sender, _recipient, _ether);
    }

    function rebalance(uint256 _ether) public onlyOwner {
        emit MockRebalanced(msg.sender, _ether);
    }

    function pauseBeaconChainDeposits() public onlyOwner {
        emit MockPausedBeaconChainDeposits(msg.sender);
    }

    function resumeBeaconChainDeposits() public onlyOwner {
        emit MockResumedBeaconChainDeposits(msg.sender);
    }

    function requestValidatorExit(bytes calldata _pubkeys) public onlyOwner {
        emit MockValidatorExitRequested(msg.sender, _pubkeys);
    }

    function triggerValidatorWithdrawal(
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) public payable onlyOwner {
        emit MockValidatorWithdrawalTriggered(_pubkeys, _amounts, _refundRecipient, msg.sender, msg.value);
    }
}
