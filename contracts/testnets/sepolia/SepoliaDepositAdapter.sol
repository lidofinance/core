// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import "@openzeppelin/contracts-v4.4/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-v4.4/access/Ownable.sol";
import "../../0.8.9/utils/Versioned.sol";

interface IDepositContract {
    event DepositEvent(bytes pubkey, bytes withdrawal_credentials, bytes amount, bytes signature, bytes index);

    function deposit(
        bytes calldata pubkey,
        bytes calldata withdrawal_credentials,
        bytes calldata signature,
        bytes32 deposit_data_root
    ) external payable;

    function get_deposit_root() external view returns (bytes32);

    function get_deposit_count() external view returns (bytes memory);
}

// Sepolia deposit contract variant of the source code https://github.com/protolambda/testnet-dep-contract/blob/master/deposit_contract.sol
interface ISepoliaDepositContract is IDepositContract, IERC20 {}

// Sepolia testnet deposit contract have a bit different logic than the mainnet deposit contract.
// The differences are:
// 1. Sepolia contract require specific Bepolia token to be used for depositing. It burns this token after depositing.
// 2. It returns the ETH to the sender after depositing.
// This adapter is used to make the mainnet deposit contract compatible with the testnet deposit contract.
// For further information see Sepolia deposit contract variant source code link above.
contract SepoliaDepositAdapter is IDepositContract, Ownable, Versioned {
    event EthReceived(address sender, uint256 amount);
    event EthRecovered(uint256 amount);
    event BepoliaRecovered(uint256 amount);

    error EthRecoverFailed();
    error BepoliaRecoverFailed();
    error DepositFailed();
    error ZeroAddress(string field);

    // Sepolia original deposit contract address
    ISepoliaDepositContract public immutable originalContract;

    constructor(address _deposit_contract) {
        originalContract = ISepoliaDepositContract(_deposit_contract);
    }

    function initialize(address _owner) external {
        if (_owner == address(0)) revert ZeroAddress("_owner");

        _initializeContractVersionTo(1);
        _transferOwnership(_owner);
    }

    function get_deposit_root() external view override returns (bytes32) {
        return originalContract.get_deposit_root();
    }

    function get_deposit_count() external view override returns (bytes memory) {
        return originalContract.get_deposit_count();
    }

    receive() external payable {
        emit EthReceived(msg.sender, msg.value);
    }

    function recoverEth() external onlyOwner {
        uint256 balance = address(this).balance;
        // solhint-disable-next-line avoid-low-level-calls
        (bool success,) = owner().call{value: balance}("");
        if (!success) {
            revert EthRecoverFailed();
        }
        emit EthRecovered(balance);
    }

    function recoverBepolia() external onlyOwner {
        uint256 bepoliaOwnTokens = originalContract.balanceOf(address(this));
        bool success = originalContract.transfer(owner(), bepoliaOwnTokens);
        if (!success) {
            revert BepoliaRecoverFailed();
        }
        emit BepoliaRecovered(bepoliaOwnTokens);
    }

    function deposit(
        bytes calldata pubkey,
        bytes calldata withdrawal_credentials,
        bytes calldata signature,
        bytes32 deposit_data_root
    ) external payable override {
        originalContract.deposit{value: msg.value}(pubkey, withdrawal_credentials, signature, deposit_data_root);
        // solhint-disable-next-line avoid-low-level-calls
        (bool success,) = owner().call{value: msg.value}("");
        if (!success) {
            revert DepositFailed();
        }
    }
}
