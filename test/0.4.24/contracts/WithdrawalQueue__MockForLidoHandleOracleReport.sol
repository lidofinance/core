// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

contract WithdrawalQueue__MockForLidoHandleOracleReport {
    event WithdrawalsFinalized(
        uint256 indexed from,
        uint256 indexed to,
        uint256 amountOfETHLocked,
        uint256 sharesToBurn,
        uint256 timestamp
    );

    bool public isPaused;

    uint256 private ethToLock_;
    uint256 private sharesToBurn_;

    function prefinalize(
        uint256[] _batches,
        uint256 _maxShareRate
    ) external view returns (uint256 ethToLock, uint256 sharesToBurn) {
        // listing params to avoid unused variable error
        _batches;
        _maxShareRate;

        ethToLock = ethToLock_;
        sharesToBurn = sharesToBurn_;
    }

    function finalize(uint256 _lastRequestIdToBeFinalized, uint256 _maxShareRate) external payable {
        _maxShareRate;

        // some random fake event values
        uint256 firstRequestIdToFinalize = 0;
        uint256 sharesToBurn = msg.value;

        emit WithdrawalsFinalized(
            firstRequestIdToFinalize,
            _lastRequestIdToBeFinalized,
            msg.value,
            sharesToBurn,
            block.timestamp
        );
    }

    function mock__isPaused(bool paused) external {
        isPaused = paused;
    }

    function mock__prefinalizeReturn(uint256 _ethToLock, uint256 _sharesToBurn) external {
        ethToLock_ = _ethToLock;
        sharesToBurn_ = _sharesToBurn;
    }
}
