// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {Lido} from "contracts/0.4.24/Lido.sol";
import {UnstructuredStorage} from "@aragon/os/contracts/apps/AragonApp.sol";

contract Lido__HarnessForFinalizeUpgradeV3 is Lido {
    using UnstructuredStorage for bytes32;

    bytes32 constant LIDO_LOCATOR_POSITION = keccak256("lido.Lido.lidoLocator");
    bytes32 constant TOTAL_SHARES_POSITION = keccak256("lido.StETH.totalShares");
    bytes32 constant BUFFERED_ETHER_POSITION = keccak256("lido.Lido.bufferedEther");
    bytes32 constant CL_VALIDATORS_POSITION = keccak256("lido.Lido.beaconValidators");
    bytes32 constant CL_BALANCE_POSITION = keccak256("lido.Lido.beaconBalance");
    bytes32 constant DEPOSITED_VALIDATORS_POSITION = keccak256("lido.Lido.depositedValidators");

    bytes32 internal constant TOTAL_SHARES_POSITION_V3 =
        0x6038150aecaa250d524370a0fdcdec13f2690e0723eaf277f41d7cae26b359e6;

    function harness_initialize_v2(address _lidoLocator) external payable {
        _bootstrapInitialHolder(); // stone in the elevator

        initialized();

        _resume();

        _setContractVersion(2);

        BUFFERED_ETHER_POSITION.setStorageUint256(msg.value);
        LIDO_LOCATOR_POSITION.setStorageAddress(_lidoLocator);
        TOTAL_SHARES_POSITION.setStorageUint256(TOTAL_SHARES_POSITION_V3.getStorageUint256());
        CL_VALIDATORS_POSITION.setStorageUint256(100);
        CL_BALANCE_POSITION.setStorageUint256(101);
        DEPOSITED_VALIDATORS_POSITION.setStorageUint256(102);
    }

    function harness_setContractVersion(uint256 _version) external {
        _setContractVersion(_version);
    }

    function harness_mintShares_v2(address _to, uint256 _sharesAmount) external {
        _mintShares(_to, _sharesAmount);
        _emitTransferAfterMintingShares(_to, _sharesAmount);
        TOTAL_SHARES_POSITION.setStorageUint256(TOTAL_SHARES_POSITION_V3.getStorageUint256());
    }
}
