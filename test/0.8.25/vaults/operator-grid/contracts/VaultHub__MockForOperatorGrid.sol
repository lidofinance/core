// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

contract VaultHub__MockForOperatorGrid {
    struct VaultSocket {
        // ### 1st slot
        /// @notice vault address
        address vault;
        /// @notice total number of stETH shares minted by the vault
        uint96 liabilityShares;
        // ### 2nd slot
        /// @notice maximum number of stETH shares that can be minted by vault owner
        uint96 shareLimit;
        /// @notice minimal share of ether that is reserved for each stETH minted
        uint16 reserveRatioBP;
        /// @notice if vault's reserve decreases to this threshold, it should be force rebalanced
        uint16 forcedRebalanceThresholdBP;
        /// @notice treasury fee in basis points
        uint16 treasuryFeeBP;
        /// @notice if true, vault is disconnected and fee is not accrued
        bool pendingDisconnect;
        /// @notice last fees accrued on the vault
        uint96 feeSharesCharged;
    }
    /// @notice unused gap in the slot 2
    /// uint8 _unused_gap_;

    mapping(address => VaultSocket) public vaultSockets;

    function mock__addVaultSocket(address _vault, VaultSocket calldata _vaultSocket) external {
        vaultSockets[_vault] = _vaultSocket;
    }

    function vaultSocket(address _vault) external view returns (VaultSocket memory) {
        return vaultSockets[_vault];
    }

    function updateConnection(
        address _vault,
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _forcedRebalanceThresholdBP,
        uint256 _treasuryFeeBP
    ) external {
        VaultSocket storage socket = vaultSockets[_vault];
        if (socket.vault == address(0)) revert NotConnectedToHub(_vault);

        socket.shareLimit = uint96(_shareLimit);
        socket.reserveRatioBP = uint16(_reserveRatioBP);
        socket.forcedRebalanceThresholdBP = uint16(_forcedRebalanceThresholdBP);
        socket.treasuryFeeBP = uint16(_treasuryFeeBP);

        emit VaultConnectionUpdated(_vault, _shareLimit, _reserveRatioBP, _forcedRebalanceThresholdBP, _treasuryFeeBP);
    }

    event VaultConnectionUpdated(
        address indexed vault,
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 forcedRebalanceThresholdBP,
        uint256 treasuryFeeBP
    );

    error NotConnectedToHub(address vault);
}
