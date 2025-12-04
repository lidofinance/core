/* `VaultHUb` properties

NOTE: There is here an implicit assumption that the conversion ratio
(`getPooledEthByShares`) only changes by calls to `rebalanceExternalEtherToInternal`.
*/

import "./vaults-array.spec";
import "./lido-mock.spec";
import "../common/erc20-summary.spec";

// `using VaultHubHarness as _VaultHub;` defined in `vaults-array.spec`
using PredepositGuarantee as _PredepositGuarantee;
using OperatorGrid as _OperatorGrid;
using ILidoMock as _Lido;

methods {
    // `LidoLocator`
    function _.vaultHub() external => _VaultHub expect address;
    function _.lido() external => _Lido expect address;
    function _.operatorGrid() external => _OperatorGrid expect address;
    function _.accounting() external => NONDET;

    // `LazyOracle`
    function _.latestReportTimestamp() external => NONDET;
    function _.removeVaultQuarantine(address) external => NONDET;

    // `StakingVault`
    // Without the following summary, the call from `VaultHub`:Line 1071,
    // `_predepositGuarantee().proveUnknownValidator(_witness, IStakingVault(_vault))`,
    // becomes unresolved ("callee contract unresolved").
    function _.withdraw(address, uint256) external => DISPATCHER(true);

    function _.availableBalance() external => DISPATCHER(true);
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
    function _.collectERC20(address, address, uint256) external => DISPATCHER(true);

    // Summarize the call to `WITHDRAWAL_REQUEST` in `TriggerableWithdrawals` library
    // as `NONDET`. NOTE: This is not sound but necessary for analysis.
    unresolved external in StakingVault.triggerValidatorWithdrawals(
        bytes, uint64[], address
    ) => DISPATCH [] default NONDET;

    // `OperatorGrid`
    function OperatorGrid.tier(uint256) external returns (OperatorGrid.Tier) envfree;
    function OperatorGrid.tiersCount() external returns (uint256) envfree;
    //function Confirmable2Addresses._collectAndCheckConfirmations(bytes calldata _calldata, address _role1, address _role2) internal returns (bool) => NONDET;

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
    // analysis. Using NONDET as it's the most practical approach for verification.
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
    // NOTE: Summarized as NONDET due to complexity of SSZ operations
    function SSZ.hashTreeRoot(SSZ.BeaconBlockHeader memory) internal returns (bytes32) => NONDET;
    function SSZ.hashTreeRoot(SSZ.Validator memory) internal returns (bytes32) => NONDET;
    function SSZ.verifyProof(bytes32[] calldata, bytes32, bytes32, SSZ.GIndex) internal => NONDET;
    
    // `CLProofVerifier`
    // NOTE: Using wildcard and NONDET as the Prover cannot resolve CLProofVerifier
    // (it worked in previous versions of the code `d1b4b34ebc911f01aca285d8d7b758f8c5fc7619`)
    function _._validatePubKeyWCProof(
        IPredepositGuarantee.ValidatorWitness calldata,
        bytes32
    ) internal => NONDET;    
}

// -- Property: `vaults` array in `VaultHub` is a set --------------------------

use invariant disconnectedVaultIsNotPending;
use invariant vaultsArrayIsNeverEmpty;
use invariant indexToVaultIsCorrect;
use invariant vaultToIndexIsCorrect;

// -- Utility functions --------------------------------------------------------

/// @dev The same as `VaultHub.TOTAL_BASIS_POINTS`
definition TOTAL_BASIS_POINTS() returns uint256 = 10000;

/// @dev The same as `OperatorGris.MAX_RESERVE_RATIO_BP`
definition TIER_MAX_RESERVE_RATIO_BP() returns uint256 = 9999;


