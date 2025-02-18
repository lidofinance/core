// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {IERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/IERC20.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

// Dumb contract to test leverage
contract VaultFunder__MockForFlashMinter {
    function fundVault(address _vault, uint256 _amount) external returns (bool) {
        IStakingVault(_vault).fund{value: _amount}();

        return true;
    }
}
