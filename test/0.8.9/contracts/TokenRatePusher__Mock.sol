// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.9;

import {ITokenRatePusher} from "contracts/0.8.9/interfaces/ITokenRatePusher.sol";

/// @notice No-arg ITokenRatePusher implementer used in TokenRateNotifier tests.
contract TokenRatePusher__Mock is ITokenRatePusher {
    uint256 public pushCount;
    bool public shouldRevertWithData;
    bool public shouldRevertWithoutData;

    event Mock__Pushed();

    function setShouldRevertWithData(bool value) external {
        shouldRevertWithData = value;
    }

    function setShouldRevertWithoutData(bool value) external {
        shouldRevertWithoutData = value;
    }

    function pushTokenRate() external override {
        if (shouldRevertWithoutData) {
            // empty-data revert; the notifier treats this as OOG
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(0, 0)
            }
        }
        if (shouldRevertWithData) {
            revert("no-arg push failed");
        }
        pushCount++;
        emit Mock__Pushed();
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        // 0x01ffc9a7 — ERC165 itself; required by OZ ERC165Checker.
        return interfaceId == type(ITokenRatePusher).interfaceId || interfaceId == 0x01ffc9a7;
    }
}
