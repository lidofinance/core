// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {Lido} from "contracts/0.4.24/Lido.sol";

contract Lido__HarnessForFinalizeUpgradeV3 is Lido {
    function harness_initialize_v2(address _lidoLocator) external payable {
        _bootstrapInitialHolder(); // stone in the elevator
        _setLidoLocator(_lidoLocator);

        initialized();

        _resume();

        _setContractVersion(2);
    }

    function harness_setContractVersion(uint256 _version) external {
        _setContractVersion(_version);
    }

    function harness_mintShares(address _to, uint256 _sharesAmount) external {
        _mintShares(_to, _sharesAmount);
        _emitTransferAfterMintingShares(_to, _sharesAmount);
    }
}
