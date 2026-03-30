// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {Lido} from "contracts/0.4.24/Lido.sol";

contract EtherReceiver__MockForLidoRedeems {
    event EtherReceived(uint256 amount);

    Lido public lido;
    bool public rejectEther;

    constructor(address _lido) public {
        lido = Lido(address(uint160(_lido)));
    }

    function receiveEther(uint256 _etherAmount) external payable {
        require(!rejectEther, "REJECT_ETHER");
        require(msg.value == _etherAmount, "VALUE_MISMATCH");
        emit EtherReceived(_etherAmount);
    }

    function callRedeemStETH(uint256 _stETHAmount) external {
        lido.redeemStETH(_stETHAmount);
    }

    function mock__rejectEther(bool _reject) external {
        rejectEther = _reject;
    }

    function() external payable {}
}
