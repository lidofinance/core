/* Spec for the `Burner` contract */

import "../common/lido-storage-ghost.spec";
import "../common/lido-summaries.spec";

using BurnerHarness as _Burner;
using LidoLocator as _LidoLocator;

methods {
    // `BurnerHarness`
    function BurnerHarness.getExcessStETHShares() external returns (uint256) envfree;

    // `LidoLocator`
    function _.burner() external => _Burner expect address;
    function _.lido() external => _Lido expect address;

    function LidoLocator.treasury() external returns (address) envfree;
}

// ---- Functions --------------------------------------------------------------

definition isValidBurnerFunc(method f) returns bool = (
    // It's pointless to call `Lido.approve`
    f.contract == _Burner &&
    // The following two functions call third party contract via `safeTransfer`
    f.selector != sig:BurnerHarness.recoverERC20(address,uint256).selector &&
    f.selector != sig:BurnerHarness.recoverERC721(address,uint256).selector
);


// ---- Rules ------------------------------------------------------------------

/// @title The `Burner` contract gives no allowance to any address
/// @notice This is part of proving that `Burner` shares are never transferred, only burned
invariant burnerDoesNotApprove(address a)
    _Lido.allowance(_Burner, a) == 0
    filtered {f -> isValidBurnerFunc(f)}


/// @title `Burner` shares can only be reduced by burning (excluding excess shares)
/// @notice This is part of proving that `Burner` shares are never transferred, only burned
rule burnerSharesOnlyBurnt(method f) filtered {f -> isValidBurnerFunc(f)} {
    uint256 sharesPre = _Lido.sharesOf(_Burner);
    uint256 totalPre = _Lido.getTotalShares();
    uint256 excessPre = _Burner.getExcessStETHShares();

    env e;
    calldataarg args;
    f(e, args);

    uint256 sharesPost = _Lido.sharesOf(_Burner);
    uint256 totalPost = _Lido.getTotalShares();

    mathint sharesDiff = sharesPost - sharesPre;
    mathint totalDiff = totalPost - totalPre;

    assert(
        sharesPost < sharesPre => (
            (sharesDiff == totalDiff) // In case of burning
            || (
                // In case of `recoverExcessStETH`
                totalDiff == 0 &&
                sharesDiff <= excessPre &&
                f.selector == sig:BurnerHarness.recoverExcessStETH().selector
            )
        ),
        "Burner shares reduced only by burning"
    );
}


/// @title Burner does not affect unrelated parties shares
/// @notice For `requestBurnShares` and `requestBurnSharesForCover` when
/// shares rate is less than 1, due to `Lido.transferSharesFrom` not verifying that the
/// value of the shares is non-zero.
/// This is a KNOWN ISSUE requiring catastrophic conditions (>14% slashing) and is not
/// economically exploitable. Acknowledged by Lido team for future fix.
/// see issue `https://github.com/lidofinance/core/issues/1399`
/// and its duplicate issue `https://github.com/lidofinance/core/issues/796`.
/// We therefore assume that the share rate is at least 1.
rule burnerDoesNotAffectThirdPartyShares(method f, address anyone) filtered {
    f -> isValidBurnerFunc(f)
}  {
    uint256 sharesPre = _Lido.sharesOf(anyone);
    uint256 allowancePre = _Lido.allowance(anyone, _Burner);

    require(CVLgetPooledEthByShares(sharesPre) >= sharesPre, "Assume 1 share is more than 1 ETH");

    env e;
    calldataarg args;
    f(e, args);

    uint256 sharesPost = _Lido.sharesOf(anyone);
    
    assert(
        sharesPre != sharesPost => (
            anyone == _Burner ||
            e.msg.sender == anyone ||
            anyone == _LidoLocator.treasury() ||
            allowancePre > 0
        ),
        "Burner does not affect unrelated parties shares"
    );
}


/// @title Integrity of request burn methods
rule burnRequestsIntegrity(method f, uint256 amount, address from, address thirdParty) filtered {
    f -> (
        f.selector == sig:BurnerHarness.requestBurnMyStETHForCover(uint256).selector ||
        f.selector == sig:BurnerHarness.requestBurnSharesForCover(address,uint256).selector ||
        f.selector == sig:BurnerHarness.requestBurnMyShares(uint256).selector ||
        f.selector == sig:BurnerHarness.requestBurnMyStETH(uint256).selector ||
        f.selector == sig:BurnerHarness.requestBurnShares(address,uint256).selector
    )
} {
    require(thirdParty != from && thirdParty != _Burner, "Unrelated third party");
    require(from != _Burner, "Burner does not request burns");

    uint256 fromPre = _Lido.sharesOf(from);
    uint256 burnerPre = _Lido.sharesOf(_Burner);
    uint256 thirdPre = _Lido.sharesOf(thirdParty);

    env e;
    if (f.selector == sig:BurnerHarness.requestBurnMyStETHForCover(uint256).selector) {
        require(e.msg.sender == from, "Correct from address");
        require(CVLgetSharesByPooledEth(amount) > 0, "Nontrivial shares amount to burn");
        _Burner.requestBurnMyStETHForCover(e, amount);
    } else if (f.selector == sig:BurnerHarness.requestBurnMyShares(uint256).selector) {
        require(e.msg.sender == from, "Correct from address");
        _Burner.requestBurnMyShares(e, amount);
    } else if (f.selector == sig:BurnerHarness.requestBurnMyStETH(uint256).selector) {
        require(e.msg.sender == from, "Correct from address");
        require(CVLgetSharesByPooledEth(amount) > 0, "Nontrivial shares amount to burn");
        _Burner.requestBurnMyStETH(e, amount);
    } else if (f.selector == sig:BurnerHarness.requestBurnSharesForCover(address,uint256).selector) {
        _Burner.requestBurnSharesForCover(e, from, amount);
    } else {
        _Burner.requestBurnShares(e, from, amount);
    }

    uint256 fromPost = _Lido.sharesOf(from);
    uint256 burnerPost = _Lido.sharesOf(_Burner);
    uint256 thirdPost = _Lido.sharesOf(thirdParty);

    assert(fromPre > fromPost, "From address reduced shares by burning request");
    assert(burnerPost > burnerPre, "Burner increased shares by burning request");
    assert(thirdPost == thirdPre, "Third party unaffected by burning request");
}


/// @title Intergrity of `commitSharesToBurn`
rule commitBurnIntergrity(uint256 sharesToBurn) {
    uint256 totalSharesPre = _Lido.getTotalShares();
    uint256 burnerPre = _Lido.sharesOf(_Burner);

    env e;
    _Burner.commitSharesToBurn(e, sharesToBurn);

    uint256 totalSharesPost = _Lido.getTotalShares();
    uint256 burnerPost = _Lido.sharesOf(_Burner);

    assert(
        totalSharesPre - totalSharesPost == sharesToBurn,
        "Correct amount of shares burnt"
    );
    assert(burnerPre - burnerPost == sharesToBurn, "Shares burnt only from Burner");
}
