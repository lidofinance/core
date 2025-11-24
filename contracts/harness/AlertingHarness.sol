// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// ======================================================================================================= //
// DISCLAIMER: This contract is provided for tooling purposes only and is NOT part of the Lido core protocol.
// It is not audited, and may be updated in the future without notice.
// ======================================================================================================= //

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {LazyOracle} from "contracts/0.8.25/vaults/LazyOracle.sol";
import {PredepositGuarantee} from "contracts/0.8.25/vaults/predeposit_guarantee/PredepositGuarantee.sol";

/// @title AlertingHarness
/// @dev this contract is NOT a part of the Lido core protocol logic, it is only used for tooling purposes
contract AlertingHarness {
    /// @notice reference to the Lido locator contract used to resolve protocol contract addresses
    ILidoLocator public immutable LIDO_LOCATOR;

    /// @notice structure containing relevant data from an underlying contract
    /// @param nodeOperator the address of the node operator
    /// @param depositor the address of the depositor
    /// @param owner the address of the owner
    /// @param pendingOwner the address of the pending owner
    /// @param stagedBalance the staged balance
    /// @param availableBalance the available balance
    /// @param beaconChainDepositsPaused the status of the beacon chain deposits
    struct ContractInfo {
        address nodeOperator;
        address depositor;
        address owner;
        address pendingOwner;
        uint256 stagedBalance;
        uint256 availableBalance;
        bool beaconChainDepositsPaused;
    }

    /// @notice structure containing relevant data for a single connected vault
    /// @param vault The address of the vault
    /// @param connection The current connection parameters for the vault (such as limits and owner info)
    /// @param record the current accounting record for the vault (liabilities, report, in/out delta, etc.)
    /// @param quarantineInfo the quarantine info (if any) for the vault from LazyOracle
    /// @param contractData the data from the underlying staking vault contracts
    /// @param pendingActivationsCount the number of pending validator activations in the vault (from PredepositGuarantee)
    struct VaultData {
        address vault;
        VaultHub.VaultConnection connection;
        VaultHub.VaultRecord record;
        LazyOracle.QuarantineInfo quarantineInfo;
        ContractInfo contractInfo;
        uint256 pendingActivationsCount;
    }

    struct VaultConnectionData {
        address vault;
        VaultHub.VaultConnection connection;
    }

    struct VaultRecordData {
        address vault;
        VaultHub.VaultRecord record;
    }

    struct VaultQuarantineInfoData {
        address vault;
        LazyOracle.QuarantineInfo quarantineInfo;
    }

    struct VaultPendingActivationsData {
        address vault;
        uint256 pendingActivationsCount;
    }

    struct VaultContractInfoData {
        address vault;
        ContractInfo contractInfo;
    }

    error ZeroAddress(string _argument);

    /// @notice initializes the AlertingHarness and stores the locator contract address
    /// @param _lidoLocator the address of the Lido locator contract
    constructor(address _lidoLocator) {
        if (_lidoLocator == address(0)) revert ZeroAddress("_lidoLocator");

        LIDO_LOCATOR = ILidoLocator(_lidoLocator);
    }

    /// @notice retrieves structured data for a single vault
    /// @param _vault the address of the vault to query
    /// @return vault data for the queried vault
    function getVaultData(address _vault) external view returns (VaultData memory) {
        return _collectVaultData(
            _vault,
            _vaultHub(),
            _lazyOracle(),
            _predepositGuarantee()
        );
    }

    /// @notice retrieves structured data for a batch of vaults in a single call
    /// @param _offset the starting vault index in the hub [0, vaultsCount)
    /// @param _limit the maximum number of vaults to return in this batch
    /// @return batch of VaultData structs for the requested vaults
    function batchVaultData(
        uint256 _offset,
        uint256 _limit
    ) external view returns (VaultData[] memory batch) {
        (VaultHub vaultHub, uint256 batchSize) = _getBatchSize(_offset, _limit);

        if (batchSize == 0) return new VaultData[](0);

        LazyOracle lazyOracle = _lazyOracle();
        PredepositGuarantee predepositGuarantee = _predepositGuarantee();

        batch = new VaultData[](batchSize);
        for (uint256 i = 0; i < batchSize; ++i) {
            address vault = vaultHub.vaultByIndex(_offset + i + 1);
            batch[i] = _collectVaultData(vault, vaultHub, lazyOracle, predepositGuarantee);
        }
    }

    /// @notice retrieves batch of VaultHub.VaultConnection structs in a single call
    /// @param _offset the starting vault index in the hub [0, vaultsCount)
    /// @param _limit maximum number of items to return in the batch
    /// @return batch of VaultConnectionData structs for the requested vaults
    function batchVaultConnections(
        uint256 _offset,
        uint256 _limit
    ) external view returns (VaultConnectionData[] memory batch) {
        (VaultHub vaultHub, uint256 batchSize) = _getBatchSize(_offset, _limit);

        if (batchSize == 0) return new VaultConnectionData[](0);

        batch = new VaultConnectionData[](batchSize);
        for (uint256 i = 0; i < batchSize; ++i) {
            address vault = vaultHub.vaultByIndex(_offset + i + 1);
            batch[i] = VaultConnectionData({
                vault: vault,
                connection: vaultHub.vaultConnection(vault)
            });
        }
    }

    /// @notice retrieves batch of VaultHub.VaultRecord structs in a single call
    /// @param _offset the starting vault index in the hub [0, vaultsCount)
    /// @param _limit maximum number of items to return in the batch
    /// @return batch of VaultRecordData structs for the requested vaults
    function batchVaultRecords(
        uint256 _offset,
        uint256 _limit
    ) external view returns (VaultRecordData[] memory batch) {
        (VaultHub vaultHub, uint256 batchSize) = _getBatchSize(_offset, _limit);

        if (batchSize == 0) return new VaultRecordData[](0);

        batch = new VaultRecordData[](batchSize);
        for (uint256 i = 0; i < batchSize; ++i) {
            address vault = vaultHub.vaultByIndex(_offset + i + 1);
            batch[i] = VaultRecordData({
                vault: vault,
                record: vaultHub.vaultRecord(vault)
            });
        }
    }

    /// @notice retrieves batch of LazyOracle.QuarantineInfo structs in a single call
    /// @param _offset the starting vault index in the hub [0, vaultsCount)
    /// @param _limit maximum number of items to return in the batch
    /// @return batch of VaultQuarantineInfoData structs for the requested vaults
    function batchVaultQuarantines(
        uint256 _offset,
        uint256 _limit
    ) external view returns (VaultQuarantineInfoData[] memory batch) {
        (VaultHub vaultHub, uint256 batchSize) = _getBatchSize(_offset, _limit);
        if (batchSize == 0) return new VaultQuarantineInfoData[](0);

        LazyOracle lazyOracle = _lazyOracle();

        batch = new VaultQuarantineInfoData[](batchSize);
        for (uint256 i = 0; i < batchSize; ++i) {
            address vault = vaultHub.vaultByIndex(_offset + i + 1);
            batch[i] = VaultQuarantineInfoData({
                vault: vault,
                quarantineInfo: lazyOracle.vaultQuarantine(vault)
            });
        }
    }

    /// @notice retrieves batch of VaultPendingActivationsData structs in a single call
    /// @param _offset the starting vault index in the hub [0, vaultsCount)
    /// @param _limit maximum number of items to return in the batch
    /// @return batch of VaultPendingActivationsData structs for the requested vaults
    function batchPendingActivations(
        uint256 _offset,
        uint256 _limit
    ) external view returns (VaultPendingActivationsData[] memory batch) {
        (VaultHub vaultHub, uint256 batchSize) = _getBatchSize(_offset, _limit);
        if (batchSize == 0) return new VaultPendingActivationsData[](0);

        PredepositGuarantee predepositGuarantee = _predepositGuarantee();

        batch = new VaultPendingActivationsData[](batchSize);
        for (uint256 i = 0; i < batchSize; ++i) {
            address vault = vaultHub.vaultByIndex(_offset + i + 1);
            batch[i] = VaultPendingActivationsData({
                vault: vault,
                pendingActivationsCount: predepositGuarantee.pendingActivations(IStakingVault(vault))
            });
        }
    }

    /// @notice retrieves batch of ContractInfo structs in a single call
    /// @param _offset the starting vault index in the hub [0, vaultsCount)
    /// @param _limit maximum number of items to return in the batch
    /// @return batch of ContractInfo structs for the requested vaults
    function batchStakingVaultData(
        uint256 _offset,
        uint256 _limit
    ) external view returns (VaultContractInfoData[] memory batch) {
        (VaultHub vaultHub, uint256 batchSize) = _getBatchSize(_offset, _limit);
        if (batchSize == 0) return new VaultContractInfoData[](0);

        batch = new VaultContractInfoData[](batchSize);
        for (uint256 i = 0; i < batchSize; ++i) {
            address vault = vaultHub.vaultByIndex(_offset + i + 1);
            batch[i] = VaultContractInfoData({
                vault: vault,
                contractInfo: _collectContractInfo(IStakingVault(vault))
            });
        }
    }
    /// @notice helper to calculate actual batch size based on vault hub
    /// @param _offset the starting vault index in the hub [0, vaultsCount)
    /// @param _limit requested batch size
    /// @return vaultHub the VaultHub contract instance
    /// @return batchSize actual batch size to use (0 if offset out of range)
    function _getBatchSize(
        uint256 _offset,
        uint256 _limit
    ) private view returns (VaultHub vaultHub, uint256 batchSize) {
        vaultHub = _vaultHub();
        uint256 vaultsCount = vaultHub.vaultsCount();

        if (_offset >= vaultsCount) return (vaultHub, 0);

        batchSize = _offset + _limit > vaultsCount ? vaultsCount - _offset : _limit;
    }

    /// @notice internal utility to collect vault data from multiple protocol contracts
    /// @param _vault vault address to collect data for
    /// @param vaultHub vaultHub contract instance
    /// @param lazyOracle lazyOracle contract instance
    /// @param predepositGuarantee predepositGuarantee contract instance
    /// @return populated vaultData structure
    function _collectVaultData(
        address _vault,
        VaultHub vaultHub,
        LazyOracle lazyOracle,
        PredepositGuarantee predepositGuarantee
    ) internal view returns (VaultData memory) {
        IStakingVault stakingVault = IStakingVault(_vault);
        return VaultData({
            vault: _vault,
            connection: vaultHub.vaultConnection(_vault),
            record: vaultHub.vaultRecord(_vault),
            quarantineInfo: lazyOracle.vaultQuarantine(_vault),
            pendingActivationsCount: predepositGuarantee.pendingActivations(stakingVault),
            contractInfo: _collectContractInfo(stakingVault)
        });
    }

    /// @notice helper to collect staking vault data from a single staking vault
    /// @param _stakingVault the staking vault to collect data from
    /// @return populated stakingVaultData structure
    function _collectContractInfo(IStakingVault _stakingVault) internal view returns (ContractInfo memory) {
        return ContractInfo({
            nodeOperator: _stakingVault.nodeOperator(),
            depositor: _stakingVault.depositor(),
            owner: _stakingVault.owner(),
            pendingOwner: _stakingVault.pendingOwner(),
            stagedBalance: _stakingVault.stagedBalance(),
            availableBalance: _stakingVault.availableBalance(),
            beaconChainDepositsPaused: _stakingVault.beaconChainDepositsPaused()
        });
    }

    /// @notice helper to resolve the current VaultHub contract from the locator
    /// @return contract instance of VaultHub
    function _vaultHub() internal view returns (VaultHub) {
        return VaultHub(payable(LIDO_LOCATOR.vaultHub()));
    }

    /// @notice helper to resolve the current LazyOracle contract from the locator
    /// @return contract instance of LazyOracle
    function _lazyOracle() internal view returns (LazyOracle) {
        return LazyOracle(LIDO_LOCATOR.lazyOracle());
    }

    /// @notice helper to resolve the current PredepositGuarantee contract from the locator
    /// @return contract instance of PredepositGuarantee
    function _predepositGuarantee() internal view returns (PredepositGuarantee) {
        return PredepositGuarantee(LIDO_LOCATOR.predepositGuarantee());
    }
}
