// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {StdAssertions} from "forge-std/StdAssertions.sol";
import {IERC165} from "forge-std/interfaces/IERC165.sol";

import {BeaconChainDepositor as BCDepositor} from "contracts/0.8.9/BeaconChainDepositor.sol";

// The following invariants are formulated and enforced for the `BeaconChainDepositor` contract:
// - exactly 32 ETH gets attached with every single deposit
// - actual BC deposits count correspond to the validators' pubkeys count provided
// - BC deposit data tuples go as is to the deposit contract not being altered or corrupted
/// @notice BCDepositor invariants contract for the forge test utils
/// @dev Uses two harness contracts to put the BCDepositor in the middle of them
contract BCDepositorInvariants is Test {
    DepositContractHarness public depositContract;
    BCDepositorHarness public bcDepositor;
    BCDepositorHandler public handler;

    function setUp() public {
        depositContract = new DepositContractHarness();
        bcDepositor = new BCDepositorHarness(address(depositContract));
        handler = new BCDepositorHandler(bcDepositor, depositContract);

        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = BCDepositorHandler.makeBeaconChainDeposits32ETH.selector;

        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));

        targetContract(address(handler));
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 32
     * forge-config: default.invariant.depth = 16
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_32ETHPaidPerKey() public view {
        uint256 depositContractBalance = address(depositContract).balance;
        assertEq(depositContractBalance, handler.ghost_totalETHDeposited(), "pays 32 ETH per key");
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 32
     * forge-config: default.invariant.depth = 16
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_DepositsCountIsCoherent() public view {
        assertEq(
            depositContract.get_deposit_count(),
            depositContract.to_little_endian_64(uint64(handler.ghost_totalDeposits())),
            "deposit count grows coherently"
        );
    }

    /**
     * https://book.getfoundry.sh/reference/config/inline-test-config#in-line-invariant-configs
     * forge-config: default.invariant.runs = 32
     * forge-config: default.invariant.depth = 16
     * forge-config: default.invariant.fail-on-revert = true
     */
    function invariant_DepositDataIsNotCorrupted() public view {
        for (uint256 depositId = 0; depositId < handler.ghost_totalDeposits(); ++depositId) {
            (
                bytes memory pubkey,
                bytes memory withdrawal_credentials,
                bytes memory amount,
                bytes memory signature,
                bytes memory index
            ) = depositContract.depositEvents(depositId);

            (
                bytes memory ghost_pubkey,
                bytes memory ghost_withdrawal_credentials,
                bytes memory ghost_amount,
                bytes memory ghost_signature,
                bytes memory ghost_index
            ) = handler.ghost_DepositEvents(depositId);

            assertEq(amount, ghost_amount, "deposit amount is the same");
            assertEq(index, ghost_index, "deposit index is the same");
            assertEq(pubkey, ghost_pubkey, "deposit pubkey is the same");
            assertEq(signature, ghost_signature, "deposit signature is the same");
            assertEq(withdrawal_credentials, ghost_withdrawal_credentials, "deposit wc are the same");
        }
    }
}

