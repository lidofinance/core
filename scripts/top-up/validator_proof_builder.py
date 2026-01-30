#!/usr/bin/env python3
"""
Build Merkle proofs for validator top-up verification via EIP-4788.

Usage examples:                                                                                                                                     
                                                                                                                                                      
  # Build proofs and write to default file                                                                                                            
  python validator_proof_builder.py prove \                                                                                                
    -e http://localhost:8545 -c http://localhost:5052 \                                                                                               
    -v 12345 -v 67890 -o                                                                                                                              
                                                                                                                                                      
  # Build proofs to custom file                                                                                                                       
  python validator_proof_builder.py prove \                                                                                                
    -e http://localhost:8545 -c http://localhost:5052 \                                                                                               
    -v 12345 -o my_proofs.json                                                                                                                        
                                                                                                                                                      
  # Send top-up transaction (reads PRIVATE_KEY from .env)                                                                                             
  python validator_proof_builder.py top-up \                                                                                               
    -e http://localhost:8545 \                                                                                                                        
    -g 0xYourGatewayAddress \                                                                                                                         
    -v 12345 -k 0 --operator-id 1 \                                                                                                                   
    -v 67890 -k 1 --operator-id 1 \                                                                                                                   
    -m 1
    
Output:
    JSON to stdout matching TopUpData struct for on-chain verification.

Flow:
    1. Fetch latest block from EL (eth_getBlockByNumber)
    2. Extract parentBeaconBlockRoot and timestamp from EL block
       - parentBeaconBlockRoаot = beacon root verifiable via 4788 precompile
       - timestamp = key to query 4788 on-chain
    3. Fetch beacon block by root from CL
    4. Build validator proofs against that beacon block's state
    5. Verify proofs locally before output

On-chain verification:
    Call 4788 precompile at 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02
    with childBlockTimestamp to get beacon_root, then verify proofs against it.
"""

import argparse
import hashlib
import json
import os
import sys
from dataclasses import dataclass
from typing import List

import requests
from dotenv import load_dotenv
from web3 import Web3

# ============================================
# remerkleable imports
# ============================================
from remerkleable.basic import uint64, uint8, boolean, uint256
from remerkleable.byte_arrays import Bytes32, Bytes48, Bytes4, Bytes96
from remerkleable.byte_arrays import ByteVector
from remerkleable.complex import Container, List as SSZList, Vector
from remerkleable.bitfields import Bitvector
from remerkleable.tree import Node


# ============================================
# Constants (Mainnet Electra)
# ============================================
VALIDATOR_REGISTRY_LIMIT = 2**40
SLOTS_PER_HISTORICAL_ROOT = 8192
EPOCHS_PER_HISTORICAL_VECTOR = 65536
EPOCHS_PER_SLASHINGS_VECTOR = 8192
HISTORICAL_ROOTS_LIMIT = 16777216
ETH1_DATA_VOTES_LIMIT = 2048
JUSTIFICATION_BITS_LENGTH = 4
SYNC_COMMITTEE_SIZE = 512
EPOCHS_PER_SYNC_COMMITTEE_PERIOD = 256
MAX_PROPOSER_SLASHINGS = 16
MAX_ATTESTER_SLASHINGS = 2
MAX_ATTESTATIONS = 128
MAX_DEPOSITS = 16
MAX_VOLUNTARY_EXITS = 16
MAX_BLS_TO_EXECUTION_CHANGES = 16
MAX_WITHDRAWALS_PER_PAYLOAD = 16
MAX_BLOB_COMMITMENTS_PER_BLOCK = 4096

MIN_SEED_LOOKAHEAD = 1
SLOTS_PER_EPOCH = 32
PROPOSER_LOOKAHEAD_SIZE = (MIN_SEED_LOOKAHEAD + 1) * SLOTS_PER_EPOCH  # = 64


# ============================================
# SSZ Type Definitions (Deneb)
# ============================================


class Fork(Container):
    previous_version: Bytes4
    current_version: Bytes4
    epoch: uint64


class Checkpoint(Container):
    epoch: uint64
    root: Bytes32


class Validator(Container):
    pubkey: Bytes48
    withdrawal_credentials: Bytes32
    effective_balance: uint64
    slashed: boolean
    activation_eligibility_epoch: uint64
    activation_epoch: uint64
    exit_epoch: uint64
    withdrawable_epoch: uint64


