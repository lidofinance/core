// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// for testing purposes only

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {AccessControlEnumerable} from "../utils/access/AccessControlEnumerable.sol";
import {IStakingModule} from "../interfaces/IStakingModule.sol";
import {StakingRouter} from "../StakingRouter.sol";
import "../../common/interfaces/ILidoLocator.sol";

interface IStakingRouter {
    function getStakingModule(uint256 _stakingModuleId) external view returns (StakingRouter.StakingModule memory);
}

interface IValidatorsExitBusOracle {
    function submitPriorityReportData(bytes32 reportHash, uint256 requestsCount) external;
}

contract Prover is AccessControlEnumerable {

  ILidoLocator internal immutable LOCATOR;
  IValidatorsExitBusOracle internal immutable ORACLE;
  uint256 public immutable STAKING_MODULE_ID;

  constructor(address _lidoLocator, address _oracle, uint256 _stakingModuleId) {
    LOCATOR = ILidoLocator(_lidoLocator);
    ORACLE = IValidatorsExitBusOracle(_oracle);
    STAKING_MODULE_ID = _stakingModuleId;

    //for test
     _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
  }

  error ErrorArraysLengthMismatch(uint256 _firstArrayLength, uint256 _secondArrayLength);
  error ErrorKeyIsNotAvailiableToExit();

  function reportKeysToExit(
    uint256 _nodeOperatorId,
    uint256[] calldata _indexes,
    bytes[] calldata _pubkeys,
    bytes32 reportHash
    // bytes calldata data
) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (_indexes.length != _pubkeys.length) {
        revert ErrorArraysLengthMismatch(_indexes.length, _pubkeys.length);
    }
    IStakingRouter router = IStakingRouter(LOCATOR.stakingRouter());
    address moduleAddress = router.getStakingModule(STAKING_MODULE_ID).stakingModuleAddress;

    for (uint256 i = 0; i < _pubkeys.length; ++i) {
        if (!IStakingModule(moduleAddress).isKeyAvailableToExit(_nodeOperatorId, _indexes[i], _pubkeys[i])) {
            revert ErrorKeyIsNotAvailiableToExit();
        }
    }

    //forced target limit > vetted

    ORACLE.submitPriorityReportData(
        reportHash, _pubkeys.length
    );
  }
}