/// @dev Non-view functions of `OperatorGrid` and `VaultHub` except for those in
/// `VaultHub` that can be called only from `OperatorGrid`.
definition isValidFuncVaultHubOperatorGrid(method f) returns bool = (
    !f.isView && (
        f.contract == _OperatorGrid || (
            f.contract == _VaultHub &&
            // This function is only called by the `OperatorGrid`
            f.selector != sig:VaultHubHarness.updateConnection(
                address, uint256, uint256, uint256, uint256, uint256, uint256
            ).selector
        )
    )
);


/// @dev Requirements for nice violation examples
function niceViolationRequirements(address vault) {
    uint256 totalValue = _VaultHub.totalValue(vault);
    uint256 shares = _VaultHub.liabilityShares(vault);
    uint256 sharesValue = CVLgetPooledEthBySharesRoundUp(shares);

    require(totalValue == 1000 && shares >= 100, "Simpler example");
    require(
        _VaultHub.forcedRebalanceThresholdBP(vault) == 2000 &&
        _VaultHub.reserveRatioBP(vault) == 2000,  // 20%
        "Assume small or simple values for simpler example"
    );
    require(
        _internalShares() >= 100 * _VaultHub.liabilityShares(vault) &&
        _internalEth >= 100 * _VaultHub.totalValue(vault),
        "Assume Lido holds many more shares and ETH than the vault"
    );
    require(CVLgetPooledEthByShares(1) >= 1, "Assume 1 share is more than 1 ETH");
    require(_VaultHub.isVaultConnected(vault), "Assume connected vault");
}


// -- Invariants ---------------------------------------------------------------

/// @title A vault with obligations is connected
/// @notice There is no check in `VaultHub.applyVaultReport` nor in `LazyOracle.updateVaultData`
/// (which calls the former) that the vault is indeed connected!
/// This makes this invariant fail for `VaultHub.applyVaultReport`
invariant obligatedVaultIsConnected(address vault)
    (
        (_VaultHub.obligationsShares(vault) > 0 || _VaultHub.unsettledLidoFees(vault) > 0) => _VaultHub.isVaultConnected(vault)
    )
    filtered { f -> f.contract == _VaultHub }
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
            applyVaultReportRquirements(_other);
            requireInvariant disconnectedVaultHasNoLiability(vault);
            requireInvariant disconnectedVaultHasNoLocked(vault);
        }
        preserved _VaultHub.triggerValidatorWithdrawals(address _vault, bytes _pubkeys, uint64[] _amountsInGwei, address _refundRecipient) with (env e) {
          require(_amountsInGwei.length <= 2, "Limit loop iterations to mitigate timeouts");
        }
        preserved _VaultHub.forceRebalance(address _vault) with (env e) {
            // Constrain the vault parameter to reduce complexity
            requireInvariant disconnectedVaultHasNoLiability(vault);
            requireInvariant disconnectedVaultHasNoLocked(vault);
        }
        preserved _VaultHub.forceValidatorExit(address _vault, bytes _pubkeys, address _refundRecipient) with (env e) {
            // Limit the complexity by constraining pubkeys length
            require(_pubkeys.length <= 96, "Limit to 2 validators (48 bytes each)");
            requireInvariant disconnectedVaultHasNoLiability(vault);
            requireInvariant disconnectedVaultHasNoLocked(vault);
        }
    }


/// @title A disconnected vault has zero liability shares
invariant disconnectedVaultHasNoLiability(address vault)
    !_VaultHub.isVaultConnected(vault) => _VaultHub.liabilityShares(vault) == 0
    filtered { f ->  isValidFuncVaultHubOperatorGrid(f) }
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
            applyVaultReportRquirements(_other);
        }
    }


/// @title A vault with locked value is connected
/// @notice Previously there is no check in `VaultHub.applyVaultReport` nor in
/// `LazyOracle.updateVaultData` (which calls the former) that the vault is indeed
/// connected! This made this invariant fail for `VaultHub.applyVaultReport`.
invariant disconnectedVaultHasNoLocked(address vault)
    !_VaultHub.isVaultConnected(vault) => _VaultHub.locked(vault) == 0
    filtered { f ->  isValidFuncVaultHubOperatorGrid(f) }
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
            applyVaultReportRquirements(_other);
        }
        preserved _VaultHub.connectVault(address _other) with (env e) {
            connectVaultRequirements();
        }
    }


