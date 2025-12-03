// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

/**
 * @dev Only for testing purposes! Lido version with some functions exposed.
 */
contract Lido__MockForVaultHub {
    function approve(address, uint256) public pure returns (bool) {}

    function getTotalShares() public pure returns (uint256) {
        return 100000000000000000000000;
    }

    function getTotalPooledEther() public pure returns (uint256) {
        return 100000000000000000000000;
    }

    function getSharesByPooledEth(uint256 x) public pure returns (uint256) {
        return x;
    }

    function getPooledEthBySharesRoundUp(uint256 x) public pure returns (uint256) {
        return x;
    }

    function mintExternalShares(address to, uint256 amount) public {
        emit Mock__ExternalSharesMinted(to, amount);
    }

    function burnExternalShares(address from, uint256 amount) public {
        emit Mock__ExternalSharesBurnt(from, amount);
    }

    function rebalanceExternalEtherToInternal() public payable {
        emit Mock__RebalanceExternalEtherToInternal(msg.value);
    }

    event Mock__ExternalSharesMinted(address indexed to, uint256 amount);
    event Mock__ExternalSharesBurnt(address indexed from, uint256 amount);
    event Mock__RebalanceExternalEtherToInternal(uint256 amount);
}
