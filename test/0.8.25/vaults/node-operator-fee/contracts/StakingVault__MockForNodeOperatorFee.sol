// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract StakingVault__MockForNodeOperatorFee {
    event Mock__Withdrawn(address indexed _sender, address indexed _recipient, uint256 _amount);

    address public immutable vaultHub;
    uint256 public locked;

    constructor(address _vaultHub) {
        vaultHub = _vaultHub;
    }

    function withdraw(address _recipient, uint256 _amount) external {
        emit Mock__Withdrawn(msg.sender, _recipient, _amount);
    }
}
