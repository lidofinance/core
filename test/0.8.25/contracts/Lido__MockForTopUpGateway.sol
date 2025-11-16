// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

contract Lido__MockForTopUpGateway {
    event TopUpCalled(
        uint256 stakingModuleId,
        uint256[] keyIndices,
        uint256[] operatorIds,
        bytes pubkeysPacked,
        uint256[] topUpLimitsGwei
    );

    uint256 public topUpCalls;

    function topUp(
        uint256 _stakingModuleId,
        uint256[] calldata _keyIndices,
        uint256[] calldata _operatorIds,
        bytes calldata _pubkeysPacked,
        uint256[] calldata _topUpLimitsGwei
    ) external {
        unchecked {
            ++topUpCalls;
        }

        emit TopUpCalled(_stakingModuleId, _keyIndices, _operatorIds, _pubkeysPacked, _topUpLimitsGwei);
    }
}
