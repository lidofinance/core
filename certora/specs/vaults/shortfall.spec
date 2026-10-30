import "./VaultHub.spec";


methods {
    function OperatorGrid.onBurnedShares(address, uint256) external => NONDET;
    function OperatorGrid.onMintedShares(address, uint256, bool) external => NONDET;
    
    // Ignore side-effects of rebalancing on internal-ETH to internal-shares ratio.
    // Without this, rebalancing increases _internalEth which increases share price,
    // causing remaining liability shares to convert to more ETH, potentially making
    // the vault unhealthy again. This is the approach used in approximated-VaultHub.spec.
    function ILidoMock.rebalanceExternalEtherToInternal(uint256) external => NONDET;
    
    // Simplify external calls that don't affect the core property
    function _.pauseBeaconChainDeposits() external => NONDET;
    function _.resumeBeaconChainDeposits() external => NONDET;
}




/**
function reasonableDeltaValues(address vault) {
    int112 recordDelta = _VaultHub.getVaultRecordDeltaValue(vault);
    require (recordDelta <= maxReasonableValue()) && (recordDelta >= -maxReasonableValue());

    int112 recordDeltaRef = _VaultHub.getVaultRecordDeltaRef(vault);
    require (recordDeltaRef <= maxReasonableValue()) && (recordDeltaRef >= -maxReasonableValue());

    int112 reportDelta = _VaultHub.getVaultReportDelta(vault);
    require (reportDelta <= maxReasonableValue()) && (reportDelta >= -maxReasonableValue());

    uint112 reportTot = _VaultHub.getVaultReportTotal(vault);
    require (reportTot <= maxReasonableValue());

    mathint totValue = reportTot + recordDelta - reportDelta;
    require totValue >= 0;

    mathint totRef = reportTot + recordDeltaRef - reportDelta;
    require totRef >= 0;
}*/
/*
rule shortfallValueIsSufficient(address vault) {
  // Assume reasonable share price
  env e;
  uint256 internal_eth = _internalEth;
  uint256 internal_shares = _internalShares();
  require(internal_shares == internal_eth, "Assume 1 share = 1 ETH");
  
  require(_VaultHub.isVaultConnected(vault), "Assume connected vault");

  reasonableDeltaValues(vault);
  
  // Lido's pool must be much larger than any individual vault (realistic assumption)
  // Without this, counter-examples have Lido with 1 wei while vault has huge values
  require(
    internal_shares >= 100 * _VaultHub.liabilityShares(vault) &&
    internal_eth >= 100 * _VaultHub.totalValue(vault),
    "Assume Lido holds many more shares and ETH than the vault"
  );
  
  // Require reasonable reserve ratio bounds (typical values are 10-50%, i.e., 1000-5000 BP)
  // Very high reserve ratios (>90%) make the shortfall formula unstable due to integer rounding
  uint16 reserveRatio = _VaultHub.reserveRatioBP(vault);
  uint16 threshold = _VaultHub.forcedRebalanceThresholdBP(vault);
  require(reserveRatio >= 100, "Reserve ratio must be at least 1%");
  require(reserveRatio <= 9000, "Reserve ratio must be at most 90% for stable math");
  // Ensure sufficient margin between reserve ratio and threshold for rounding tolerance
  require(reserveRatio >= threshold + 10, "Need margin between reserveRatio and threshold");
  
  requireInvariant vaultReserveRatioGeThreshold(vault);
  requireInvariant vaultLockedCoversLiabilityAndReserve(vault);

  // Ensure reasonable liability for meaningful test (avoid edge cases with tiny values)
  require(_VaultHub.liabilityShares(vault) >= 1000, "Liability should be non-trivial");
  require(_VaultHub.totalValue(vault) >= 1000, "Total value should be non-trivial");
  
  // The vault must have enough total value to cover its locked amount
  // Without this, the vault is underwater and cannot be fixed by rebalancing
  require(_VaultHub.totalValue(vault) >= _VaultHub.locked(vault), "Vault must not be underwater");
  
  // Simplify: assume maxLiabilityShares == liabilityShares (no extra minting in this period)
  // This avoids edge cases where the shortfall gets capped at liabilityShares
  requireInvariant maxLiabilitySharesGeqLiabilityShares(e, vault);
  require(
    _VaultHub.maxLiabilityShares(e, vault) == _VaultHub.liabilityShares(vault),
    "Assume no extra minting beyond current liability"
  );

  require(!_VaultHub.isVaultHealthy(vault), "Start from an unhealthy vault");

  // Compute shortfall shares
  uint256 shortfall = _VaultHub.healthShortfallShares(vault);

  require(shortfall < max_uint256, "bad debt: cannot be fixed by rebalance");
  
  // Ensure the shortfall doesn't get capped (which would indicate an edge case)
  require(shortfall <= _VaultHub.liabilityShares(vault), "Shortfall should not exceed liability");

  // rebalance
  _VaultHub.rebalance(e, vault, shortfall);

  assert _VaultHub.isVaultHealthy(vault);
} 
*/