invariant tierReserveRatioLeqOne(uint256 tierId)
  _OperatorGrid.og_storage.tiers[tierId].reserveRatioBP <= TIER_MAX_RESERVE_RATIO_BP()
  filtered { f ->  isValidFuncVaultHubOperatorGrid(f) }
  {
    preserved constructor() {
      require _OperatorGrid.og_storage.tiers[tierId].reserveRatioBP <= TIER_MAX_RESERVE_RATIO_BP();
    }
  }




/// @title A vaults reserve ratio is at most 100%
invariant reserveRatioNotBig(address vault)
    _VaultHub.reserveRatioBP(vault) <= TOTAL_BASIS_POINTS()
    filtered { f ->  isValidFuncVaultHubOperatorGrid(f) }
    {
      preserved _OperatorGrid.changeTier(address _, uint256 requestedTierId, uint256 _) with (env e) {
        requireInvariant tierReserveRatioLeqOne(requestedTierId);
      }
      preserved _OperatorGrid.syncTier(address _vault) with (env e) {
        uint256 vaultTierId = _OperatorGrid.og_storage.vaultTier[_vault];
        requireInvariant tierReserveRatioLeqOne(vaultTierId);        
      }
      preserved _VaultHub.connectVault(address _vault) with (env e) {
        uint256 vaultTierId = _OperatorGrid.og_storage.vaultTier[_vault];
        requireInvariant tierReserveRatioLeqOne(vaultTierId);        
      }
    }



invariant everyNonDefaultTierHasGroup(uint256 tierId,address nodeOperator)
    (
        tierId > 0 && tierId < _OperatorGrid.og_storage.tiers.length
    ) => (
        _OperatorGrid.og_storage.groups[
            _OperatorGrid.og_storage.tiers[tierId].operator
        ].operator != 0
    )
    filtered { 
        f -> f.contract == _OperatorGrid
    }
    {
        preserved OperatorGrid.registerTiers(address _nodeOperator, OperatorGrid.TierParams[] _tiers) with (env e) {
            // The registerTiers function checks that the group exists before creating tiers (line 274)
            require _OperatorGrid.og_storage.groups[_nodeOperator].operator != 0;
            // Constrain the number of tiers to prevent timeouts
            require _tiers.length <= 50;
        }
        preserved OperatorGrid.initialize(address _admin, OperatorGrid.TierParams _defaultTierParams) with (env e) {
            // After initialization, no group should exist yet (groups are registered separately)
            // So the invariant should hold vacuously
            require _OperatorGrid.og_storage.groups[nodeOperator].operator == 0;
        }
    }


/// @dev Returns the value n ETH of a vaults liability shares (rounded up)
definition liabilityEth(address vault) returns uint256 = (
    CVLgetPooledEthBySharesRoundUp(_VaultHub.liabilityShares(vault))
);

/// @dev Functions that can reduce the vault's total value (excluding `applyVaultReport`).
definition isReducingVaultTotal(method f) returns bool = (
    f.selector == sig:VaultHubHarness.rebalance(address, uint256).selector ||
    f.selector == sig:VaultHubHarness.forceRebalance(address).selector ||
    // The following functions may reduce the total balance by calling `_settleObligations`
    f.selector == sig:VaultHubHarness.resumeBeaconChainDeposits(address).selector ||
    f.selector == sig:VaultHubHarness.settleLidoFees(address).selector
);


