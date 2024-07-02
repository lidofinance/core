// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

import {BeaconChainDepositor} from "../BeaconChainDepositor.sol";
import {Basic} from "./interfaces/Basic.sol";

contract BasicVault is Basic, BeaconChainDepositor {
    address public owner;

    modifier onlyOwner() {
        if (msg.sender != owner) revert("ONLY_OWNER");
        _;
    }

    constructor(
        address _owner,
        address _depositContract
    ) BeaconChainDepositor(_depositContract) {
        owner = _owner;
    }

    receive() external payable virtual {
        // emit EL reward flow
    }

    function deposit() public payable virtual {
        // emit deposit flow
    }

    function getWithdrawalCredentials() public view returns (bytes32) {
        return bytes32(0x01 << 254 + uint160(address(this)));
    }

    function depositKeys(
        uint256 _keysCount,
        bytes calldata _publicKeysBatch,
        bytes calldata _signaturesBatch
    ) public virtual onlyOwner {
        // TODO: maxEB + DSM support
        _makeBeaconChainDeposits32ETH(
            _keysCount,
            bytes.concat(getWithdrawalCredentials()),
            _publicKeysBatch,
            _signaturesBatch
        );
    }

    function withdraw(
        address _receiver,
        uint256 _amount
    ) public virtual onlyOwner {
        _requireNonZeroAddress(_receiver);
        (bool success, ) = _receiver.call{value: _amount}("");
        if(!success) revert("TRANSFER_FAILED");
    }

    function _requireNonZeroAddress(address _address) private pure {
        if (_address == address(0)) revert("ZERO_ADDRESS");
    }
}
