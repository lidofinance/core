// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract Burner__MockForSanityChecker {
    uint256 private nonCover;
    uint256 private cover;

    function getSharesRequestedToBurn() external view returns (uint256 coverShares, uint256 nonCoverShares) {
        coverShares = cover;
        nonCoverShares = nonCover;
    }

    function setSharesRequestedToBurn(uint256 _cover, uint256 _nonCover) external {
        cover = _cover;
        nonCover = _nonCover;
    }
}
