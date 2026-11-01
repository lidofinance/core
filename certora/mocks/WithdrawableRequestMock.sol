contract WithdrawableRequestMock {
    fallback(bytes calldata data) external payable returns (bytes memory) {
        return new bytes(32);
    }
}