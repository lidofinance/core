/* `VaultHUb` properties

NOTE: This spec assumes the conversion rate of shares to ETH is CONSTANT!.
*/

import "./vaults-array.spec";

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

    // `ILidoMock`
    function ILidoMock.mintExternalShares(
        address _recipient, uint256 _amountOfShares
    ) external => CVLmintExternalSharesImm(_amountOfShares);
    function ILidoMock.burnExternalShares(
        uint256 _amountOfShares
    ) external => CVLburnExternalSharesImm(_amountOfShares);
    function ILidoMock.getSharesByPooledEth(
        uint256 _ethAmount
    ) external returns (uint256) => CVLgetSharesByPooledEthImm(_ethAmount);
    function ILidoMock.getPooledEthByShares(
        uint256 _sharesAmount
    ) external returns (uint256) => CVLgetPooledEthBySharesImm(_sharesAmount);
    function ILidoMock.getPooledEthBySharesRoundUp(
        uint256 _sharesAmount
    ) external returns (uint256) => CVLgetPooledEthBySharesRoundUpImm(_sharesAmount);
    function ILidoMock.rebalanceExternalEtherToInternal(
    ) external with (env e) => CVLrebalanceExternalEtherToInternalImm(e.msg.value);
    function ILidoMock.getTotalShares() external returns (uint256) => NONDET;

    // TODO: this summary may not be sound
    function ILidoMock.transferSharesFrom(
        address, address, uint256
    ) external returns (uint256) => NONDET;

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
    function _.availableBalance() external => DISPATCHER(true);
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
    function OperatorGrid.tiersCount() external returns (uint256) envfree;

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
    // NOTE: The Prover is unable to find `CLProofVerifier` for some reason (it did work in
    // previous versions of the code `d1b4b34ebc911f01aca285d8d7b758f8c5fc7619`),
    // so we switched to using a wild card.
    function _._validatePubKeyWCProof(
        IPredepositGuarantee.ValidatorWitness calldata,
        bytes32
    ) internal => NONDET;
}

// -- Summary ghosts and functions ---------------------------------------------

ghost uint256 _internalShares {
    // TODO: note this requirement
    axiom _internalShares > 0 && _internalShares <= max_uint128;
}


ghost uint256 _internalEthGhost {
    // TODO: note these requirements, especially the second one is an assumption.
    axiom _internalEthGhost > 0 && _internalEthGhost <= max_uint128;
}


/// @dev Summarizes `Lido.getSharesByPooledEth`
/// @notice While the original function will revert if `_ethAmount` exceeds `UINT128_MAX`,
/// this summary will not.
function CVLgetSharesByPooledEthImm(uint256 _ethAmount) returns uint256 {
    require(
        _ethAmount <= max_uint128,
        "Lido.getSharesByPooledEth reverts if _ethAmount is bigger"
    );
    uint256 numeratorInEther = _internalEthGhost;
    uint256 denominatorInShares = _internalShares;
    return require_uint256((_ethAmount * denominatorInShares) / numeratorInEther);
}


/// @dev Summarizes `Lido.getPooledEthBySharesRoundUp`
/// @notice While the original function will revert if `_sharesAmount` exceeds `UINT128_MAX`,
/// this summary will not.
function CVLgetPooledEthBySharesRoundUpImm(uint256 _sharesAmount) returns uint256 {
    require(
        _sharesAmount <= max_uint128,
        "Lido.getPooledEthBySharesRoundUp reverts if _sharesAmount is bigger"
    );
    uint256 numeratorInEther = _internalEthGhost;
    uint256 denominatorInShares = _internalShares;

    return assert_uint256(
        // Add `denominatorInShares - 1` to round up
        (_sharesAmount * numeratorInEther + denominatorInShares - 1)
        / denominatorInShares
    );
}


