// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// for testing purposes only

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

contract TriggerableExitMock {
    address constant WITHDRAWAL_REQUEST_PREDEPLOY_ADDRESS = 0x00A3ca265EBcb825B45F985A16CEFB49958cE017;

    uint256 private constant EXCESS_WITHDRAWAL_REQUESTS_STORAGE_SLOT = 0;
    uint256 private constant WITHDRAWAL_REQUEST_COUNT_STORAGE_SLOT = 1;
    uint256 private constant WITHDRAWAL_REQUEST_QUEUE_HEAD_STORAGE_SLOT = 2;
    uint256 private constant WITHDRAWAL_REQUEST_QUEUE_TAIL_STORAGE_SLOT = 3;
    uint256 private constant WITHDRAWAL_REQUEST_QUEUE_STORAGE_OFFSET = 4;

    uint256 private constant MAX_WITHDRAWAL_REQUESTS_PER_BLOCK = 16;
    uint256 private constant TARGET_WITHDRAWAL_REQUESTS_PER_BLOCK = 2;
    uint256 private constant MIN_WITHDRAWAL_REQUEST_FEE = 1;
    uint256 private constant WITHDRAWAL_REQUEST_FEE_UPDATE_FRACTION = 17;

    struct ValidatorWithdrawalRequest {
        address sourceAddress;
        bytes validatorPubkey;
        uint64 amount;
    }

    event WithdrawalRequest(bytes indexed validatorPubkey, uint256 amount);
    event WithdrawalRequestProcessed(
        address sender,
        bytes indexed validatorPubkey,
        uint256 amount
    );

    uint256 public lastProcessedBlock;

    // @notice Add withdrawal request adds new request to the withdrawal request queue, so long as a sufficient fee is provided.
    function addWithdrawalRequest(bytes memory validatorPubkey, uint256 amount) external payable {
        checkExitFee(msg.value);
        incrementExitCount();
        insertExitToQueue(validatorPubkey, uint64(amount));

        emit WithdrawalRequest(validatorPubkey, amount);
    }

    function insertExitToQueue(bytes memory validatorPubkey, uint64 amount) private {
        require(validatorPubkey.length == 48, "Validator public key must contain 48 bytes");

        bytes32 queueTailSlot = getSlotReference(WITHDRAWAL_REQUEST_QUEUE_TAIL_STORAGE_SLOT);

        uint256 queueTailIndex;
        assembly {
            queueTailIndex := sload(queueTailSlot)
        }

        bytes32 queueStorageSlot = getSlotReference(WITHDRAWAL_REQUEST_QUEUE_STORAGE_OFFSET + queueTailIndex * 3);

        assembly {
            let offset := add(validatorPubkey, 0x20)

            // save to storage in next format
            //
            // A: sender
            //  slot1: aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa 00 00 00 00 00 00 00 00 00 00 00 00
            //
            // B: pubkey[0:31]
            //  slot2: bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb bb
            //
            // C: pubkey[32:48] ++ amount[0:8]
            //  slot3: cc cc cc cc cc cc cc cc cc cc cc cc cc cc cc cc dd dd dd dd dd dd dd dd 00 00 00 00 00 00 00 00

            sstore(queueStorageSlot, caller())
            sstore(add(queueStorageSlot, 1), mload(offset)) //save 0..31 bytes
            sstore(add(queueStorageSlot, 2), add(mload(add(offset, 0x20)), shl(64, amount))) //32..47 pk + 8bytes amount
            sstore(queueTailSlot, add(queueTailIndex, 1)) //increase queue tail
        }
    }

    function getSlotReference(uint256 index) private pure returns (bytes32) {
        bytes32 slotAddress = bytes32(uint256(uint160(WITHDRAWAL_REQUEST_PREDEPLOY_ADDRESS)));
        bytes32 slotIndex = bytes32(index);

        return keccak256(abi.encodePacked(slotAddress, slotIndex));
    }

    function checkExitFee(uint256 feeSent) internal view {
        uint256 exitFee = getFee();
        require(feeSent >= exitFee, "Insufficient exit fee");
    }

    function getFee() public view returns (uint256) {
        bytes32 position = getSlotReference(EXCESS_WITHDRAWAL_REQUESTS_STORAGE_SLOT);

        uint256 excessExits;
        assembly {
            excessExits := sload(position)
        }
        return fakeExponential(
            MIN_WITHDRAWAL_REQUEST_FEE,
            excessExits,
            WITHDRAWAL_REQUEST_FEE_UPDATE_FRACTION);
    }

    function fakeExponential(uint256 factor, uint256 numerator, uint256 denominator) private pure returns (uint256) {
        uint256 i = 1;
        uint256 output = 0;

        uint256 numeratorAccum = factor * denominator;

        while (numeratorAccum > 0) {
            output += numeratorAccum;
            numeratorAccum = (numeratorAccum * numerator) / (denominator * i);
            i += 1;
        }

        return output / denominator;
    }

    function incrementExitCount() private {
        bytes32 position = getSlotReference(WITHDRAWAL_REQUEST_COUNT_STORAGE_SLOT);
        assembly {
            sstore(position, add(sload(position), 1))
        }
    }

    // ------------------------------
    // block processing
    // ------------------------------
    error BlockAlreadyProcessed();

    // only once in a block
    function blockProcessing() public returns(ValidatorWithdrawalRequest[] memory) {
        if (block.number == lastProcessedBlock) {
            revert BlockAlreadyProcessed();
        }

        lastProcessedBlock = block.number;

        ValidatorWithdrawalRequest[] memory reqs = dequeueWithdrawalRequests();
        updateExcessWithdrawalRequests();
        resetWithdrawalRequestsCount();

        return reqs;
    }

    function dequeueWithdrawalRequests() internal returns(ValidatorWithdrawalRequest[] memory) {
        bytes32 queueHeadIndexPosition = getSlotReference(WITHDRAWAL_REQUEST_QUEUE_HEAD_STORAGE_SLOT);
        bytes32 queueTailIndexPosition = getSlotReference(WITHDRAWAL_REQUEST_QUEUE_TAIL_STORAGE_SLOT);

        uint256 queueHeadIndex;
        uint256 queueTailIndex;
        assembly {
            queueHeadIndex := sload(queueHeadIndexPosition)
            queueTailIndex := sload(queueTailIndexPosition)
        }

        uint256 numInQueue = queueTailIndex - queueHeadIndex;
        uint256 numDequeued = min(numInQueue, MAX_WITHDRAWAL_REQUESTS_PER_BLOCK);

        ValidatorWithdrawalRequest[] memory result = new ValidatorWithdrawalRequest[](numDequeued);
        bytes32 queueStorageSlot;
        address sourceAddress;

        bytes memory tmpKey = new bytes(48);
        uint64 amount;

        for (uint256 i=0; i < numDequeued; i++) {
            queueStorageSlot = getSlotReference(WITHDRAWAL_REQUEST_QUEUE_STORAGE_OFFSET + (queueHeadIndex + i) * 3);

            assembly {
                //  Withdrawal request record:
                //
                //  +------+--------+--------+
                //  | addr | pubkey | amount |
                //  +------+--------+--------+
                //     20      48        8

                sourceAddress := sload(queueStorageSlot)
                let p1 := sload(add(queueStorageSlot, 1)) //first part of pubkey
                let p2 := sload(add(queueStorageSlot, 2)) //second part of pubkey + 8bytes amount

                mstore(add(tmpKey, 0x20), p1)
                mstore(add(tmpKey, 0x40), p2)

                amount := and(shr(64, p2), 0xffffffffffffffff)
            }

            result[i] = ValidatorWithdrawalRequest(sourceAddress, tmpKey, amount);
            emit WithdrawalRequestProcessed(sourceAddress, tmpKey, amount);
        }

        uint256 newQueueHeadIndex = queueHeadIndex + numDequeued;
        if (newQueueHeadIndex == queueTailIndex) {
            // Queue is empty, reset queue pointers
            assembly {
                sstore(queueHeadIndexPosition, 0)
                sstore(queueTailIndexPosition, 0)
            }
        } else {
            assembly {
                sstore(queueHeadIndexPosition, newQueueHeadIndex)
            }
        }

        return result;
    }

    function updateExcessWithdrawalRequests() internal {
        bytes32 positionExceessExits = getSlotReference(EXCESS_WITHDRAWAL_REQUESTS_STORAGE_SLOT);
        bytes32 positionExitsCount = getSlotReference(WITHDRAWAL_REQUEST_COUNT_STORAGE_SLOT);

        uint256 previousExcessExits;
        uint256 exitCount;
        assembly {
            previousExcessExits := sload(positionExceessExits)
            exitCount := sload(positionExitsCount)
        }

        uint256 newExcessExits = 0;
        if (previousExcessExits + exitCount > TARGET_WITHDRAWAL_REQUESTS_PER_BLOCK) {
            newExcessExits = previousExcessExits + exitCount - TARGET_WITHDRAWAL_REQUESTS_PER_BLOCK;
            assembly {
                sstore(positionExceessExits, newExcessExits)
            }
        }
    }

    function resetWithdrawalRequestsCount() internal {
        bytes32 position = getSlotReference(WITHDRAWAL_REQUEST_COUNT_STORAGE_SLOT);
        assembly {
            sstore(position, 0)
        }
    }


    // ------------------------------
    // Helpers
    // ------------------------------
    function getQueueCount() external view returns(uint256 c) {
        bytes32 position = getSlotReference(WITHDRAWAL_REQUEST_COUNT_STORAGE_SLOT);
        assembly {
            c := sload(position)
        }
    }

    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