/// @title The locked amount of a vault covers its shares and reserve
/// @notice Violated in the following functions:
/// - `OperatorGrid.changeTier` see `https://github.com/lidofinance/core/issues/1272`
/// - `VaultHub.rebalance`- caused by internal ETH to internal shares increasing
///    (because another vault rebalanced).
///    See `https://github.com/lidofinance/core/issues/1309`.
///    See also `./immutable-ratio.spec` proving this issue, job run:
///    `https://prover.certora.com/output/98279/2558a54109a548b4b3806d020a21a93e`
/// - `VaultHub.resumeBeaconChainDeposits` - the same.
/// - `VaultHub.settleVaultObligations` - the same.
/// - `VaultHub.forceRebalance` - the same.
/// @notice The following violations prevented by requires (safety verified via preconditions)
/// - `VaultHub.applyVaultReport` - Unsafe casting to `uint128` in `_applyVaultReport`
/// - `VaultHub.mintShares` - Unsafe casting to `uint128` in `_increaseLiability`
invariant vaultLockedCoversLiabilityAndReserve(address vault)
  (_VaultHub.reserveRatioBP(vault) < TOTAL_BASIS_POINTS()) => 
    (_VaultHub.locked(vault) >= (liabilityEth(vault) * TOTAL_BASIS_POINTS() / (TOTAL_BASIS_POINTS() - _VaultHub.reserveRatioBP(vault))))
  filtered { f ->  isValidFuncVaultHubOperatorGrid(f) }
  {
      preserved {
          requireInvariant vaultReserveRatioGeThreshold(vault);
      }
      preserved _VaultHub.mintShares(
          address _vault, address _recipient, uint256 _amountOfShares
      )  with (env e) {
          requireInvariant vaultReserveRatioGeThreshold(vault);
          require(
              // Could use `2^128/TOTAL_BASIS_POINTS()` below
              _VaultHub.liabilityShares(vault) < 2^100,
              "Avoid underflow in unsafe casting in VaultHub:Line 1095"
          );
      }
      preserved _OperatorGrid.changeTier(address _vault, uint256 _requestedTierId, uint256 _requestedShareLimit) with (env e) {
          requireInvariant tierReserveRatioGeThreshold(_requestedTierId);
          requireInvariant maxLiabilitySharesGeqLiabilityShares(e, _vault);
          require (_VaultHub.reserveRatioBP(vault) < TOTAL_BASIS_POINTS());
      }
      preserved _OperatorGrid.syncTier(address _vault) with (env e) {
        requireInvariant maxLiabilitySharesGeqLiabilityShares(e, _vault);
      }
      preserved _VaultHub.applyVaultReport(
          address _vault,
          uint256 _reportTimestamp,
          uint256 _reportTotalValue,
          int256 _reportInOutDelta,
          uint256 _reportCumulativeLidoFees,
          uint256 _reportLiabilityShares,
          uint256 _reportMaxLiabilityShares,
          uint256 _reportSlashingReserve
      ) with (env e) {
          reasonableDeltaValues(_vault);
          applyVaultReportRquirements(_vault);
          requireInvariant vaultReserveRatioGeThreshold(_vault);
          require(_VaultHub.reserveRatioBP(_vault) < TOTAL_BASIS_POINTS());
          requireInvariant maxLiabilitySharesGeqLiabilityShares(e, _vault);
          require(
              // Could use `2^128/TOTAL_BASIS_POINTS()` below
              CVLgetPooledEthBySharesRoundUp(_reportLiabilityShares) < 2^100 &&
              CVLgetPooledEthBySharesRoundUp(_VaultHub.liabilityShares(vault)) < 2^100,
              "Avoid underflow in unsafe casting in VaultHub:Line 1042"
          );
          // These overflow otherwise due to unchecked downcasts
          require(_reportSlashingReserve < 2^128, "Prevent overflow of minimal reserve");
          require(_reportLiabilityShares < 2^92, "Prevent overflow of maxLiabilityShares");
          require(_reportTotalValue < 2^104,  "Prevent overflow of _reportTotalValue");
          require(-2^103 < _reportInOutDelta && _reportInOutDelta < 2^103, "Prevent under/overflow of _reportInOutDelta");
          
      }
  }

