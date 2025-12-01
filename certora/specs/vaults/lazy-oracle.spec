/* Spec for the `LazyOracle` contract */
// TODO: Fixes added an `enum QuarantineState` - which must be incorporated into the rules
// or have rules of its own

import "./vaults-array.spec";
import "./lido-mock.spec";

using LazyOracleHarness as _LazyOracle;
using OperatorGrid as _OperatorGrid;
using ILidoMock as _Lido;

methods {
    // `LidoLocator`
    function _.vaultHub() external => _VaultHub expect address;
    function _.lido() external => _Lido expect address;
    function _.operatorGrid() external => _OperatorGrid expect address;
    function _.accounting() external => CONSTANT;

    // `VaultHub`
    function _.applyVaultReport(
        address, uint256, uint256, int256, uint256, uint256, uint256, uint256
    ) external => DISPATCHER(true);

    // `LazyOracleHarness`
    function LazyOracleHarness.quarantinePeriod() external returns (uint256) envfree;
    function LazyOracleHarness.vaultQuarantine(
        address
    ) external returns (LazyOracle.QuarantineInfo)  envfree;
    function LazyOracleHarness.vaultQuarantine(
        address
    ) external returns (LazyOracle.QuarantineInfo) envfree;
    function LazyOracleHarness.handleSanityChecks(
        address, uint256, uint48, uint256, uint256, uint256, uint256
    ) external returns (uint256, int256) envfree;

    // `MerkleProof` library
    function MerkleProof.verify(
        bytes32[] memory, bytes32, bytes32
    ) internal returns (bool) => ALWAYS(true);

    // `PredepositGuarantee`
    // Strictly speaking this summary is not sound, but it is sufficient here
    function _.proveUnknownValidator(
        IPredepositGuarantee.ValidatorWitness, address
    ) external => NONDET;

    // `StakingVault`
    // Without the following summary, the call from `VaultHub`:Line 1071,
    // `_predepositGuarantee().proveUnknownValidator(_witness, IStakingVault(_vault))`,
    // becomes unresolved ("callee contract unresolved").
    function _.withdraw(address, uint256) external => DISPATCHER(true);

    function _.beaconChainDepositsPaused() external => DISPATCHER(true);
    function _.resumeBeaconChainDeposits() external => DISPATCHER(true);
    function _.pauseBeaconChainDeposits() external => DISPATCHER(true);
    function _.transferOwnership(address) external => DISPATCHER(true);
    function _.pendingOwner() external => DISPATCHER(true);
    function _.depositor() external => DISPATCHER(true);
    function _.owner() external => DISPATCHER(true);
    function _.nodeOperator() external => DISPATCHER(true);
    function _.acceptOwnership() external => DISPATCHER(true);
    function _.fund() external => DISPATCHER(true);
    function _.requestValidatorExit(bytes) external => DISPATCHER(true);
    function _.triggerValidatorWithdrawals(bytes, uint64[], address) external => DISPATCHER(true);
}


/// @dev Same as `LazyOracle.TOTAL_BASIS_POINTS`
definition TOTAL_BASIS_POINTS() returns uint256 = 10000;
    
/// @dev Adapted from `LazyOracle._processTotalValue`
definition getQuarantineThreshold(mathint onchainTotalValueOnRefSlot) returns mathint = (
    onchainTotalValueOnRefSlot * 
    (TOTAL_BASIS_POINTS() + _LazyOracle.lo_storage.maxRewardRatioBP) /
    TOTAL_BASIS_POINTS()
);

