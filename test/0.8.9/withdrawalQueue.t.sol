// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {StdAssertions} from "forge-std/StdAssertions.sol";
import {console2} from "forge-std/console2.sol";

import {WithdrawalQueueBase as WQBase} from "contracts/0.8.9/WithdrawalQueueBase.sol";

contract WQInvariants is Test {
    WQ public wq;
    WQHandler public handler;

    function setUp() public {
        wq = new WQ();
        handler = new WQHandler(wq);

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = WQHandler.request.selector;
        selectors[1] = WQHandler.finalize.selector;
        selectors[2] = WQHandler.claim.selector;

        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));

        targetContract(address(handler));
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_queueStETH() public view {
        uint256 lastRequestId = wq.getLastRequestId();
        uint256 naiveUnfinalizedStETH = handler.sumOfStETHInQueue(wq.getLastFinalizedRequestId() + 1, lastRequestId);

        assertEq(naiveUnfinalizedStETH, wq.unfinalizedStETH(), "cumulative stETH in queue is equal to sum of requests");
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_queueLength() public view {
        assertEq(wq.getLastRequestId(), handler.ghost_totalRequestNum(), "queue grows on request");
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_unfinalizedQueue() public view {
        assertEq(wq.getLastRequestId() - wq.getLastFinalizedRequestId(), wq.unfinalizedRequestNumber());
        assertLe(wq.unfinalizedRequestNumber(), handler.ghost_totalRequestNum());
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_lockedEthIsLessThanInQueue() public view {
        uint256 maxEthInTheQueue = handler.sumOfStETHInQueue(1, wq.getLastFinalizedRequestId());
        assertLe(
            wq.getLockedEtherAmount(),
            maxEthInTheQueue,
            "locked eth is less or equal than sum of stETH of finalized requests"
        );
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_lockedEthDecreasesOnClaim() public view {
        assertEq(
            wq.getLockedEtherAmount(),
            handler.ghost_totalLockedEth() - handler.ghost_totalClaimedEth(),
            "locked eth decreases on claim"
        );
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_totalLockedEthNaiveCheck() public view {
        assertLe(
            handler.ghost_totalLockedEth() - handler.naiveSumOfFinalizedRequestsEth(),
            wq.getLastFinalizedRequestId(),
            "total locked eth should be equal to sum of all finalized request in the queue"
        );
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 256
     * forge-config: default.invariant.depth = 256
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_requestCantBeClaimedAndNotFinalizedInTheSameTime() public view {
        uint256 lastId = wq.getLastRequestId();
        for (uint256 i = 1; i <= lastId; ++i) {
            WQBase.WithdrawalRequestStatus memory status = wq.status(i);

            assertFalse(status.isClaimed && !status.isFinalized, "can't be claimed but not finalized");
        }
    }
}

contract WQHandler is CommonBase, StdAssertions, StdUtils {
    WQ public wq;

    uint256 public ghost_totalRequestedEth;
    uint256 public ghost_totalRequestNum;
    uint256 public ghost_totalLockedEth;
    uint256 public ghost_totalClaimedEth;

    constructor(WQ _wq) {
        wq = _wq;
    }

    function request(uint256 amountOfStEth, uint256 amountOfShares) public {
        amountOfStEth = bound(amountOfStEth, 100, 1000 * 1e18);
        amountOfShares = bound(amountOfShares, 1, 1e7 * 1e18);

        wq.request(uint128(amountOfStEth), uint128(amountOfShares));

        ghost_totalRequestedEth += amountOfStEth;
        ghost_totalRequestNum += 1;
        wq.incrementRebaseTimestamp(); // TODO: make several requests in rebase
    }

    function finalize(uint256 maxShareRate, uint256 ethBudget) public {
        ethBudget = bound(ethBudget, 1, type(uint64).max); // todo: check real bounds
        maxShareRate = bound(maxShareRate, 0.0001 * 10 ** 27, 100 * 10 ** 27);

        uint256[] memory batches = calculateBatches(ethBudget, maxShareRate);

        if (batches.length > 0) {
            (uint256 eth, ) = wq.prefinalize(batches, maxShareRate);

            vm.deal(address(this), eth);
            wq.finalize{value: eth}(batches[batches.length - 1], maxShareRate);

            ghost_totalLockedEth += eth;

            console2.log("Ghost: %s", ghost_totalLockedEth);
            console2.log("Naive: %s", naiveSumOfFinalizedRequestsEth());
        }
    }

    function claim(uint256 requestId) public {
        if (wq.getLastFinalizedRequestId() > 0) {
            requestId = bound(requestId, 1, wq.getLastFinalizedRequestId());

            if (!wq.status(requestId).isClaimed) {
                uint256 hint = wq.checkpoint(requestId);
                ghost_totalClaimedEth += wq.claimableEth(requestId, hint);
                wq.claim(requestId, hint);
            }
        }
    }

    receive() external payable {}

    function calculateBatches(uint256 ethBudget, uint256 maxShareRate) public view returns (uint256[] memory batches) {
        uint256[36] memory emptyBatches;
        WQBase.BatchesCalculationState memory state = WQBase.BatchesCalculationState(ethBudget, false, emptyBatches, 0);
        while (!state.finished) {
            state = wq.calculateFinalizationBatches(maxShareRate, block.timestamp, 3, state);
        }

        batches = new uint256[](state.batchesLength);
        for (uint256 i; i < state.batchesLength; ++i) {
            batches[i] = state.batches[i];
        }
    }

    function sumOfStETHInQueue(uint256 start, uint256 end) public view returns (uint256 stETHSum) {
        for (uint256 i = start; i <= end; ++i) {
            stETHSum += wq.status(i).amountOfStETH;
        }
    }

    function naiveSumOfFinalizedRequestsEth() public view returns (uint256 sumOfEth) {
        uint256 lastId = wq.getLastRequestId();

        for (uint256 id = 1; id <= lastId; ++id) {
            WQBase.WithdrawalRequestStatus memory status = wq.status(id);

            if (status.isFinalized) {
                sumOfEth += wq.claimableEth(id, wq.checkpoint(id));
            }
        }
    }
}

contract WQ is WQBase {
    constructor() {
        _initializeQueue();
    }

    function request(uint128 amountOfStEth, uint128 amountOfShares) external {
        _enqueue(amountOfStEth, amountOfShares, msg.sender);
    }

    function finalize(uint256 _lastRequestIdToFinalize, uint256 _maxShareRate) external payable {
        _finalize(_lastRequestIdToFinalize, msg.value, _maxShareRate);
    }

    function claim(uint256 requestId, uint256 hint) external {
        _claim(requestId, hint, msg.sender);
    }

    function status(uint256 requestId) external view returns (WithdrawalRequestStatus memory) {
        return _getStatus(requestId);
    }

    function checkpoint(uint256 requestId) external view returns (uint256) {
        return _findCheckpointHint(requestId, 1, getLastCheckpointIndex());
    }

    function claimableEth(uint256 requestId, uint256 hint) external view returns (uint256) {
        return _calculateClaimableEther(_getQueue()[requestId], requestId, hint);
    }

    function incrementRebaseTimestamp() external {
        _setLastReportTimestamp(_getLastReportTimestamp() + 1);
    }
}
