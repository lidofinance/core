// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract Burner__MockForMigration {
    uint256 public coverSharesBurnRequested;
    uint256 public nonCoverSharesBurnRequested;

    uint256 public totalCoverSharesBurnt;
    uint256 public totalNonCoverSharesBurnt;

    function setSharesRequestedToBurn(uint256 _coverShares, uint256 _nonCoverShares) external {
        coverSharesBurnRequested = _coverShares;
        nonCoverSharesBurnRequested = _nonCoverShares;
    }

    function setSharesBurnt(uint256 _coverSharesBurnt, uint256 _nonCoverSharesBurnt) external {
        totalCoverSharesBurnt = _coverSharesBurnt;
        totalNonCoverSharesBurnt = _nonCoverSharesBurnt;
    }

    function getCoverSharesBurnt() external view returns (uint256) {
        return totalCoverSharesBurnt;
    }

    function getNonCoverSharesBurnt() external view returns (uint256) {
        return totalNonCoverSharesBurnt;
    }

    function getSharesRequestedToBurn() external view returns (uint256 coverShares, uint256 nonCoverShares) {
        coverShares = coverSharesBurnRequested;
        nonCoverShares = nonCoverSharesBurnRequested;
    }
}
