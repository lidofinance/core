/* `Lido` and `VaultHub` properties
*/

import "./comprehensive-setup.spec";

// -- Ghosts and hooks ---------------------------------------------------------

// Sum of all `VaultHub.records[vault].liabilityShares`
persistent ghost mathint sumVaultsLiabilityShares {
    init_state axiom sumVaultsLiabilityShares == 0;
}

hook Sstore _VaultHub.vh_storage.records[KEY address vault].liabilityShares uint96 newShares (uint96 oldShares) {
    sumVaultsLiabilityShares = sumVaultsLiabilityShares + newShares - oldShares;
}

// -- Utility functions --------------------------------------------------------

/// @dev `Lido` functions that can only be called by `VaultHub` 
definition onlyCalledByVaultHub(method f) returns bool = (
    f.contract == _Lido && (
        f.selector == sig:LidoHarness.mintExternalShares(address, uint256).selector ||
        f.selector == sig:LidoHarness.burnExternalShares(uint256).selector ||
        f.selector == sig:LidoHarness.rebalanceExternalEtherToInternal(uint256).selector
    )
);


/// @dev `Lido` functions that can only be called by `Accounting` 
definition onlyCalledByAccounting(method f) returns bool = (
    f.contract == _Lido && (
        f.selector == sig:LidoHarness.internalizeExternalBadDebt(uint256).selector ||
        f.selector == sig:LidoHarness.collectRewardsAndProcessWithdrawals(
            uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256 
        ).selector ||
        f.selector == sig:LidoHarness.emitTokenRebase(
            uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256 
        ).selector ||
        f.selector == sig:LidoHarness.mintShares(address, uint256).selector ||
        f.selector == sig:LidoHarness.processClStateUpdate(
            uint256, uint256, uint256, uint256
        ).selector
    )
);


/// @dev A `VaultHub` function that can only be called by `Accounting`
definition vaultHubOnlyCalledByAccounting(method f) returns bool = (
    f.contract == _VaultHub &&
    f.selector == sig:VaultHubHarness.decreaseInternalizedBadDebt(uint256).selector
);

// -- Rules --------------------------------------------------------------------

/// @title Verifies the `Lido` functions that can only be called by `VaultHub`
rule verifyOnlyCalledByVaultHub(method f) filtered {
    f -> onlyCalledByVaultHub(f)
} {
    env e;
    calldataarg args;
    f(e, args);
    assert(e.msg.sender == _VaultHub, "only VaultHub can call these functions");
}


/// @title Verifies functions that can only be called by `Accounting`
rule verifyOnlyCalledByAccounting(method f) filtered {
    f -> onlyCalledByAccounting(f) || vaultHubOnlyCalledByAccounting(f)
} {
    env e;
    calldataarg args;
    f(e, args);
    assert(e.msg.sender == _Accounting, "only Accounting can call these functions");
}


/// @title Diconnected vault has no liability shares
invariant disconnectedVaultHasNoLiability(address vault)
    !_VaultHub.isVaultConnected(vault) => _VaultHub.liabilityShares(vault) == 0
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
            // The following two requirements show the indexes of `vault` and `_other`
            // are different if `vault != _other`.
            requireInvariant vaultToIndexIsCorrect(vault);
            requireInvariant vaultToIndexIsCorrect(_other);

            require(
                isInitialized(),
                "Assumes `initialize` is called immediately after constructor"
            );
            requireInvariant vaultsArrayIsNeverEmpty();

            requireInvariant disconnectedVaultIsNotPending(_other);
        }
    }


/// @dev The inequality stems from rounding errors, for example
/// `VaultHub._settleObligations` may reduce external shares by more than the liability
/// shares.
/// @notice We added a requirement to prevent `Lido`'s external shares from overflowing. 
invariant externalSharesAtMostSumLiabilityShares()
    getExternalShares() <= sumVaultsLiabilityShares + _VaultHub.badDebtToInternalize()
    filtered {
        f -> (
            !onlyCalledByVaultHub(f) && !vaultHubOnlyCalledByAccounting(f) &&
            (
                f.contract == _Lido => (
                    // `internalizeExternalBadDebt` is only called by `Accounting`
                    f.selector != sig:LidoHarness.internalizeExternalBadDebt(uint256).selector &&
                    // `finalizeUpgrade_v3` sets external shares to zero
                    // `transferToVault` is not supported (reverts)
                    f.selector != sig:LidoHarness.transferToVault(address).selector
                )
            )
        )
    }
    {
        preserved _VaultHub.mintShares(
            address _vault,
            address _recipient,
            uint256 _amountOfShares
        ) with (env e) {
            require(
                getExternalShares() + _amountOfShares < 2^128,
                "Prevent Lido's external shares from overflowing"
            );
        }

        // Prevent having a disconnected vault with non-zero liability shares
        preserved _VaultHub.connectVault(address _vault) with (env e) {
            requireInvariant disconnectedVaultHasNoLiability(_vault);
        }

        preserved _VaultHub.rebalance(address _vault, uint256 _shares) with (env e) {
            require(
                _shares * _Lido.getInternalEther() < max_uint256,
                "Prevent Lido.getPooledEthBySharesRoundUp from overflowing"
            );
        }
    }


