// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

contract WithdrawalsPredeployed_Mock {
    event WithdrawalRequestedMetadata(
       uint256 dataLength
    );
    event WithdrawalRequested(
        bytes pubKey,
        uint64 amount,
        uint256 feePaid,
        address sender
    );

    uint256 public fee;
    bool public failOnAddRequest;
    bool public failOnGetFee;

    function setFailOnAddRequest(bool _failOnAddRequest) external {
        failOnAddRequest = _failOnAddRequest;
    }

    function setFailOnGetFee(bool _failOnGetFee) external {
        failOnGetFee = _failOnGetFee;
    }

    function setFee(uint256 _fee) external {
        require(_fee > 0, "fee must be greater than 0");
        fee = _fee;
    }

    fallback(bytes calldata input) external payable returns (bytes memory output){
        if (input.length == 0) {
            require(!failOnGetFee, "fail on get fee");

            uint256 currentFee = fee;
            output = new bytes(32);
            assembly { mstore(add(output, 32), currentFee) }
            return output;
        }

        require(!failOnAddRequest, "fail on add request");

        require(input.length == 56, "Invalid callData length");
    }
}
