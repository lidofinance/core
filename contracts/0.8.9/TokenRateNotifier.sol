// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

import {Ownable} from "@openzeppelin/contracts-v4.4/access/Ownable.sol";
import {ERC165Checker} from "@openzeppelin/contracts-v4.4/utils/introspection/ERC165Checker.sol";
import {ITokenRatePusher} from "./interfaces/ITokenRatePusher.sol";
import {ITokenRatePusherWithArgs} from "./interfaces/ITokenRatePusherWithArgs.sol";
import {IPostTokenRebaseReceiver} from "./interfaces/IPostTokenRebaseReceiver.sol";


/// @author kovalgek
/// @notice Notifies all `observers` when rebase event occurs.
/// @dev Observers are kept in a single registry tagged with their kind:
///      - Legacy observers implement `ITokenRatePusher` and are notified via `pushTokenRate()`;
///      - WithArgs observers implement `ITokenRatePusherWithArgs` and are notified via
///        `pushTokenRate(...)` with the full per-rebase payload forwarded from
///        `handlePostTokenRebase` (mirrors `IPostTokenRebaseReceiver` 1:1).
contract TokenRateNotifier is Ownable, IPostTokenRebaseReceiver {
    using ERC165Checker for address;

    /// @notice Distinguishes the two notification flavors an observer can subscribe to.
    enum ObserverKind { Legacy, WithArgs }

    /// @notice A single observer entry: the contract address and its notification kind.
    /// @dev `addr` (20 bytes) and `kind` (1 byte) pack into a single 32-byte storage slot.
    struct Observer {
        address addr;
        ObserverKind kind;
    }

    /// @notice Address of lido core protocol accounting contract that is allowed to call handlePostTokenRebase.
    address public immutable TOKEN_RATE_PROVIDER;

    /// @notice Maximum total amount of observers (across both kinds) to be supported.
    uint256 public constant MAX_OBSERVERS_COUNT = 32;

    /// @notice A value that indicates that value was not found.
    uint256 public constant INDEX_NOT_FOUND = type(uint256).max;

    /// @notice An interface that each legacy observer should support.
    bytes4 public constant REQUIRED_INTERFACE = type(ITokenRatePusher).interfaceId;

    /// @notice An interface that each args-bearing observer should support.
    bytes4 public constant REQUIRED_INTERFACE_WITH_ARGS = type(ITokenRatePusherWithArgs).interfaceId;

    /// @notice All observers, in insertion order. Mixed kinds; an address may appear at most once.
    Observer[] public observers;

    /// @param initialOwner_ initial owner
    /// @param tokenRateProvider_ Address of token rate provider contract that is allowed to call handlePostTokenRebase.
    constructor(address initialOwner_, address tokenRateProvider_) {
        if (initialOwner_ == address(0)) {
            revert ErrorZeroAddressOwner();
        }
        if (tokenRateProvider_ == address(0)) {
            revert ErrorZeroAddressTokenRateProvider();
        }
        _transferOwnership(initialOwner_);
        TOKEN_RATE_PROVIDER = tokenRateProvider_;
    }

    /// @notice Register an observer. The notification flavor is auto-detected from the observer's
    ///         `supportsInterface` declaration: if it claims `REQUIRED_INTERFACE_WITH_ARGS` it is
    ///         registered as `WithArgs` (and notified with the full rebase payload); otherwise it
    ///         must claim `REQUIRED_INTERFACE` and is registered as `Legacy` (no-arg notification).
    /// @dev If the observer claims BOTH interfaces, `WithArgs` wins (richer payload). Observers
    ///      that want the legacy flavor must NOT declare support for `ITokenRatePusherWithArgs`.
    /// @param observer_ observer address
    function addObserver(address observer_) external onlyOwner {
        if (observer_ == address(0)) {
            revert ErrorZeroAddressObserver();
        }

        ObserverKind kind_;
        if (observer_.supportsInterface(REQUIRED_INTERFACE_WITH_ARGS)) {
            kind_ = ObserverKind.WithArgs;
        } else if (observer_.supportsInterface(REQUIRED_INTERFACE)) {
            kind_ = ObserverKind.Legacy;
        } else {
            revert ErrorBadObserverInterface();
        }

        if (observers.length >= MAX_OBSERVERS_COUNT) {
            revert ErrorMaxObserversCountExceeded();
        }
        if (_observerIndex(observer_) != INDEX_NOT_FOUND) {
            revert ErrorAddExistedObserver();
        }

        observers.push(Observer({addr: observer_, kind: kind_}));
        emit ObserverAdded(observer_, kind_);
    }

    /// @notice Remove an observer (of any kind) by address.
    /// @param observer_ observer address to remove
    function removeObserver(address observer_) external onlyOwner {
        uint256 indexToRemove = _observerIndex(observer_);
        if (indexToRemove == INDEX_NOT_FOUND) {
            revert ErrorNoObserverToRemove();
        }
        ObserverKind removedKind = observers[indexToRemove].kind;
        uint256 lastIndex = observers.length - 1;
        if (indexToRemove != lastIndex) {
            observers[indexToRemove] = observers[lastIndex];
        }
        observers.pop();
        emit ObserverRemoved(observer_, removedKind);
    }

    /// @inheritdoc IPostTokenRebaseReceiver
    /// @dev Legacy observers receive no parameters because they fetch all required data on their
    ///      own (e.g. read `wstETH.stEthPerToken()` directly). Args-bearing observers receive the
    ///      full rebase payload forwarded as-is, so they can consume per-rebase values
    ///      (notably `_sharesMintedAsFees`) without back-deriving them from rate deltas.
    ///      Allowed to be called by the token rate provider only.
    function handlePostTokenRebase(
        uint256 _reportTimestamp,
        uint256 _timeElapsed,
        uint256 _preTotalShares,
        uint256 _preTotalEther,
        uint256 _postTotalShares,
        uint256 _postTotalEther,
        uint256 _sharesMintedAsFees
    ) external {
        if (msg.sender != TOKEN_RATE_PROVIDER) {
            revert ErrorNotAuthorizedRebaseCaller();
        }

        uint256 observersLength_ = observers.length;
        for (uint256 obIndex = 0; obIndex < observersLength_; obIndex++) {
            Observer storage entry = observers[obIndex];
            address observerAddr = entry.addr;
            if (entry.kind == ObserverKind.Legacy) {
                // solhint-disable-next-line no-empty-blocks
                try ITokenRatePusher(observerAddr).pushTokenRate() {}
                catch (bytes memory lowLevelRevertData) {
                    _handlePushFailure(observerAddr, lowLevelRevertData);
                }
            } else {
                // ObserverKind.WithArgs
                // solhint-disable-next-line no-empty-blocks
                try ITokenRatePusherWithArgs(observerAddr).pushTokenRate(
                    _reportTimestamp,
                    _timeElapsed,
                    _preTotalShares,
                    _preTotalEther,
                    _postTotalShares,
                    _postTotalEther,
                    _sharesMintedAsFees
                ) {}
                catch (bytes memory lowLevelRevertData) {
                    _handlePushFailure(observerAddr, lowLevelRevertData);
                }
            }
        }
    }

    /// @notice Total observer count (across both kinds).
    /// @return Added `observers` count
    function observersLength() external view returns (uint256) {
        return observers.length;
    }

    /// @dev Handles a failed observer notification: bubbles up empty-data reverts (assumed
    ///      "out of gas") to keep gas estimation correct, otherwise emits `PushTokenRateFailed`.
    ///      This check is required to prevent incorrect gas estimation of the method. Without it,
    ///      Ethereum nodes that use binary search for gas estimation may return an invalid value
    ///      when the pushTokenRate() reverts because of the "out of gas" error. Here we assume that
    ///      the pushTokenRate() method doesn't have reverts with empty error data except "out of gas".
    function _handlePushFailure(address observer_, bytes memory lowLevelRevertData_) internal {
        if (lowLevelRevertData_.length == 0) revert ErrorTokenRateNotifierRevertedWithNoData();
        emit PushTokenRateFailed(observer_, lowLevelRevertData_);
    }

    /// @notice `observer_` index in `observers` (regardless of kind).
    /// @return An index of `observer_` or `INDEX_NOT_FOUND` if it wasn't found.
    function _observerIndex(address observer_) internal view returns (uint256) {
        uint256 length_ = observers.length;
        for (uint256 obIndex = 0; obIndex < length_; obIndex++) {
            if (observers[obIndex].addr == observer_) {
                return obIndex;
            }
        }
        return INDEX_NOT_FOUND;
    }

    event PushTokenRateFailed(address indexed observer, bytes lowLevelRevertData);
    event ObserverAdded(address indexed observer, ObserverKind kind);
    event ObserverRemoved(address indexed observer, ObserverKind kind);

    error ErrorTokenRateNotifierRevertedWithNoData();
    error ErrorZeroAddressObserver();
    error ErrorBadObserverInterface();
    error ErrorMaxObserversCountExceeded();
    error ErrorNoObserverToRemove();
    error ErrorZeroAddressOwner();
    error ErrorZeroAddressTokenRateProvider();
    error ErrorNotAuthorizedRebaseCaller();
    error ErrorAddExistedObserver();
}
