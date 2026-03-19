methods {
    function ILidoMock.totalSupply() external returns (uint256) => NONDET;
    function ILidoMock.balanceOf(address) external returns (uint256) => NONDET;

    function ILidoMock.sharesOf(address) external returns (uint256) => NONDET;
    function ILidoMock.getSharesByPooledEth(uint256) external returns (uint256) => NONDET;
    function ILidoMock.getPooledEthByShares(uint256) external returns (uint256) => NONDET;
    function ILidoMock.getPooledEthBySharesRoundUp(uint256) external returns (uint256) => NONDET;
}