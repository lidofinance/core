// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

/**
 * @notice This is an mock of EIP-7002's pre-deploy contract.
 */
contract WithdrawalsPredeployed_Mock {
    uint256 public fee;
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
        fee = _fee;
    }

    fallback(bytes calldata input) external payable returns (bytes memory output) {
        if (input.length == 0) {
            require(!failOnGetFee, "fail on get fee");

            output = abi.encode(fee);
            return output;
        }

        require(!failOnAddRequest, "fail on add request");

        require(input.length == 56, "Invalid callData length");

        emit eip7002MockRequestAdded(input, msg.value);
    }
}
