// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import "@openzeppelin/contracts-v5.2/token/ERC20/ERC20.sol";

// for simplicity, 1 share = 1 steth
contract StETH__MockForVaultHub is ERC20 {
    uint256 public totalShares = 0;

    constructor(uint256 _initialSupply) ERC20("StETH", "STETH") {
        mint(msg.sender, _initialSupply);
    }

    function mint(address to, uint256 amount) public {
        _mint(to, amount);
        totalShares += amount;
    }

    function burn(address from, uint256 amount) public {
        _burn(from, amount);
        totalShares -= amount;
    }

    function getTotalShares() external view returns (uint256) {
        return totalShares;
    }

    function setTotalShares(uint256 _totalShares) external {
        totalShares = _totalShares;
    }

    event Mock__ExternalSharesMinted(address indexed to, uint256 amount);
    event Mock__ExternalSharesBurned(address indexed from, uint256 amount);

    uint256 shareRate = 1 ether;

    function setShareRate(uint256 _shareRate) external {
        shareRate = _shareRate;
    }

    function mintExternalShares(address to, uint256 amount) external {
        uint256 tokens = getPooledEthBySharesRoundUp(amount);
        _mint(to, tokens);

        emit Mock__ExternalSharesMinted(to, amount);
    }

    function transferSharesFrom(address from, address to, uint256 amount) external returns (uint256) {
        _transfer(from, to, amount);
        return amount;
    }

    function burnExternalShares(uint256 amount) external {
        _burn(msg.sender, amount);

        emit Mock__ExternalSharesBurned(msg.sender, amount);
    }

    function getPooledEthByShares(uint256 shares) public view returns (uint256) {
        return (shares * shareRate) / 1 ether;
    }

    function getPooledEthBySharesRoundUp(uint256 shares) public view returns (uint256) {
        uint256 pooledEth = (shares * shareRate) / 1 ether;

        if ((pooledEth * 1 ether) / shareRate != shares) {
            return pooledEth + 1;
        }

        return pooledEth;
    }

    function getSharesByPooledEth(uint256 pooledEth) external view returns (uint256) {
        return (pooledEth * 1 ether) / shareRate;
    }
}
