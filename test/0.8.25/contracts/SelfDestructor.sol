// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

contract SelfDestructor {
    constructor(address payable _target) payable {
        selfdestruct(_target);
    }
}
