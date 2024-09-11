// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// taken from https://github.com/lidofinance/lido-l2-with-steth/blob/780c0af4e4a517258a8ca2756fd84c9492582dac/contracts/lido/TokenRateNotifier.sol

pragma solidity 0.8.9;

import {Ownable} from "@openzeppelin/contracts-v4.4/access/Ownable.sol";
import {ERC165Checker} from "@openzeppelin/contracts-v4.4/utils/introspection/ERC165Checker.sol";
import {ITokenRatePusher} from "./interfaces/ITokenRatePusher.sol";
import {IPostTokenRebaseReceiver} from "./interfaces/IPostTokenRebaseReceiver.sol";

/// @author kovalgek
/// @notice Notifies all `observers` when rebase event occurs.
contract TokenRateNotifier is Ownable, IPostTokenRebaseReceiver {
    using ERC165Checker for address;

    /// @notice Address of lido core protocol contract that is allowed to call handlePostTokenRebase.
    address public immutable LIDO;

    /// @notice Maximum amount of observers to be supported.
    uint256 public constant MAX_OBSERVERS_COUNT = 32;

    /// @notice A value that indicates that value was not found.
    uint256 public constant INDEX_NOT_FOUND = type(uint256).max;

    /// @notice An interface that each observer should support.
    bytes4 public constant REQUIRED_INTERFACE = type(ITokenRatePusher).interfaceId;

    /// @notice All observers.
    address[] public observers;

    /// @param initialOwner_ initial owner
    /// @param lido_ Address of lido core protocol contract that is allowed to call handlePostTokenRebase.
    constructor(address initialOwner_, address lido_) {
        if (initialOwner_ == address(0)) {
            revert ErrorZeroAddressOwner();
        }
        if (lido_ == address(0)) {
            revert ErrorZeroAddressLido();
        }
        _transferOwnership(initialOwner_);
        LIDO = lido_;
    }

    /// @notice Add a `observer_` to the back of array
    /// @param observer_ observer address
    function addObserver(address observer_) external onlyOwner {
        if (observer_ == address(0)) {
            revert ErrorZeroAddressObserver();
        }
        if (!observer_.supportsInterface(REQUIRED_INTERFACE)) {
            revert ErrorBadObserverInterface();
        }
        if (observers.length >= MAX_OBSERVERS_COUNT) {
            revert ErrorMaxObserversCountExceeded();
        }
        if (_observerIndex(observer_) != INDEX_NOT_FOUND) {
            revert ErrorAddExistedObserver();
        }

        observers.push(observer_);
        emit ObserverAdded(observer_);
    }

    /// @notice Remove a observer at the given `observer_` position
    /// @param observer_ observer remove position
    function removeObserver(address observer_) external onlyOwner {
        uint256 observerIndexToRemove = _observerIndex(observer_);

        if (observerIndexToRemove == INDEX_NOT_FOUND) {
            revert ErrorNoObserverToRemove();
        }
        if (observerIndexToRemove != observers.length - 1) {
            observers[observerIndexToRemove] = observers[observers.length - 1];
        }
        observers.pop();

        emit ObserverRemoved(observer_);
    }

    /// @inheritdoc IPostTokenRebaseReceiver
    /// @dev Parameters aren't used because all required data further components fetch by themselves.
    ///      Allowed to called by Lido contract. See Lido._completeTokenRebase.
    function handlePostTokenRebase(
        uint256, /* reportTimestamp    */
        uint256, /* timeElapsed        */
        uint256, /* preTotalShares     */
        uint256, /* preTotalEther      */
        uint256, /* postTotalShares    */
        uint256, /* postTotalEther     */
        uint256  /* sharesMintedAsFees */
    ) external {
        if (msg.sender != LIDO) {
            revert ErrorNotAuthorizedRebaseCaller();
        }

        uint256 cachedObserversLength = observers.length;
        for (uint256 obIndex = 0; obIndex < cachedObserversLength; obIndex++) {
            // solhint-disable-next-line no-empty-blocks
            try ITokenRatePusher(observers[obIndex]).pushTokenRate() {}
            catch (bytes memory lowLevelRevertData) {
                /// @dev This check is required to prevent incorrect gas estimation of the method.
                ///      Without it, Ethereum nodes that use binary search for gas estimation may
                ///      return an invalid value when the pushTokenRate() reverts because of the
                ///      "out of gas" error. Here we assume that the pushTokenRate() method doesn't
                ///      have reverts with empty error data except "out of gas".
                if (lowLevelRevertData.length == 0) revert ErrorTokenRateNotifierRevertedWithNoData();
                emit PushTokenRateFailed(
                    observers[obIndex],
                    lowLevelRevertData
                );
            }
        }
    }

    /// @notice Observer length
    /// @return Added `observers` count
    function observersLength() external view returns (uint256) {
        return observers.length;
    }

    /// @notice `observer_` index in `observers` array.
    /// @return An index of `observer_` or `INDEX_NOT_FOUND` if it wasn't found.
    function _observerIndex(address observer_) internal view returns (uint256) {
        uint256 cachedObserversLength = observers.length;
        for (uint256 obIndex = 0; obIndex < cachedObserversLength; obIndex++) {
            if (observers[obIndex] == observer_) {
                return obIndex;
            }
        }
        return INDEX_NOT_FOUND;
    }

    event PushTokenRateFailed(address indexed observer, bytes lowLevelRevertData);
    event ObserverAdded(address indexed observer);
    event ObserverRemoved(address indexed observer);

    error ErrorTokenRateNotifierRevertedWithNoData();
    error ErrorZeroAddressObserver();
    error ErrorBadObserverInterface();
    error ErrorMaxObserversCountExceeded();
    error ErrorNoObserverToRemove();
    error ErrorZeroAddressOwner();
    error ErrorZeroAddressLido();
    error ErrorNotAuthorizedRebaseCaller();
    error ErrorAddExistedObserver();
}
