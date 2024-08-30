// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract Initializable__Mock {
    uint8 private _version;
    bool private _initialized;

    event Initialized(uint256 version);
    event ReceiveCalled();

    function initialize(uint8 _v) public payable {
        require(!_initialized, "Contract is already initialized");
        _version = _v;
        _initialized = true;
        emit Initialized(_v);
    }

    function version() public view returns (uint8) {
        return _version;
    }

    receive() external payable {
        emit ReceiveCalled();
    }
}
