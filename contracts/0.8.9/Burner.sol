// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {IERC20} from "@openzeppelin/contracts-v4.4/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts-v4.4/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts-v4.4/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts-v4.4/utils/math/Math.sol";

import {IBurner} from "contracts/common/interfaces/IBurner.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

import {AccessControlEnumerable} from "./utils/access/AccessControlEnumerable.sol";
import {Versioned} from "./utils/Versioned.sol";


/**
 * @title Interface defining Lido contract
 */
interface ILido is IERC20 {
    /**
     * @notice Get stETH amount by the provided shares amount
     * @param _sharesAmount shares amount
     * @dev dual to `getSharesByPooledEth`.
     */
    function getPooledEthByShares(uint256 _sharesAmount) external view returns (uint256);

    /**
     * @notice Get shares amount by the provided stETH amount
     * @param _pooledEthAmount stETH amount
     * @dev dual to `getPooledEthByShares`.
     */
    function getSharesByPooledEth(uint256 _pooledEthAmount) external view returns (uint256);

    /**
     * @notice Get shares amount of the provided account
     * @param _account provided account address.
     */
    function sharesOf(address _account) external view returns (uint256);

    /**
     * @notice Transfer `_sharesAmount` stETH shares from `_sender` to `_receiver` using allowance.
     */
    function transferSharesFrom(address _sender, address _recipient, uint256 _sharesAmount) external returns (uint256);

    /**
     * @notice Burn shares from the account
     * @param _amount amount of shares to burn
     */
    function burnShares(uint256 _amount) external;
}

/**
 * @notice A dedicated contract for stETH burning requests scheduling
 *
 * @dev Burning stETH means 'decrease total underlying shares amount to perform stETH positive token rebase'
 */
