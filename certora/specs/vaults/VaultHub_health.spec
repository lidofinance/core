import "./VaultHub.spec";

methods {

  function maxLiabilityShares(address) external returns uint96 envfree;
  function minimalReserve(address) external returns uint128 envfree;
  function redemptionShares(address) external returns uint128 envfree;
  function _getPooledEthBySharesRoundUp(uint256 _shares) internal returns (uint256);

  function VaultHub._withdrawableValueFeesIncluded(address _vault, VaultHub.VaultConnection storage,VaultHub.VaultRecord storage) internal returns uint256 with (env e) => _withdrawableValueFeesIncludedCVL(e, _vault);

  function OperatorGrid.onBurnedShares(address _vault, uint256 _amount) external => NONDET;
    
}



definition min(mathint x, mathint y) returns mathint =
    x > y ? y : x;

definition max(mathint x, mathint y) returns mathint =
    x > y ? x : y;

function mulDivUpCVL(uint256 x, uint256 y, uint256 z) returns uint256 {
    require z !=0;
    return require_uint256((x * y + z - 1) / z);
}

function _lockedCVL(env e, uint256 maxLiabilityShares, uint256 minimalReserve, uint256 reserveRatioBP) returns uint256 {
  uint256 liability = _getPooledEthBySharesRoundUp(e, maxLiabilityShares);

  uint256 reserve = mulDivUpCVL(liability, reserveRatioBP, require_uint256(TOTAL_BASIS_POINTS() - reserveRatioBP));

  return require_uint256(liability + max(reserve, minimalReserve));
}

function _unlockedCVL(env e, uint256 totalValue, uint256 maxLiabilityShares, uint256 minimalReserve, uint256 reserveRatioBP) returns (uint256) {
  uint256 locked = _lockedCVL(e, maxLiabilityShares, minimalReserve, reserveRatioBP);
  return totalValue > locked ? assert_uint256(totalValue - locked) : 0;
}

function _withdrawableValueFeesIncludedCVL(env e, address vault) returns uint256 {

  int104 recordDelta = _VaultHub.getVaultRecordDeltaValue(vault);
  int104 reportDelta = _VaultHub.getVaultReportDelta(vault);
  uint104 reportTotalValue = getVaultReportTotal(vault);
  
  uint256 redemptionShares = redemptionShares(vault); 

  uint256 balance = _availableBalance(e, vault);

  uint256 totalValue = require_uint256(reportTotalValue + recordDelta - reportDelta);
  uint256 availableBalance = assert_uint256(min(balance, totalValue));


  uint256 redemptionValue = _getPooledEthBySharesRoundUp(e, redemptionShares);
  if (redemptionValue > availableBalance) { 
    return 0;
  }
  uint256 availableBalanceWithoutRedemption = assert_uint256(availableBalance - redemptionValue);

  uint256 maxLiabilityShares = maxLiabilityShares(vault);
  uint256 minimalReserve = minimalReserve(vault);
  uint256 reserveRatioBP = reserveRatioBP(vault);

  // We must account vaults locked value when calculating the withdrawable amount
  return assert_uint256(min(availableBalanceWithoutRedemption, _unlockedCVL(e, totalValue,maxLiabilityShares,minimalReserve,reserveRatioBP)));
}

function requireSoundVaultState(address vault) {
  requireInvariant vaultReserveRatioGeThreshold(vault);
  // TODO: Change this to the invariant.
  require _VaultHub.vh_storage.records[vault].liabilityShares <= _VaultHub.vh_storage.records[vault].maxLiabilityShares; 
  require _VaultHub.vh_storage.connections[vault].reserveRatioBP > 0;
  requireInvariant reserveRatioNotBig(vault);
  reasonableDeltaValues(vault);
  requireInvariant vaultLockedCoversLiabilityAndReserve(vault);
}



