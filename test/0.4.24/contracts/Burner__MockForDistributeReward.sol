// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

contract Burner__MockForDistributeReward {
    event StETHBurnRequested(
        bool indexed isCover,
        address indexed requestedBy,
        uint256 amountOfStETH,
        uint256 amountOfShares
    );

    event Mock__CommitSharesToBurnWasCalled();

    function requestBurnShares(address, uint256 _sharesAmountToBurn) external {
        // imitating share to steth rate 1:2
        uint256 _stETHAmount = _sharesAmountToBurn * 2;
        emit StETHBurnRequested(false, msg.sender, _stETHAmount, _sharesAmountToBurn);
    }

    function commitSharesToBurn(uint256 _sharesToBurn) external {
        _sharesToBurn;

        emit Mock__CommitSharesToBurnWasCalled();
    }
}
