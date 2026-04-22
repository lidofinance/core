// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

contract Lido__MockForRedeemsBuffer {
    bool private _stopped;
    uint256 public receivedETH;
    uint256 private _sharesOnBuffer;

    event TransferSharesFromCalled(address from, address to, uint256 sharesAmount);
    event TransferSharesCalled(address to, uint256 sharesAmount);
    event RequestBurnSharesCalled(address from, uint256 sharesAmount);
    event ApproveCalled(address spender, uint256 amount);
    event EtherReceivedFromRedeemsBuffer(uint256 amount);

    receive() external payable {}

    function getSharesByPooledEth(uint256 _pooledEthAmount) external pure returns (uint256) {
        return _pooledEthAmount; // 1:1 rate
    }

    function getPooledEthByShares(uint256 _sharesAmount) external pure returns (uint256) {
        return _sharesAmount; // 1:1 rate
    }

    function transferSharesFrom(address _sender, address _recipient, uint256 _sharesAmount) external returns (uint256) {
        emit TransferSharesFromCalled(_sender, _recipient, _sharesAmount);
        return _sharesAmount;
    }

    function transferShares(address _recipient, uint256 _sharesAmount) external returns (uint256) {
        emit TransferSharesCalled(_recipient, _sharesAmount);
        return _sharesAmount;
    }

    function sharesOf(address) external view returns (uint256) {
        return _sharesOnBuffer;
    }

    function setSharesOnBuffer(uint256 _shares) external {
        _sharesOnBuffer = _shares;
    }

    function approve(address _spender, uint256 _amount) external returns (bool) {
        emit ApproveCalled(_spender, _amount);
        return true;
    }

    function isStopped() external view returns (bool) {
        return _stopped;
    }

    function receiveFromRedeemsBuffer() external payable {
        receivedETH += msg.value;
        emit EtherReceivedFromRedeemsBuffer(msg.value);
    }

    // Test helpers
    function setStopped(bool _isStopped) external {
        _stopped = _isStopped;
    }
}