contract Burner is IBurner, AccessControlEnumerable, Versioned {
    using SafeERC20 for IERC20;

    error AppAuthFailed();
    error MigrationNotAllowedOrAlreadyMigrated();
    error DirectETHTransfer();
    error ZeroRecoveryAmount();
    error StETHRecoveryWrongFunc();
    error ZeroBurnAmount();
    error BurnAmountExceedsActual(uint256 requestedAmount, uint256 actualAmount);
    error ZeroAddress(string field);
    error OnlyLidoCanMigrate();
    error NotInitialized();

    // -----------------------------
    //           STORAGE STRUCTS
    // -----------------------------
    /// @custom:storage-location erc7201:Burner
    struct Storage {
        uint256 coverSharesBurnRequested;
        uint256 nonCoverSharesBurnRequested;

        uint256 totalCoverSharesBurnt;
        uint256 totalNonCoverSharesBurnt;
    }

    /// @custom:storage-location erc7201:Burner:IsMigrationAllowed-v3Upgrade
    struct StorageV3Upgrade {
        bool isMigrationAllowed;
    }

    bytes32 public constant REQUEST_BURN_MY_STETH_ROLE = keccak256("REQUEST_BURN_MY_STETH_ROLE");
    bytes32 public constant REQUEST_BURN_SHARES_ROLE = keccak256("REQUEST_BURN_SHARES_ROLE");

    // keccak256(abi.encode(uint256(keccak256("Burner")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0xf01bebc885dbdcd6f86dfe57676112e525cafe0421724bf6b4a9ab1ee741de00;

    /// @dev After V3 Upgrade finished is no longer needed and should be removed
    // keccak256(abi.encode(uint256(keccak256("Burner.IsMigrationAllowed-v3Upgrade")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_V3_UPGRADE_LOCATION = 0xe26691b9ae4d2ff5628fc98afc2ccacdd3dd28e1ab2df809eb32ad4af2845800;

    ILidoLocator public immutable LOCATOR;
    ILido public immutable LIDO;

    /**
     * Emitted when a new stETH burning request is added by the `requestedBy` address.
     */
    event StETHBurnRequested(
        bool indexed isCover,
        address indexed requestedBy,
        uint256 amountOfStETH,
        uint256 amountOfShares
    );

    /**
     * Emitted when the stETH `amount` (corresponding to `amountOfShares` shares) burnt for the `isCover` reason.
     */
    event StETHBurnt(bool indexed isCover, uint256 amountOfStETH, uint256 amountOfShares);

    /**
     * Emitted when the excessive stETH `amount` (corresponding to `amountOfShares` shares) recovered (i.e. transferred)
     * to the Lido treasure address by `requestedBy` sender.
     */
    event ExcessStETHRecovered(address indexed requestedBy, uint256 amountOfStETH, uint256 amountOfShares);

    /**
     * Emitted when the ERC20 `token` recovered (i.e. transferred)
     * to the Lido treasure address by `requestedBy` sender.
     */
    event ERC20Recovered(address indexed requestedBy, address indexed token, uint256 amount);

    /**
     * Emitted when the ERC721-compatible `token` (NFT) recovered (i.e. transferred)
     * to the Lido treasure address by `requestedBy` sender.
     */
    event ERC721Recovered(address indexed requestedBy, address indexed token, uint256 tokenId);

    /**
     * Ctor
     *
     * @param _locator the Lido locator address
     * @param _stETH stETH token address
     */
    constructor(address _locator, address _stETH)
        Versioned()
    {
        if (_locator == address(0)) revert ZeroAddress("_locator");
        if (_stETH == address(0)) revert ZeroAddress("_stETH");

        LOCATOR = ILidoLocator(_locator);
        LIDO = ILido(_stETH);
    }

    /**
     * @notice Initializes the contract by setting up roles and migration allowance.
     * @dev This function should be called only once during the contract deployment.
     * @param _admin The address to be granted the DEFAULT_ADMIN_ROLE.
     * @param _isMigrationAllowed whether migration is allowed initially.
     */
    function initialize(address _admin, bool _isMigrationAllowed) external {
        if (_admin == address(0)) revert ZeroAddress("_admin");

        _initializeContractVersionTo(1);

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);

        _storageV3Upgrade().isMigrationAllowed = _isMigrationAllowed;
    }

    /**
     * @param _oldBurner The address of the old Burner contract
     * @dev Can be called only by Lido contract. Migrates state from the old Burner. Can be run only once.
     *      Cannot be run if migration is disabled upon deployment.
     */
    function migrate(address _oldBurner) external {
        if (msg.sender != address(LIDO)) revert OnlyLidoCanMigrate();
        if (_oldBurner == address(0)) revert ZeroAddress("_oldBurner");
        _checkContractVersion(1);
        if (!_storageV3Upgrade().isMigrationAllowed) revert MigrationNotAllowedOrAlreadyMigrated();
        _storageV3Upgrade().isMigrationAllowed = false;

        IBurner oldBurner = IBurner(_oldBurner);
        Storage storage $ = _storage();
        $.totalCoverSharesBurnt = oldBurner.getCoverSharesBurnt();
        $.totalNonCoverSharesBurnt = oldBurner.getNonCoverSharesBurnt();
        (uint256 coverShares, uint256 nonCoverShares) = oldBurner.getSharesRequestedToBurn();
        $.coverSharesBurnRequested = coverShares;
        $.nonCoverSharesBurnRequested = nonCoverShares;
    }

    /**
     * @notice Returns whether migration is allowed.
     * @dev After V3 Upgrade finished is no longer needed and should be removed
     */
    function isMigrationAllowed() external view returns (bool) {
        return _storageV3Upgrade().isMigrationAllowed;
    }

    /**
     * @notice BE CAREFUL, the provided stETH will be burnt permanently.
     *
     * Transfers `_stETHAmountToBurn` stETH tokens from the message sender and irreversibly locks these
     * on the burner contract address. Internally converts `_stETHAmountToBurn` amount into underlying
     * shares amount (`_stETHAmountToBurnAsShares`) and marks the converted amount for burning
     * by increasing the `coverSharesBurnRequested` counter.
     *
     * @param _stETHAmountToBurn stETH tokens to burn
     *
     */
    function requestBurnMyStETHForCover(uint256 _stETHAmountToBurn) external onlyRole(REQUEST_BURN_MY_STETH_ROLE) {
        LIDO.transferFrom(msg.sender, address(this), _stETHAmountToBurn);
        uint256 sharesAmount = LIDO.getSharesByPooledEth(_stETHAmountToBurn);
        _requestBurn(sharesAmount, _stETHAmountToBurn, true /* _isCover */);
    }

    /**
     * @notice BE CAREFUL, the provided stETH will be burnt permanently.
     *
     * Transfers `_sharesAmountToBurn` stETH shares from `_from` and irreversibly locks these
     * on the burner contract address. Marks the shares amount for burning
     * by increasing the `coverSharesBurnRequested` counter.
     *
     * @param _from address to transfer shares from
     * @param _sharesAmountToBurn stETH shares to burn
     *
     */
    function requestBurnSharesForCover(
        address _from,
        uint256 _sharesAmountToBurn
    ) external onlyRole(REQUEST_BURN_SHARES_ROLE) {
        uint256 stETHAmount = LIDO.transferSharesFrom(_from, address(this), _sharesAmountToBurn);
        _requestBurn(_sharesAmountToBurn, stETHAmount, true /* _isCover */);
    }

    /**
     * @notice BE CAREFUL, the provided stETH shares will be burnt permanently.
     *
     * Transfers `_sharesAmountToBurn` stETH shares from the message sender and irreversibly locks these
     * on the burner contract address. Marks the shares amount for burning
     * by increasing the `nonCoverSharesBurnRequested` counter.
     *
     * @param _sharesAmountToBurn stETH shares to burn
     *
     */
    function requestBurnMyShares(uint256 _sharesAmountToBurn) external onlyRole(REQUEST_BURN_MY_STETH_ROLE) {
        uint256 stETHAmount = LIDO.transferSharesFrom(msg.sender, address(this), _sharesAmountToBurn);
        _requestBurn(_sharesAmountToBurn, stETHAmount, false /* _isCover */);
    }

    /**
     * @notice BE CAREFUL, the provided stETH will be burnt permanently.
     * @dev DEPRECATED, use `requestBurnMyShares` instead to prevent dust accumulation.
     *
     * Transfers `_stETHAmountToBurn` stETH tokens from the message sender and irreversibly locks these
     * on the burner contract address. Internally converts `_stETHAmountToBurn` amount into underlying
     * shares amount (`_stETHAmountToBurnAsShares`) and marks the converted amount for burning
     * by increasing the `nonCoverSharesBurnRequested` counter.
     *
     * @param _stETHAmountToBurn stETH tokens to burn
     *
     */
    function requestBurnMyStETH(uint256 _stETHAmountToBurn) external onlyRole(REQUEST_BURN_MY_STETH_ROLE) {
        LIDO.transferFrom(msg.sender, address(this), _stETHAmountToBurn);
        uint256 sharesAmount = LIDO.getSharesByPooledEth(_stETHAmountToBurn);
        _requestBurn(sharesAmount, _stETHAmountToBurn, false /* _isCover */);
    }

    /**
     * @notice BE CAREFUL, the provided stETH will be burnt permanently.
     *
     * Transfers `_sharesAmountToBurn` stETH shares from `_from` and irreversibly locks these
     * on the burner contract address. Marks the shares amount for burning
     * by increasing the `nonCoverSharesBurnRequested` counter.
     *
     * @param _from address to transfer shares from
     * @param _sharesAmountToBurn stETH shares to burn
     *
     */
    function requestBurnShares(address _from, uint256 _sharesAmountToBurn) external onlyRole(REQUEST_BURN_SHARES_ROLE) {
        uint256 stETHAmount = LIDO.transferSharesFrom(_from, address(this), _sharesAmountToBurn);
        _requestBurn(_sharesAmountToBurn, stETHAmount, false /* _isCover */);
    }

    /**
     * Transfers the excess stETH amount (e.g. belonging to the burner contract address
     * but not marked for burning) to the Lido treasury address set upon the
     * contract construction.
     */
    function recoverExcessStETH() external {
        uint256 excessStETH = getExcessStETH();

        if (excessStETH > 0) {
            uint256 excessSharesAmount = LIDO.getSharesByPooledEth(excessStETH);

            emit ExcessStETHRecovered(msg.sender, excessStETH, excessSharesAmount);

            LIDO.transfer(LOCATOR.treasury(), excessStETH);
        }
    }

    /**
     * Intentionally deny incoming ether
     */
    receive() external payable {
        revert DirectETHTransfer();
    }

    /**
     * Transfers a given `_amount` of an ERC20-token (defined by the `_token` contract address)
     * currently belonging to the burner contract address to the Lido treasury address.
     *
     * @param _token an ERC20-compatible token
     * @param _amount token amount
     */
    function recoverERC20(address _token, uint256 _amount) external {
        if (_amount == 0) revert ZeroRecoveryAmount();
        if (_token == address(LIDO)) revert StETHRecoveryWrongFunc();

        IERC20(_token).safeTransfer(LOCATOR.treasury(), _amount);

        emit ERC20Recovered(msg.sender, _token, _amount);
    }

    /**
     * Transfers a given token_id of an ERC721-compatible NFT (defined by the token contract address)
     * currently belonging to the burner contract address to the Lido treasury address.
     *
     * @param _token an ERC721-compatible token
     * @param _tokenId minted token id
     */
    function recoverERC721(address _token, uint256 _tokenId) external {
        if (_token == address(LIDO)) revert StETHRecoveryWrongFunc();

        IERC721(_token).transferFrom(address(this), LOCATOR.treasury(), _tokenId);

        emit ERC721Recovered(msg.sender, _token, _tokenId);
    }

    /**
     * Commit cover/non-cover burning requests and logs cover/non-cover shares amount just burnt.
     *
     * NB: The real burn enactment to be invoked after the call (via internal Lido._burnShares())
     *
     * Increments `totalCoverSharesBurnt` and `totalNonCoverSharesBurnt` counters.
     * Decrements `coverSharesBurnRequested` and `nonCoverSharesBurnRequested` counters.
     * Does nothing if zero amount passed.
     *
     * @param _sharesToBurn amount of shares to be burnt
     */
    function commitSharesToBurn(uint256 _sharesToBurn) external virtual override {
        if (msg.sender != LOCATOR.accounting()) revert AppAuthFailed();

        if (_sharesToBurn == 0) {
            return;
        }

        Storage storage $ = _storage();
        uint256 memCoverSharesBurnRequested = $.coverSharesBurnRequested;
        uint256 memNonCoverSharesBurnRequested = $.nonCoverSharesBurnRequested;

        uint256 burnAmount = memCoverSharesBurnRequested + memNonCoverSharesBurnRequested;

        if (_sharesToBurn > burnAmount) {
            revert BurnAmountExceedsActual(_sharesToBurn, burnAmount);
        }

        uint256 sharesToBurnNow;
        if (memCoverSharesBurnRequested > 0) {
            uint256 sharesToBurnNowForCover = Math.min(_sharesToBurn, memCoverSharesBurnRequested);

            $.totalCoverSharesBurnt += sharesToBurnNowForCover;
            uint256 stETHToBurnNowForCover = LIDO.getPooledEthByShares(sharesToBurnNowForCover);
            emit StETHBurnt(true /* isCover */, stETHToBurnNowForCover, sharesToBurnNowForCover);

            $.coverSharesBurnRequested -= sharesToBurnNowForCover;
            sharesToBurnNow += sharesToBurnNowForCover;
        }
        if (memNonCoverSharesBurnRequested > 0 && sharesToBurnNow < _sharesToBurn) {
            uint256 sharesToBurnNowForNonCover = Math.min(
                _sharesToBurn - sharesToBurnNow,
                memNonCoverSharesBurnRequested
            );

            $.totalNonCoverSharesBurnt += sharesToBurnNowForNonCover;
            uint256 stETHToBurnNowForNonCover = LIDO.getPooledEthByShares(sharesToBurnNowForNonCover);
            emit StETHBurnt(false /* isCover */, stETHToBurnNowForNonCover, sharesToBurnNowForNonCover);

            $.nonCoverSharesBurnRequested -= sharesToBurnNowForNonCover;
            sharesToBurnNow += sharesToBurnNowForNonCover;
        }

        LIDO.burnShares(_sharesToBurn);
        assert(sharesToBurnNow == _sharesToBurn);
    }

    /**
     * Returns the current amount of shares locked on the contract to be burnt.
     */
    function getSharesRequestedToBurn()
        external
        view
        virtual
        override
        returns (uint256 coverShares, uint256 nonCoverShares)
    {
        Storage storage $ = _storage();
        coverShares = $.coverSharesBurnRequested;
        nonCoverShares = $.nonCoverSharesBurnRequested;
    }

    /**
     * Returns the total cover shares ever burnt.
     */
    function getCoverSharesBurnt() external view virtual override returns (uint256) {
        return _storage().totalCoverSharesBurnt;
    }

    /**
     * Returns the total non-cover shares ever burnt.
     */
    function getNonCoverSharesBurnt() external view virtual override returns (uint256) {
        return _storage().totalNonCoverSharesBurnt;
    }

    /**
     * Returns the stETH amount belonging to the burner contract address but not marked for burning.
     */
    function getExcessStETH() public view returns (uint256) {
        return LIDO.getPooledEthByShares(_getExcessStETHShares());
    }

    function _getExcessStETHShares() internal view returns (uint256) {
        Storage storage $ = _storage();
        uint256 sharesBurnRequested = ($.coverSharesBurnRequested + $.nonCoverSharesBurnRequested);
        uint256 totalShares = LIDO.sharesOf(address(this));

        // sanity check, don't revert
        if (totalShares <= sharesBurnRequested) {
            return 0;
        }

        return totalShares - sharesBurnRequested;
    }

    function _requestBurn(uint256 _sharesAmount, uint256 _stETHAmount, bool _isCover) private {
        if (_sharesAmount == 0) revert ZeroBurnAmount();

        emit StETHBurnRequested(_isCover, msg.sender, _stETHAmount, _sharesAmount);

        Storage storage $ = _storage();
        if (_isCover) {
            $.coverSharesBurnRequested += _sharesAmount;
        } else {
            $.nonCoverSharesBurnRequested += _sharesAmount;
        }
    }

    function _storage() internal pure returns (Storage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    function _storageV3Upgrade() internal pure returns (StorageV3Upgrade storage $) {
        assembly {
            $.slot := STORAGE_V3_UPGRADE_LOCATION
        }
    }
}
