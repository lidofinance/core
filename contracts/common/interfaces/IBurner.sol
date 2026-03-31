// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line
pragma solidity >=0.4.24 <0.9.0;


interface IBurner {
    function REQUEST_BURN_MY_STETH_ROLE() external view returns (bytes32);
    function REQUEST_BURN_SHARES_ROLE() external view returns (bytes32);

    /**
     * Commit cover/non-cover burning requests and logs cover/non-cover shares amount just burnt.
     *
     * NB: The real burn enactment to be invoked after the call (via internal Lido._burnShares())
     */
    function commitSharesToBurn(uint256 _sharesToBurn) external;

    /**
     * Request burn shares
     */
    function requestBurnShares(address _from, uint256 _sharesAmountToBurn) external;

    function requestBurnMyShares(uint256 _sharesAmountToBurn) external;

    /**
     * Request burn shares for redeem (isolated track, burned outside the rebase limiter)
     */
    function requestBurnSharesForRedeem(address _from, uint256 _sharesAmountToBurn) external;

    /**
     * Commit all pending redeem shares to burn. No budget argument — always burns everything.
     */
    function commitRedeemSharesToBurn() external;

    /**
     * Returns the current amount of redeem shares locked on the contract to be burnt.
     */
    function getRedeemSharesRequestedToBurn() external view returns (uint256);

    /**
     * Returns the total redeem shares ever burnt.
     */
    function getRedeemSharesBurnt() external view returns (uint256);

    /**
      * Returns the current amount of shares locked on the contract to be burnt.
      */
    function getSharesRequestedToBurn() external view returns (uint256 coverShares, uint256 nonCoverShares);

    /**
      * Returns the total cover shares ever burnt.
      */
    function getCoverSharesBurnt() external view returns (uint256);

    /**
      * Returns the total non-cover shares ever burnt.
      */
    function getNonCoverSharesBurnt() external view returns (uint256);
}
