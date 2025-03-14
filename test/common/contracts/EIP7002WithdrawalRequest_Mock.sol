// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

/**
 * @notice This is a mock of EIP-7002's pre-deploy contract.
 */
contract EIP7002WithdrawalRequest_Mock {
    bytes public fee;
    bool public failOnAddRequest;
    bool public failOnGetFee;

    event eip7002MockRequestAdded(bytes request, uint256 fee);

    function setFailOnAddRequest(bool _failOnAddRequest) external {
        failOnAddRequest = _failOnAddRequest;
    }

    function setFailOnGetFee(bool _failOnGetFee) external {
        failOnGetFee = _failOnGetFee;
    }

    function setFee(uint256 _fee) external {
        require(_fee > 0, "fee must be greater than 0");
        fee = abi.encode(_fee);
    }

    function setFeeRaw(bytes calldata _rawFeeBytes) external {
        fee = _rawFeeBytes;
    }

    fallback(bytes calldata input) external payable returns (bytes memory) {
        if (input.length == 0) {
            require(!failOnGetFee, "fail on get fee");

            return fee;
        }

        require(!failOnAddRequest, "fail on add request");

        require(input.length == 56, "Invalid callData length");

        emit eip7002MockRequestAdded(input, msg.value);
    }
}
