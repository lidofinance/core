// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

contract PostTokenRebaseReceiver__MockForLidoHandleOracleReport {
    event Mock__PostTokenRebaseHandled();

    function handlePostTokenRebase(
        uint256 _reportTimestamp,
        uint256 _timeElapsed,
        uint256 _preTotalShares,
        uint256 _preTotalEther,
        uint256 _postTotalShares,
        uint256 _postTotalEther,
        uint256 _sharesMintedAsFees
    ) external {
        emit Mock__PostTokenRebaseHandled();
    }
}
