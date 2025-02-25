// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {IERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/IERC20.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {ISideloader} from "contracts/0.8.25/interfaces/ISideloader.sol";
import {StETH__MockForSideloading} from "./StETH__MockForSideloading.sol";
import {Swapper__Mock} from "./Swapper__Mock.sol";

// Dumb contract to test leverage
contract SwapperAdapter__MockForSideloading is ISideloader {
    event Mock__Received(address _sender, uint256 _amount);
    event Mock__Sideloaded(address _vault, address _sideloader, uint256 _amountOfShares, bytes _data);

    error InvalidSideloader();
    error SwapFailed();

    address public steth;
    address public swapper;

    bool public onSideloadShouldReturnIncorrectHash = false;

    constructor(address _steth, address _swapper) {
        steth = _steth;
        swapper = _swapper;
    }

    receive() external payable {
        emit Mock__Received(msg.sender, msg.value);
    }

    function makeHookReturnIncorrectHash() external {
        onSideloadShouldReturnIncorrectHash = true;
    }

    function onSideload(
        address _vault,
        address _sideloader,
        uint256 _amountOfShares,
        bytes calldata _data
    ) external returns (bytes32) {
        if (_sideloader != address(this)) revert InvalidSideloader();

        uint256 stethAmount = StETH__MockForSideloading(steth).getPooledEthByShares(_amountOfShares);

        IERC20(steth).approve(swapper, stethAmount);
        bool success = Swapper__Mock(swapper).swap(stethAmount);

        if (!success) revert SwapFailed();

        IStakingVault(_vault).fund{value: address(this).balance}();

        emit Mock__Sideloaded(_vault, _sideloader, _amountOfShares, _data);

        return onSideloadShouldReturnIncorrectHash ? keccak256("Incorrect") : keccak256("Sideloader.onSideload");
    }
}
