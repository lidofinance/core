// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/OwnableUpgradeable.sol";
import {SafeCast} from "@openzeppelin/contracts-v5.0.2/utils/math/SafeCast.sol";
import {IERC20} from "@openzeppelin/contracts-v5.0.2/token/ERC20/IERC20.sol";
import {ERC1967Utils} from "@openzeppelin/contracts-v5.0.2/proxy/ERC1967/ERC1967Utils.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
//import {IReportReceiver} from "./interfaces/IReportReceiver.sol";
//import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {IBeaconProxy} from "contracts/0.8.25/vaults/interfaces/IBeaconProxy.sol";
import {VaultBeaconChainDepositor} from "contracts/0.8.25/vaults/VaultBeaconChainDepositor.sol";

contract StakingVault__MockForVault is IBeaconProxy, VaultBeaconChainDepositor, OwnableUpgradeable {
    uint8 private constant _version = 2;

    VaultHub public immutable vaultHub;
    IERC20 public immutable stETH;

    error ZeroArgument(string name);
    error NonProxyCall();

    constructor(
        address _hub,
        address _stETH,
        address _beaconChainDepositContract
    ) VaultBeaconChainDepositor(_beaconChainDepositContract) {
        if (_hub == address(0)) revert ZeroArgument("_hub");

        vaultHub = VaultHub(_hub);
        stETH = IERC20(_stETH);
    }

    /// @notice Initialize the contract storage explicitly.
    /// @param _owner owner address that can TBD
    function initialize(address _owner) public {
        if (_owner == address(0)) revert ZeroArgument("_owner");
        if (getBeacon() == address(0)) revert NonProxyCall();

        _transferOwnership(_owner);
    }

    function version() public pure virtual returns(uint8) {
        return _version;
    }

    function getBeacon() public view returns (address) {
        return ERC1967Utils.getBeacon();
    }
}
