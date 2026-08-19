// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.9;

import {ITokenRatePusherWithArgs} from "contracts/0.8.9/interfaces/ITokenRatePusherWithArgs.sol";

/// @notice ITokenRatePusherWithArgs implementer that records the full rebase payload it received.
contract TokenRatePusherWithArgs__Mock is ITokenRatePusherWithArgs {
    struct ReceivedArgs {
        uint256 reportTimestamp;
        uint256 timeElapsed;
        uint256 preTotalShares;
        uint256 preTotalEther;
        uint256 postTotalShares;
        uint256 postTotalEther;
        uint256 sharesMintedAsFees;
    }

    ReceivedArgs public lastReceived;
    uint256 public pushCount;
    bool public shouldRevertWithData;
    bool public shouldRevertWithoutData;

    event Mock__Pushed(
        uint256 reportTimestamp,
        uint256 timeElapsed,
        uint256 preTotalShares,
        uint256 preTotalEther,
        uint256 postTotalShares,
        uint256 postTotalEther,
        uint256 sharesMintedAsFees
    );

    function setShouldRevertWithData(bool value) external {
        shouldRevertWithData = value;
    }

    function setShouldRevertWithoutData(bool value) external {
        shouldRevertWithoutData = value;
    }

    function pushTokenRate(
        uint256 reportTimestamp_,
        uint256 timeElapsed_,
        uint256 preTotalShares_,
        uint256 preTotalEther_,
        uint256 postTotalShares_,
        uint256 postTotalEther_,
        uint256 sharesMintedAsFees_
    ) external override {
        if (shouldRevertWithoutData) {
            // empty-data revert; the notifier treats this as OOG
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(0, 0)
            }
        }
        if (shouldRevertWithData) {
            revert("withArgs push failed");
        }
        lastReceived = ReceivedArgs({
            reportTimestamp: reportTimestamp_,
            timeElapsed: timeElapsed_,
            preTotalShares: preTotalShares_,
            preTotalEther: preTotalEther_,
            postTotalShares: postTotalShares_,
            postTotalEther: postTotalEther_,
            sharesMintedAsFees: sharesMintedAsFees_
        });
        pushCount++;
        emit Mock__Pushed(
            reportTimestamp_,
            timeElapsed_,
            preTotalShares_,
            preTotalEther_,
            postTotalShares_,
            postTotalEther_,
            sharesMintedAsFees_
        );
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(ITokenRatePusherWithArgs).interfaceId || interfaceId == 0x01ffc9a7;
    }
}
