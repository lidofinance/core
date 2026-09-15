/* Proves the `vaults` array in `VaultHub` is a set
*/

using VaultHubHarness as _VaultHub;

methods {
    // `VaultHubHarness`
    function VaultHubHarness.totalValue(address) external returns (uint256) envfree;
    function VaultHubHarness.locked(address) external returns (uint256) envfree;
    function VaultHubHarness.isPendingDisconnect(address) external returns (bool) envfree;
    function VaultHubHarness.isVaultConnected(address) external returns (bool) envfree;
    function VaultHubHarness.isVaultHealthy(address) external returns (bool) envfree;
    function VaultHubHarness.getVaultRecordDeltaValue(address) external returns (int104) envfree;
    function VaultHubHarness.getVaultRecordInOutDelta(
        address, uint48
    ) external returns (int104) envfree;
    function VaultHubHarness.getVaultRecordBothDeltas(
        address
    ) external returns (int104, int104) envfree;
    function VaultHubHarness.getVaultReportDelta(address) external returns (int104) envfree;
    function VaultHubHarness.getVaultReportTotal(address) external returns (uint104) envfree;
    function VaultHubHarness.obligationsShares(address) external returns (uint256) envfree;
    function VaultHubHarness.unsettledLidoFees(address) external returns (uint256) envfree;
    function VaultHubHarness.totalValue(address) external returns (uint256) envfree;
    function VaultHubHarness.healthShortfallShares(address) external returns (uint256) envfree;
    function VaultHubHarness.totalMintingCapacityShares(address _vault, int256 _deltaValue) external returns (uint256) envfree;
    function VaultHubHarness.liabilityShares(address) external returns (uint256) envfree;
    function VaultHubHarness.redemptionShares(address) external returns (uint128) envfree;
    function VaultHubHarness.badDebtToInternalize() external returns (uint256) envfree;
    function VaultHubHarness.vaultsArrayLength() external returns (uint256) envfree;
    function VaultHubHarness.vaultArrayAtIndex(uint256) external returns (address) envfree;
    function VaultHubHarness.getInitializedVersion() external returns (uint64) envfree;
    function VaultHubHarness.vaultConnection(
        address
    )external returns (VaultHub.VaultConnection) envfree;
    function VaultHubHarness.reserveRatioBP(address) external returns (uint16) envfree;
    function VaultHubHarness.forcedRebalanceThresholdBP(address) external returns (uint16) envfree;
}

// -- Utility functions --------------------------------------------------------

/// @dev Requirements that are needed in invariants for `_VaultHub.applyVaultReport`.
/// These are needed to prevent the case where a vault with index 0 is deleted 
/// and therefore another becomes disconnected.
/// @notice Assumes `initialize` is called immediately after constructor (verified with Lido)
function applyVaultReportRquirements(address _other) {
    require(
        isInitialized(),
        "Assumes `initialize` is called immediately after constructor"
    );
    requireInvariant vaultsArrayIsNeverEmpty();

    // In case `_other` is deleted
    requireInvariant disconnectedVaultIsNotPending(_other);  // So its index is not 0
    requireInvariant vaultToIndexIsCorrect(_other);

    // NOTE: This limits the number of vaults to `max_uint96`
    uint96 lastIndex = require_uint96(vaultsLength() - 1);
    address lastVault = vaults(lastIndex);
    requireInvariant vaultToIndexIsCorrect(lastVault);
    requireInvariant indexToVaultIsCorrect(lastIndex);
}


/// @dev Requirements that are needed in invariants for `_VaultHub.connectVault`.
/// These are needed to prevent a newly connected vault from being in index 0 and
/// therefore disconnected.
/// @notice Assumes `initialize` is called immediately after constructor (verified with Lido)
function connectVaultRequirements() {
    require(
        isInitialized(),
        "Assumes `initialize` is called immediately after constructor"
    );
    requireInvariant vaultsArrayIsNeverEmpty();
}

/// @dev Returns whether the `VaultHub` has been initialized
definition isInitialized() returns bool = _VaultHub.getInitializedVersion() == 1;

/// @dev The length of the `vaults` array
definition vaultsLength() returns uint256 = _VaultHub.vh_storage.vaults.length;

/// @dev The vault in the given index of the array
definition vaults(uint96 index) returns address = (
    _VaultHub.vh_storage.vaults[assert_uint256(index)]
);

/// @dev The index of the given vault (according to the inverse mapping)
definition vaultIndex(address vault) returns uint96 = (
    _VaultHub.vh_storage.connections[vault].vaultIndex
);


definition maxReasonableValue() returns mathint = 2^100;