/// @title Example showing external shares can be strictly less than sum libility shares
/// plus internalized bad debt
rule strictlyTooManyLiabilityShares(method f, address vault) filtered {
    f -> f.contract == _VaultHub && (
        f.selector == sig:VaultHubHarness.rebalance(address,uint256).selector ||
        f.selector == sig:VaultHubHarness.forceRebalance(address).selector
    )
} {
    require(
        getExternalShares() == sumVaultsLiabilityShares + _VaultHub.badDebtToInternalize(),
        "Assume equality of external to liability shares, see externalSharesAtMostSumLiabilityShares"
    );
    require(getExternalShares() <= 10000, "Make the example simpler");
    require(sumVaultsLiabilityShares > 0, "Assume there are some liability shares");
    require(
        _VaultHub.liabilityShares(vault) <= sumVaultsLiabilityShares,
        "Sum liability shares is less than a single vault's"
    );

    uint256 numeratorInEther = _Lido.getShareRateNumerator();
    uint256 denominatorInShares = _Lido.getShareRateDenominator();
    require(numeratorInEther < denominatorInShares, "Assume share is worth less than 1 wei");
    require(
        100 * numeratorInEther >= 90 * denominatorInShares,
        "Shares to eth ratio is at least 90%"
    );

    env e;
    if (f.selector == sig:VaultHubHarness.rebalance(address,uint256).selector) {
        uint256 amount;
        _VaultHub.rebalance(e, vault, amount);
    } else {
        _VaultHub.forceRebalance(e, vault);
    }

    satisfy getExternalShares() < sumVaultsLiabilityShares + _VaultHub.badDebtToInternalize();
}

/// @title Showing external shares and liability shares increase together, and decrease
/// together when the shares ratio is 1 or more
rule externalSharesLiabilitySharesChangeTogether(method f) filtered {
    f -> (
        !f.isView && !onlyCalledByVaultHub(f) && !vaultHubOnlyCalledByAccounting(f) &&
        (
            f.contract == _Lido => (
                // `internalizeExternalBadDebt` is only called by `Accounting`
                f.selector != sig:LidoHarness.internalizeExternalBadDebt(uint256).selector &&
                // `finalizeUpgrade_v3` sets external shares to zero
                // `transferToVault` is not supported (reverts)
                f.selector != sig:LidoHarness.transferToVault(address).selector
            )
        )
    )
} {
    mathint externalsPre = getExternalShares();
    mathint liabilitiesPre = sumVaultsLiabilityShares + _VaultHub.badDebtToInternalize();

    env e;
    require(
        externalsPre <= 2^100 && e.msg.value <= 2^100,
        "Assume reasonable values to avoid overflows"
    );

    if (f.selector == sig:VaultHubHarness.mintShares(address, address, uint256).selector) {
        // Special handling to avoid overflows
        address vault;
        address recipient;
        uint256 amountOfShares;
        require(amountOfShares <= 2^100, "Assume reasonable value to avoid overflow");
        _VaultHub.mintShares(e, vault, recipient, amountOfShares);
    } else if (f.selector == sig:VaultHubHarness.connectVault(address).selector) {
        address vault;
        requireInvariant disconnectedVaultHasNoLiability(vault);
        _VaultHub.connectVault(e, vault);
    } else {
        calldataarg args;
        f(e, args);
    }

    mathint externalsPost = getExternalShares();
    mathint liabilitiesPost = sumVaultsLiabilityShares + _VaultHub.badDebtToInternalize();

    assert(
        externalsPre > externalsPost <=> liabilitiesPre > liabilitiesPost,
        "external shares and liabilities total increase together"
    );
    assert(
        externalsPre < externalsPost <=> liabilitiesPre < liabilitiesPost,
        "external shares and liabilities total decerase together"
    );
}