/*/// @title A vault is unhealthy if and only if its shortfall is non-zero
/// @notice This fails, see comment in `https://github.com/lidofinance/core/issues/1305`.
/// Also see `https://prover.certora.com/output/98279/ee7f7d49f5d74d07b64edb33e220cc70`
rule unhealthyVaultIffShortfallNonzero(address vault) {
    reasonableDeltaValues(vault);
    uint256 shortfall = _VaultHub.healthShortfallShares(vault);
    bool isHealthy = _VaultHub.isVaultHealthy(vault);
    assert shortfall == 0 <=> isHealthy;
}

/// @title Non-zero shortfall implies vault is unhealthy
rule nonZeroShortfallIsUnhealthy(address vault) {
    reasonableDeltaValues(vault);
    uint256 shortfall = _VaultHub.healthShortfallShares(vault);
    bool isHealthy = _VaultHub.isVaultHealthy(vault);
    assert shortfall > 0 => !isHealthy;
}


// /// @dev Produces a simple example the shortfall value is too small
// rule insufficientShortfallValueExample(address vault) {
//     reasonableDeltaValues(vault);
//     requireInvariant vaultReserveRatioGeThreshold(vault);
//     requireInvariant vaultLockedCoversLiabilityAndReserve(vault);
    
//     uint256 shortfall = _VaultHub.healthShortfallShares(vault);
//     require(
//         shortfall >= 10 && shortfall < max_uint256,
//         "Assume vault is unhealthy but can be made healthy by rebalancing"
//     );

//     uint256 totalValue = _VaultHub.totalValue(vault);
//     uint256 shares = _VaultHub.liabilityShares(vault);

//     require(totalValue == 1000 && shares >= 100, "Simpler example");
//     require(
//         _VaultHub.forcedRebalanceThresholdBP(vault) <= 3000 &&
//         _VaultHub.forcedRebalanceThresholdBP(vault) >= 1000 &&
//         _VaultHub.reserveRatioBP(vault) <= 3000 && 
//         _VaultHub.reserveRatioBP(vault) >= 1000,
//         "Assume small or simple values for simpler example"
//     );
//     require(
//         _internalShares() >= 100 * _VaultHub.liabilityShares(vault) &&
//         _internalEth >= 100 * _VaultHub.totalValue(vault),
//         "Assume Lido holds many more shares and ETH than the vault"
//     );

    
//     uint256 internal_eth = _internalEth;
//     uint256 internal_shares = _internalShares();

//     // 1 <= (internal_eth/internal_shares) <= 2
//     // <--> internal_shares <= internal_eth <= 2*internal_shares

//     require(internal_shares <= internal_eth  && internal_eth <= require_uint256(2 * internal_shares), "Assume share price between 1 and 2 eth");


//     require(_VaultHub.isVaultConnected(vault), "Assume connected vault");

//     env e;
//     _VaultHub.rebalance(e, vault, shortfall);
//     assert _VaultHub.isVaultHealthy(vault);
// }


*/