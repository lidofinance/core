// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {Math} from "@openzeppelin/contracts-v5.0.2/utils/math/Math.sol";
import {StorageSlot} from "@openzeppelin/contracts-v5.0.2/utils/StorageSlot.sol";
import {StETHPermit} from "./StETHPermit.sol";

contract StETHToken is StETHPermit {

    uint256 private constant DEPOSIT_SIZE = 32 ether;

    uint256 internal constant TOTAL_BASIS_POINTS = 10000;

    /// @dev amount of Ether (on the current Ethereum side) buffered on this smart contract balance
    bytes32 internal constant BUFFERED_ETHER_POSITION = keccak256("lido.Lido.bufferedEther");

    /// @dev total amount of ether on Consensus Layer (sum of all the balances of Lido validators)
    // "beacon" in the `keccak256()` parameter is staying here for compatibility reason
    bytes32 internal constant CL_BALANCE_POSITION = keccak256("lido.Lido.beaconBalance");

    /// @dev amount of external balance that is counted into total pooled eth
    bytes32 internal constant EXTERNAL_BALANCE_POSITION = keccak256("lido.Lido.externalBalance");

    /// @dev number of deposited validators (incrementing counter of deposit operations).
    bytes32 internal constant DEPOSITED_VALIDATORS_POSITION = keccak256("lido.Lido.depositedValidators");

    /// @dev number of Lido's validators available in the Consensus Layer state
    // "beacon" in the `keccak256()` parameter is staying here for compatibility reason
    bytes32 internal constant CL_VALIDATORS_POSITION = keccak256("lido.Lido.beaconValidators");

    /// @dev maximum allowed external balance as a percentage of total pooled ether
    bytes32 internal constant MAX_EXTERNAL_BALANCE_POSITION = keccak256("lido.Lido.maxExternalBalanceBP");

    /**
    * @notice Get the amount of Ether temporary buffered on this contract balance
    * @dev Buffered balance is kept on the contract from the moment the funds are received from user
    * until the moment they are actually sent to the official Deposit contract.
    * @return amount of buffered funds in wei
    */
    function getBufferedEther() external view returns (uint256) {
        return _getBufferedEther();
    }

    function getExternalEther() external view returns (uint256) {
        return StorageSlot.getUint256Slot(EXTERNAL_BALANCE_POSITION).value;
    }

    function getMaxExternalBalance() external view returns (uint256) {
        return _getMaxExternalBalance();
    }


    /**
     * @dev Gets the total amount of Ether controlled by the system
     * @return total balance in wei
     */
    function _getTotalPooledEther() internal view override returns (uint256) {
        return _getBufferedEther()
            + StorageSlot.getUint256Slot(CL_BALANCE_POSITION).value
            + StorageSlot.getUint256Slot(EXTERNAL_BALANCE_POSITION).value
            + _getTransientBalance();
    }

    /**
     * @dev Gets the amount of Ether temporary buffered on this contract balance
     */
    function _getBufferedEther() internal view returns (uint256) {
        return StorageSlot.getUint256Slot(BUFFERED_ETHER_POSITION).value;
    }

    /**
     * @dev Sets the amount of Ether temporary buffered on this contract balance
     * @param _newBufferedEther new amount of buffered funds in wei
     */
    function _setBufferedEther(uint256 _newBufferedEther) internal {
        StorageSlot.getUint256Slot(BUFFERED_ETHER_POSITION).value = _newBufferedEther;
    }

    /// @dev Calculates and returns the total base balance (multiple of 32) of validators in transient state,
    ///     i.e. submitted to the official Deposit contract but not yet visible in the CL state.
    /// @return transient balance in wei (1e-18 Ether)
    function _getTransientBalance() internal view returns (uint256) {
        uint256 depositedValidators = StorageSlot.getUint256Slot(DEPOSITED_VALIDATORS_POSITION).value;
        uint256 clValidators =StorageSlot.getUint256Slot(CL_VALIDATORS_POSITION).value;
        // clValidators can never be less than deposited ones.
        assert(depositedValidators >= clValidators);

        return (depositedValidators - clValidators) * DEPOSIT_SIZE;
    }

    /**
     * @dev Gets the maximum allowed external balance as a percentage of total pooled ether
     * @return max external balance in wei
     */
    function _getMaxExternalBalance() internal view returns (uint256) {
        return Math.mulDiv(
            _getTotalPooledEther(),
            StorageSlot.getUint256Slot(MAX_EXTERNAL_BALANCE_POSITION).value,
            TOTAL_BASIS_POINTS
        );
    }
}
