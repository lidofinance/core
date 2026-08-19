// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.9;

import {ITokenRatePusher} from "contracts/0.8.9/interfaces/ITokenRatePusher.sol";
import {ITokenRatePusherWithArgs} from "contracts/0.8.9/interfaces/ITokenRatePusherWithArgs.sol";

/// @notice An observer that claims BOTH pusher interfaces in `supportsInterface`. Used to verify
///         that `TokenRateNotifier.addObserver` registers it as `WithArgs` (priority rule).
contract TokenRatePusherDualSupport__Mock is ITokenRatePusher, ITokenRatePusherWithArgs {
    uint256 public legacyCallCount;
    uint256 public withArgsCallCount;
    uint256 public lastSharesMintedAsFees;

    event Mock__LegacyPushed();
    event Mock__WithArgsPushed(uint256 sharesMintedAsFees);

    function pushTokenRate() external override {
        legacyCallCount++;
        emit Mock__LegacyPushed();
    }

    function pushTokenRate(
        uint256 /* reportTimestamp     */,
        uint256 /* timeElapsed         */,
        uint256 /* preTotalShares      */,
        uint256 /* preTotalEther       */,
        uint256 /* postTotalShares     */,
        uint256 /* postTotalEther      */,
        uint256 sharesMintedAsFees_
    ) external override {
        withArgsCallCount++;
        lastSharesMintedAsFees = sharesMintedAsFees_;
        emit Mock__WithArgsPushed(sharesMintedAsFees_);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(ITokenRatePusher).interfaceId ||
            interfaceId == type(ITokenRatePusherWithArgs).interfaceId ||
            interfaceId == 0x01ffc9a7;
    }
}