class Eth1Data(Container):
    deposit_root: Bytes32
    deposit_count: uint64
    block_hash: Bytes32


class BeaconBlockHeader(Container):
    slot: uint64
    proposer_index: uint64
    parent_root: Bytes32
    state_root: Bytes32
    body_root: Bytes32


class SyncCommittee(Container):
    pubkeys: Vector[Bytes48, SYNC_COMMITTEE_SIZE]
    aggregate_pubkey: Bytes48


class ExecutionPayloadHeader(Container):
    parent_hash: Bytes32
    fee_recipient: ByteVector[20]
    state_root: Bytes32
    receipts_root: Bytes32
    logs_bloom: Vector[uint8, 256]
    prev_randao: Bytes32
    block_number: uint64
    gas_limit: uint64
    gas_used: uint64
    timestamp: uint64
    extra_data: SSZList[uint8, 32]
    base_fee_per_gas: uint256
    block_hash: Bytes32
    transactions_root: Bytes32
    withdrawals_root: Bytes32
    blob_gas_used: uint64
    excess_blob_gas: uint64


class HistoricalSummary(Container):
    block_summary_root: Bytes32
    state_summary_root: Bytes32


# Electra-specific constants
PENDING_DEPOSITS_LIMIT = 134217728
PENDING_PARTIAL_WITHDRAWALS_LIMIT = 134217728
PENDING_CONSOLIDATIONS_LIMIT = 262144


class PendingDeposit(Container):
    pubkey: Bytes48
    withdrawal_credentials: Bytes32
    amount: uint64
    signature: Bytes96
    slot: uint64


class PendingPartialWithdrawal(Container):
    validator_index: uint64
    amount: uint64
    withdrawable_epoch: uint64


class PendingConsolidation(Container):
    source_index: uint64
    target_index: uint64


class BeaconState(Container):
    # Versioning [0-3]
    genesis_time: uint64
    genesis_validators_root: Bytes32
    slot: uint64
    fork: Fork

    # History [4-7]
    latest_block_header: BeaconBlockHeader
    block_roots: Vector[Bytes32, SLOTS_PER_HISTORICAL_ROOT]
    state_roots: Vector[Bytes32, SLOTS_PER_HISTORICAL_ROOT]
    historical_roots: SSZList[Bytes32, HISTORICAL_ROOTS_LIMIT]

    # Eth1 [8-10]
    eth1_data: Eth1Data
    eth1_data_votes: SSZList[Eth1Data, ETH1_DATA_VOTES_LIMIT]
    eth1_deposit_index: uint64

    # Registry [11-12]
    validators: SSZList[Validator, VALIDATOR_REGISTRY_LIMIT]
    balances: SSZList[uint64, VALIDATOR_REGISTRY_LIMIT]

    # Randomness [13]
    randao_mixes: Vector[Bytes32, EPOCHS_PER_HISTORICAL_VECTOR]

    # Slashings [14]
    slashings: Vector[uint64, EPOCHS_PER_SLASHINGS_VECTOR]

    # Participation [15-16]
    previous_epoch_participation: SSZList[uint8, VALIDATOR_REGISTRY_LIMIT]
    current_epoch_participation: SSZList[uint8, VALIDATOR_REGISTRY_LIMIT]

    # Finality [17-20]
    justification_bits: Bitvector[JUSTIFICATION_BITS_LENGTH]
    previous_justified_checkpoint: Checkpoint
    current_justified_checkpoint: Checkpoint
    finalized_checkpoint: Checkpoint

    # Inactivity [21]
    inactivity_scores: SSZList[uint64, VALIDATOR_REGISTRY_LIMIT]

    # Sync committees [22-23]
    current_sync_committee: SyncCommittee
    next_sync_committee: SyncCommittee

    # Execution [24]
    latest_execution_payload_header: ExecutionPayloadHeader

    # Withdrawals [25-26]
    next_withdrawal_index: uint64
    next_withdrawal_validator_index: uint64

    # Deep history [27]
    historical_summaries: SSZList[HistoricalSummary, HISTORICAL_ROOTS_LIMIT]

    # Electra [28-36]
    deposit_requests_start_index: uint64
    deposit_balance_to_consume: uint64
    exit_balance_to_consume: uint64
    earliest_exit_epoch: uint64
    consolidation_balance_to_consume: uint64
    earliest_consolidation_epoch: uint64
    pending_deposits: SSZList[PendingDeposit, PENDING_DEPOSITS_LIMIT]
    pending_partial_withdrawals: SSZList[
        PendingPartialWithdrawal, PENDING_PARTIAL_WITHDRAWALS_LIMIT
    ]
    pending_consolidations: SSZList[PendingConsolidation, PENDING_CONSOLIDATIONS_LIMIT]
    proposer_lookahead: Vector[uint64, PROPOSER_LOOKAHEAD_SIZE]


