// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {StakingRouter} from "../StakingRouter.sol";
import {UnstructuredStorage} from "../lib/UnstructuredStorage.sol";

contract StakingRouterMock is StakingRouter {
    using UnstructuredStorage for bytes32;

    constructor(address _depositContract) StakingRouter(_depositContract) {
        CONTRACT_VERSION_POSITION.setStorageUint256(0);
    }

    function getStakingModuleIndexById(uint256 _stakingModuleId) external view returns (uint256) {
        return _getStakingModuleIndexById(_stakingModuleId);
    }

    function getStakingModuleByIndex(uint256 _stakingModuleIndex) external view returns (StakingModule memory) {
        return _getStakingModuleByIndex(_stakingModuleIndex);
    }
}
