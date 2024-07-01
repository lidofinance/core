// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

contract Initializable__Mock {
  uint8 private _version;
  bool private initialized;
  event Initialized(uint256 version);
  event ReceiveCalled();

  function initialize(uint8 __version) public payable {
    require(!initialized, "Contract is already initialized");
    _version = __version;
    initialized = true;
    emit Initialized(__version);
  }

  function version() public view returns (uint8) {
    return _version;
  }

  receive() external payable {
    emit ReceiveCalled();
  }
}