# Generalized Index Calculation
# ============================================


def compute_gindex_for_validator(validator_index: int) -> int:
    """
    Compute generalized index for validator[index] in BeaconState.
    Proves the entire Validator object (hash_tree_root).
    """
    STATE_TREE_DEPTH = 6  # 37 fields (Electra) -> pad to 64
    VALIDATORS_FIELD_INDEX = 11
    VALIDATORS_LIST_DEPTH = 40

    validators_gindex = (1 << STATE_TREE_DEPTH) + VALIDATORS_FIELD_INDEX
    validators_data_gindex = validators_gindex * 2
    final_gindex = (
        validators_data_gindex * (1 << VALIDATORS_LIST_DEPTH) + validator_index
    )

    return final_gindex


def compute_gindex_for_state_root_in_header() -> int:
    """
    Compute gindex for state_root inside BeaconBlockHeader.
    5 fields -> pad to 8 -> depth 3, state_root is field 3.
    """
    HEADER_DEPTH = 3
    STATE_ROOT_INDEX = 3
    return (1 << HEADER_DEPTH) + STATE_ROOT_INDEX


# ============================================
# Merkle Proof Functions
# ============================================


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def hash_concat(left: bytes, right: bytes) -> bytes:
    return sha256(left + right)


def extract_proof_from_tree(backing: Node, gindex: int) -> List[bytes]:
    """
    Returns sibling hashes from leaf -> root (bottom-up),
    aligned with gindex bits LSB-first in verification.
    """
    if gindex <= 1:
        return []

    # Path bits from root to leaf, excluding leading 1.
    # Example: gindex bits "1xyz..." => path bits [x, y, z, ...]
    path_bits = [int(b) for b in bin(gindex)[3:]]

    proof_top_down: List[bytes] = []
    cur = backing

    for bit in path_bits:
        if bit == 0:
            # going left, sibling is right
            proof_top_down.append(cur.get_right().merkle_root())
            cur = cur.get_left()
        else:
            # going right, sibling is left
            proof_top_down.append(cur.get_left().merkle_root())
            cur = cur.get_right()

    # Convert to bottom-up for leaf->root hashing
    return list(reversed(proof_top_down))


def verify_merkle_proof(
    leaf: bytes, proof: List[bytes], gindex: int, root: bytes
) -> bool:
    """
    Verify with proof ordered leaf->root (bottom-up).
    Uses gindex path bits bottom-up (LSB-first).
    """
    if gindex <= 1:
        return leaf == root

    path_bits = [int(b) for b in bin(gindex)[3:]]  # root->leaf bits
    path_bits_bottom_up = list(reversed(path_bits))

    if len(proof) != len(path_bits_bottom_up):
        return False

    computed = leaf
    for bit, sibling in zip(path_bits_bottom_up, proof):
        if bit == 0:
            computed = hash_concat(computed, sibling)
        else:
            computed = hash_concat(sibling, computed)

    return computed == root


# ============================================
# EL + CL Client
# ============================================


def get_latest_el_block(el_url: str) -> dict:
    """
    Step 1: Get latest EL block via eth_getBlockByNumber("latest", false).
    Returns dict with 'timestamp' and 'parentBeaconBlockRoot'.
    """
    resp = requests.post(
        el_url,
        json={
            "jsonrpc": "2.0",
            "method": "eth_getBlockByNumber",
            "params": ["latest", False],
            "id": 1,
        },
        timeout=30,
    )
    resp.raise_for_status()
    result = resp.json()["result"]
    return {
        "timestamp": int(result["timestamp"], 16),
        "parentBeaconBlockRoot": bytes.fromhex(result["parentBeaconBlockRoot"][2:]),
    }