/*
/// @dev For creating a reasonable counter-example
invariant vaultLockedCoversLiabilityAndReserveiViolations(address vault)
    (_VaultHub.reserveRatioBP(vault) < TOTAL_BASIS_POINTS()) => (
        _VaultHub.locked(vault) >= (
            liabilityEth(vault) * TOTAL_BASIS_POINTS() / 
            (TOTAL_BASIS_POINTS() - _VaultHub.reserveRatioBP(vault))
        )
    )
    filtered { f ->  isValidFuncVaultHubOperatorGrid(f) }
    {
        preserved {
            niceViolationRequirements(vault);
            requireInvariant vaultReserveRatioGeThreshold(vault);
        }
        preserved _VaultHub.mintShares(
            address _vault, address _recipient, uint256 _amountOfShares
        )  with (env e) {
            niceViolationRequirements(vault);
            requireInvariant vaultReserveRatioGeThreshold(vault);
            require(
                _VaultHub.liabilityShares(vault) < max_uint256 / TOTAL_BASIS_POINTS(),
                "Avoid overflow in BP calculations"
            );
        }
        preserved _OperatorGrid.changeTier(
            address _vault, uint256 _requestedTierId, uint256 _requestedShareLimit
        ) with (env e) {
            requireInvariant tierReserveRatioGeThreshold(_requestedTierId);
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
            niceViolationRequirements(vault);
            applyVaultReportRquirements(_other);
            requireInvariant vaultReserveRatioGeThreshold(vault);
            require(
                _VaultHub.liabilityShares(vault) < max_uint256 / TOTAL_BASIS_POINTS(),
                "Avoid overflow in BP calculations"
            );
        }
    }
*/

invariant maxLiabilitySharesGeqLiabilityShares(env e, address vault)
    _VaultHub.maxLiabilityShares(e,vault) >= _VaultHub.liabilityShares(e, vault)
    filtered { 
        f -> f.contract == _VaultHub || f.contract == _OperatorGrid
        && 
        // Exclude proveUnknownValidatorToPDG - doesn't modify liability or maxLiability as it times out
        f.selector != sig:VaultHubHarness.proveUnknownValidatorToPDG(
            address, IPredepositGuarantee.ValidatorWitness
        ).selector
    }
    {
        preserved _VaultHub.applyVaultReport(
            address _vault,
            uint256 _reportTimestamp,
            uint256 _reportTotalValue,
            int256 _reportInOutDelta,
            uint256 _reportCumulativeLidoFees,
            uint256 _reportLiabilityShares,
            uint256 _reportMaxLiabilityShares,
            uint256 _reportSlashingReserve
        ) with (env e2) {
            // Prevent overflow in unsafe downcasts to uint96 on line 1109
            require _reportLiabilityShares <= max_uint96;
            require _reportMaxLiabilityShares <= max_uint96;
            
            requireInvariant disconnectedVaultHasNoLiability(_vault);
            requireInvariant disconnectedVaultHasNoLocked(_vault);
        }
    }
    

// -- Rules for tiers ----------------------------------------------------------

definition numTiers() returns uint256 = _OperatorGrid.tiersCount();

/// @dev Using this definition, otherwise pushing a new tier will be ignored
definition tierReserveRatioBP(uint256 tierId) returns uint16 = (
    tierId < numTiers() ? _OperatorGrid.tier(tierId).reserveRatioBP : 0
);

/// @dev Using this definition, otherwise pushing a new tier will be ignored
definition tierforcedRebalanceThresholdBP(uint256 tierId) returns uint16 = (
    tierId < numTiers() ? _OperatorGrid.tier(tierId).forcedRebalanceThresholdBP : 0
);

/// @title For each tier the reserve ratio is greater than the force rebalance threshold
/// @notice Violated because the `initialize` function does not validate the parameters
/// (i.e. it does not call `_validateParams`).
/// See `https://github.com/lidofinance/core/issues/1291`.
invariant tierReserveRatioGeThreshold(uint256 tierId)
    tierId < numTiers() => (
        tierReserveRatioBP(tierId) > 0 => tierReserveRatioBP(tierId) > tierforcedRebalanceThresholdBP(tierId)
    )
    filtered { f -> f.contract == _OperatorGrid }
    {
        preserved constructor() {
            require tierId >= numTiers() || tierReserveRatioBP(tierId) == 0 || 
                    tierReserveRatioBP(tierId) > tierforcedRebalanceThresholdBP(tierId);
        }
    }