/// @dev Summarizes `Lido.getPooledEthByShares`
/// @notice While the original function will revert if `_sharesAmount` exceeds `UINT128_MAX`,
/// this summary will not.
function CVLgetPooledEthBySharesImm(uint256 _sharesAmount) returns uint256 {
    require(
        _sharesAmount <= max_uint128,
        "Lido.getPooledEthBySharesRoundUp reverts if _sharesAmount is bigger"
    );
    uint256 numeratorInEther = _internalEthGhost;
    uint256 denominatorInShares = _internalShares;

    return assert_uint256(
        (_sharesAmount * numeratorInEther) / denominatorInShares
    );
}


/// @dev Summarizes `Lido.mintExternalShares`
/// @notice While the original function will revert if either `_recipient` or
/// `_amountOfShares` is zero, or `_amountOfShares` is too high, this summary will not.
/// @notice This summary does nothing!
function CVLmintExternalSharesImm(uint256 _amountOfShares) {
}


/// @dev Summarizes `Lido.burnExternalShares`
/// @notice While the original function will revert if `_amountOfShares` is zero
/// or too large this summary will not.
/// @notice This summary does nothing!
function CVLburnExternalSharesImm(uint256 _amountOfShares) {
}


/// @dev Summarizes `Lido.rebalanceExternalEtherToInternal`
/// @notice While the original function will revert if `msg_value` is zero or too large
/// this summary will not.
/// @notice This summary does nothing!
function CVLrebalanceExternalEtherToInternalImm(uint256 msg_value) {
}

// -- Utility functions --------------------------------------------------------

/// @dev The same as `VaultHub.TOTAL_BASIS_POINTS`
definition TOTAL_BASIS_POINTS() returns uint256 = 10000;

// -- Invariants ---------------------------------------------------------------

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
/// @dev Disabled here! See `VaultHub.spec`.
/// @notice Violated because the `initialize` function does not validate the parameters
/// (i.e. it does not call `_validateParams`).
/// See `https://github.com/lidofinance/core/issues/1291`.
invariant reserveRatioNotGreaterThanThreshold(uint256 tierId)
    tierReserveRatioBP(tierId) >= tierforcedRebalanceThresholdBP(tierId)
    filtered { f -> f.contract == _OperatorGrid }


/// @title For every vault its reserve ratio is greater than its force rebalance threshold
invariant vaultReserveRatioNotGreaterThanThreshold(address vault)
    _VaultHub.reserveRatioBP(vault) >= _VaultHub.forcedRebalanceThresholdBP(vault)
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
        preserved OperatorGrid.changeTier(
            address _vault,
            uint256 _requestedTierId,
            uint256 _requestedShareLimit
        ) with (env e) {
            requireInvariant reserveRatioNotGreaterThanThreshold(_requestedTierId);
        }
    }

/// @dev Returns the value n ETH of a vaults liability shares (rounded up)
definition liabilityEth(address vault) returns uint256 = (
    CVLgetPooledEthBySharesRoundUpImm(_VaultHub.liabilityShares(vault))
);


/// @title The locked amount of a vault covers its shares and reserve with immutable ratio
/// @dev This is needed just to verify that the violations of
/// `vaultLockedCoversLiabilityAndReserve` in the relevant functions are due to the
/// shares to ETH ratio changes.
/// @dev To prevent timeouts, this rule needs to be run for each of the three methods individually
invariant vaultLockedCoversLiabilityAndReserveImmutableRatio(address vault)
    (_VaultHub.reserveRatioBP(vault) < TOTAL_BASIS_POINTS()) => (
        _VaultHub.locked(vault) >= (
            liabilityEth(vault) * TOTAL_BASIS_POINTS() / 
            (TOTAL_BASIS_POINTS() - _VaultHub.reserveRatioBP(vault))
        )
    )
    filtered {
        f -> (
            f.selector == sig:VaultHubHarness.rebalance(address, uint256).selector ||
            f.selector == sig:VaultHubHarness.forceRebalance(address).selector ||
            f.selector == sig:VaultHubHarness.resumeBeaconChainDeposits(address).selector
        )
    }
    {
        preserved {
            requireInvariant vaultReserveRatioNotGreaterThanThreshold(vault);
            require(_internalShares > 0 && _internalEthGhost > 0, "Avoid division by zero");
        }
    }