def get_beacon_block_header_by_root(cl_url: str, block_root: bytes) -> dict:
    """
    Step 3: GET /eth/v2/beacon/blocks/{root} and extract header fields.
    """
    root_hex = "0x" + block_root.hex()
    url = f"{cl_url}/eth/v2/beacon/blocks/{root_hex}"
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    header = resp.json()["data"]["message"]
    return {
        "slot": int(header["slot"]),
        "proposer_index": int(header["proposer_index"]),
    }


def get_beacon_state_ssz(cl_url: str, slot: int) -> bytes:
    """
    Step 4: GET /eth/v2/debug/beacon/states/{slot} in SSZ format.
    """
    url = f"{cl_url}/eth/v2/debug/beacon/states/{slot}"
    headers = {"Accept": "application/octet-stream"}
    print(f"Fetching BeaconState for slot {slot}...", file=sys.stderr)
    resp = requests.get(url, headers=headers, timeout=300)
    resp.raise_for_status()
    print(f"Received {len(resp.content):,} bytes", file=sys.stderr)
    return resp.content


# ============================================
# Proof Builder
# ============================================


def build_top_up_data(el_url: str, cl_url: str, validator_indices: List[int]) -> dict:
    """
    Build TopUpData for the given validator indices.

    Flow:
    1. Get latest EL block -> timestamp, parentBeaconBlockRoot
    2. parentBeaconBlockRoot IS the beacon root from 4788
    3. Get beacon block header by root -> slot, proposerIndex
    4. Get state for that slot -> build proofs
    5. Verify proofs locally
    """
    # Step 1-2: Get latest EL block
    print("Step 1: Fetching latest EL block...", file=sys.stderr)
    el_block = get_latest_el_block(el_url)
    child_block_timestamp = el_block["timestamp"]
    parent_beacon_block_root = el_block["parentBeaconBlockRoot"]
    print(f"  timestamp: {child_block_timestamp}", file=sys.stderr)
    print(
        f"  parentBeaconBlockRoot: 0x{parent_beacon_block_root.hex()}", file=sys.stderr
    )

    # Step 3: Get beacon block header by root
    print("Step 3: Fetching beacon block header...", file=sys.stderr)
    beacon_header = get_beacon_block_header_by_root(cl_url, parent_beacon_block_root)
    slot = beacon_header["slot"]
    proposer_index = beacon_header["proposer_index"]
    print(f"  slot: {slot}, proposerIndex: {proposer_index}", file=sys.stderr)

    # Step 4: Get state SSZ
    print("Step 4: Fetching beacon state...", file=sys.stderr)
    ssz_bytes = get_beacon_state_ssz(cl_url, slot)

    print("Deserializing BeaconState...", file=sys.stderr)
    state = BeaconState.decode_bytes(ssz_bytes)

    # Reconstruct header for proof building
    # We need the full header to build header proofs.
    # Fetch it from the state's latest_block_header + fill state_root.
    state_root = bytes(state.hash_tree_root())
    print(f"  state_root: 0x{state_root.hex()}", file=sys.stderr)

    # Build header object for proof extraction
    # The beacon block at this slot has state_root = state.hash_tree_root()
    # We need the full header. Fetch it from CL.
    header_url = f"{cl_url}/eth/v1/beacon/headers/{slot}"
    header_resp = requests.get(header_url, timeout=30)
    header_resp.raise_for_status()
    header_msg = header_resp.json()["data"]["header"]["message"]

    header = BeaconBlockHeader(
        slot=uint64(int(header_msg["slot"])),
        proposer_index=uint64(int(header_msg["proposer_index"])),
        parent_root=Bytes32(bytes.fromhex(header_msg["parent_root"][2:])),
        state_root=Bytes32(bytes.fromhex(header_msg["state_root"][2:])),
        body_root=Bytes32(bytes.fromhex(header_msg["body_root"][2:])),
    )

    beacon_block_root = bytes(header.hash_tree_root())
    print(f"  beacon_block_root: 0x{beacon_block_root.hex()}", file=sys.stderr)

    # Verify beacon_block_root matches parentBeaconBlockRoot from EL
    if beacon_block_root != parent_beacon_block_root:
        raise ValueError(
            f"beacon_block_root mismatch!\n"
            f"  computed:  0x{beacon_block_root.hex()}\n"
            f"  expected:  0x{parent_beacon_block_root.hex()}"
        )
    print("  beacon_block_root matches parentBeaconBlockRoot", file=sys.stderr)

    # Build header proof (state_root -> beacon_block_root)
    header_backing = header.get_backing()
    state_root_gindex = compute_gindex_for_state_root_in_header()
    header_proof = extract_proof_from_tree(header_backing, state_root_gindex)

    # Build proofs for each validator
    state_backing = state.get_backing()
    validator_witnesses = []

    for vi in validator_indices:
        print(f"Step 5: Building proof for validator {vi}...", file=sys.stderr)

        validator = state.validators[vi]
        validator_root = bytes(validator.hash_tree_root())

        # Proof: validator[i] -> state_root
        validator_gindex = compute_gindex_for_validator(vi)
        validator_proof = extract_proof_from_tree(state_backing, validator_gindex)

        # Full proof: validator_proof + header_proof
        full_proof = validator_proof + header_proof

        # Verification: walk from leaf to state_root
        print(f"  Verifying validator proof (leaf -> state_root)...", file=sys.stderr)
        if not verify_merkle_proof(
            validator_root, validator_proof, validator_gindex, state_root
        ):
            raise ValueError(
                f"Validator proof verification FAILED for index {vi}!\n"
                f"  leaf (validator_root): 0x{validator_root.hex()}\n"
                f"  expected state_root:   0x{state_root.hex()}"
            )
        print(f"  Validator proof verified OK", file=sys.stderr)

        # Verification: walk from state_root to beacon_block_root
        header_state_root = bytes(header.state_root)
        print(
            f"  Verifying header proof (state_root -> beacon_block_root)...",
            file=sys.stderr,
        )
        if not verify_merkle_proof(
            header_state_root, header_proof, state_root_gindex, beacon_block_root
        ):
            raise ValueError(
                f"Header proof verification FAILED!\n"
                f"  leaf (state_root):        0x{header_state_root.hex()}\n"
                f"  expected beacon_block_root: 0x{beacon_block_root.hex()}"
            )
        print(f"  Header proof verified OK", file=sys.stderr)

        validator_witnesses.append(
            {
                "validatorIndex": vi,
                "pubkey": "0x" + bytes(validator.pubkey).hex(),
                "effectiveBalance": int(validator.effective_balance),
                "activationEligibilityEpoch": int(
                    validator.activation_eligibility_epoch
                ),
                "activationEpoch": int(validator.activation_epoch),
                "exitEpoch": int(validator.exit_epoch),
                "withdrawableEpoch": int(validator.withdrawable_epoch),
                "slashed": bool(validator.slashed),
                "proofs": ["0x" + p.hex() for p in full_proof],
            }
        )

    return {
        "beaconRootData": {
            "childBlockTimestamp": child_block_timestamp,
            "slot": slot,
            "proposerIndex": proposer_index,
        },
        "validatorWitnesses": validator_witnesses,
    }


