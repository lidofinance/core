
/* `VaultHUb` properties

We neglect the effects of rebalancing on internal-shares to internal-ETH ratio.

NOTE: There is here an implicit assumption that the conversion ratio
(`getPooledEthByShares`) only changes by calls to `rebalanceExternalEtherToInternal`.
*/
using VaultHubHarness as _VaultHub;
using PredepositGuarantee as _PredepositGuarantee;
using OperatorGrid as _OperatorGrid;
using ILidoMock as _Lido;

methods {
    // `LidoLocator`
    function _.vaultHub() external => _VaultHub expect address;
    function _.lido() external => _Lido expect address;
    function _.operatorGrid() external => _OperatorGrid expect address;
    function _.accounting() external => NONDET;

    // `ILidoMock`
    function ILidoMock.mintExternalShares(address, uint256) external => NONDET;
    function ILidoMock.burnExternalShares(uint256) external => NONDET;
    function ILidoMock.getSharesByPooledEth(
        uint256 _ethAmount
    ) external returns (uint256) => CVLgetSharesByPooledEth(_ethAmount);
    function ILidoMock.getPooledEthByShares(
        uint256 _sharesAmount
    ) external returns (uint256) => CVLgetPooledEthByShares(_sharesAmount);
    function ILidoMock.getPooledEthBySharesRoundUp(
        uint256 _sharesAmount
    ) external returns (uint256) => CVLgetPooledEthBySharesRoundUp(_sharesAmount);
    function ILidoMock.getTotalShares() external returns (uint256) => NONDET;

    // TODO: We ignore any side-effects of `rebalanceExternalEtherToInternal`
    function ILidoMock.rebalanceExternalEtherToInternal() external => NONDET;

    // TODO: this summary may not be sound
    function ILidoMock.transferSharesFrom(
        address, address, uint256
    ) external returns (uint256) => NONDET;


    // `VaultHubHarness`
    function VaultHubHarness.totalValue(address) external returns (uint256) envfree;
    function VaultHubHarness.locked(address) external returns (uint256) envfree;
    function VaultHubHarness.isPendingDisconnect(address) external returns (bool) envfree;
    function VaultHubHarness.isVaultConnected(address) external returns (bool) envfree;
    function VaultHubHarness.isVaultHealthy(address) external returns (bool) envfree;
    function VaultHubHarness.getVaultRecordDeltaValue(address) external returns (int104) envfree;
    function VaultHubHarness.getVaultReportDelta(address) external returns (int104) envfree;
    function VaultHubHarness.getVaultReportTotal(address) external returns (uint104) envfree;
    function VaultHubHarness.unsettledLidoFees(address) external returns (uint256) envfree;
    function VaultHubHarness.liabilityShares(address) external returns (uint256) envfree;
    function VaultHubHarness.badDebtToInternalize() external returns (uint256) envfree;
    function VaultHubHarness.vaultsArrayLength() external returns (uint256) envfree;
    function VaultHubHarness.vaultArrayAtIndex(uint256) external returns (address) envfree;
    function VaultHubHarness.getInitializedVersion() external returns (uint64) envfree;
    function VaultHubHarness.vaultConnection(
        address
    )external returns (VaultHub.VaultConnection) envfree;
    function VaultHubHarness.reserveRatioBP(address) external returns (uint16) envfree;
    function VaultHubHarness.forcedRebalanceThresholdBP(address) external returns (uint16) envfree;

    // `LazyOracle`
    function _.latestReportTimestamp() external => NONDET;

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

    // Summarize the call to `WITHDRAWAL_REQUEST` in `TriggerableWithdrawals` library
    // as `NONDET`. TODO This is not sound.
    unresolved external in StakingVault.triggerValidatorWithdrawals(
        bytes, uint64[], address
    ) => DISPATCH [] default NONDET;

    // `OperatorGrid`
    function OperatorGrid.tier(uint256) external returns (OperatorGrid.Tier) envfree;

    // `PredepositGuarantee`
    // Without the following summary, the call from `VaultHub`:Line 929,
    // `_predepositGuarantee().proveUnknownValidator(_witness, IStakingVault(_vault))`,
    // becomes unresolved ("callee contract unresolved").
    function _.proveUnknownValidator(
        IPredepositGuarantee.ValidatorWitness, address
    ) external => DISPATCHER(true);

    // `BLS` Library
    // Summarizing the `BLS` library since the Prover cannot easily handle such
    // calculations and it contains many unsafe memory operations that hurt static
    // analysis.
    // TODO: Can we do better than `NONDET`? Can we revert (e.g. in `verifyDepositMessage`)?
    function BLS12_381.verifyDepositMessage(
        bytes calldata,
        bytes calldata,
        uint256,
        BLS12_381.DepositY calldata,
        bytes32,
        bytes32
    ) internal => NONDET;
    function BLS12_381.sha256Pair(bytes32, bytes32) internal returns (bytes32) => NONDET;
    function BLS12_381.pubkeyRoot(bytes calldata) internal returns (bytes32) => NONDET;

    // `SSZ` Library
    // TODO: Can we do better than `NONDET`?
    function SSZ.hashTreeRoot(SSZ.BeaconBlockHeader memory) internal returns (bytes32) => NONDET;
    function SSZ.hashTreeRoot(SSZ.Validator memory) internal returns (bytes32) => NONDET;
    function SSZ.verifyProof(bytes32[] calldata, bytes32, bytes32, SSZ.GIndex) internal => NONDET;
    
    // `CLProofVerifier`
    // TODO: Can we do better than `NONDET`?
    function CLProofVerifier._validatePubKeyWCProof(
        IPredepositGuarantee.ValidatorWitness calldata,
        bytes32
    ) internal => NONDET;
}

