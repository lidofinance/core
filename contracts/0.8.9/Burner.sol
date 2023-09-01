// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {IERC20} from "@openzeppelin/contracts-v4.4/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts-v4.4/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts-v4.4/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts-v4.4/utils/math/Math.sol";

import {AccessControlEnumerable} from "./utils/access/AccessControlEnumerable.sol";
import {IBurner} from "../common/interfaces/IBurner.sol";

/**
  * @title Interface defining ERC20-compatible StETH token
  */
interface IStETH is IERC20 {
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
    function transferSharesFrom(
        address _sender, address _recipient, uint256 _sharesAmount
    ) external returns (uint256);
}

/**
  * @notice A dedicated contract for stETH burning requests scheduling
  *
  * @dev Burning stETH means 'decrease total underlying shares amount to perform stETH positive token rebase'
  */
contract Burner is IBurner, AccessControlEnumerable {
    using SafeERC20 for IERC20;

    error AppAuthLidoFailed();
    error DirectETHTransfer();
    error ZeroRecoveryAmount();
    error StETHRecoveryWrongFunc();
    error ZeroBurnAmount();
    error BurnAmountExceedsActual(uint256 requestedAmount, uint256 actualAmount);
    error ZeroAddress(string field);

    bytes32 public constant REQUEST_BURN_MY_STETH_ROLE = keccak256("REQUEST_BURN_MY_STETH_ROLE");
    bytes32 public constant REQUEST_BURN_SHARES_ROLE = keccak256("REQUEST_BURN_SHARES_ROLE");

    uint256 private coverSharesBurnRequested;
    uint256 private nonCoverSharesBurnRequested;

    uint256 private totalCoverSharesBurnt;
    uint256 private totalNonCoverSharesBurnt;

    address public immutable STETH;
    address public immutable TREASURY;

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
    event StETHBurnt(
        bool indexed isCover,
        uint256 amountOfStETH,
        uint256 amountOfShares
    );

    /**
      * Emitted when the excessive stETH `amount` (corresponding to `amountOfShares` shares) recovered (i.e. transferred)
      * to the Lido treasure address by `requestedBy` sender.
      */
    event ExcessStETHRecovered(
        address indexed requestedBy,
        uint256 amountOfStETH,
        uint256 amountOfShares
    );

    /**
      * Emitted when the ERC20 `token` recovered (i.e. transferred)
      * to the Lido treasure address by `requestedBy` sender.
      */
    event ERC20Recovered(
        address indexed requestedBy,
        address indexed token,
        uint256 amount
    );

    /**
      * Emitted when the ERC721-compatible `token` (NFT) recovered (i.e. transferred)
      * to the Lido treasure address by `requestedBy` sender.
      */
    event ERC721Recovered(
        address indexed requestedBy,
        address indexed token,
        uint256 tokenId
    );

    /**
      * Ctor
      *
      * @param _admin the Lido DAO Aragon agent contract address
      * @param _treasury the Lido treasury address (see StETH/ERC20/ERC721-recovery interfaces)
      * @param _stETH stETH token address
      * @param _totalCoverSharesBurnt Shares burnt counter init value (cover case)
      * @param _totalNonCoverSharesBurnt Shares burnt counter init value (non-cover case)
      */
    constructor(
        address _admin,
        address _treasury,
        address _stETH,
        uint256 _totalCoverSharesBurnt,
        uint256 _totalNonCoverSharesBurnt
    ) {
        if (_admin == address(0)) revert ZeroAddress("_admin");
        if (_treasury == address(0)) revert ZeroAddress("_treasury");
        if (_stETH == address(0)) revert ZeroAddress("_stETH");

        _setupRole(DEFAULT_ADMIN_ROLE, _admin);
        _setupRole(REQUEST_BURN_SHARES_ROLE, _stETH);

        TREASURY = _treasury;
        STETH = _stETH;

        totalCoverSharesBurnt = _totalCoverSharesBurnt;
        totalNonCoverSharesBurnt = _totalNonCoverSharesBurnt;
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
        IStETH(STETH).transferFrom(msg.sender, address(this), _stETHAmountToBurn);
        uint256 sharesAmount = IStETH(STETH).getSharesByPooledEth(_stETHAmountToBurn);
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
    function requestBurnSharesForCover(address _from, uint256 _sharesAmountToBurn) external onlyRole(REQUEST_BURN_SHARES_ROLE) {
        uint256 stETHAmount = IStETH(STETH).transferSharesFrom(_from, address(this), _sharesAmountToBurn);
        _requestBurn(_sharesAmountToBurn, stETHAmount, true /* _isCover */);
    }

    /**
      * @notice BE CAREFUL, the provided stETH will be burnt permanently.
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
        IStETH(STETH).transferFrom(msg.sender, address(this), _stETHAmountToBurn);
        uint256 sharesAmount = IStETH(STETH).getSharesByPooledEth(_stETHAmountToBurn);
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
        uint256 stETHAmount = IStETH(STETH).transferSharesFrom(_from, address(this), _sharesAmountToBurn);
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
            uint256 excessSharesAmount = IStETH(STETH).getSharesByPooledEth(excessStETH);

            emit ExcessStETHRecovered(msg.sender, excessStETH, excessSharesAmount);

            IStETH(STETH).transfer(TREASURY, excessStETH);
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
        if (_token == STETH) revert StETHRecoveryWrongFunc();

        emit ERC20Recovered(msg.sender, _token, _amount);

        IERC20(_token).safeTransfer(TREASURY, _amount);
    }

    /**
      * Transfers a given token_id of an ERC721-compatible NFT (defined by the token contract address)
      * currently belonging to the burner contract address to the Lido treasury address.
      *
      * @param _token an ERC721-compatible token
      * @param _tokenId minted token id
      */
    function recoverERC721(address _token, uint256 _tokenId) external {
        if (_token == STETH) revert StETHRecoveryWrongFunc();

        emit ERC721Recovered(msg.sender, _token, _tokenId);

        IERC721(_token).transferFrom(address(this), TREASURY, _tokenId);
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
        if (msg.sender != STETH) revert AppAuthLidoFailed();

        if (_sharesToBurn == 0) {
            return;
        }

        uint256 memCoverSharesBurnRequested = coverSharesBurnRequested;
        uint256 memNonCoverSharesBurnRequested = nonCoverSharesBurnRequested;

        uint256 burnAmount = memCoverSharesBurnRequested + memNonCoverSharesBurnRequested;

        if (_sharesToBurn > burnAmount) {
            revert BurnAmountExceedsActual(_sharesToBurn, burnAmount);
        }

        uint256 sharesToBurnNow;
        if (memCoverSharesBurnRequested > 0) {
            uint256 sharesToBurnNowForCover = Math.min(_sharesToBurn, memCoverSharesBurnRequested);

            totalCoverSharesBurnt += sharesToBurnNowForCover;
            uint256 stETHToBurnNowForCover = IStETH(STETH).getPooledEthByShares(sharesToBurnNowForCover);
            emit StETHBurnt(true /* isCover */, stETHToBurnNowForCover, sharesToBurnNowForCover);

            coverSharesBurnRequested -= sharesToBurnNowForCover;
            sharesToBurnNow += sharesToBurnNowForCover;
        }
        if (memNonCoverSharesBurnRequested > 0 && sharesToBurnNow < _sharesToBurn) {
            uint256 sharesToBurnNowForNonCover = Math.min(
                _sharesToBurn - sharesToBurnNow,
                memNonCoverSharesBurnRequested
            );

            totalNonCoverSharesBurnt += sharesToBurnNowForNonCover;
            uint256 stETHToBurnNowForNonCover = IStETH(STETH).getPooledEthByShares(sharesToBurnNowForNonCover);
            emit StETHBurnt(false /* isCover */, stETHToBurnNowForNonCover, sharesToBurnNowForNonCover);

            nonCoverSharesBurnRequested -= sharesToBurnNowForNonCover;
            sharesToBurnNow += sharesToBurnNowForNonCover;
        }
        assert(sharesToBurnNow == _sharesToBurn);
    }

    /**
      * Returns the current amount of shares locked on the contract to be burnt.
      */
    function getSharesRequestedToBurn() external view virtual override returns (
        uint256 coverShares, uint256 nonCoverShares
    ) {
        coverShares = coverSharesBurnRequested;
        nonCoverShares = nonCoverSharesBurnRequested;
    }

    /**
      * Returns the total cover shares ever burnt.
      */
    function getCoverSharesBurnt() external view virtual override returns (uint256) {
        return totalCoverSharesBurnt;
    }

    /**
      * Returns the total non-cover shares ever burnt.
      */
    function getNonCoverSharesBurnt() external view virtual override returns (uint256) {
        return totalNonCoverSharesBurnt;
    }

    /**
      * Returns the stETH amount belonging to the burner contract address but not marked for burning.
      */
    function getExcessStETH() public view returns (uint256)  {
        return IStETH(STETH).getPooledEthByShares(_getExcessStETHShares());
    }

    function _getExcessStETHShares() internal view returns (uint256) {
        uint256 sharesBurnRequested = (coverSharesBurnRequested + nonCoverSharesBurnRequested);
        uint256 totalShares = IStETH(STETH).sharesOf(address(this));

        // sanity check, don't revert
        if (totalShares <= sharesBurnRequested) {
            return 0;
        }

        return totalShares - sharesBurnRequested;
    }

    function _requestBurn(uint256 _sharesAmount, uint256 _stETHAmount, bool _isCover) private {
        if (_sharesAmount == 0) revert ZeroBurnAmount();

        emit StETHBurnRequested(_isCover, msg.sender, _stETHAmount, _sharesAmount);

        if (_isCover) {
            coverSharesBurnRequested += _sharesAmount;
        } else {
            nonCoverSharesBurnRequested += _sharesAmount;
        }
    }
}