# ============================================
# TopUpGateway ABI (topUp function only)
# ============================================

TOP_UP_GATEWAY_ABI = json.loads(
    """[
    {
        "inputs": [
            {
                "components": [
                    {"internalType": "uint256", "name": "moduleId", "type": "uint256"},
                    {"internalType": "uint256[]", "name": "keyIndices", "type": "uint256[]"},
                    {"internalType": "uint256[]", "name": "operatorIds", "type": "uint256[]"},
                    {"internalType": "uint256[]", "name": "validatorIndices", "type": "uint256[]"},
                    {
                        "components": [
                            {"internalType": "uint64", "name": "childBlockTimestamp", "type": "uint64"},
                            {"internalType": "uint64", "name": "slot", "type": "uint64"},
                            {"internalType": "uint64", "name": "proposerIndex", "type": "uint64"}
                        ],
                        "internalType": "struct BeaconRootData",
                        "name": "beaconRootData",
                        "type": "tuple"
                    },
                    {
                        "components": [
                            {"internalType": "bytes32[]", "name": "proofValidator", "type": "bytes32[]"},
                            {"internalType": "bytes", "name": "pubkey", "type": "bytes"},
                            {"internalType": "uint64", "name": "effectiveBalance", "type": "uint64"},
                            {"internalType": "uint64", "name": "activationEligibilityEpoch", "type": "uint64"},
                            {"internalType": "uint64", "name": "activationEpoch", "type": "uint64"},
                            {"internalType": "uint64", "name": "exitEpoch", "type": "uint64"},
                            {"internalType": "uint64", "name": "withdrawableEpoch", "type": "uint64"},
                            {"internalType": "bool", "name": "slashed", "type": "bool"}
                        ],
                        "internalType": "struct ValidatorWitness[]",
                        "name": "validatorWitness",
                        "type": "tuple[]"
                    },
                    {"internalType": "uint256[]", "name": "pendingBalanceGwei", "type": "uint256[]"}
                ],
                "internalType": "struct TopUpData",
                "name": "_topUps",
                "type": "tuple"
            }
        ],
        "name": "topUp",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }
]"""
)

