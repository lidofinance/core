// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import "@openzeppelin/contracts-v4.4/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-v4.4/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts-v4.4/token/ERC20/utils/SafeERC20.sol";

import {Versioned} from "./utils/Versioned.sol";
import {AccessControlEnumerable} from "./utils/access/AccessControlEnumerable.sol";
import {PausableUntil} from "./utils/PausableUntil.sol";

import {WithdrawalVaultEIP7685} from "./WithdrawalVaultEIP7685.sol";

interface ILido {
    /**
     * @notice A payable function supposed to be called only by WithdrawalVault contract
     * @dev We need a dedicated function because funds received by the default payable function
     * are treated as a user deposit
     */
    function receiveWithdrawals() external payable;
}

/**
 * @title A vault for temporary storage of withdrawals
 */
contract WithdrawalVault is AccessControlEnumerable, Versioned, PausableUntil, WithdrawalVaultEIP7685 {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 public constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 public constant ADD_WITHDRAWAL_REQUEST_ROLE = keccak256("ADD_WITHDRAWAL_REQUEST_ROLE");

    ILido public immutable LIDO;
    address public immutable TREASURY;

    // Events
    /**
     * Emitted when the ERC20 `token` recovered (i.e. transferred)
     * to the Lido treasury address by `requestedBy` sender.
     */
    event ERC20Recovered(address indexed requestedBy, address indexed token, uint256 amount);

    /**
     * Emitted when the ERC721-compatible `token` (NFT) recovered (i.e. transferred)
     * to the Lido treasury address by `requestedBy` sender.
     */
    event ERC721Recovered(address indexed requestedBy, address indexed token, uint256 tokenId);

    // Errors
    error ZeroAddress();
    error NotLido();
    error NotEnoughEther(uint256 requested, uint256 balance);
    error ZeroAmount();

    /**
     * @param _lido the Lido token (stETH) address
     * @param _treasury the Lido treasury address (see ERC20/ERC721-recovery interfaces)
     */
    constructor(address _lido, address _treasury) {
        _onlyNonZeroAddress(_lido);
        _onlyNonZeroAddress(_treasury);

        LIDO = ILido(_lido);
        TREASURY = _treasury;
    }

    /// @dev Ensures the contract’s ETH balance is unchanged.
    modifier preservesEthBalance() {
        uint256 balanceBeforeCall = address(this).balance - msg.value;
        _;
        assert(address(this).balance == balanceBeforeCall);
    }

    /// @notice Initializes the contract. Can be called only once.
    /// @param _admin Lido DAO Aragon agent contract address.
    /// @dev Proxy initialization method.
    function initialize(address _admin) external {
        // Initializations for v0 --> v2
        _checkContractVersion(0);

        _initialize_v2(_admin);
        _initializeContractVersionTo(2);
    }

    /// @notice Finalizes upgrade to v2 (from v1). Can be called only once.
    /// @param _admin Lido DAO Aragon agent contract address.
    function finalizeUpgrade_v2(address _admin) external {
        // Finalization for v1 --> v2
        _checkContractVersion(1);

        _initialize_v2(_admin);
        _updateContractVersion(2);
    }

    /**
     * @dev Resumes the general purpose execution layer requests.
     * @notice Reverts if:
     *         - The contract is not paused.
     *         - The sender does not have the `RESUME_ROLE`.
     */
    function resume() external onlyRole(RESUME_ROLE) {
        _resume();
    }

    /**
     * @notice Pauses the general purpose execution layer requests placement for a specified duration.
     * @param _duration The pause duration in seconds (use `PAUSE_INFINITELY` for unlimited).
     * @dev Reverts if:
     *         - The contract is already paused.
     *         - The sender does not have the `PAUSE_ROLE`.
     *         - A zero duration is passed.
     */
    function pauseFor(uint256 _duration) external onlyRole(PAUSE_ROLE) {
        _pauseFor(_duration);
    }

    /**
     * @notice Pauses the general purpose execution layer requests placement until a specified timestamp.
     * @param _pauseUntilInclusive The last second to pause until (inclusive).
     * @dev Reverts if:
     *         - The timestamp is in the past.
     *         - The sender does not have the `PAUSE_ROLE`.
     *         - The contract is already paused.
     */
    function pauseUntil(uint256 _pauseUntilInclusive) external onlyRole(PAUSE_ROLE) {
        _pauseUntil(_pauseUntilInclusive);
    }

    /**
     * @notice Withdraw `_amount` of accumulated withdrawals to Lido contract
     * @dev Can be called only by the Lido contract
     * @param _amount amount of ETH to withdraw
     */
    function withdrawWithdrawals(uint256 _amount) external {
        if (msg.sender != address(LIDO)) {
            revert NotLido();
        }
        if (_amount == 0) {
            revert ZeroAmount();
        }

        uint256 balance = address(this).balance;
        if (_amount > balance) {
            revert NotEnoughEther(_amount, balance);
        }

        LIDO.receiveWithdrawals{value: _amount}();
    }

    /**
     * Transfers a given `_amount` of an ERC20-token (defined by the `_token` contract address)
     * currently belonging to the burner contract address to the Lido treasury address.
     *
     * @param _token an ERC20-compatible token
     * @param _amount token amount
     */
    function recoverERC20(IERC20 _token, uint256 _amount) external {
        if (_amount == 0) {
            revert ZeroAmount();
        }

        emit ERC20Recovered(msg.sender, address(_token), _amount);

        _token.safeTransfer(TREASURY, _amount);
    }

    /**
     * Transfers a given token_id of an ERC721-compatible NFT (defined by the token contract address)
     * currently belonging to the burner contract address to the Lido treasury address.
     *
     * @param _token an ERC721-compatible token
     * @param _tokenId minted token id
     */
    function recoverERC721(IERC721 _token, uint256 _tokenId) external {
        emit ERC721Recovered(msg.sender, address(_token), _tokenId);

        _token.transferFrom(address(this), TREASURY, _tokenId);
    }

    function _onlyNonZeroAddress(address _address) internal pure {
        if (_address == address(0)) revert ZeroAddress();
    }

    function _initialize_v2(address _admin) internal {
        _onlyNonZeroAddress(_admin);
        _setupRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /// Withdrawals EIP-7002
    function addWithdrawalRequests(bytes[] calldata pubkeys, uint64[] calldata amounts)
        external
        payable
        onlyRole(ADD_WITHDRAWAL_REQUEST_ROLE)
        whenResumed
        preservesEthBalance
    {
        _addWithdrawalRequests(pubkeys, amounts);
    }
}