/// @title Basic integrity for quarantines
rule quarantineIntegrity(
    address vault,
    uint256 totalValue,
    uint256 cumulativeLidoFees,
    uint256 liabilityShares,
    uint256 maxLiabilityShares,
    uint256 slashingReserve
) {
    reasonableDeltaValues(vault);  // Prevent overflows and underflows

    uint64 dataTimestamp = _LazyOracle.lo_storage.vaultsDataTimestamp;
    uint48 refSlot = _LazyOracle.lo_storage.vaultsDataRefSlot;
    LazyOracle.QuarantineInfo infoPre = _LazyOracle.vaultQuarantine(vault);

    uint104 totalPre = _VaultHub.getVaultReportTotal(vault);
    int104 recDeltaPreRef = _VaultHub.getVaultRecordInOutDelta(vault, refSlot);
    int104 repDeltaPre = _VaultHub.getVaultReportDelta(vault);

    // Adapted from `LazyOracle._processTotalValue`
    mathint onchainTotalValueOnRefSlot = totalPre + recDeltaPreRef - repDeltaPre;
    mathint quarantineThreshold = getQuarantineThreshold(onchainTotalValueOnRefSlot);

    require(
        infoPre.pendingTotalValueIncrease <= maxReasonableValue(),
        "Prevent overflows and underflows"
    );

    env e;
    bytes32[] proof;
    _LazyOracle.updateVaultData(
        e,
        vault,
        totalValue,
        cumulativeLidoFees,
        liabilityShares,
        maxLiabilityShares,
        slashingReserve,
        proof
    );
    
    LazyOracle.QuarantineInfo infoPost = _LazyOracle.vaultQuarantine(vault);
    uint104 totalPost = _VaultHub.getVaultReportTotal(vault);

    assert(
        (
            infoPre.isActive &&
            infoPre.endTimestamp > dataTimestamp &&
            totalValue > quarantineThreshold &&
            _VaultHub.isVaultConnected(vault)
        ) => (
            infoPost.isActive &&
            infoPre.pendingTotalValueIncrease == infoPost.pendingTotalValueIncrease
        ),
        "Quarantine is active until end time"
    );
    assert(
        (infoPre.isActive && infoPre.endTimestamp > dataTimestamp) => (
            totalPost <= onchainTotalValueOnRefSlot ||
            totalPost <= totalValue
        ),
        "Funds are not released while quarantine is active"
    );
    assert(
        (infoPre.isActive && infoPre.endTimestamp <= dataTimestamp) => (
            totalPost >= onchainTotalValueOnRefSlot + infoPre.pendingTotalValueIncrease ||
            totalPost == totalValue ||
            !_VaultHub.isVaultConnected(vault)
        ),
        "Funds are released after quarantine ends"
    );
    assert(totalPost <= totalValue);
}


/// @title Quarantine state consistency
invariant quarantineStateConsistency(address vault)
    // Active quarantine must have non-zero timestamp and valid end time
    (_LazyOracle.vaultQuarantine(vault).isActive =>
        (
            _LazyOracle.vaultQuarantine(vault).startTimestamp > 0 &&
            _LazyOracle.vaultQuarantine(vault).pendingTotalValueIncrease > 0 &&
            (
                _LazyOracle.lo_storage.quarantinePeriod == 0 || 
                _LazyOracle.vaultQuarantine(vault).endTimestamp > 
                _LazyOracle.vaultQuarantine(vault).startTimestamp
            )
        )
    ) &&
    // Inactive quarantine must be completely zeroed
    (!_LazyOracle.vaultQuarantine(vault).isActive =>
        (
            _LazyOracle.vaultQuarantine(vault).startTimestamp == 0 &&
            _LazyOracle.vaultQuarantine(vault).pendingTotalValueIncrease == 0
        )
    )
    filtered { f -> f.contract == _LazyOracle }


