// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

contract VaultHub__MockForOperatorGrid {
    struct VaultSocket {
        // ### 1st slot
        /// @notice vault address
        address vault;
        /// @notice total number of stETH shares that the vault owes to Lido
        uint96 liabilityShares;
        // ### 2nd slot
        /// @notice maximum number of stETH shares that can be minted by vault owner
        uint96 shareLimit;
        /// @notice share of ether that is locked on the vault as an additional reserve
        /// e.g RR=30% means that for 1stETH minted 1/(1-0.3)=1.428571428571428571 ETH is locked on the vault
        uint16 reserveRatioBP;
        /// @notice if vault's reserve decreases to this threshold, it should be force rebalanced
        uint16 forcedRebalanceThresholdBP;
        /// @notice infra fee in basis points
        uint16 infraFeeBP;
        /// @notice liquidity fee in basis points
        uint16 liquidityFeeBP;
        /// @notice reservation fee in basis points
        uint16 reservationFeeBP;
        /// @notice if true, vault is disconnected and fee is not accrued
        bool pendingDisconnect;
        /// @notice unused gap in the slot 2
        /// uint72 _unused_gap_;
        // ### 3rd slot
        /// @notice cumulative amount of shares charged as fees for the vault
        uint96 feeSharesCharged;
    }
    /// @notice unused gap in the slot 3
    /// uint160 _unused_gap_;

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
        uint256 _infraFeeBP,
        uint256 _liquidityFeeBP,
        uint256 _reservationFeeBP
    ) external {
        VaultSocket storage socket = vaultSockets[_vault];
        if (socket.vault == address(0)) revert NotConnectedToHub(_vault);

        socket.shareLimit = uint96(_shareLimit);
        socket.reserveRatioBP = uint16(_reserveRatioBP);
        socket.forcedRebalanceThresholdBP = uint16(_forcedRebalanceThresholdBP);
        socket.treasuryFeeBP = uint16(_treasuryFeeBP);

        emit VaultConnectionUpdated(
            _vault,
            _shareLimit,
            _reserveRatioBP,
            _forcedRebalanceThresholdBP,
            _infraFeeBP,
            _liquidityFeeBP,
            _reservationFeeBP
        );
    }

    event VaultConnectionUpdated(
        address indexed vault,
        uint256 shareLimit,
        uint256 reserveRatioBP,
        uint256 forcedRebalanceThresholdBP,
        uint256 infraFeeBP,
        uint256 liquidityFeeBP,
        uint256 reservationFeeBP
    );

    error NotConnectedToHub(address vault);
}
