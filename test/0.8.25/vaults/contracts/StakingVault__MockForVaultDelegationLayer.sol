// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {OwnableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/OwnableUpgradeable.sol";

contract StakingVault__MockForVaultDelegationLayer is OwnableUpgradeable {
    address public constant vaultHub = address(0xABCD);

    function latestReport() public pure returns (IStakingVault.Report memory) {
        return IStakingVault.Report({valuation: 1 ether, inOutDelta: 0});
    }

    constructor() {
        _transferOwnership(msg.sender);
    }

    function initialize(address _owner) external {
        _transferOwnership(_owner);
    }
}
