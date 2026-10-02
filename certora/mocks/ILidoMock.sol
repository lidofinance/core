pragma solidity >=0.8.0;  // Same as ILido

import { ILido } from "contracts/common/interfaces/ILido.sol";

contract ILidoMock is ILido {
    // IERC20
    function totalSupply() external view returns (uint256) {
        return 0;
    }
    function balanceOf(address account) external view returns (uint256) {
        return 0;
    }
    function transfer(address to, uint256 value) external returns (bool) {
        return true;
    }
    function allowance(address owner, address spender) external view returns (uint256) {
        return 0;
    }
    function approve(address spender, uint256 value) external returns (bool) {
        return true;
    }
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        return true;
    }

    // IERC20Permit
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {}
    function nonces(address owner) external view returns (uint256) {
        return 0;
    }
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return bytes32(0);
    }

    // IVersioned
    function getContractVersion() external view returns (uint256) {
        return 0;
    }

    // ILido
    function sharesOf(address user) external view returns (uint256) {
        return 0;
    }

    function getSharesByPooledEth(uint256 _ethAmount) external view returns (uint256) {
        return 0;
    }

    function getPooledEthByShares(uint256 _sharesAmount) external view returns (uint256) {
        return 0;
    }

    function getPooledEthBySharesRoundUp(uint256 _sharesAmount) external view returns (uint256) {
        return 0;
    }

    function transferSharesFrom(address _sender, address _recipient, uint256 _sharesAmount) external returns (uint256) {
        return 0;
    }

    function transferShares(
        address _recipient, uint256 _sharesAmount
    ) external returns (uint256) {
        return 0;
    }

    function rebalanceExternalEtherToInternal() external payable {}

    function getTotalPooledEther() external view returns (uint256) {
        return 0;
    }

    function getExternalEther() external view returns (uint256) {
        return 0;
    }

    function getExternalShares() external view returns (uint256) {
        return 0;
    }

    function mintExternalShares(address _recipient, uint256 _amountOfShares) external {}

    function burnExternalShares(uint256 _amountOfShares) external {}

    function getTotalShares() external view returns (uint256) {
        return 0;
    }

    function getBeaconStat()
        external
        view
        returns (uint256 depositedValidators, uint256 beaconValidators, uint256 beaconBalance) {
        return (0,0,0);
    }

    function processClStateUpdate(
        uint256 _reportTimestamp,
        uint256 _preClValidators,
        uint256 _reportClValidators,
        uint256 _reportClBalance
    ) external {}

    function collectRewardsAndProcessWithdrawals(
        uint256 _reportTimestamp,
        uint256 _reportClBalance,
        uint256 _adjustedPreCLBalance,
        uint256 _withdrawalsToWithdraw,
        uint256 _elRewardsToWithdraw,
        uint256 _lastWithdrawalRequestToFinalize,
        uint256 _simulatedShareRate,
        uint256 _etherToLockOnWithdrawalQueue
    ) external {}

    function emitTokenRebase(
        uint256 _reportTimestamp,
        uint256 _timeElapsed,
        uint256 _preTotalShares,
        uint256 _preTotalEther,
        uint256 _postTotalShares,
        uint256 _postTotalEther,
        uint256 _postInternalShares,
        uint256 _postInternalEther,
        uint256 _sharesMintedAsFees
    ) external {}

    function mintShares(address _recipient, uint256 _sharesAmount) external {}
    
    function burnShares(uint256 _amountOfShares) external {}

    function internalizeExternalBadDebt(uint256 _amountOfShares) external {}

    function rebalanceExternalEtherToInternal(uint256 _amountOfShares) external payable {}
}
