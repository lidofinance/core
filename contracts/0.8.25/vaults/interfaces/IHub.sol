// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {IVault} from "./IVault.sol";

interface IHub {
    struct VaultSocket {
        IVault vault;
        uint96 capShares;
        uint96 mintedShares;
        uint16 minBondRateBP;
        uint16 treasuryFeeBP;
    }

    event MintedStETHOnVault(address indexed vault, uint256 amountOfTokens);
    event BurnedStETHOnVault(address indexed vault, uint256 amountOfTokens);
    event VaultRebalanced(address indexed vault, uint256 tokensBurnt, uint256 newBondRateBP);
    event VaultConnected(address indexed vault, uint256 capShares, uint256 minBondRateBP);
    event VaultDisconnected(address indexed vault);

    function vaultsCount() external view returns (uint256);

    function vault(uint256 _index) external view returns (IVault);

    function vaultSocket(uint256 _index) external view returns (VaultSocket memory);

    function vaultSocket(IVault _vault) external view returns (VaultSocket memory);

    function connectVault(IVault _vault, uint256 _capShares, uint256 _minBondRateBP, uint256 _treasuryFeeBP) external;

    function disconnectVault(IVault _vault) external;

    function mintStethBackedByVault(
        address _receiver,
        uint256 _amountOfTokens
    ) external returns (uint256 totalEtherToLock);

    function burnStethBackedByVault(uint256 _amountOfTokens) external;

    function forceRebalance(IVault _vault) external;

    function rebalance() external payable;

    // Errors
    error StETHMintFailed(address vault);
    error AlreadyBalanced(address vault);
    error NotEnoughShares(address vault, uint256 amount);
    error BondLimitReached(address vault);
    error MintCapReached(address vault);
    error AlreadyConnected(address vault);
    error NotConnectedToHub(address vault);
    error RebalanceFailed(address vault);
    error NotAuthorized(string operation, address addr);
    error ZeroArgument(string argument);
    error NotEnoughBalance(address vault, uint256 balance, uint256 shouldBe);
    error TooManyVaults();
    error CapTooHigh(address vault, uint256 capShares, uint256 maxCapShares);
    error MinBondRateTooHigh(address vault, uint256 minBondRateBP, uint256 maxMinBondRateBP);
    error TreasuryFeeTooHigh(address vault, uint256 treasuryFeeBP, uint256 maxTreasuryFeeBP);
}
