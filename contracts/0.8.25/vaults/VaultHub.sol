// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {IHubVault} from "./interfaces/IHubVault.sol";

interface StETH {
    function mintExternalShares(address, uint256) external;

    function burnExternalShares(uint256) external;

    function getExternalEther() external view returns (uint256);

    function getMaxExternalBalance() external view returns (uint256);

    function getPooledEthByShares(uint256) external view returns (uint256);

    function getSharesByPooledEth(uint256) external view returns (uint256);

    function getTotalShares() external view returns (uint256);
}

// TODO: rebalance gas compensation
// TODO: optimize storage
// TODO: add limits for vaults length
// TODO: unstructured storag and upgradability

/// @notice Vaults registry contract that is an interface to the Lido protocol
/// in the same time
/// @author folkyatina
abstract contract VaultHub is AccessControlEnumerableUpgradeable {
    /// @notice role that allows to connect vaults to the hub
    bytes32 public constant VAULT_MASTER_ROLE = keccak256("Vaults.VaultHub.VaultMasterRole");
    /// @dev basis points base
    uint256 internal constant BPS_BASE = 100_00;
    /// @dev maximum number of vaults that can be connected to the hub
    uint256 internal constant MAX_VAULTS_COUNT = 500;
    /// @dev maximum size of the vault relative to Lido TVL in basis points
    uint256 internal constant MAX_VAULT_SIZE_BP = 10_00;

    StETH public immutable STETH;
    address public immutable treasury;

    struct VaultSocket {
        /// @notice vault address
        IHubVault vault;
        /// @notice maximum number of stETH shares that can be minted by vault owner
        uint96 capShares;
        /// @notice total number of stETH shares minted by the vault
        uint96 mintedShares;
        /// @notice minimum bond rate in basis points
        uint16 minReserveRatioBP;
        /// @notice treasury fee in basis points
        uint16 treasuryFeeBP;
    }

    /// @notice vault sockets with vaults connected to the hub
    /// @dev first socket is always zero. stone in the elevator
    VaultSocket[] private sockets;
    /// @notice mapping from vault address to its socket
    /// @dev if vault is not connected to the hub, it's index is zero
    mapping(IHubVault => uint256) private vaultIndex;

    constructor(address _admin, address _stETH, address _treasury) {
        STETH = StETH(_stETH);
        treasury = _treasury;

        sockets.push(VaultSocket(IHubVault(address(0)), 0, 0, 0, 0)); // stone in the elevator

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /// @notice returns the number of vaults connected to the hub
    function vaultsCount() public view returns (uint256) {
        return sockets.length - 1;
    }

    function vault(uint256 _index) public view returns (IHubVault) {
        return sockets[_index + 1].vault;
    }

    function vaultSocket(uint256 _index) external view returns (VaultSocket memory) {
        return sockets[_index + 1];
    }

    function vaultSocket(IHubVault _vault) public view returns (VaultSocket memory) {
        return sockets[vaultIndex[_vault]];
    }

    function reserveRatio(IHubVault _vault) public view returns (uint256) {
        return _reserveRatio(vaultSocket(_vault));
    }

    /// @notice connects a vault to the hub
    /// @param _vault vault address
    /// @param _capShares maximum number of stETH shares that can be minted by the vault
    /// @param _minReserveRatioBP minimum reserve ratio in basis points
    /// @param _treasuryFeeBP treasury fee in basis points
    function connectVault(
        IHubVault _vault,
        uint256 _capShares,
        uint256 _minReserveRatioBP,
        uint256 _treasuryFeeBP
    ) external onlyRole(VAULT_MASTER_ROLE) {
        if (address(_vault) == address(0)) revert ZeroArgument("vault");
        if (_capShares == 0) revert ZeroArgument("capShares");

        if (_minReserveRatioBP == 0) revert ZeroArgument("reserveRatioBP");
        if (_minReserveRatioBP > BPS_BASE) revert ReserveRatioTooHigh(address(_vault), _minReserveRatioBP, BPS_BASE);
        if (_treasuryFeeBP == 0) revert ZeroArgument("treasuryFeeBP");
        if (_treasuryFeeBP > BPS_BASE) revert TreasuryFeeTooHigh(address(_vault), _treasuryFeeBP, BPS_BASE);

        if (vaultIndex[_vault] != 0) revert AlreadyConnected(address(_vault), vaultIndex[_vault]);
        if (vaultsCount() == MAX_VAULTS_COUNT) revert TooManyVaults();
        if (_capShares > (STETH.getTotalShares() * MAX_VAULT_SIZE_BP) / BPS_BASE) {
            revert CapTooHigh(address(_vault), _capShares, STETH.getTotalShares() / 10);
        }

        uint256 capVaultBalance = STETH.getPooledEthByShares(_capShares);
        uint256 maxExternalBalance = STETH.getMaxExternalBalance();
        if (capVaultBalance + STETH.getExternalEther() > maxExternalBalance) {
            revert ExternalBalanceCapReached(address(_vault), capVaultBalance, maxExternalBalance);
        }

        VaultSocket memory vr = VaultSocket(
            IHubVault(_vault),
            uint96(_capShares),
            0, // mintedShares
            uint16(_minReserveRatioBP),
            uint16(_treasuryFeeBP)
        );
        vaultIndex[_vault] = sockets.length;
        sockets.push(vr);

        emit VaultConnected(address(_vault), _capShares, _minReserveRatioBP, _treasuryFeeBP);
    }

    /// @notice disconnects a vault from the hub
    /// @dev can be called by vaults only
    function disconnectVault() external {
        uint256 index = vaultIndex[IHubVault(msg.sender)];
        if (index == 0) revert NotConnectedToHub(msg.sender);

        VaultSocket memory socket = sockets[index];
        IHubVault vaultToDisconnect = socket.vault;

        if (socket.mintedShares > 0) {
            uint256 stethToBurn = STETH.getPooledEthByShares(socket.mintedShares);
            vaultToDisconnect.rebalance(stethToBurn);
        }

        vaultToDisconnect.report(vaultToDisconnect.valuation(), vaultToDisconnect.inOutDelta(), 0);

        VaultSocket memory lastSocket = sockets[sockets.length - 1];
        sockets[index] = lastSocket;
        vaultIndex[lastSocket.vault] = index;
        sockets.pop();

        delete vaultIndex[vaultToDisconnect];

        emit VaultDisconnected(address(vaultToDisconnect));
    }

    /// @notice mint StETH tokens backed by vault external balance to the receiver address
    /// @param _receiver address of the receiver
    /// @param _amountOfTokens amount of stETH tokens to mint
    /// @return totalEtherToLock total amount of ether that should be locked on the vault
    /// @dev can be used by vaults only
    function mintStethBackedByVault(
        address _receiver,
        uint256 _amountOfTokens
    ) external returns (uint256 totalEtherToLock) {
        if (_amountOfTokens == 0) revert ZeroArgument("amountOfTokens");
        if (_receiver == address(0)) revert ZeroArgument("receiver");

        IHubVault vault_ = IHubVault(msg.sender);
        uint256 index = vaultIndex[vault_];
        if (index == 0) revert NotConnectedToHub(msg.sender);
        VaultSocket memory socket = sockets[index];

        uint256 sharesToMint = STETH.getSharesByPooledEth(_amountOfTokens);
        uint256 vaultSharesAfterMint = socket.mintedShares + sharesToMint;
        if (vaultSharesAfterMint > socket.capShares) revert MintCapReached(msg.sender, socket.capShares);

        uint256 reserveRatioAfterMint = _reserveRatio(vault_, vaultSharesAfterMint);
        if (reserveRatioAfterMint < socket.minReserveRatioBP) {
            revert MinReserveRatioReached(msg.sender, _reserveRatio(socket), socket.minReserveRatioBP);
        }

        sockets[index].mintedShares = uint96(vaultSharesAfterMint);

        STETH.mintExternalShares(_receiver, sharesToMint);

        emit MintedStETHOnVault(msg.sender, _amountOfTokens);

        totalEtherToLock =
            (STETH.getPooledEthByShares(vaultSharesAfterMint) * BPS_BASE) /
            (BPS_BASE - socket.minReserveRatioBP);
    }

    /// @notice burn steth from the balance of the vault contract
    /// @param _amountOfTokens amount of tokens to burn
    /// @dev can be used by vaults only
    function burnStethBackedByVault(uint256 _amountOfTokens) external {
        if (_amountOfTokens == 0) revert ZeroArgument("amountOfTokens");

        uint256 index = vaultIndex[IHubVault(msg.sender)];
        if (index == 0) revert NotConnectedToHub(msg.sender);
        VaultSocket memory socket = sockets[index];

        uint256 amountOfShares = STETH.getSharesByPooledEth(_amountOfTokens);
        if (socket.mintedShares < amountOfShares) revert NotEnoughShares(msg.sender, socket.mintedShares);

        sockets[index].mintedShares -= uint96(amountOfShares);

        STETH.burnExternalShares(amountOfShares);

        emit BurnedStETHOnVault(msg.sender, _amountOfTokens);
    }

    /// @notice force rebalance of the vault
    /// @param _vault vault address
    /// @dev can be used permissionlessly if the vault is underreserved
    function forceRebalance(IHubVault _vault) external {
        uint256 index = vaultIndex[_vault];
        if (index == 0) revert NotConnectedToHub(msg.sender);
        VaultSocket memory socket = sockets[index];

        uint256 reserveRatio_ = _reserveRatio(socket);

        if (reserveRatio_ >= socket.minReserveRatioBP) {
            revert AlreadyBalanced(address(_vault), reserveRatio_, socket.minReserveRatioBP);
        }

        uint256 mintedStETH = STETH.getPooledEthByShares(socket.mintedShares);
        uint256 maxMintedShare = (BPS_BASE - socket.minReserveRatioBP);

        // how much ETH should be moved out of the vault to rebalance it to target bond rate
        // (mintedStETH - X) / (vault.valuation() - X) == (BPS_BASE - minReserveRatioBP)
        //
        // X is amountToRebalance
        uint256 amountToRebalance = (mintedStETH * BPS_BASE - maxMintedShare * _vault.valuation()) /
            socket.minReserveRatioBP;

        // TODO: add some gas compensation here

        _vault.rebalance(amountToRebalance);

        if (reserveRatio_ >= _reserveRatio(socket)) revert RebalanceFailed(address(_vault));
    }

    /// @notice rebalances the vault, by writing off the amount equal to passed ether
    ///     from the vault's minted stETH counter
    /// @dev can be called by vaults only
    function rebalance() external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        uint256 index = vaultIndex[IHubVault(msg.sender)];
        if (index == 0) revert NotConnectedToHub(msg.sender);
        VaultSocket memory socket = sockets[index];

        uint256 amountOfShares = STETH.getSharesByPooledEth(msg.value);
        if (socket.mintedShares < amountOfShares) revert NotEnoughShares(msg.sender, socket.mintedShares);

        sockets[index].mintedShares = socket.mintedShares - uint96(amountOfShares);

        // mint stETH (shares+ TPE+)
        (bool success, ) = address(STETH).call{value: msg.value}("");
        if (!success) revert StETHMintFailed(msg.sender);
        STETH.burnExternalShares(amountOfShares);

        emit VaultRebalanced(msg.sender, amountOfShares, _reserveRatio(socket));
    }

    function _calculateVaultsRebase(
        uint256 postTotalShares,
        uint256 postTotalPooledEther,
        uint256 preTotalShares,
        uint256 preTotalPooledEther,
        uint256 sharesToMintAsFees
    ) internal view returns (uint256[] memory lockedEther, uint256[] memory treasuryFeeShares) {
        /// HERE WILL BE ACCOUNTING DRAGONS

        //                 \||/
        //                 |  @___oo
        //       /\  /\   / (__,,,,|
        //     ) /^\) ^\/ _)
        //     )   /^\/   _)
        //     )   _ /  / _)
        // /\  )/\/ ||  | )_)
        //<  >      |(,,) )__)
        // ||      /    \)___)\
        // | \____(      )___) )___
        //  \______(_______;;; __;;;

        uint256 length = vaultsCount();
        // for each vault
        treasuryFeeShares = new uint256[](length);

        lockedEther = new uint256[](length);

        for (uint256 i = 0; i < length; ++i) {
            VaultSocket memory socket = sockets[i + 1];

            // if there is no fee in Lido, then no fee in vaults
            // see LIP-12 for details
            if (sharesToMintAsFees > 0) {
                treasuryFeeShares[i] = _calculateLidoFees(
                    socket,
                    postTotalShares - sharesToMintAsFees,
                    postTotalPooledEther,
                    preTotalShares,
                    preTotalPooledEther
                );
            }

            uint256 totalMintedShares = socket.mintedShares + treasuryFeeShares[i];
            uint256 mintedStETH = (totalMintedShares * postTotalPooledEther) / postTotalShares; //TODO: check rounding
            lockedEther[i] = (mintedStETH * BPS_BASE) / (BPS_BASE - socket.minReserveRatioBP);
        }
    }

    function _calculateLidoFees(
        VaultSocket memory _socket,
        uint256 postTotalSharesNoFees,
        uint256 postTotalPooledEther,
        uint256 preTotalShares,
        uint256 preTotalPooledEther
    ) internal view returns (uint256 treasuryFeeShares) {
        IHubVault vault_ = _socket.vault;

        uint256 chargeableValue = _min(vault_.valuation(), (_socket.capShares * preTotalPooledEther) / preTotalShares);

        // treasury fee is calculated as a share of potential rewards that
        // Lido curated validators could earn if vault's ETH was staked in Lido
        // itself and minted as stETH shares
        //
        // treasuryFeeShares = value * lidoGrossAPR * treasuryFeeRate / preShareRate
        // lidoGrossAPR = postShareRateWithoutFees / preShareRate - 1
        // = value  * (postShareRateWithoutFees / preShareRate - 1) * treasuryFeeRate / preShareRate

        // TODO: optimize potential rewards calculation
        uint256 potentialRewards = ((chargeableValue * (postTotalPooledEther * preTotalShares)) /
            (postTotalSharesNoFees * preTotalPooledEther) -
            chargeableValue);
        uint256 treasuryFee = (potentialRewards * _socket.treasuryFeeBP) / BPS_BASE;

        treasuryFeeShares = (treasuryFee * preTotalShares) / preTotalPooledEther;
    }

    function _updateVaults(
        uint256[] memory values,
        int256[] memory netCashFlows,
        uint256[] memory lockedEther,
        uint256[] memory treasuryFeeShares
    ) internal {
        uint256 totalTreasuryShares;
        for (uint256 i = 0; i < values.length; ++i) {
            VaultSocket memory socket = sockets[i + 1];
            if (treasuryFeeShares[i] > 0) {
                socket.mintedShares += uint96(treasuryFeeShares[i]);
                totalTreasuryShares += treasuryFeeShares[i];
            }

            socket.vault.report(values[i], netCashFlows[i], lockedEther[i]);
        }

        if (totalTreasuryShares > 0) {
            STETH.mintExternalShares(treasury, totalTreasuryShares);
        }
    }

    function _reserveRatio(VaultSocket memory _socket) internal view returns (uint256) {
        return _reserveRatio(_socket.vault, _socket.mintedShares);
    }

    function _reserveRatio(IHubVault _vault, uint256 _mintedShares) internal view returns (uint256) {
        return (STETH.getPooledEthByShares(_mintedShares) * BPS_BASE) / _vault.valuation();
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    event VaultConnected(address vault, uint256 capShares, uint256 minReserveRatio, uint256 treasuryFeeBP);
    event VaultDisconnected(address vault);
    event MintedStETHOnVault(address sender, uint256 tokens);
    event BurnedStETHOnVault(address sender, uint256 tokens);
    event VaultRebalanced(address sender, uint256 shares, uint256 reserveRatio);

    error StETHMintFailed(address vault);
    error AlreadyBalanced(address vault, uint256 reserveRatio, uint256 minReserveRatio);
    error NotEnoughShares(address vault, uint256 amount);
    error MintCapReached(address vault, uint256 capShares);
    error AlreadyConnected(address vault, uint256 index);
    error NotConnectedToHub(address vault);
    error RebalanceFailed(address vault);
    error NotAuthorized(string operation, address addr);
    error ZeroArgument(string argument);
    error NotEnoughBalance(address vault, uint256 balance, uint256 shouldBe);
    error TooManyVaults();
    error CapTooHigh(address vault, uint256 capShares, uint256 maxCapShares);
    error ReserveRatioTooHigh(address vault, uint256 reserveRatioBP, uint256 maxReserveRatioBP);
    error TreasuryFeeTooHigh(address vault, uint256 treasuryFeeBP, uint256 maxTreasuryFeeBP);
    error ExternalBalanceCapReached(address vault, uint256 capVaultBalance, uint256 maxExternalBalance);
    error MinReserveRatioReached(address vault, uint256 reserveRatio, uint256 minReserveRatio);
}
