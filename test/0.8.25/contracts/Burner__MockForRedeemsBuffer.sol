// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

contract Burner__MockForRedeemsBuffer {
    event RequestBurnSharesCalled(address from, uint256 sharesAmount);

    function requestBurnShares(address _from, uint256 _sharesAmount) external {
        emit RequestBurnSharesCalled(_from, _sharesAmount);
    }
}
