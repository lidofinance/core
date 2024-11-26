// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {Test} from "forge-std/Test.sol";

import {PositiveTokenRebaseLimiter, TokenRebaseLimiterData} from "contracts/0.8.9/lib/PositiveTokenRebaseLimiter.sol";

contract PositiveTokenRebaseLimiterTest is Test {
    PositiveTokenRebaseLimiter__Harness public rebaseLimiter;

    // general purpose fuzz test constants
    uint256 private constant MAX_PROJECTED_ETH = 200_000_000 * 1 ether;
    uint256 private constant MAX_SHARE_RATE_COEF = 1_000;
    uint256 private constant MIN_PROTOCOL_ETH = 1 ether;

    // constants for `getSharesToBurnLimit` fuzz cases
    uint256 private constant MAX_ETHER_DECREASE_COEF = 1e3;
    uint256 private constant REBASE_COMPARISON_TOLERANCE = 1e5;
    uint256 private constant SHARE_RATE_PRECISION = 1e27;

    function setUp() public {
        rebaseLimiter = new PositiveTokenRebaseLimiter__Harness();
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 65536
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_initLimiterStateTooLowLimit(TokenRebaseLimiterData calldata _fuzzData) external {
        vm.expectRevert(PositiveTokenRebaseLimiter.TooLowTokenRebaseLimit.selector);
        rebaseLimiter.initLimiterState(0, _fuzzData.preTotalPooledEther, _fuzzData.preTotalShares);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 65536
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_initLimiterTooHighLimit(TokenRebaseLimiterData calldata _fuzzData) external {
        uint256 rebaseLimit = bound(
            _fuzzData.positiveRebaseLimit,
            PositiveTokenRebaseLimiter.UNLIMITED_REBASE + 1,
            type(uint256).max
        );

        vm.expectRevert(PositiveTokenRebaseLimiter.TooHighTokenRebaseLimit.selector);
        rebaseLimiter.initLimiterState(rebaseLimit, _fuzzData.preTotalPooledEther, _fuzzData.preTotalShares);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 65536
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_initLimiterState(TokenRebaseLimiterData calldata _fuzzData) external {
        uint256 rebaseLimit = bound(_fuzzData.positiveRebaseLimit, 1, PositiveTokenRebaseLimiter.UNLIMITED_REBASE);
        uint256 preTotalPooledEther = bound(_fuzzData.preTotalPooledEther, 0, MAX_PROJECTED_ETH);
        uint256 preTotalShares = bound(_fuzzData.preTotalShares, 0, MAX_PROJECTED_ETH);

        rebaseLimiter.initLimiterState(rebaseLimit, preTotalPooledEther, preTotalShares);

        TokenRebaseLimiterData memory data = rebaseLimiter.getData__harness();

        assertEq(data.preTotalPooledEther, preTotalPooledEther);
        assertEq(data.preTotalShares, preTotalShares);
        assertEq(data.currentTotalPooledEther, preTotalPooledEther);

        if (preTotalPooledEther == 0) {
            assertEq(data.positiveRebaseLimit, PositiveTokenRebaseLimiter.UNLIMITED_REBASE);
        }

        if (data.positiveRebaseLimit != PositiveTokenRebaseLimiter.UNLIMITED_REBASE) {
            assertTrue(preTotalPooledEther != 0);
            assertEq(data.positiveRebaseLimit, rebaseLimit);
            assertEq(
                data.maxTotalPooledEther,
                preTotalPooledEther +
                    (preTotalPooledEther * rebaseLimit) /
                    PositiveTokenRebaseLimiter.LIMITER_PRECISION_BASE
            );
        } else {
            assertEq(data.positiveRebaseLimit, PositiveTokenRebaseLimiter.UNLIMITED_REBASE);
            assertEq(data.maxTotalPooledEther, type(uint256).max);
        }
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 65536
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_isLimitReached(TokenRebaseLimiterData calldata _fuzzData) external {
        rebaseLimiter.setData__harness(_fuzzData);

        bool isLimitReached = rebaseLimiter.isLimitReached();
        if (_fuzzData.currentTotalPooledEther >= _fuzzData.maxTotalPooledEther) {
            assertTrue(isLimitReached);
        } else {
            assertFalse(isLimitReached);
        }
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 65536
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_decreaseEtherUnlimited(TokenRebaseLimiterData memory _fuzzData, uint256 _etherAmount) external {
        _fuzzData.positiveRebaseLimit = PositiveTokenRebaseLimiter.UNLIMITED_REBASE;
        rebaseLimiter.setData__harness(_fuzzData);

        rebaseLimiter.decreaseEther(_etherAmount);

        TokenRebaseLimiterData memory data = rebaseLimiter.getData__harness();

        // hasn't been changed
        assertEq(data.currentTotalPooledEther, _fuzzData.currentTotalPooledEther);
        assertEq(data.positiveRebaseLimit, PositiveTokenRebaseLimiter.UNLIMITED_REBASE);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 65536
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_decreaseEther(TokenRebaseLimiterData memory _fuzzData, uint256 _etherAmount) external {
        _fuzzData.positiveRebaseLimit = bound(
            _fuzzData.positiveRebaseLimit,
            1,
            PositiveTokenRebaseLimiter.UNLIMITED_REBASE - 1
        );
        _fuzzData.currentTotalPooledEther = bound(_fuzzData.currentTotalPooledEther, 0, MAX_PROJECTED_ETH);
        rebaseLimiter.setData__harness(_fuzzData);

        _etherAmount = bound(_etherAmount, 0, MAX_PROJECTED_ETH);

        if (_etherAmount > _fuzzData.currentTotalPooledEther) {
            vm.expectRevert(PositiveTokenRebaseLimiter.NegativeTotalPooledEther.selector);
            rebaseLimiter.decreaseEther(_etherAmount);
        } else {
            rebaseLimiter.decreaseEther(_etherAmount);
            TokenRebaseLimiterData memory data = rebaseLimiter.getData__harness();

            assertEq(data.currentTotalPooledEther, _fuzzData.currentTotalPooledEther - _etherAmount);
            assertEq(data.positiveRebaseLimit, _fuzzData.positiveRebaseLimit);
        }
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 65536
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_increaseEtherUnlimited(TokenRebaseLimiterData memory _fuzzData, uint256 _etherAmount) external {
        _fuzzData.positiveRebaseLimit = PositiveTokenRebaseLimiter.UNLIMITED_REBASE;
        rebaseLimiter.setData__harness(_fuzzData);

        rebaseLimiter.increaseEther(_etherAmount);

        TokenRebaseLimiterData memory data = rebaseLimiter.getData__harness();

        assertEq(data.positiveRebaseLimit, PositiveTokenRebaseLimiter.UNLIMITED_REBASE);
        // values haven't been changed
        assertEq(data.currentTotalPooledEther, _fuzzData.currentTotalPooledEther);
        assertEq(data.maxTotalPooledEther, _fuzzData.maxTotalPooledEther);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 65536
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_increaseEther(TokenRebaseLimiterData memory _fuzzData, uint256 _etherAmount) external {
        _fuzzData.positiveRebaseLimit = bound(
            _fuzzData.positiveRebaseLimit,
            1,
            PositiveTokenRebaseLimiter.UNLIMITED_REBASE - 1
        );
        _fuzzData.maxTotalPooledEther = bound(_fuzzData.maxTotalPooledEther, 0, MAX_PROJECTED_ETH);
        _fuzzData.currentTotalPooledEther = bound(_fuzzData.currentTotalPooledEther, 0, _fuzzData.maxTotalPooledEther);

        rebaseLimiter.setData__harness(_fuzzData);

        _etherAmount = bound(_etherAmount, 0, MAX_PROJECTED_ETH);

        uint256 consumed = rebaseLimiter.increaseEther(_etherAmount);
        TokenRebaseLimiterData memory data = rebaseLimiter.getData__harness();

        assertLe(data.currentTotalPooledEther, data.maxTotalPooledEther);

        if ((_fuzzData.currentTotalPooledEther + _etherAmount) <= _fuzzData.maxTotalPooledEther) {
            assertEq(consumed, _etherAmount);
            if ((_fuzzData.currentTotalPooledEther + _etherAmount) == _fuzzData.maxTotalPooledEther) {
                assertEq(data.currentTotalPooledEther, data.maxTotalPooledEther);
            }
        } else {
            uint256 overlimit = (_fuzzData.currentTotalPooledEther + _etherAmount) - _fuzzData.maxTotalPooledEther;
            assertEq(consumed, _etherAmount - overlimit);
        }
        assertEq(data.maxTotalPooledEther, _fuzzData.maxTotalPooledEther);
        assertEq(data.positiveRebaseLimit, _fuzzData.positiveRebaseLimit);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 65536
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_getSharesToBurnLimitUnlimited(TokenRebaseLimiterData memory _fuzzData) external {
        _fuzzData.positiveRebaseLimit = PositiveTokenRebaseLimiter.UNLIMITED_REBASE;
        rebaseLimiter.setData__harness(_fuzzData);

        uint256 sharesToBurnLimit = rebaseLimiter.getSharesToBurnLimit();

        assertEq(sharesToBurnLimit, _fuzzData.preTotalShares);
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 65536
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_getSharesToBurnLimitZeroTVL(TokenRebaseLimiterData memory _fuzzData) external {
        _fuzzData.positiveRebaseLimit = bound(
            _fuzzData.positiveRebaseLimit,
            1,
            PositiveTokenRebaseLimiter.UNLIMITED_REBASE - 1
        );
        _fuzzData.preTotalPooledEther = 0;
        rebaseLimiter.setData__harness(_fuzzData);

        if (!rebaseLimiter.isLimitReached()) {
            vm.expectRevert();
            rebaseLimiter.getSharesToBurnLimit();
        }
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-fuzz-configs
     * forge-config: default.fuzz.runs = 65536
     * forge-config: default.fuzz.max-test-rejects = 0
     */
    function testFuzz_getSharesToBurnLimit(TokenRebaseLimiterData memory _fuzzData) external {
        /**
         * Review: As PositiveTokenRebaseLimiter uses a limited precision for calculation (only 1e9),
         * data boundaries should be reasonable and tight to meet the requirements
         *
         * The data boundaries might be extended in future versions of the lib by usins the ray math internally (1e27)
         */

        _fuzzData.preTotalPooledEther = bound(_fuzzData.preTotalPooledEther, MIN_PROTOCOL_ETH, MAX_PROJECTED_ETH);
        _fuzzData.preTotalShares = bound(
            _fuzzData.preTotalShares,
            _fuzzData.preTotalPooledEther / MAX_SHARE_RATE_COEF,
            _fuzzData.preTotalPooledEther * MAX_SHARE_RATE_COEF
        );
        _fuzzData.positiveRebaseLimit = bound(
            _fuzzData.positiveRebaseLimit,
            1,
            PositiveTokenRebaseLimiter.LIMITER_PRECISION_BASE
        );

        rebaseLimiter.initLimiterState(
            _fuzzData.positiveRebaseLimit,
            _fuzzData.preTotalPooledEther,
            _fuzzData.preTotalShares
        );

        TokenRebaseLimiterData memory initializedData = rebaseLimiter.getData__harness();

        initializedData.currentTotalPooledEther = bound(
            _fuzzData.currentTotalPooledEther,
            _fuzzData.preTotalPooledEther / MAX_ETHER_DECREASE_COEF, // x1000 drop at max
            MAX_PROJECTED_ETH
        );

        rebaseLimiter.setData__harness(initializedData);

        uint256 sharesToBurnLimit = rebaseLimiter.getSharesToBurnLimit();

        if (initializedData.currentTotalPooledEther >= initializedData.maxTotalPooledEther) {
            assertEq(sharesToBurnLimit, 0);
        } else {
            assertLt(sharesToBurnLimit, _fuzzData.preTotalShares);

            uint256 oldShareRate = (_fuzzData.preTotalPooledEther * SHARE_RATE_PRECISION) / _fuzzData.preTotalShares;
            uint256 newShareRate = (initializedData.currentTotalPooledEther * SHARE_RATE_PRECISION) /
                (_fuzzData.preTotalShares - sharesToBurnLimit);

            uint256 rebase = (((newShareRate - oldShareRate) * PositiveTokenRebaseLimiter.LIMITER_PRECISION_BASE) /
                oldShareRate);

            // 0.1 BP difference at max
            assertApproxEqAbs(
                rebase,
                initializedData.positiveRebaseLimit,
                PositiveTokenRebaseLimiter.LIMITER_PRECISION_BASE / REBASE_COMPARISON_TOLERANCE
            );
        }
    }
}

contract PositiveTokenRebaseLimiter__Harness {
    using PositiveTokenRebaseLimiter for TokenRebaseLimiterData;

    TokenRebaseLimiterData trlData;

    event DataSet(
        uint256 preTotalPooledEther,
        uint256 preTotalShares,
        uint256 currentTotalPooledEther,
        uint256 positiveRebaseLimit,
        uint256 maxTotalPooledEther
    );
    event LimiterStateInitialized(uint256 rebaseLimit, uint256 preTotalPooledEther, uint256 preTotalShares);
    event EtherDecreased(uint256 etherAmount);
    event EtherIncreased(uint256 etherAmount);

    function getData__harness() external view returns (TokenRebaseLimiterData memory) {
        return trlData;
    }

    function setData__harness(TokenRebaseLimiterData calldata _data) external {
        trlData = _data;

        emit DataSet(
            _data.preTotalPooledEther,
            _data.preTotalShares,
            _data.currentTotalPooledEther,
            _data.positiveRebaseLimit,
            _data.maxTotalPooledEther
        );
    }

    function initLimiterState(uint256 _rebaseLimit, uint256 _preTotalPooledEther, uint256 _preTotalShares) external {
        trlData = PositiveTokenRebaseLimiter.initLimiterState(_rebaseLimit, _preTotalPooledEther, _preTotalShares);

        emit LimiterStateInitialized(_rebaseLimit, _preTotalPooledEther, _preTotalShares);
    }

    function isLimitReached() external view returns (bool) {
        return trlData.isLimitReached();
    }

    function decreaseEther(uint256 _etherAmount) external {
        TokenRebaseLimiterData memory data = trlData;
        data.decreaseEther(_etherAmount);
        trlData = data;

        emit EtherDecreased(_etherAmount);
    }

    function increaseEther(uint256 _etherAmount) external returns (uint256 consumed) {
        TokenRebaseLimiterData memory data = trlData;
        consumed = data.increaseEther(_etherAmount);
        trlData = data;

        emit EtherIncreased(_etherAmount);
    }

    function getSharesToBurnLimit() external view returns (uint256 maxSharesToBurn) {
        return trlData.getSharesToBurnLimit();
    }
}
