// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {ILido as StETH} from "contracts/0.8.25/interfaces/ILido.sol";

pragma solidity 0.8.25;

contract VaultHub__Harness is VaultHub {

    /// @notice Lido Locator contract
    ILidoLocator public immutable LIDO_LOCATOR;
    /// @notice Lido contract
    StETH public immutable LIDO;

    constructor(ILidoLocator _lidoLocator, StETH _lido, address _treasury)
    VaultHub(_lido, _treasury){
        LIDO_LOCATOR = _lidoLocator;
        LIDO = _lido;
    }
}