/// @title Revert conditions for `_handleSanityChecks`
rule handleSanityChecksRevertConditions(
    address vault,
    uint256 totalValue,
    uint48 _reportRefSlot,
    uint256 _reportTimestamp,
    uint256 _cumulativeLidoFees,
    uint256 _liabilityShares,
    uint256 _maxLiabilityShares
) {
    reasonableDeltaValues(vault);  // Prevent overflows and underflows

    require(
        _reportTimestamp == _LazyOracle.lo_storage.vaultsDataTimestamp,
        "Assume report is updated"
    );

    LazyOracle.QuarantineInfo infoPre = _LazyOracle.vaultQuarantine(vault);
    require(
        _reportTimestamp <= max_uint48 &&  // Prevent overflow, this is reasonable time
        _reportTimestamp >= infoPre.startTimestamp && 
        _reportTimestamp > _VaultHub.vh_storage.records[vault].report.timestamp,
        "Time integrity"
    );
    require(
        infoPre.pendingTotalValueIncrease <= maxReasonableValue(),
        "Prevent overflows and underflows"
    );
    requireInvariant quarantineStateConsistency(vault);

    uint104 totalPre = _VaultHub.getVaultReportTotal(vault);
    int104 recDeltaPreRef = _VaultHub.getVaultRecordInOutDelta(vault, _reportRefSlot);
    int104 repDeltaPre = _VaultHub.getVaultReportDelta(vault);
    // Adapted from `LazyOracle._processTotalValue`
    mathint onchainTotalValueOnRefSlot = totalPre + recDeltaPreRef - repDeltaPre;
    mathint quarantineThreshold = getQuarantineThreshold(onchainTotalValueOnRefSlot);
    int104 currDelta = _VaultHub.getVaultRecordDeltaValue(vault);

    _LazyOracle.handleSanityChecks@withrevert(
        vault,
        totalValue,
        _reportRefSlot,
        _reportTimestamp,
        _cumulativeLidoFees,
        _liabilityShares,
        _maxLiabilityShares
    );
    bool reverted = lastReverted;

    mathint deltas = currDelta - recDeltaPreRef;
    mathint prevCumulativeLidoFees = _VaultHub.vh_storage.records[vault].cumulativeLidoFees;
    mathint prevMaxLiabilityShares = _VaultHub.vh_storage.records[vault].maxLiabilityShares;
    // See `LazyOracle._handleSanityChecks` Line 409
    mathint maxLidoFees = (
        (_reportTimestamp - _VaultHub.vh_storage.records[vault].report.timestamp)
        * _LazyOracle.lo_storage.maxLidoFeeRatePerSecond
    );
    assert(
        reverted <=> (
            // The following two lines handle the underflow condition (3) in `_handleSanityChecks`
            totalValue + deltas < 0 ||
            onchainTotalValueOnRefSlot + infoPre.pendingTotalValueIncrease + deltas < 0 ||
            // Condition in `LazyOracle._processTotalValue`
            totalValue > max_uint96 ||
            // Overflows in `LazyOracle._processTotalValue`
            (
                onchainTotalValueOnRefSlot > max_uint256 ||
                onchainTotalValueOnRefSlot < 0 ||
                onchainTotalValueOnRefSlot * (
                    TOTAL_BASIS_POINTS() + _LazyOracle.lo_storage.maxRewardRatioBP
                ) > max_uint256
            ) ||
            // Condition (4) in `LazyOracle._handleSanityChecks`
            (
                prevCumulativeLidoFees > _cumulativeLidoFees ||
                _cumulativeLidoFees - prevCumulativeLidoFees > maxLidoFees
            ) ||
            // Condition (5) in `LazyOracle._handleSanityChecks`
            (
                _maxLiabilityShares < _liabilityShares ||
                _maxLiabilityShares > prevMaxLiabilityShares
            )
        )
    );
}


/// @title Ensure that once a quarantine expires it cannot be reused
/// @notice Fails, see `https://github.com/lidofinance/core/issues/1304`
rule quarantineExpiry(
    address vault,
    uint256 totalValue,
    uint256 cumulativeLidoFees,
    uint256 liabilityShares,
    uint256 maxLiabilityShares,
    uint256 slashingReserve
) {
    reasonableDeltaValues(vault);  // Prevent overflows and underflows

    uint64 dataTimestamp = _LazyOracle.lo_storage.vaultsDataTimestamp;
    LazyOracle.QuarantineInfo infoPre = _LazyOracle.vaultQuarantine(vault);

    env e;
    bytes32[] proof;
    _LazyOracle.updateVaultData(
        e,
        vault,
        totalValue,
        cumulativeLidoFees,
        liabilityShares,
        maxLiabilityShares,
        slashingReserve,
        proof
    );
    
    LazyOracle.QuarantineInfo infoPost = _LazyOracle.vaultQuarantine(vault);

    assert(
        // Active quarantine expired
        (infoPre.isActive && infoPre.endTimestamp <= dataTimestamp) => (
            !infoPost.isActive || // Current quarantine expired
            infoPost.pendingTotalValueIncrease == 0 || // Current quarantine expired
            infoPost.startTimestamp == dataTimestamp // New quarantine
        ),
        "Current quarantine must expire after end time"
    );
}