contract BCDepositorHandler is CommonBase, StdAssertions, StdUtils {
    uint256 public constant WITHDRAWAL_CREDENTIALS_START = 2 ** 248; // 0x01....00
    uint256 public constant WITHDRAWAL_CREDENTIALS_END = 2 ** 249 - 1; // 0x01FF...FF

    uint8 public constant MAX_DEPOSITS = 150; // max DSM deposits per block

    BCDepositorHarness public bcDepositor;
    DepositContractHarness public depositContract;

    uint256 public ghost_totalDeposits;
    uint256 public ghost_totalETHDeposited;
    DepositContractHarness.DepositEventData[] public ghost_DepositEvents;

    constructor(BCDepositorHarness _bcDepositor, DepositContractHarness _depositContract) {
        bcDepositor = _bcDepositor;
        depositContract = _depositContract;
    }

    /// @dev Ghosted version of the _makeBeaconChainDeposits32ETH for invariant checks
    /// @param _keysCount amount of keys to deposit
    /// @param _withdrawalCredentialsAsUint256 Commitment to a public key for withdrawals
    /// @param _depositDataSeed Randomized seed for deposit data generation (auxiliary param)
    function makeBeaconChainDeposits32ETH(
        uint256 _keysCount,
        uint256 _withdrawalCredentialsAsUint256,
        uint256 _depositDataSeed
    ) external {
        // use MAX_DEPOSITS as defined for DSM per a single block
        _keysCount = bound(_keysCount, 1, MAX_DEPOSITS);
        // use withdrawal credentials with the `0x01` prefix
        _withdrawalCredentialsAsUint256 = bound(
            _withdrawalCredentialsAsUint256,
            WITHDRAWAL_CREDENTIALS_START,
            WITHDRAWAL_CREDENTIALS_END
        );
        // leave some space to prevent overflow for the seed increments
        _depositDataSeed = bound(_depositDataSeed, 0, type(uint248).max);

        bytes memory withdrawalCredentials = abi.encodePacked(_withdrawalCredentialsAsUint256);

        bytes memory encoded_keys;
        bytes memory encoded_signatures;

        for (uint256 key = 0; key < _keysCount; key++) {
            bytes memory pubkey = abi.encodePacked(
                bytes16(sha256(abi.encodePacked(_depositDataSeed++))),
                bytes16(sha256(abi.encodePacked(_depositDataSeed++))),
                bytes16(sha256(abi.encodePacked(_depositDataSeed++)))
            );
            encoded_keys = bytes.concat(encoded_keys, pubkey);

            bytes memory signature = abi.encodePacked(
                sha256(abi.encodePacked(_depositDataSeed++)),
                sha256(abi.encodePacked(_depositDataSeed++)),
                sha256(abi.encodePacked(_depositDataSeed++))
            );
            encoded_signatures = bytes.concat(encoded_signatures, signature);

            ghost_DepositEvents.push(
                DepositContractHarness.DepositEventData(
                    pubkey,
                    withdrawalCredentials,
                    depositContract.to_little_endian_64(uint64(32 ether / 1 gwei)),
                    signature,
                    depositContract.to_little_endian_64(uint64(ghost_totalDeposits))
                )
            );

            ghost_totalDeposits += 1;
            ghost_totalETHDeposited += 32 ether;
        }

        // top-up depositor's balance to perform deposits
        vm.deal(address(bcDepositor), 32 ether * _keysCount);
        bcDepositor.makeBeaconChainDeposits32ETH(_keysCount, withdrawalCredentials, encoded_keys, encoded_signatures);
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
/// For more information see the Phase 0 specification under https://github.com/ethereum/consensus-specs/tree/dev/specs/phase0
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

// This is a rewrite of the Vyper Eth2.0 deposit contract in Solidity.
// It tries to stay as close as possible to the original source code.
/// @notice This is the Ethereum 2.0 deposit contract interface.
/// For more information see the Phase 0 specification under https://github.com/ethereum/consensus-specs/tree/dev/specs/phase0
contract DepositContractHarness is IDepositContract, IERC165 {
    uint constant DEPOSIT_CONTRACT_TREE_DEPTH = 32;
    // NOTE: this also ensures `deposit_count` will fit into 64-bits
    uint constant MAX_DEPOSIT_COUNT = 2 ** DEPOSIT_CONTRACT_TREE_DEPTH - 1;

    bytes32[DEPOSIT_CONTRACT_TREE_DEPTH] branch;
    uint256 deposit_count;

    bytes32[DEPOSIT_CONTRACT_TREE_DEPTH] zero_hashes;

    struct DepositEventData {
        bytes pubkey;
        bytes withdrawal_credentials;
        bytes amount;
        bytes signature;
        bytes index;
    }

    // Dev: harness part
    DepositEventData[] public depositEvents;

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
        emit DepositEvent(
            pubkey,
            withdrawal_credentials,
            amount,
            signature,
            to_little_endian_64(uint64(deposit_count))
        );

        // Dev: harness part
        depositEvents.push(
            DepositEventData(
                pubkey,
                withdrawal_credentials,
                amount,
                signature,
                to_little_endian_64(uint64(deposit_count))
            )
        );

        // Compute deposit data root (`DepositData` hash tree root)
        bytes32 pubkey_root = sha256(abi.encodePacked(pubkey, bytes16(0)));
        bytes32 signature_root = sha256(
            abi.encodePacked(
                sha256(abi.encodePacked(signature[:64])),
                sha256(abi.encodePacked(signature[64:], bytes32(0)))
            )
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
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IDepositContract).interfaceId;
    }

    // Dev: function visibility lifted
    function to_little_endian_64(uint64 value) public pure returns (bytes memory ret) {
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
