// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>

pragma solidity 0.8.9;

library WithdrawalCredentialsRequests {
    address constant WITHDRAWAL_REQUEST = 0x0c15F14308530b7CDB8460094BbB9cC28b9AaaAA;

    error InvalidArrayLengths(uint256 lengthA, uint256 lengthB);
    error FeeNotEnough(uint256 minFeePerRequest, uint256 requestCount, uint256 msgValue);
    error WithdrawalRequestFeeReadFailed();

    error InvalidPubkeyLength(bytes pubkey);
    error WithdrawalRequestAdditionFailed(bytes pubkey, uint256 amount);

    event WithdrawalRequestAdded(bytes pubkey, uint256 amount);

    function addWithdrawalRequests(
        bytes[] calldata pubkeys,
        uint64[] calldata amounts
    ) internal {
        uint256 keysCount = pubkeys.length;
        if (keysCount != amounts.length || keysCount == 0) {
            revert InvalidArrayLengths(keysCount, amounts.length);
        }

        uint256 minFeePerRequest = getWithdrawalRequestFee();
        if (minFeePerRequest * keysCount > msg.value) {
            revert FeeNotEnough(minFeePerRequest, keysCount, msg.value);
        }

        uint256 feePerRequest = msg.value / keysCount;
        uint256 unallocatedFee = msg.value % keysCount;
        uint256 prevBalance = address(this).balance - msg.value;


        for (uint256 i = 0; i < keysCount; ++i) {
            bytes memory pubkey = pubkeys[i];
            uint64 amount = amounts[i];

            if(pubkey.length != 48) {
                revert InvalidPubkeyLength(pubkey);
            }

            uint256 feeToSend = feePerRequest;

            if (i == keysCount - 1) {
                feeToSend += unallocatedFee;
            }

            bytes memory callData = abi.encodePacked(pubkey, amount);
            (bool success, ) = WITHDRAWAL_REQUEST.call{value: feeToSend}(callData);

            if (!success) {
                revert WithdrawalRequestAdditionFailed(pubkey, amount);
            }

            emit WithdrawalRequestAdded(pubkey, amount);
        }

        assert(address(this).balance == prevBalance);
    }

    function getWithdrawalRequestFee() internal view returns (uint256) {
        (bool success, bytes memory feeData) = WITHDRAWAL_REQUEST.staticcall("");

        if (!success) {
            revert WithdrawalRequestFeeReadFailed();
        }

        return abi.decode(feeData, (uint256));
    }
}
