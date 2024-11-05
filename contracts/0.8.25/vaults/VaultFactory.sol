// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

import {UpgradeableBeacon} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts-v5.0.2/proxy/beacon/BeaconProxy.sol";
import {Clones} from "@openzeppelin/contracts-v5.0.2/proxy/Clones.sol";

import {StakingVault} from "./StakingVault.sol";
import {VaultStaffRoom} from "./VaultStaffRoom.sol";
import {VaultDashboard} from "./VaultDashboard.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";

pragma solidity 0.8.25;

interface IVaultStaffRoom {
    struct VaultStaffRoomParams {
        uint256 managementFee;
        uint256 performanceFee;
        address manager;
        address operator;
    }

    function MANAGER_ROLE() external view returns (bytes32);
    function OPERATOR_ROLE() external view returns (bytes32);
    function DEFAULT_ADMIN_ROLE() external view returns (bytes32);

    function initialize(address admin, address stakingVault) external;
    function setManagementFee(uint256 _newManagementFee) external;
    function setPerformanceFee(uint256 _newPerformanceFee) external;
    function grantRole(bytes32 role, address account) external;
    function revokeRole(bytes32 role, address account) external;
}

contract VaultFactory is UpgradeableBeacon {

    address public immutable vaultStaffRoomImpl;

    /// @param _owner The address of the VaultFactory owner
    /// @param _stakingVaultImpl The address of the StakingVault implementation
    /// @param _vaultStaffRoomImpl The address of the VaultStaffRoom implementation
    constructor(address _owner, address _stakingVaultImpl, address _vaultStaffRoomImpl) UpgradeableBeacon(_stakingVaultImpl, _owner) {
        if (_vaultStaffRoomImpl == address(0)) revert ZeroArgument("_vaultStaffRoom");

        vaultStaffRoomImpl = _vaultStaffRoomImpl;
    }

    /// @notice Creates a new StakingVault and VaultStaffRoom contracts
    /// @param _stakingVaultParams The params of vault initialization
    /// @param _vaultStaffRoomParams The params of vault initialization
    function createVault(bytes calldata _stakingVaultParams, bytes calldata _vaultStaffRoomParams) external returns(address vault, address vaultStaffRoom) {
        vault = address(new BeaconProxy(address(this), ""));

        IVaultStaffRoom.VaultStaffRoomParams memory vaultStaffRoomParams = abi.decode(
            _vaultStaffRoomParams,
            (IVaultStaffRoom.VaultStaffRoomParams)
        );
        IVaultStaffRoom vaultStaffRoom = IVaultStaffRoom(Clones.clone(vaultStaffRoomImpl));

        //grant roles for factory to set fees
        vaultStaffRoom.initialize(address(this), vault);
        vaultStaffRoom.grantRole(vaultStaffRoom.MANAGER_ROLE(), address(this));
        vaultStaffRoom.grantRole(vaultStaffRoom.MANAGER_ROLE(), vaultStaffRoomParams.manager);
        vaultStaffRoom.grantRole(vaultStaffRoom.OPERATOR_ROLE(), vaultStaffRoomParams.operator);
        vaultStaffRoom.grantRole(vaultStaffRoom.DEFAULT_ADMIN_ROLE(), msg.sender);

        vaultStaffRoom.setManagementFee(vaultStaffRoomParams.managementFee);
        vaultStaffRoom.setPerformanceFee(vaultStaffRoomParams.performanceFee);

        //revoke roles from factory
        vaultStaffRoom.revokeRole(vaultStaffRoom.MANAGER_ROLE(), address(this));
        vaultStaffRoom.revokeRole(vaultStaffRoom.DEFAULT_ADMIN_ROLE(), address(this));

        IStakingVault(vault).initialize(address(vaultStaffRoom), _stakingVaultParams);

        emit VaultCreated(address(vaultStaffRoom), vault);
        emit VaultStaffRoomCreated(msg.sender, address(vaultStaffRoom));
    }

    /**
    * @notice Event emitted on a Vault creation
    * @param admin The address of the Vault admin
    * @param vault The address of the created Vault
    */
    event VaultCreated(
        address indexed admin,
        address indexed vault
    );

    /**
    * @notice Event emitted on a VaultStaffRoom creation
    * @param admin The address of the VaultStaffRoom admin
    * @param vaultStaffRoom The address of the created VaultStaffRoom
    */
    event VaultStaffRoomCreated(
        address indexed admin,
        address indexed vaultStaffRoom
    );

    error ZeroArgument(string);
}
