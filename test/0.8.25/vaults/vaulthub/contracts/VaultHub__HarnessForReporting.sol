// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {VaultHub, IHashConsensus} from "contracts/0.8.25/vaults/VaultHub.sol";
import {DoubleRefSlotCache} from "contracts/0.8.25/vaults/lib/RefSlotCache.sol";

contract VaultHub__HarnessForReporting is VaultHub {
    // keccak256(abi.encode(uint256(keccak256("Lido.Vaults.VaultHub")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant VAULT_HUB_STORAGE_LOCATION =
        0x9eb73ffa4c77d08d5d1746cf5a5e50a47018b610ea5d728ea9bd9e399b76e200;

    constructor(
        ILidoLocator _locator,
        ILido _lido,
        IHashConsensus _consensusContract,
        uint256 _maxRelativeShareLimitBP
    ) VaultHub(_locator, _lido, _consensusContract, _maxRelativeShareLimitBP) {}

    function harness_getVaultHubStorage() private pure returns (VaultHub.Storage storage $) {
        assembly {
            $.slot := VAULT_HUB_STORAGE_LOCATION
        }
    }

    /// @notice connects a vault to the hub
    /// @param _vault vault address
    /// @param _shareLimit maximum number of stETH shares that can be minted by the vault
    /// @param _reserveRatioBP minimum reserve ratio in basis points
    /// @param _forcedRebalanceThresholdBP threshold to force rebalance on the vault in basis points
    /// @param _infraFeeBP infra fee in basis points
    /// @param _liquidityFeeBP liquidity fee in basis points
    /// @param _reservationFeeBP reservation fee in basis points
    /// @dev msg.sender must have VAULT_MASTER_ROLE
    function harness__connectVault(
        address _vault,
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _forcedRebalanceThresholdBP,
        uint256 _infraFeeBP,
        uint256 _liquidityFeeBP,
        uint256 _reservationFeeBP
    ) external {
        VaultHub.Storage storage $ = harness_getVaultHubStorage();

        VaultHub.VaultConnection memory connection = VaultHub.VaultConnection(
            address(0), // owner
            uint96(_shareLimit),
            uint96($.vaults.length),
            DISCONNECT_NOT_INITIATED, // disconnectInitiatedTs
            uint16(_reserveRatioBP),
            uint16(_forcedRebalanceThresholdBP),
            uint16(_infraFeeBP),
            uint16(_liquidityFeeBP),
            uint16(_reservationFeeBP),
            false // manuallyPausedBeaconChainDeposits
        );
        $.connections[_vault] = connection;

        VaultHub.VaultRecord memory record = VaultHub.VaultRecord({
            report: VaultHub.Report(0, 0, 0),
            maxLiabilityShares: 0,
            liabilityShares: uint96(_shareLimit),
            inOutDelta: [
                DoubleRefSlotCache.Int104WithCache({value: 0, valueOnRefSlot: 0, refSlot: 0}),
                DoubleRefSlotCache.Int104WithCache({value: 0, valueOnRefSlot: 0, refSlot: 0})
            ],
            minimalReserve: 0,
            redemptionShares: 0,
            cumulativeLidoFees: 0,
            settledLidoFees: 0
        });

        $.records[_vault] = record;
        $.vaults.push(_vault);

        emit VaultConnected(
            _vault,
            _shareLimit,
            _reserveRatioBP,
            _forcedRebalanceThresholdBP,
            _infraFeeBP,
            _liquidityFeeBP,
            _reservationFeeBP
        );
    }
}
