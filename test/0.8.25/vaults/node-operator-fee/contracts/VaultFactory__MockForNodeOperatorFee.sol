// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {VaultFactory} from "contracts/0.8.25/vaults/VaultFactory.sol";
import {NodeOperatorFee} from "contracts/0.8.25/vaults/dashboard/NodeOperatorFee.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";
import {Clones} from "@openzeppelin/contracts-v5.2/proxy/Clones.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.2/proxy/beacon/BeaconProxy.sol";
import {StakingVault__MockForNodeOperatorFee} from "./StakingVault__MockForNodeOperatorFee.sol";
import {NodeOperatorFee__Harness} from "./NodeOperatorFee__Harness.sol";

contract VaultFactory__MockForNodeOperatorFee {
    address public immutable BEACON;
    address public immutable NODE_OPERATOR_FEE_IMPL;

    constructor(address _beacon, address _nodeOperatorFeeHarnessImpl) {
        BEACON = _beacon;
        NODE_OPERATOR_FEE_IMPL = _nodeOperatorFeeHarnessImpl;
    }

    function createVaultWithNodeOperatorFee(
        address _defaultAdmin,
        address _nodeOperatorManager,
        uint256 _nodeOperatorFeeBP,
        uint256 _confirmExpiry
    ) external returns (StakingVault__MockForNodeOperatorFee vault, NodeOperatorFee__Harness nodeOperatorFee) {
        vault = StakingVault__MockForNodeOperatorFee(address(new BeaconProxy(BEACON, "")));

        bytes memory immutableArgs = abi.encode(vault);
        nodeOperatorFee = NodeOperatorFee__Harness(
            payable(Clones.cloneWithImmutableArgs(NODE_OPERATOR_FEE_IMPL, immutableArgs))
        );

        nodeOperatorFee.initialize(_defaultAdmin, _nodeOperatorManager, _nodeOperatorFeeBP, _confirmExpiry);

        emit VaultCreated(address(vault), address(nodeOperatorFee));
    }

    event VaultCreated(address indexed vault, address indexed nodeOperatorFee);
}
