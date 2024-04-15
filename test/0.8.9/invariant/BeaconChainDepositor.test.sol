// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// for testing purposes only

pragma solidity 0.8.9;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {StdAssertions} from "forge-std/StdAssertions.sol";
import {console2} from "forge-std/console2.sol";

import {BeaconChainDepositor as BCDepositor} from "contracts/0.8.9/BeaconChainDepositor.sol";

contract BCDepositorInvariants is Test {
  DepositContract public depositContract;
  BCDepositorHarness public bcDepositor;
  BCDepositorHandler public handler;

  function setUp() public {
    depositContract = new DepositContract();
    bcDepositor = new BCDepositorHarness(address(depositContract));
    handler = new BCDepositorHandler(bcDepositor);

    bytes4[] memory selectors = new bytes4[](1);
    selectors[0] = BCDepositorHandler.makeBeaconChainDeposits32ETH.selector;

    targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));

    targetContract(address(handler));
  }

  function invariant_32ETHPaidPerKey() public {
    uint256 depositContractBalance = address(depositContract).balance;
    assertEq(depositContractBalance, handler.ghost_totalETHDeposited(), "pays 32 ETH per key");
  }
  function invariant_WithdrawalCredentialsTheSame() public {}
  function invariant_DepositsCountIsCoherent() public {
    assertEq(depositContract.get_deposit_count(), handler.ghost_totalDeposits(), "deposit count grows coherently");
  }
  function invarinat_DepositDataIsNotCorrupted() public {}
}

contract BCDepositorHandler is CommonBase, StdAssertions, StdUtils {
  BCDepositorHarness public bcDepositor;

  uint256 public ghost_totalDeposits;
  uint256 public ghost_totalETHDeposited;

  constructor(BCDepositorHarness _bcDepositor) {
    bcDepositor = _bcDepositor;
  }

  function makeBeaconChainDeposits32ETH(
    uint256 keysCount,
    uint256 withdrawalCredentialsAsUint256,
    bytes memory publicKeysBatch,
    bytes memory signaturesBatch
  ) external {
    keysCount = bound(keysCount, 1, 1000);
    withdrawalCredentialsAsUint256 = bound(withdrawalCredentialsAsUint256, 0, type(uint256).max);
    bytes memory withdrawalCredentials = new bytes(32);
    for (uint256 i = 0; i < 32; ++i) {
      withdrawalCredentials[i] = bytes32(withdrawalCredentialsAsUint256)[i];
    }

    bcDepositor.makeBeaconChainDeposits32ETH(keysCount, withdrawalCredentials, publicKeysBatch, signaturesBatch);

    ghost_totalDeposits += keysCount;
    ghost_totalETHDeposited += (keysCount * 32 ether);
  }
}

contract BCDepositorHarness is BCDepositor {
  constructor(address _depositContract) BCDepositor(_depositContract) {}

  /// @dev Exposed version of the _makeBeaconChainDeposits32ETH
  /// @param _keysCount amount of keys to deposit
  /// @param _withdrawalCredentials Commitment to a public key for withdrawals
  /// @param _publicKeysBatch A BLS12-381 public keys batch
  /// @param _signaturesBatch A BLS12-381 signatures batch
  function makeBeaconChainDeposits32ETH(
    uint256 _keysCount,
    bytes memory _withdrawalCredentials,
    bytes memory _publicKeysBatch,
    bytes memory _signaturesBatch
  ) external {
    _makeBeaconChainDeposits32ETH(_keysCount, _withdrawalCredentials, _publicKeysBatch, _signaturesBatch);
  }
}

// This interface is designed to be compatible with the Vyper version.
/// @notice This is the Ethereum 2.0 deposit contract interface.
/// For more information see the Phase 0 specification under https://github.com/ethereum/eth2.0-specs
interface IDepositContract {
  /// @notice A processed deposit event.
  event DepositEvent(bytes pubkey, bytes withdrawal_credentials, bytes amount, bytes signature, bytes index);

  /// @notice Submit a Phase 0 DepositData object.
  /// @param pubkey A BLS12-381 public key.
  /// @param withdrawal_credentials Commitment to a public key for withdrawals.
  /// @param signature A BLS12-381 signature.
  /// @param deposit_data_root The SHA-256 hash of the SSZ-encoded DepositData object.
  /// Used as a protection against malformed input.
  function deposit(
    bytes calldata pubkey,
    bytes calldata withdrawal_credentials,
    bytes calldata signature,
    bytes32 deposit_data_root
  ) external payable;

  /// @notice Query the current deposit root hash.
  /// @return The deposit root hash.
  function get_deposit_root() external view returns (bytes32);

  /// @notice Query the current deposit count.
  /// @return The deposit count encoded as a little endian 64-bit number.
  function get_deposit_count() external view returns (bytes memory);
}

// Based on official specification in https://eips.ethereum.org/EIPS/eip-165
interface ERC165 {
  /// @notice Query if a contract implements an interface
  /// @param interfaceId The interface identifier, as specified in ERC-165
  /// @dev Interface identification is specified in ERC-165. This function
  ///  uses less than 30,000 gas.
  /// @return `true` if the contract implements `interfaceId` and
  ///  `interfaceId` is not 0xffffffff, `false` otherwise
  function supportsInterface(bytes4 interfaceId) external pure returns (bool);
}