// -- Summary ghosts and functions ---------------------------------------------


ghost fullEthBySharesUp(
    mathint,  // internal shares
    mathint,  // internal ETH
    mathint  // shares amount
) returns mathint {
    axiom forall mathint iShares. (
        forall mathint iEth. (
            forall mathint shares. (
                forall mathint rebalanced. (
                    fullEthBySharesUp(iShares, iEth, shares - rebalanced) <=
                    fullEthBySharesUp(iShares, iEth, shares) -
                    fullEthBySharesUp(iShares, iEth, rebalanced) + 2
                )
            )
        )
    );
    // The effect of rebalancing on the internal-ETH to internal-shares ratio.
    axiom forall mathint iShares. (
        forall mathint iEth. (
            forall mathint shares. (
                forall mathint rS. (  // Amount that has been rebalanced
                    fullEthBySharesUp(
                        iShares + rS,
                        iEth + fullEthBySharesUp(iShares, iEth, rS),
                        shares
                    ) - fullEthBySharesUp(iShares, iEth, shares) <= shares
                )
            )
        )
    );
}


ghost ethBySharesUp(mathint /* shares */ ) returns mathint {
    axiom ethBySharesUp(0) == 0;
    axiom forall mathint shares. forall mathint part. (
        shares > part => (
            ethBySharesUp(shares - part) <= ethBySharesUp(shares) - ethBySharesUp(part) + 2
        )
    );
    axiom forall mathint shares1. forall mathint shares2. (
        shares1 >= shares2 => ethBySharesUp(shares1) >= ethBySharesUp(shares2)
    );
}


ghost sharesByEth(mathint /* ETH */ ) returns mathint {
    axiom sharesByEth(0) == 0;
    axiom forall mathint eth. (
        ethBySharesUp(sharesByEth(eth)) >= eth &&
        ethBySharesUp(sharesByEth(eth)) <= eth + 1
    );
    axiom forall mathint eth1. forall mathint eth2. (
        eth1 >= eth2 => ethBySharesUp(eth1) >= ethBySharesUp(eth2)
    );
}



/// @dev Summarizes `Lido.getSharesByPooledEth`
/// @notice While the original function will revert if `_ethAmount` exceeds `UINT128_MAX`,
/// this summary will not.
function CVLgetSharesByPooledEth(uint256 _ethAmount) returns uint256 {
    require(
        _ethAmount <= max_uint128,
        "Lido.getSharesByPooledEth reverts if _ethAmount is bigger"
    );
    return require_uint256(sharesByEth(_ethAmount));
}


/// @dev Summarizes `Lido.getPooledEthBySharesRoundUp`
/// @notice While the original function will revert if `_sharesAmount` exceeds `UINT128_MAX`,
/// this summary will not.
function CVLgetPooledEthBySharesRoundUp(uint256 _sharesAmount) returns uint256 {
    require(
        _sharesAmount <= max_uint128,
        "Lido.getPooledEthBySharesRoundUp reverts if _sharesAmount is bigger"
    );
    return require_uint256(ethBySharesUp(_sharesAmount));
}


/// @dev Summarizes `Lido.getPooledEthByShares`
/// @notice While the original function will revert if `_sharesAmount` exceeds `UINT128_MAX`,
/// this summary will not.
function CVLgetPooledEthByShares(uint256 _sharesAmount) returns uint256 {
    require(
        _sharesAmount <= max_uint128,
        "Lido.getPooledEthBySharesRoundUp reverts if _sharesAmount is bigger"
    );
    uint256 roundedUp = CVLgetPooledEthBySharesRoundUp(_sharesAmount);
    uint256 eth;
    require eth <= roundedUp && eth + 1 >= roundedUp;
    return eth;
}

