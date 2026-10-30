import "snippet_StakingVault.spec";

using StakingVault as StakingVault;

methods {
    function _._stakingVault() internal => CVL_stakingVault() expect address;
}

function CVL_stakingVault() returns address {
    return StakingVault;
}