// This is a rewrite of the Vyper Eth2.0 deposit contract in Solidity.
// It tries to stay as close as possible to the original source code.
/// @notice This is the Ethereum 2.0 deposit contract interface.
/// For more information see the Phase 0 specification under https://github.com/ethereum/eth2.0-specs
contract DepositContract is IDepositContract, ERC165 {
  uint constant DEPOSIT_CONTRACT_TREE_DEPTH = 32;
  // NOTE: this also ensures `deposit_count` will fit into 64-bits
  uint constant MAX_DEPOSIT_COUNT = 2 ** DEPOSIT_CONTRACT_TREE_DEPTH - 1;

  bytes32[DEPOSIT_CONTRACT_TREE_DEPTH] branch;
  uint256 deposit_count;

  bytes32[DEPOSIT_CONTRACT_TREE_DEPTH] zero_hashes;

  constructor() {
    // Compute hashes in empty sparse Merkle tree
    for (uint height = 0; height < DEPOSIT_CONTRACT_TREE_DEPTH - 1; height++)
      zero_hashes[height + 1] = sha256(abi.encodePacked(zero_hashes[height], zero_hashes[height]));
  }

  function get_deposit_root() external view override returns (bytes32) {
    bytes32 node;
    uint size = deposit_count;
    for (uint height = 0; height < DEPOSIT_CONTRACT_TREE_DEPTH; height++) {
      if ((size & 1) == 1) node = sha256(abi.encodePacked(branch[height], node));
      else node = sha256(abi.encodePacked(node, zero_hashes[height]));
      size /= 2;
    }
    return sha256(abi.encodePacked(node, to_little_endian_64(uint64(deposit_count)), bytes24(0)));
  }

  function get_deposit_count() external view override returns (bytes memory) {
    return to_little_endian_64(uint64(deposit_count));
  }

  function deposit(
    bytes calldata pubkey,
    bytes calldata withdrawal_credentials,
    bytes calldata signature,
    bytes32 deposit_data_root
  ) external payable override {
    // Extended ABI length checks since dynamic types are used.
    require(pubkey.length == 48, "DepositContract: invalid pubkey length");
    require(withdrawal_credentials.length == 32, "DepositContract: invalid withdrawal_credentials length");
    require(signature.length == 96, "DepositContract: invalid signature length");

    // Check deposit amount
    require(msg.value >= 1 ether, "DepositContract: deposit value too low");
    require(msg.value % 1 gwei == 0, "DepositContract: deposit value not multiple of gwei");
    uint deposit_amount = msg.value / 1 gwei;
    require(deposit_amount <= type(uint64).max, "DepositContract: deposit value too high");

    // Emit `DepositEvent` log
    bytes memory amount = to_little_endian_64(uint64(deposit_amount));
    emit DepositEvent(pubkey, withdrawal_credentials, amount, signature, to_little_endian_64(uint64(deposit_count)));

    // Compute deposit data root (`DepositData` hash tree root)
    bytes32 pubkey_root = sha256(abi.encodePacked(pubkey, bytes16(0)));
    bytes32 signature_root = sha256(
      abi.encodePacked(sha256(abi.encodePacked(signature[:64])), sha256(abi.encodePacked(signature[64:], bytes32(0))))
    );
    bytes32 node = sha256(
      abi.encodePacked(
        sha256(abi.encodePacked(pubkey_root, withdrawal_credentials)),
        sha256(abi.encodePacked(amount, bytes24(0), signature_root))
      )
    );

    // Verify computed and expected deposit data roots match
    require(
      node == deposit_data_root,
      "DepositContract: reconstructed DepositData does not match supplied deposit_data_root"
    );

    // Avoid overflowing the Merkle tree (and prevent edge case in computing `branch`)
    require(deposit_count < MAX_DEPOSIT_COUNT, "DepositContract: merkle tree full");

    // Add deposit data root to Merkle tree (update a single `branch` node)
    deposit_count += 1;
    uint size = deposit_count;
    for (uint height = 0; height < DEPOSIT_CONTRACT_TREE_DEPTH; height++) {
      if ((size & 1) == 1) {
        branch[height] = node;
        return;
      }
      node = sha256(abi.encodePacked(branch[height], node));
      size /= 2;
    }
    // As the loop should always end prematurely with the `return` statement,
    // this code should be unreachable. We assert `false` just to be safe.
    assert(false);
  }

  function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
    return interfaceId == type(ERC165).interfaceId || interfaceId == type(IDepositContract).interfaceId;
  }

  function to_little_endian_64(uint64 value) internal pure returns (bytes memory ret) {
    ret = new bytes(8);
    bytes8 bytesValue = bytes8(value);
    // Byteswapping during copying to bytes.
    ret[0] = bytesValue[7];
    ret[1] = bytesValue[6];
    ret[2] = bytesValue[5];
    ret[3] = bytesValue[4];
    ret[4] = bytesValue[3];
    ret[5] = bytesValue[2];
    ret[6] = bytesValue[1];
    ret[7] = bytesValue[0];
  }
}