/// @title For every vault its reserve ratio is greater than its force rebalance threshold
invariant vaultReserveRatioGeThreshold(address vault)
    _VaultHub.reserveRatioBP(vault) > 0 => _VaultHub.reserveRatioBP(vault) > _VaultHub.forcedRebalanceThresholdBP(vault)
    filtered { 
        f -> (
            f.contract == _OperatorGrid ||
            (
                f.contract == _VaultHub &&
                // This function is only called by the `OperatorGrid`
                f.selector != sig:VaultHubHarness.updateConnection(
                    address, uint256, uint256, uint256, uint256, uint256, uint256
                ).selector
            )
        )
    }
    {
      preserved _OperatorGrid.syncTier(address _vault) with (env e) {
        require _VaultHub.isVaultConnected(_vault);
        uint256 tierId = _OperatorGrid.og_storage.vaultTier[_vault];
        require numTiers() < 100;  
        require tierId < numTiers();

        requireInvariant tierReserveRatioGeThreshold(tierId);
        require _VaultHub.reserveRatioBP(_vault) >= _VaultHub.forcedRebalanceThresholdBP(_vault);
      }
      preserved _OperatorGrid.changeTier(
          address _vault,
          uint256 _requestedTierId,
          uint256 _requestedShareLimit
      ) with (env e) {
          requireInvariant tierReserveRatioGeThreshold(_requestedTierId);
      }
      preserved VaultHubHarness.connectVault(address _vault) with (env e) {
          uint256 tierId = _OperatorGrid.og_storage.vaultTier[_vault];
          requireInvariant tierReserveRatioGeThreshold(tierId);
      }
    }

// -- Misc Rules ---------------------------------------------------------------


/**
* @report: https://prover.certora.com/output/8195906/0c62dbd983f64b97bfac7696ae5545d4?anonymousKey=7fc0b9e06d4893ed529f0a1191c37b2ef5fdbbf6
*/
invariant redemptionSharesLeqLiabilityShares(address vault)
  _VaultHub.redemptionShares(vault) <= _VaultHub.liabilityShares(vault)
  filtered {
    f -> f.contract == _VaultHub && !f.isView
  }

/**
* @report https://prover.certora.com/output/8195906/0c62dbd983f64b97bfac7696ae5545d4?anonymousKey=7fc0b9e06d4893ed529f0a1191c37b2ef5fdbbf6
*/
invariant pendingHasNoShares(address vault)
    _VaultHub.isPendingDisconnect(vault) => (
        _VaultHub.liabilityShares(vault) == 0 &&
        _VaultHub.obligationsShares(vault) == 0
    )
    filtered {
        f -> f.contract == _VaultHub && !f.isView
    }
    {
      preserved _VaultHub.disconnect(address _vault) with (env _e) {
        requireInvariant redemptionSharesLeqLiabilityShares(_vault);
      }
      preserved _VaultHub.voluntaryDisconnect(address _vault) with (env _e) {
        requireInvariant redemptionSharesLeqLiabilityShares(_vault);
      }
    }



/// @dev functions that can increase a vault's total value
definition isIncreasingTotal(method f) returns bool = (
    f.selector == sig:VaultHubHarness.fund(address).selector ||
    f.selector == sig:VaultHubHarness.applyVaultReport(
        address, uint256, uint256, int256, uint256, uint256, uint256, uint256
    ).selector ||
    f.selector == sig:VaultHubHarness.connectVault(address).selector
);

