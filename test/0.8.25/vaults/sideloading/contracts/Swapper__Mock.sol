// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {IERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/IERC20.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {ISideloader} from "contracts/0.8.25/interfaces/ISideloader.sol";

// Dumb contract to test leverage
contract Swapper__Mock {
    address public steth;
    uint256 public swapRatio = 1 ether;

    event Mock__Swapped(address _vault, address _sideloader, uint256 _amountOfShares, bytes _data);

    constructor(address _steth) {
        steth = _steth;
    }

    function setSwapRatio(uint256 _swapRatio) external {
        swapRatio = _swapRatio;
    }

    function swap(uint256 _amountOfSteth) external returns (bool) {
        IERC20(steth).transferFrom(msg.sender, address(this), _amountOfSteth);

        (bool success, ) = msg.sender.call{value: (_amountOfSteth * swapRatio) / 1e18}("");
        require(success, "Swap failed");

        return true;
    }
}
