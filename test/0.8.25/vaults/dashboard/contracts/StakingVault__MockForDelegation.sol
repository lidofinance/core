// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {Ownable} from "@openzeppelin/contracts-v5.2/access/Ownable.sol";

contract StakingVault__MockForDelegation is Ownable {
    constructor(address _owner, address _depositor, address _vaultHub) Ownable(_owner) {
        _transferOwnership(_depositor);
    }
}