/// @title Which functions can increase a vault's total value
/// @notice Violated for `settleVaultObligations`. See 
/// `https://github.com/lidofinance/core/issues/1298`. The violation occurs because
/// the total value becomes negative, and then unsafely cast to `uint`.
rule canIncreaseTotalValue(method f, address vault) filtered {
    f -> f.contract == _VaultHub && !f.isView
} {
    reasonableDeltaValues(vault);
    require(_VaultHub.totalValue(vault) > 0, "Assume vault has non-zero value");
    requireInvariant pendingHasNoShares(vault);
    uint256 valuePre = _VaultHub.totalValue(vault);
    
    env e;
    calldataarg args;
    f(e, args);

    uint256 valuePost = _VaultHub.totalValue(vault);

    assert(
        valuePost > valuePre => isIncreasingTotal(f),
        "Only specific functions can increase a vault's total value"
    );
}


/// @title Fees can only be increased by `applyVaultReport`
/// @notice Previously this rule referred to vault obligations and was violated, see below.
/// @notice Previously violated for the following functions,
/// see `https://github.com/lidofinance/core/issues/1321`
/// - `applyVaultReport`
/// - `resumeBeaconChainDeposits`
/// - `settleVaultObligations`
rule redemptionsIncrease(method f, address vault) filtered {
    f -> f.contract == _VaultHub && !f.isView
} {
    reasonableDeltaValues(vault);
    requireInvariant pendingHasNoShares(vault);
    uint256 feesPre = _VaultHub.unsettledLidoFees(vault);

    env e;
    calldataarg args;
    f(e, args);

    uint256 feesPost = _VaultHub.unsettledLidoFees(vault);
    assert(
        feesPost > feesPre =>
        f.selector == sig:VaultHubHarness.applyVaultReport(
            address, uint256, uint256, int256, uint256, uint256, uint256, uint256
        ).selector,
        "Only applyVaultReport can increase fees"
    );
}

/*
/// @title Generate simple counter examples to `redemptionsIncrease`
rule redemptionsIncreaseViolation(method f, address vault) filtered {
    f -> (
        f.selector == sig:VaultHubHarness.applyVaultReport(
            address,uint256,uint256,int256,uint256,uint256,uint256,uint256
        ).selector ||
        f.selector == sig:VaultHubHarness.resumeBeaconChainDeposits(address).selector ||
        f.selector == sig:VaultHubHarness.settleVaultObligations(address).selector
    )
} {
    reasonableDeltaValues(vault);
    niceViolationRequirements(vault);
    requireInvariant pendingHasNoShares(vault);
    requireInvariant vaultLockedCoversLiabilityAndReserve(vault);
    require(
        _VaultHub.locked(vault) <= _VaultHub.totalValue(vault),
        "Assume total value covers locked"
    );
    requireInvariant vaultReserveRatioGeThreshold(vault);
    uint128 redemptionsPre = _VaultHub.redemptions(vault);

    env e;
    calldataarg args;
    f(e, args);

    uint128 redemptionsPost = _VaultHub.redemptions(vault);
    assert(redemptionsPost <= redemptionsPre);
}
*/






