// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/AccessControlEnumerable.sol";

import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";
import {IRefSlotStore} from "contracts/common/interfaces/IRefSlotStore.sol";

import {_getCurrentRefSlot, RefSlotCache} from "./vaults/lib/RefSlotCache.sol";

/**
 * @title RefSlotStore
 * @author Lido
 * @notice Generic key-value store that auto-snapshots uint104 values at oracle frame boundaries
 */
contract RefSlotStore is IRefSlotStore, AccessControlEnumerable {
    using RefSlotCache for RefSlotCache.Uint104WithCache;

    bytes32 public constant WRITER_ROLE = keccak256("RefSlotStore.WriterRole");

    IHashConsensus public immutable HASH_CONSENSUS;

    mapping(bytes32 => RefSlotCache.Uint104WithCache) private _slots;

    event ValueSet(bytes32 indexed slot, uint104 value, uint104 valueOnRefSlot, uint48 refSlot);
    event ValueReset(bytes32 indexed slot);

    error ZeroHashConsensus();

    /**
     * @param _hashConsensus HashConsensus used to resolve the current refSlot
     * @param _admin address to be granted DEFAULT_ADMIN_ROLE
     */
    constructor(address _hashConsensus, address _admin) {
        if (_hashConsensus == address(0)) revert ZeroHashConsensus();
        HASH_CONSENSUS = IHashConsensus(_hashConsensus);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /**
     * @notice Sets `_slot` to `_value`; auto-snapshots the pre-image at frame boundaries. Writer-only.
     */
    function set(bytes32 _slot, uint104 _value) external onlyRole(WRITER_ROLE) {
        RefSlotCache.Uint104WithCache memory cache = _slots[_slot];
        uint256 refSlot = _getCurrentRefSlot(HASH_CONSENSUS);

        if (cache.refSlot != uint48(refSlot)) {
            cache.valueOnRefSlot = cache.value;
            cache.refSlot = uint48(refSlot);
        }

        cache.value = _value;
        _slots[_slot] = cache;

        emit ValueSet(_slot, cache.value, cache.valueOnRefSlot, cache.refSlot);
    }

    /// @notice Returns the current live value of `_slot`
    function getValue(bytes32 _slot) external view returns (uint256) {
        return _slots[_slot].value;
    }

    /// @notice Returns the value of `_slot` as of the last oracle frame boundary
    function getSnapshotValue(bytes32 _slot) external view returns (uint256) {
        return _slots[_slot].getValueForLastRefSlot(HASH_CONSENSUS);
    }

    /// @notice Zeroes `_slot` (value + snapshot). Writer-only.
    function reset(bytes32 _slot) external onlyRole(WRITER_ROLE) {
        _slots[_slot] = RefSlotCache.Uint104WithCache(0, 0, 0);

        emit ValueReset(_slot);
    }
}
