// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.4.24;

import {StETH} from "contracts/0.4.24/StETH.sol";

contract Steth__MinimalMock is StETH {
  uint256 private totalPooledEther;

  constructor(address _holder) public payable {
    _resume();
    uint256 balance = address(this).balance;
    assert(balance != 0);

    setTotalPooledEther(balance);
    _mintShares(_holder, balance);
  }

  function _getTotalPooledEther() internal view returns (uint256) {
    return totalPooledEther;
  }

  function setTotalPooledEther(uint256 _totalPooledEther) public {
    totalPooledEther = _totalPooledEther;
  }

  function mintShares(address _recipient, uint256 _sharesAmount) external {
    super._mintShares(_recipient, _sharesAmount);
  }

  function burnShares(address _account, uint256 _sharesAmount) external {
    super._burnShares(_account, _sharesAmount);
  }
}