// -- Violation examples -------------------------------------------------------
/*
/// Example that `_rebalanceExternalEtherToInternal` can cause another vault to become unhealthy
//rule example

function requireVaultTotalNotLessThanLocked(address vault) {
    require (
        _VaultHub.isVaultConnected(vault) => (
            _VaultHub.totalValue(vault) >=  _VaultHub.locked(vault)
        ), "Assume vault locked is at most its total value"
    );
}


/// @title Example that `updateConnection` followed by `withdraw` may turn a vault unhealthy
rule healthViolationByTierChange(
    address vault,
    uint256 newTierId,
    uint256 newShareLimit,
    uint256 etherAmount
) { 
    reasonableDeltaValues(vault);
    require(
        _VaultHub.totalValue(vault) == 1000 && 
        _VaultHub.forcedRebalanceThresholdBP(vault) == 1000 &&  // 10%
        tierforcedRebalanceThresholdBP(newTierId) == 2000,  // 20%
        "Assume small or simple values for simpler example"
    );
    requireInvariant vaultReserveRatioGeThreshold(vault);
    requireInvariant vaultLockedCoversLiabilityAndReserve(vault);
    requireVaultTotalNotLessThanLocked(vault);
    require(_VaultHub.isVaultHealthy(vault), "Pre condition - assume vault is healthy");
    require(CVLgetPooledEthByShares(1) >= 1, "Assume 1 share is more than 1 ETH");
    require(_VaultHub.isVaultConnected(vault), "Assume connected vault");
    requireInvariant tierReserveRatioGeThreshold(newTierId);

    env e;
    require(e.msg.sender != vault);

    _OperatorGrid.changeTier(e, vault, newTierId, newShareLimit);

    bool intermediateHealth = _VaultHub.isVaultHealthy(vault);

    _VaultHub.withdraw(e, vault, e.msg.sender, etherAmount);
    
    assert _VaultHub.isVaultHealthy(vault);
}


/// @title An example that a healthy vault can turn unhealthy via calls to `_settleObligations`
rule healthViolationBySettling(address vault) {
    reasonableDeltaValues(vault);
    require(
        _VaultHub.totalValue(vault) == 1000 && 
        _VaultHub.forcedRebalanceThresholdBP(vault) == 1000,  // 10%
        "Assume small or simple values for simpler example"
    );
    require(
        _internalShares() >= 100 * _VaultHub.liabilityShares(vault) &&
        _internalEth >= 100 * _VaultHub.totalValue(vault),
        "Assume Lido holds many more shares and ETH than the vault"
    );
    requireInvariant vaultLockedCoversLiabilityAndReserve(vault);
    requireInvariant vaultReserveRatioGeThreshold(vault);
    requireVaultTotalNotLessThanLocked(vault);
    require(_VaultHub.isVaultHealthy(vault), "Pre condition - assume vault is healthy");
    //require(CVLgetPooledEthByShares(1) >= 1, "Assume 1 share is more than 1 ETH");
    require(_VaultHub.isVaultConnected(vault), "Assume connected vault");
    require(_VaultHub.isPendingDisconnect(vault), "Assume vault is pending disconnect");

    env e1;
    _VaultHub.voluntaryDisconnect(e1, vault);

    env e2;
    _VaultHub.settleVaultObligations(e2, vault);

    satisfy !_VaultHub.isVaultHealthy(vault);
}


rule healthViolationByRebalancing(address vault, uint256 shares) {
    reasonableDeltaValues(vault);
    require(
        _VaultHub.totalValue(vault) == 1000 && 
        _VaultHub.forcedRebalanceThresholdBP(vault) == 1000,  // 10%
        "Assume small or simple values for simpler example"
    );
    require(
        _internalShares() >= 100 * _VaultHub.liabilityShares(vault) &&
        _internalEth >= 100 * _VaultHub.totalValue(vault),
        "Assume Lido holds many more shares and ETH than the vault"
    );
    requireInvariant vaultLockedCoversLiabilityAndReserve(vault);
    requireInvariant vaultReserveRatioGeThreshold(vault);
    requireVaultTotalNotLessThanLocked(vault);
    require(_VaultHub.isVaultHealthy(vault), "Pre condition - assume vault is healthy");
    require(CVLgetPooledEthByShares(1) >= 1, "Assume 1 share is more than 1 ETH");
    require(_VaultHub.isVaultConnected(vault), "Assume connected vault");

    env e;
    require(
        e.msg.value <= maxReasonableValue(),
        "Avoid overflow due to unreasonable ETH amount (e.g. in `VaultHub.fund`"
    );
    //calldataarg args;
    //f(e, args);
    _VaultHub.rebalance(e, vault, shares);

    //assert _VaultHub.isVaultHealthy(vault);
    assert(
        CVLgetPooledEthBySharesRoundUp(_VaultHub.liabilityShares(vault)) <= 
        (_VaultHub.totalValue(vault) * 9000 / 10000) + 2
    );
}
*/
