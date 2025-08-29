// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IOwnable2Step} from "../interfaces/IOwnable2Step.sol";
import {Ownable2StepStorage} from "./Ownable2StepStorage.sol";

contract Ownable2Step is IOwnable2Step {
    constructor(address initialOwner) {
        Ownable2StepStorage.setOwner(initialOwner);
    }

    modifier onlyOwner() {
        Ownable2StepStorage.checkOwner();
        _;
    }

    function owner() public view returns (address) {
        return Ownable2StepStorage.owner();
    }

    function pendingOwner() public view returns (address) {
        return Ownable2StepStorage.pendingOwner();
    }

    function transferOwnership(address newOwner) external {
        Ownable2StepStorage.setPendingOwner(newOwner);
    }

    function acceptOwnership() external {
        Ownable2StepStorage.checkPendingOwner();

        Ownable2StepStorage.setOwner(Ownable2StepStorage.pendingOwner());
        Ownable2StepStorage.setPendingOwner(address(0));
    }
}
