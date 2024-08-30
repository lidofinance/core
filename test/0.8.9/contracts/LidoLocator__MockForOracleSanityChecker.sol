// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

interface ILidoLocator {
    function lido() external view returns (address);

    function burner() external view returns (address);

    function withdrawalVault() external view returns (address);

    function withdrawalQueue() external view returns (address);
}

contract LidoLocator__MockForOracleSanityChecker is ILidoLocator {
    address private immutable LIDO;
    address private immutable WITHDRAWAL_VAULT;
    address private immutable WITHDRAWAL_QUEUE;
    address private immutable EL_REWARDS_VAULT;
    address private immutable BURNER;

    constructor(
        address _lido,
        address _withdrawalVault,
        address _withdrawalQueue,
        address _elRewardsVault,
        address _burner
    ) {
        LIDO = _lido;
        WITHDRAWAL_VAULT = _withdrawalVault;
        WITHDRAWAL_QUEUE = _withdrawalQueue;
        EL_REWARDS_VAULT = _elRewardsVault;
        BURNER = _burner;
    }

    function lido() external view returns (address) {
        return LIDO;
    }

    function withdrawalQueue() external view returns (address) {
        return WITHDRAWAL_QUEUE;
    }

    function withdrawalVault() external view returns (address) {
        return WITHDRAWAL_VAULT;
    }

    function elRewardsVault() external view returns (address) {
        return EL_REWARDS_VAULT;
    }

    function burner() external view returns (address) {
        return BURNER;
    }
}
