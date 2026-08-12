// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

/**
 * @notice This is a mock of EIP-7251's consolidation request pre-deploy contract.
 */
contract EIP7251ConsolidationRequest__Mock {
    uint256[100] __gap; // NB: to avoid storage collision with the predeployed withdrawals contract https://github.com/NomicFoundation/edr/issues/865
    bytes public fee;
    bool public mock__failOnAddRequest;
    bool public mock__failOnGetFee;

    bool public constant MOCK = true;

    event ConsolidationRequestAdded__Mock(bytes request, uint256 fee);

    function mock__setFailOnAddRequest(bool _failOnAddRequest) external {
        mock__failOnAddRequest = _failOnAddRequest;
    }

    function mock__setFailOnGetFee(bool _failOnGetFee) external {
        mock__failOnGetFee = _failOnGetFee;
    }

    function mock__setFee(uint256 _fee) external {
        require(_fee > 0, "fee must be greater than 0");
        fee = abi.encode(_fee);
    }

    function mock__setFeeRaw(bytes calldata _rawFeeBytes) external {
        fee = _rawFeeBytes;
    }

    // https://github.com/ethereum/EIPs/blob/master/EIPS/eip-7251.md#add-consolidation-request
    fallback(bytes calldata input) external payable returns (bytes memory) {
        // calculate the fee path
        if (input.length == 0) {
            require(!mock__failOnGetFee, "Inhibitor still active");
            return fee;
        }

        // add consolidation request path
        require(input.length == 48 * 2, "Invalid callData length"); // 48 bytes source + 48 bytes target
        require(!mock__failOnAddRequest, "fail on add request");

        uint256 feeValue = abi.decode(fee, (uint256));
        if (msg.value < feeValue) {
            revert("Insufficient value for fee");
        }

        emit ConsolidationRequestAdded__Mock(input, msg.value);
    }
}
