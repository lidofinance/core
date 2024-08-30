// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {UnstructuredStorage} from "contracts/0.8.9/lib/UnstructuredStorage.sol";
import {BaseOracle} from "contracts/0.8.9/oracle/BaseOracle.sol";

contract BaseOracle__Harness is BaseOracle {
    using UnstructuredStorage for bytes32;
    uint256 internal _time = 2513040315;

    event MockStartProcessingResult(uint256 prevProcessingRefSlot);

    struct HandleConsensusReportLastCall {
        BaseOracle.ConsensusReport report;
        uint256 prevSubmittedRefSlot;
        uint256 prevProcessingRefSlot;
        uint256 callCount;
    }

    HandleConsensusReportLastCall internal _handleConsensusReportLastCall;
    BaseOracle.ConsensusReport public lastDiscardedReport;

    constructor(uint256 secondsPerSlot, uint256 genesisTime, address admin) BaseOracle(secondsPerSlot, genesisTime) {
        _setupRole(DEFAULT_ADMIN_ROLE, admin);
        CONTRACT_VERSION_POSITION.setStorageUint256(0);
        require(genesisTime <= _time, "GENESIS_TIME_CANNOT_BE_MORE_THAN_MOCK_TIME");
    }

    function initialize(address consensusContract, uint256 consensusVersion, uint256 lastProcessingRefSlot) external {
        _initialize(consensusContract, consensusVersion, lastProcessingRefSlot);
    }

    function _getTime() internal view override returns (uint256) {
        return _time;
    }

    function getTime() external view returns (uint256) {
        return _time;
    }

    function harness_getTime() external view returns (uint256) {
        return BaseOracle._getTime();
    }

    function setTime(uint256 newTime) external {
        _time = newTime;
    }

    function advanceTimeBy(uint256 timeAdvance) external {
        _time += timeAdvance;
    }

    function _handleConsensusReport(
        BaseOracle.ConsensusReport memory report,
        uint256 prevSubmittedRefSlot,
        uint256 prevProcessingRefSlot
    ) internal virtual override {
        _handleConsensusReportLastCall.report = report;
        _handleConsensusReportLastCall.prevSubmittedRefSlot = prevSubmittedRefSlot;
        _handleConsensusReportLastCall.prevProcessingRefSlot = prevProcessingRefSlot;
        ++_handleConsensusReportLastCall.callCount;
    }

    function _handleConsensusReportDiscarded(BaseOracle.ConsensusReport memory report) internal override {
        lastDiscardedReport = report;
    }

    function getConsensusReportLastCall() external view returns (HandleConsensusReportLastCall memory) {
        return _handleConsensusReportLastCall;
    }

    function startProcessing() external {
        uint256 _res = _startProcessing();
        emit MockStartProcessingResult(_res);
    }

    function isConsensusMember(address addr) external view returns (bool) {
        return _isConsensusMember(addr);
    }

    function getCurrentRefSlot() external view returns (uint256) {
        return _getCurrentRefSlot();
    }

    function checkConsensusData(uint256 refSlot, uint256 consensusVersion, bytes32 hash) external view {
        _checkConsensusData(refSlot, consensusVersion, hash);
    }

    function checkProcessingDeadline() external view {
        _checkProcessingDeadline();
    }
}
