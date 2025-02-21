// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {ERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/ERC20.sol";

contract StETH__MockForSideloading is ERC20 {
    event Mock__ExternalSharesMinted(address indexed to, uint256 amount);

    constructor() ERC20("Staked Ether", "stETH") {
        _mint(msg.sender, 1_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function mintExternalShares(address to, uint256 amount) external {
        _mint(to, amount);

        emit Mock__ExternalSharesMinted(to, amount);
    }

    // for simplicity, 1 share = 1 steth
    function getPooledEthByShares(uint256 shares) external view returns (uint256) {
        return shares;
    }

    // for simplicity, 1 steth = 1 share
    function getSharesByPooledEth(uint256 pooledEth) external view returns (uint256) {
        return pooledEth;
    }

    function getTotalShares() external view returns (uint256) {
        return totalSupply();
    }
}