DEFAULT_WITNESS_FILE = "validatorWitness.json"


# ============================================
# CLI
# ============================================


def cmd_prove(args):
    """Build proofs and optionally write to file."""
    try:
        result = build_top_up_data(
            el_url=args.el_url,
            cl_url=args.cl_url,
            validator_indices=args.validator_indices,
        )

        json_output = json.dumps(result, indent=2)

        if args.output:
            with open(args.output, "w") as f:
                f.write(json_output)
            print(f"Proof data written to {args.output}", file=sys.stderr)
        else:
            print(json_output)

    except Exception as e:
        print(f"ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        import traceback

        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


def cmd_top_up(args):
    """Read witness file and send topUp transaction to TopUpGateway."""
    load_dotenv()

    private_key = os.environ.get("PRIVATE_KEY")
    if not private_key:
        print("ERROR: PRIVATE_KEY not found in .env file", file=sys.stderr)
        sys.exit(1)

    # Read witness data
    input_file = args.input
    print(f"Reading witness data from {input_file}...", file=sys.stderr)
    with open(input_file, "r") as f:
        witness_data = json.load(f)

    # Connect to EL
    w3 = Web3(Web3.HTTPProvider(args.el_url))
    if not w3.is_connected():
        print("ERROR: Cannot connect to EL node", file=sys.stderr)
        sys.exit(1)

    account = w3.eth.account.from_key(private_key)
    print(f"Sender: {account.address}", file=sys.stderr)

    # Build TopUpData struct
    beacon_root_data = witness_data["beaconRootData"]
    validators = witness_data["validatorWitnesses"]

    # Match validator indices with provided arguments
    # args provides parallel arrays: validatorIndex, keyIndex, operatorId
    if len(args.validator_index) != len(args.key_index) or len(
        args.validator_index
    ) != len(args.operator_id):
        print(
            "ERROR: --validator-index, --key-index, and --operator-id must have the same count",
            file=sys.stderr,
        )
        sys.exit(1)

    # Filter and order witnesses to match requested validator indices
    witness_by_index = {v["validatorIndex"]: v for v in validators}
    ordered_witnesses = []
    for vi in args.validator_index:
        if vi not in witness_by_index:
            print(
                f"ERROR: Validator index {vi} not found in witness file",
                file=sys.stderr,
            )
            sys.exit(1)
        ordered_witnesses.append(witness_by_index[vi])

    # Build contract call data
    validator_witnesses_tuples = []
    for vw in ordered_witnesses:
        validator_witnesses_tuples.append(
            (
                [bytes.fromhex(p[2:]) for p in vw["proofs"]],  # proofValidator
                bytes.fromhex(vw["pubkey"][2:]),  # pubkey
                vw["effectiveBalance"],  # effectiveBalance
                vw["activationEligibilityEpoch"],  # activationEligibilityEpoch
                vw["activationEpoch"],  # activationEpoch
                vw["exitEpoch"],  # exitEpoch
                vw["withdrawableEpoch"],  # withdrawableEpoch
                vw["slashed"],  # slashed
            )
        )

    # pendingBalanceGwei defaults to 0 for each validator
    pending_balances = [0] * len(args.validator_index)

    top_up_data = (
        args.module_id,  # moduleId
        list(args.key_index),  # keyIndices
        list(args.operator_id),  # operatorIds
        list(args.validator_index),  # validatorIndices
        (  # beaconRootData
            beacon_root_data["childBlockTimestamp"],
            beacon_root_data["slot"],
            beacon_root_data["proposerIndex"],
        ),
        validator_witnesses_tuples,  # validatorWitness
        pending_balances,  # pendingBalanceGwei
    )

    contract = w3.eth.contract(
        address=Web3.to_checksum_address(args.gateway_address),
        abi=TOP_UP_GATEWAY_ABI,
    )

    print("Building transaction...", file=sys.stderr)
    tx = contract.functions.topUp(top_up_data).build_transaction(
        {
            "from": account.address,
            "nonce": w3.eth.get_transaction_count(account.address),
            "gas": args.gas_limit,
            "maxFeePerGas": w3.eth.gas_price * 2,
            "maxPriorityFeePerGas": w3.to_wei(1, "gwei"),
        }
    )

    print("Signing and sending transaction...", file=sys.stderr)
    signed_tx = w3.eth.account.sign_transaction(tx, private_key)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
    print(f"Transaction sent: 0x{tx_hash.hex()}", file=sys.stderr)

    print("Waiting for receipt...", file=sys.stderr)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=300)
    if receipt["status"] == 1:
        print(
            f"Transaction confirmed in block {receipt['blockNumber']}", file=sys.stderr
        )
    else:
        print(
            f"Transaction REVERTED in block {receipt['blockNumber']}", file=sys.stderr
        )
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Build Merkle proofs and send top-up transactions for validator verification via EIP-4788.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # ---- prove command ----
    prove_parser = subparsers.add_parser(
        "prove",
        help="Build Merkle proofs for validators",
    )
    prove_parser.add_argument(
        "--el-url",
        "-e",
        required=True,
        help="EL RPC endpoint, e.g. http://localhost:8545",
    )
    prove_parser.add_argument(
        "--cl-url",
        "-c",
        required=True,
        help="CL API endpoint, e.g. http://localhost:5052",
    )
    prove_parser.add_argument(
        "--validator-index",
        "-v",
        type=int,
        action="append",
        required=True,
        dest="validator_indices",
        help="Validator index (can be specified multiple times)",
    )
    prove_parser.add_argument(
        "--output",
        "-o",
        default=None,
        help=f"Output file path (default: stdout, use -o without value for '{DEFAULT_WITNESS_FILE}')",
        nargs="?",
        const=DEFAULT_WITNESS_FILE,
    )

    # ---- top-up command ----
    topup_parser = subparsers.add_parser(
        "top-up",
        help="Send topUp transaction to TopUpGateway",
    )
    topup_parser.add_argument(
        "--el-url",
        "-e",
        required=True,
        help="EL RPC endpoint, e.g. http://localhost:8545",
    )
    topup_parser.add_argument(
        "--gateway-address",
        "-g",
        required=True,
        help="TopUpGateway contract address",
    )
    topup_parser.add_argument(
        "--validator-index",
        "-v",
        type=int,
        action="append",
        required=True,
        dest="validator_index",
        help="Validator index (can be specified multiple times, order matters)",
    )
    topup_parser.add_argument(
        "--key-index",
        "-k",
        type=int,
        action="append",
        required=True,
        dest="key_index",
        help="Key index for each validator (same order as -v)",
    )
    topup_parser.add_argument(
        "--operator-id",
        type=int,
        action="append",
        required=True,
        dest="operator_id",
        help="Operator ID for each validator (same order as -v)",
    )
    topup_parser.add_argument(
        "--module-id",
        "-m",
        type=int,
        required=True,
        dest="module_id",
        help="Staking module ID",
    )
    topup_parser.add_argument(
        "--input",
        "-i",
        default=DEFAULT_WITNESS_FILE,
        help=f"Input witness file (default: {DEFAULT_WITNESS_FILE})",
    )
    topup_parser.add_argument(
        "--gas-limit",
        type=int,
        default=1_000_000,
        help="Gas limit for transaction (default: 1000000)",
    )

    args = parser.parse_args()

    if args.command == "prove":
        cmd_prove(args)
    elif args.command == "top-up":
        cmd_top_up(args)


if __name__ == "__main__":
    main()
