// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// solhint-disable-next-line
pragma solidity >=0.8.9 <0.9.0;

/// @notice Deposit state
struct DepositState {
    uint64 lastNonce;
    uint96 settledAmount;
    uint96 unsettledAmount;
}

library DepositStatePacking {
    function pack(uint64 lastNonce, uint96 settledAmount, uint96 unsettledAmount)
        internal
        pure
        returns (uint256 statePacked)
    {
        return (uint256(lastNonce) << 192) | (uint256(settledAmount) << 96) | uint256(unsettledAmount);
    }

    function pack(DepositState storage state, uint64 lastNonce, uint96 settledAmount, uint96 unsettledAmount) internal {
        save(state, pack(lastNonce, settledAmount, unsettledAmount));
    }

    function unpack(uint256 statePacked)
        internal
        pure
        returns (uint64 lastNonce, uint96 settledAmount, uint96 unsettledAmount)
    {
        lastNonce = uint64(statePacked >> 192);
        settledAmount = uint96(statePacked >> 96);
        unsettledAmount = uint96(statePacked);
    }

    function unpack(DepositState storage state)
        internal
        view
        returns (uint64 lastNonce, uint96 settledAmount, uint96 unsettledAmount)
    {
        return unpack(load(state));
    }

    function load(DepositState storage state) internal view returns (uint256 statePacked) {
        assembly {
            statePacked := sload(state.slot)
        }
    }

    function save(DepositState storage state, uint256 statePacked) internal {
        assembly {
            sstore(state.slot, statePacked)
        }
    }
}

/// @notice library for tracking deposits for some period of time
library DepositsTracker {
    using DepositStatePacking for uint256;
    using DepositStatePacking for DepositState;

    error InvalidNonce();

    /**
     *   @dev `nonce` is the current frame number after last report and provided by external source.
     *        If an external source changes the logic for calculating the nonce in such a way that
     *        it becomes smaller than the value saved before the `recycle` operation, all methods will be reverted.
     *
     * Lifetime flow diagram:
     *
     *    timeline: -|--R0-D1--D2-|-D3-R1--D4-|--D5---|-------|--R2--D6---|---...
     *    nonce:        ->0           1->0        1     2       3->0
     *
     *  nonce: current number (ID#) of frame after some report
     *  D1, D2, ... - deposit events
     *  R1, R2, ... - reports
     *
     * Assume start from scratch (or at some report R0) and there are no deposits yet.
     * D1:track - nonce = 0, settled = 0, unsettled = D1
     * D2:track - nonce = 0, settled = 0, unsettled = D1+D2
     * D3:track - nonce = 1, settled = D1+D2, unsettled = D3 (nonce is changed, sync)
     * R1:sync - nonce = 1, settled = D1+D2, unsettled = D3 (nonce is the same, so no sync)
     * R1:recycle - nonce = 0, settled = 0, unsettled = D3, (returns prev settled amount D1+D2 as deposited in prev period)
     * D4:track - nonce = 0, settled = 0, unsettled = D3+D4
     * D5:track - nonce = 1, settled = D3+D4, unsettled = D5 (nonce is changed, sync)
     * R2:sync - nonce = 3, settled = D3+D4+D5, unsettled = 0 (nonce is changed, sync)
     * R2:recycle - nonce = 0, settled = 0, unsettled = 0, (returns prev settled amount D3+D4+D5 as deposited in prev period)
     * D6:track - nonce = 0, settled = 0, unsettled = D6
     * ...
     */

    function track(DepositState storage state, uint64 curNonce, uint96 amount) internal {
        (uint96 settledAmount, uint96 unsettledAmount) = _unpackAndSync(state, curNonce);
        unsettledAmount += amount;
        state.pack(curNonce, settledAmount, unsettledAmount);
    }

    function recycle(DepositState storage state, uint64 curNonce) internal returns (uint96) {
        (uint96 settledAmount, uint96 unsettledAmount) = _unpackAndSync(state, curNonce);
        // resetting nonce and move unsettled amount to settled
        state.pack(0, 0, unsettledAmount);
        // state.pack(0, unsettledAmount, 0);
        return settledAmount;
        return settledAmount;
    }

    function get(DepositState storage state, uint64 curNonce)
        internal
        view
        returns (uint96 settledAmount, uint96 unsettledAmount)
    {
        return _unpackAndSync(state, curNonce);
    }

    function _unpackAndSync(DepositState storage state, uint64 curNonce)
        private
        view
        returns (uint96 settledAmount, uint96 unsettledAmount)
    {
        uint64 lastNonce;
        (lastNonce, settledAmount, unsettledAmount) = state.unpack();
        /// @dev require only an increase of the nonce
        if (curNonce < lastNonce) revert InvalidNonce();

        if (lastNonce != curNonce) {
            // all unsettled amount is belong to previous curNonce, so merge it into settled
            settledAmount += unsettledAmount;
            unsettledAmount = 0;
        }
    }
}
