methods {
    function IHashConsensusMock.getIsMember(address) external returns (bool) => NONDET;
    function IHashConsensusMock.getCurrentFrame() external returns (uint256,uint256) => NONDET;
    function IHashConsensusMock.getChainConfig() external returns (uint256,uint256,uint256) => NONDET;
    function IHashConsensusMock.getFrameConfig() external returns (uint256,uint256) => NONDET;
    function IHashConsensusMock.getInitialRefSlot() external returns (uint256) => NONDET;
}
