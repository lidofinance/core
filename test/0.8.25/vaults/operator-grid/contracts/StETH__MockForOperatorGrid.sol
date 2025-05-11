// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {ERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/ERC20.sol";

contract StETH__MockForOperatorGrid is ERC20 {
    constructor() ERC20("Staked Ether", "stETH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function transferSharesFrom(address from, address to, uint256 amount) external returns (uint256) {
        _transfer(from, to, amount);
        return amount;
    }

    function getTotalShares() external pure returns (uint256) {
        return 1000 * 10 ** 18;
    }
}
