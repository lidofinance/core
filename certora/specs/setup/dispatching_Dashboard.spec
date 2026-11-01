import "snippet_lidomock.spec";
import "snippet_proof.spec";
import "snippet_StakingVault.spec";
import "snippet_withdrawals.spec";

using StakingVault as StakingVault;

methods {
    function _._stakingVault() internal => CVL_stakingVault() expect address;
    function _.deposit(bytes,bytes,bytes,bytes32) external => DISPATCHER(true);

    // dispatch in recoverERC20
    function _.transfer(address,uint256) external => DISPATCHER(true);

    // dispatch in recoverERC721
    function _.safeTransferFrom(address,address,uint256) external => DISPATCHER(true);

    // dispatch to ERC721RecipientMock
    function _.onERC721Received(address,address,uint256,bytes) external => DISPATCHER(true);
}

function CVL_stakingVault() returns address {
    return StakingVault;
}