/// @title A healthy vault remains healthy until a new report is produced, with the exception of settling fees.
/// @notice For `forceRebalance` we assume the vault has not redemption shares.
/// @notice Fails for rounding issues in `rebalance` nad `forceRebalance` - see `https://github.com/lidofinance/core/issues/1262`.
///   See: https://prover.certora.com/output/8195906/4e31567240ae4252b8733272ada97e2c?anonymousKey=68396f69922f0d2a85700e75e4219224358ef93a
///   Example
///     Initial:
///       - liabilityShares = 4
///       - totalValue = 42
///       - liability value = ceil(liabilityShares * 21 / 2) =  42
///       - => Vault is healthy (totalValue = 42 = liabilityValue)
///     Rebalance 1 share, which is worth ceil(1 * 21/2) = ceil(10.5) = 11 eth
///     Afterwards we have:
///       - liabilityShares = 3 (1 rebalanced)
///       - totalValue = 31 (11 was rebalanced)
///       - liability (value) = ceil(liabilityShares * 21 / 2) = ceil( 3 * 21 / 2) = 32
///       - => Vault is unhealthy (totalValue = 31 < 32 = liabilityValue)
///     If instead rebalancing rounded down (10 eth), we'd remain healthy (totalValue = 32 liabilityValue).
///   This issue is acknowledged, but fine. To filter out these kinds of violations,
//    we assume that the threshold is not breached by at least 2 wei.
/// @dev The same type of violation was previously seen in other functions too (e.g. settle fees). These are now timing out.
/// @dev Running this requires applying the path `munge-VaultHub-health-constant.patch`
rule vaultIsHealtyhUntilReport(method f, address vault) filtered {
    f -> (
        f.contract == _VaultHub &&
        !f.isView &&
        f.selector != sig:VaultHubHarness.applyVaultReport(
            address, uint256, uint256, int256, uint256, uint256 ,uint256, uint256 
        ).selector 
    )
} {
    requireSoundVaultState(vault);
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
            vault,
            _shareLimit,
            _reserveRatioBP,
            _forcedRebalanceThresholdBP,
            _infraFeeBP,
            _liquidityFeeBP,
            _reservationFeeBP
        );
    } else if (f.selector == sig:VaultHubHarness.withdraw(address,address,uint256).selector) {
      address _recipient;
      uint256 _ether;
      _VaultHub.withdraw(e, vault, _recipient, _ether);

    } else if (f.selector == sig:VaultHubHarness.settleLidoFees(address /*vault*/).selector) {
      _VaultHub.settleLidoFees(e, vault);
    } else if (f.selector == sig:VaultHubHarness.rebalance(address,uint256).selector) {
      uint256 _shares;
      require(_internalShares() < _internalEth, "Assume a share price greater than 1");
      
      uint256 tv = totalValue(vault);
      uint256 ls = liabilityShares(vault);
      uint256 tbp = forcedRebalanceThresholdBP(vault);

      require(CVLgetPooledEthBySharesRoundUp(ls) + 1 < tv * ((TOTAL_BASIS_POINTS() - tbp) / TOTAL_BASIS_POINTS()), "Prevent rounding issues");
      _VaultHub.rebalance(e, vault, _shares);
    }else if (f.selector == sig:VaultHubHarness.forceRebalance(address).selector) {
      require(_internalShares() < _internalEth, "Assume a share price greater than 1");

      uint256 tv = totalValue(vault);
      uint256 ls = liabilityShares(vault);
      uint256 tbp = forcedRebalanceThresholdBP(vault);

      require(CVLgetPooledEthBySharesRoundUp(ls) + 1 < tv * ((TOTAL_BASIS_POINTS() - tbp) / TOTAL_BASIS_POINTS()), "Prevent rounding issues");
      
      _VaultHub.forceRebalance(e, vault);
    } else {
        calldataarg args;
        f(e, args);
    }

    assert(
        _VaultHub.isVaultHealthy(vault),
        "A vault should remain healthy until a new report arrives"
    );
}

/*
/// @dev This is for testing if the rounding issue occurs also when the value
/// of 1 share is 1 ETH or more.
/// @notice This is still violated due to the same rounding issues as above in
/// `vaultIsHealtyhUntilReport`.
rule vaultIsHealtyhUntilReportRatioMoreOne(method f, address vault) filtered {
    f -> (
        f.selector == sig:VaultHubHarness.rebalance(address, uint256).selector ||
        f.selector == sig:VaultHubHarness.forceRebalance(address).selector
    )
} {
    reasonableDeltaValues(vault);
    requireInvariant vaultLockedCoversLiabilityAndReserve(vault);
    require(CVLgetPooledEthByShares(1) >= 1, "Assume 1 share is more than 1 ETH");
    require(_VaultHub.isVaultHealthy(vault), "Pre condition - assume vault is healthy");

    env e;
    require(
        e.msg.value <= maxReasonableValue(),
        "Avoid overflow due to unreasonable ETH amount (e.g. in `VaultHub.fund`"
    );
    calldataarg args;
    f(e, args);

    assert(
        _VaultHub.isVaultHealthy(vault),
        "A vault should remain healthy until a new report arrives"
    );
}
*/


/// Correctness of above summary in terms of functional equivalence.
/// Report: https://prover.certora.com/output/8195906/6a3f94fccfd142a3af5fbaa40fcca878/?anonymousKey=d4ca77cc9310d8aa47d18fa8bbf2febc31dc1dc7
rule summaryCorrect(env e, address vault) {
  uint256 original = withdrawableValueFeesIncluded(e,vault);
  uint256 summary = _withdrawableValueFeesIncludedCVL(e, vault);
  assert original == summary;
}