/// @dev Sets limits on the vault's possible values
/// @notice Missing conditions on previous slots using `DoubleRefSlotCache.getValueForRefSlot`
function reasonableDeltaValues(address vault) {
    // Just to be on the safe side we require for current delta as well as both deltas
    int104 recordDelta = _VaultHub.getVaultRecordDeltaValue(vault);
    require (recordDelta <= maxReasonableValue()) && (recordDelta >= -maxReasonableValue());

    int104 delta0;
    int104 delta1;
    (delta0, delta1) = _VaultHub.getVaultRecordBothDeltas(vault);
    require (
        delta0 <= maxReasonableValue() && delta0 >= -maxReasonableValue() &&
        delta1 <= maxReasonableValue() && delta1 >= -maxReasonableValue()
    );

    int104 reportDelta = _VaultHub.getVaultReportDelta(vault);
    require (reportDelta <= maxReasonableValue()) && (reportDelta >= -maxReasonableValue());

    uint104 reportTot = _VaultHub.getVaultReportTotal(vault);
    require (reportTot <= maxReasonableValue());

    mathint totValue = reportTot + recordDelta - reportDelta;
    require totValue >= 0;
}

// -- Invariants ---------------------------------------------------------------

/// @title A vault that is pending disconnect is connected
invariant disconnectedVaultIsNotPending(address vault)
    _VaultHub.isPendingDisconnect(vault) => _VaultHub.isVaultConnected(vault)
    filtered {
        f -> f.contract == _VaultHub  // `VaultHub` is sufficient for this invariant
    }
    {
        preserved _VaultHub.applyVaultReport(
            address _other,
            uint256 _reportTimestamp,
            uint256 _reportTotalValue,
            int256 _reportInOutDelta,
            uint256 _reportCumulativeLidoFees,
            uint256 _reportLiabilityShares,
            uint256 _reportMaxLiabilityShares,
            uint256 _reportSlashingReserve
        ) with (env e) {
            requireInvariant disconnectedVaultIsNotPending(_other);
            require(
                isInitialized(),
                "Assumes `initialize` is called immediately after constructor"
            );
            requireInvariant vaultsArrayIsNeverEmpty();
        }
    }


/// @title The `vaults` array in `VaultHub` has address 0 at index 0 after initialization
invariant vaultsArrayIsNeverEmpty()
    (vaultIndex(0) == 0) && (isInitialized() => (vaultsLength() > 0 && vaults(0) == 0))
    filtered {
        f -> f.contract == _VaultHub  // `VaultHub` is sufficient for this invariant
    }
    {
        preserved {
            require(
                isInitialized(),
                "Assumes `initialize` is called immediately after constructor"
            );
        }
        preserved initialize(address _admin) with (env e) {
            require(
                _VaultHub.vaultsArrayLength() == 0,
                "Assumes `initialize` is called immediately after constructor"
            );
        }
        preserved _VaultHub.applyVaultReport(
            address _other,
            uint256 _reportTimestamp,
            uint256 _reportTotalValue,
            int256 _reportInOutDelta,
            uint256 _reportCumulativeLidoFees,
            uint256 _reportLiabilityShares,
            uint256 _reportMaxLiabilityShares,
            uint256 _reportSlashingReserve
        ) with (env e) {
            applyVaultReportRquirements(_other);
        }
    }


invariant indexToVaultIsCorrect(uint96 index)
    index < vaultsLength() => (vaultIndex(vaults(index)) == index)
    filtered {
        f -> (
            f.contract == _VaultHub && // `VaultHub` is sufficient for this invariant
            // NOTE: Filtering out `initialize` as it's a special case handled separately
            f.selector != sig:VaultHubHarness.initialize(address).selector
        )
    }
    {
        preserved _VaultHub.connectVault(address _other) with (env e) {
            connectVaultRequirements();
        }
        preserved _VaultHub.applyVaultReport(
            address _other,
            uint256 _reportTimestamp,
            uint256 _reportTotalValue,
            int256 _reportInOutDelta,
            uint256 _reportCumulativeLidoFees,
            uint256 _reportLiabilityShares,
            uint256 _reportMaxLiabilityShares,
            uint256 _reportSlashingReserve
        ) with (env e) {
            applyVaultReportRquirements(_other);
        }
    }


invariant vaultToIndexIsCorrect(address vault)
    (
        (vaultIndex(vault) <= vaultsLength()) &&
        (vaultsLength() > 0 => vaultIndex(vault) < vaultsLength()) &&
        (vaultIndex(vault) > 0 => vaults(vaultIndex(vault)) == vault)
    )
    filtered {
        f -> (
            f.contract == _VaultHub && // `VaultHub` is sufficient for this invariant
            // NOTE: Filtering out `initialize` as it's a special case handled separately
            f.selector != sig:VaultHubHarness.initialize(address).selector
        )
    }
    {
        preserved _VaultHub.connectVault(address _other) with (env e) {
            connectVaultRequirements();
        }
        preserved _VaultHub.applyVaultReport(
            address _other,
            uint256 _reportTimestamp,
            uint256 _reportTotalValue,
            int256 _reportInOutDelta,
            uint256 _reportCumulativeLidoFees,
            uint256 _reportLiabilityShares,
            uint256 _reportMaxLiabilityShares,
            uint256 _reportSlashingReserve
        ) with (env e) {
            applyVaultReportRquirements(_other);
        }
    }
