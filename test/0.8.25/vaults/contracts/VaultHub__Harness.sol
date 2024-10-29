// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";

pragma solidity 0.8.25;

interface ILido {}

contract VaultHub__Harness is VaultHub {

    /// @notice Lido Locator contract
    ILidoLocator public immutable LIDO_LOCATOR;
    /// @notice Lido contract
    ILido public immutable LIDO;

    constructor(address _admin, ILidoLocator _lidoLocator, ILido _lido, address _treasury)
    VaultHub(_admin, address(_lido), _treasury){
        LIDO_LOCATOR = _lidoLocator;
        LIDO = _lido;
    }
}
