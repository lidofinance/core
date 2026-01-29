// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract AccountingOracle__MockForLidoFastLane {
    uint256 currentFrameRefSlot;
    bool mainDataSubmitted;
    bool extraDataSubmitted;

    constructor() {
        currentFrameRefSlot = 0;
        mainDataSubmitted = false;
        extraDataSubmitted = false;
    }

    struct ProcessingState {
        uint256 currentFrameRefSlot;
        uint256 processingDeadlineTime;
        bytes32 mainDataHash;
        bool mainDataSubmitted;
        bytes32 extraDataHash;
        uint256 extraDataFormat;
        bool extraDataSubmitted;
        uint256 extraDataItemsCount;
        uint256 extraDataItemsSubmitted;
    }

    function getProcessingState() external view returns (ProcessingState memory result) {
        result.currentFrameRefSlot = currentFrameRefSlot;
        result.mainDataSubmitted = mainDataSubmitted;
        result.extraDataSubmitted = extraDataSubmitted;
    }

    function mock_setProcessingState(uint256 _refSlot, bool _mainDataSubmitted, bool _extraDataSubmitted) external {
        currentFrameRefSlot = _refSlot;
        mainDataSubmitted = _mainDataSubmitted;
        extraDataSubmitted = _extraDataSubmitted;
    }
}
