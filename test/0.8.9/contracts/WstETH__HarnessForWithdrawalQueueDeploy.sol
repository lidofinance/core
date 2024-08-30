// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.6.12; // latest available for using OZ

import {WstETH} from "contracts/0.6.12/WstETH.sol";
import {IStETH} from "contracts/0.6.12/interfaces/IStETH.sol";

contract WstETH__HarnessForWithdrawalQueueDeploy is WstETH {
    constructor(IStETH _StETH) public WstETH(_StETH) {}

    function harness__mint(address recipient, uint256 amount) public {
        _mint(recipient, amount);
    }

    function mock__getChainId() external view returns (uint256 chainId) {
        this; // silence state mutability warning without generating bytecode - see https://github.com/ethereum/solidity/issues/2691
        // solhint-disable-next-line no-inline-assembly
        assembly {
            chainId := chainid()
        }
    }
}
