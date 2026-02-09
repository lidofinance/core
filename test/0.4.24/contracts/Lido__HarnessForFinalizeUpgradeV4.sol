// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {Lido} from "contracts/0.4.24/Lido.sol";
import {UnstructuredStorage} from "@aragon/os/contracts/apps/AragonApp.sol";
import {UnstructuredStorageExt} from "contracts/0.4.24/utils/UnstructuredStorageExt.sol";

contract Lido__HarnessForFinalizeUpgradeV4 is Lido {
    using UnstructuredStorage for bytes32;
    using UnstructuredStorageExt for bytes32;

    // v3 storage positions
    bytes32 internal constant BUFFERED_ETHER_AND_DEPOSITED_VALIDATORS_POSITION =
        keccak256("lido.Lido.bufferedEtherAndDepositedValidators");
    bytes32 internal constant CL_BALANCE_AND_CL_VALIDATORS_POSITION = keccak256("lido.Lido.clBalanceAndClValidators");

    function harness_initialize_v3() external payable {
        _bootstrapInitialHolder(); // stone in the elevator

        initialized();

        _resume();

        _setContractVersion(3);

        BUFFERED_ETHER_AND_DEPOSITED_VALIDATORS_POSITION.setLowUint128(msg.value);
        BUFFERED_ETHER_AND_DEPOSITED_VALIDATORS_POSITION.setHighUint128(120);

        CL_BALANCE_AND_CL_VALIDATORS_POSITION.setLowUint128(100 * 32 ether);
        CL_BALANCE_AND_CL_VALIDATORS_POSITION.setHighUint128(100);
    }

    function harness_setContractVersion(uint256 _version) external {
        _setContractVersion(_version);
    }
}
