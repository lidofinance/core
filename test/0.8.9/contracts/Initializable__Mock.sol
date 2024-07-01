// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

contract Initializable__Mock {
  uint8 private _version;
  bool private initialized;
  event Initialized(uint256 version);
  event ReceiveCalled();

  function initialize(uint8 __version) public {
    require(!initialized, "Contract is already initialized");
    _version = __version;
    initialized = true;
    emit Initialized(_version);
  }

  function version() public view returns (uint8) {
    return _version;
  }

  // Receive function example
  receive() external payable {
    emit ReceiveCalled();
  }
}