// -- Property: vaults array is a set ------------------------------------------

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
                _VaultHub.vaultArrayAtIndex(0) == 0,
                "See vaultsArrayIsNeverEmpty, assumes contract is initialized"
            );
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
            // TODO: check with Lido that `initialize` is called after constructor
            require(
                isInitialized(),
                "Assumes `initialize` is called immediately after constructor"
            );
        }
        preserved initialize(address _admin) with (env e) {
            // TODO: check with Lido that `initialize` is called after constructor
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
            // TODO: a special case we avoid here
            f.selector != sig:VaultHubHarness.initialize(address).selector
        )
    }
    {
        /*
        preserved {
            // TODO: check with Lido that `initialize` is called after constructor
            require(
                isInitialized(),
                "Assumes `initialize` is called immediately after constructor"
            );
            requireInvariant vaultsArrayIsNeverEmpty();
        }
        */
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
            // TODO: a special case we avoid here
            f.selector != sig:VaultHubHarness.initialize(address).selector
        )
    }
    {
        /*
        preserved {
            // TODO: check with Lido that `initialize` is called after constructor
            require(
                isInitialized(),
                "Assumes `initialize` is called immediately after constructor"
            );
            requireInvariant vaultsArrayIsNeverEmpty();
        }
        */
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

// -- Utility functions --------------------------------------------------------

definition maxReasonableValue() returns mathint = 2^100;


/// @dev Sets limits on the vault's possible values
/// TODO: Verify these are indeed reasonable
function reasonableDeltaValues(address vault) {
    int112 recordDelta = _VaultHub.getVaultRecordDeltaValue(vault);
    require (recordDelta <= maxReasonableValue()) && (recordDelta >= -maxReasonableValue());

    int112 reportDelta = _VaultHub.getVaultReportDelta(vault);
    require (reportDelta <= maxReasonableValue()) && (reportDelta >= -maxReasonableValue());

    uint112 reportTot = _VaultHub.getVaultReportTotal(vault);
    require (reportTot <= maxReasonableValue());

    mathint totValue = reportTot + recordDelta - reportDelta;
    require totValue >= 0;

    mathint totRef = reportTot - reportDelta;
    require totRef >= 0;
}


/// @dev Requirements that are needed in invariants for `_VaultHub.applyVaultReport`.
/// These are needed to prevent the case where a vault with index 0 is deleted 
/// and therefore another becomes disconnected.
function applyVaultReportRquirements(address _other) {
    // TODO: check with Lido that `initialize` is called after constructor
    require(
        isInitialized(),
        "Assumes `initialize` is called immediately after constructor"
    );
    requireInvariant vaultsArrayIsNeverEmpty();

    // In case `_other` is deleted
    requireInvariant disconnectedVaultIsNotPending(_other);  // So its index is not 0
    requireInvariant vaultToIndexIsCorrect(_other);

    // TODO: this limits the number of vaults to `max_uint96`
    uint96 lastIndex = require_uint96(vaultsLength() - 1);
    address lastVault = vaults(lastIndex);
    requireInvariant vaultToIndexIsCorrect(lastVault);
    requireInvariant indexToVaultIsCorrect(lastIndex);
}


/// @dev Requirements that are needed in invariants for `_VaultHub.connectVault`.
/// These are needed to prevent a newly connected vault from being in index 0 and
/// therefore disconnected.
function connectVaultRequirements() {
    // TODO: check with Lido that `initialize` is called after constructor
    require(
        isInitialized(),
        "Assumes `initialize` is called immediately after constructor"
    );
    requireInvariant vaultsArrayIsNeverEmpty();
}


/// @dev Returns whether the `VaultHub` has been initialized
definition isInitialized() returns bool = _VaultHub.getInitializedVersion() == 1;

definition vaultsLength() returns uint256 = _VaultHub.vh_storage.vaults.length;

definition vaults(uint96 index) returns address = (
    _VaultHub.vh_storage.vaults[assert_uint256(index)]
);

definition vaultIndex(address vault) returns uint96 = (
    _VaultHub.vh_storage.connections[vault].vaultIndex
);

/// @dev The same as `VaultHub.TOTAL_BASIS_POINTS`
definition TOTAL_BASIS_POINTS() returns uint256 = 10000;


definition isAlmostHealthy(address vault) returns bool = (
    ethBySharesUp(_VaultHub.liabilityShares(vault)) <=
    (
        _VaultHub.totalValue(vault) *
        (TOTAL_BASIS_POINTS() - _VaultHub.forcedRebalanceThresholdBP(vault)) /
        TOTAL_BASIS_POINTS()
    ) + 2
);


// -- Invariants ---------------------------------------------------------------

/// @title A vaults reserve ratio is at most 100%
invariant reserveRatioNotBig(address vault)
    _VaultHub.reserveRatioBP(vault) <= TOTAL_BASIS_POINTS();


/// @dev Returns the value n ETH of a vaults liability shares (rounded up)
definition liabilityEth(address vault) returns uint256 = (
    CVLgetPooledEthBySharesRoundUp(_VaultHub.liabilityShares(vault))
);

/// @title The locked amount of a vault 
invariant vaultLockedCoversLiabilityAndReserve(address vault)
    _VaultHub.locked(vault) * (TOTAL_BASIS_POINTS() - _VaultHub.reserveRatioBP(vault)) >=
    liabilityEth(vault) * TOTAL_BASIS_POINTS()
    {
        preserved {
            requireInvariant reserveRatioNotBig(vault);
            requireInvariant vaultReserveRatioNotGreaterThanThreshold(vault);
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
            requireInvariant reserveRatioNotBig(vault);
            requireInvariant vaultReserveRatioNotGreaterThanThreshold(vault);
        }
        preserved _OperatorGrid.changeTier(
            address _vault, uint256 _requestedTierId, uint256 _requestedShareLimit
        ) with (env e) {
            requireInvariant reserveRatioNotGreaterThanThreshold(_requestedTierId);
        }
    }


invariant vaultReserveRatioNotGreaterThanThreshold(address vault)
    _VaultHub.reserveRatioBP(vault) >= _VaultHub.forcedRebalanceThresholdBP(vault);

definition tierReserveRatioBP(uint256 tierId) returns uint16 = (
    _OperatorGrid.tier(tierId).reserveRatioBP
);

definition tierforcedRebalanceThresholdBP(uint256 tierId) returns uint16 = (
    _OperatorGrid.tier(tierId).forcedRebalanceThresholdBP
);

invariant reserveRatioNotGreaterThanThreshold(uint256 tierId)
    tierReserveRatioBP(tierId) >= tierforcedRebalanceThresholdBP(tierId)
    filtered { f -> f.contract == _OperatorGrid }


// -- Rules --------------------------------------------------------------------


/// @title A healthy vault remains healthy until a new report is produced
rule vaultIsHealtyhUntilReport(method f, address vault) filtered {
    f -> (
        f.contract == _VaultHub &&
        !f.isView &&
        f.selector != sig:VaultHubHarness.applyVaultReport(
            address, uint256, uint256, int256, uint256, uint256 ,uint256, uint256
        ).selector
    )
} {
    reasonableDeltaValues(vault);
    requireInvariant vaultLockedCoversLiabilityAndReserve(vault);
    requireInvariant vaultReserveRatioNotGreaterThanThreshold(vault);
    //requireInvariant vaultTotalNotLessThanLocked(vault);
    require(_VaultHub.isVaultHealthy(vault), "Pre condition - assume vault is healthy");

    env e;
    require(
        e.msg.value <= maxReasonableValue(),
        "Avoid overflow due to unreasonable ETH amount (e.g. in `VaultHub.fund`"
    );
    if (
        f.selector == sig:VaultHubHarness.updateConnection(
            address,uint256,uint256,uint256,uint256,uint256,uint256
        ).selector
    ) {
        // This case needs an additional requirement
        address _vault;
        uint256 _shareLimit;
        uint256 _reserveRatioBP;
        uint256 _forcedRebalanceThresholdBP;
        uint256 _infraFeeBP;
        uint256 _liquidityFeeBP;
        uint256 _reservationFeeBP;
        // TODO: Prove this invariant
        require(
            _forcedRebalanceThresholdBP <= _reserveRatioBP,
            "This is enforced by PredepositGuarantee, see reserveRatioNotGreaterThanThreshold"
        );
        _VaultHub.updateConnection(
            e,
            _vault,
            _shareLimit,
            _reserveRatioBP,
            _forcedRebalanceThresholdBP,
            _infraFeeBP,
            _liquidityFeeBP,
            _reservationFeeBP
        );
    } else {
        calldataarg args;
        f(e, args);
    }

    assert(
        isAlmostHealthy(vault),
        "A vault should remain almost healthy until a new report arrives"
    );
}
