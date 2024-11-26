// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {Lido} from "contracts/0.4.24/Lido.sol";

contract Lido__HarnessForFinalizeUpgradeV2 is Lido {
    function harness__initialize(uint256 _initialVersion) external payable {
        assert(address(this).balance != 0);
        _bootstrapInitialHolder();
        _setContractVersion(_initialVersion);
        initialized();
    }

    function harness__mintSharesWithoutChecks(address account, uint256 amount) external returns (uint256) {
        return super._mintShares(account, amount);
    }

    function harness__burnInitialHoldersShares() external returns (uint256) {
        return super._burnShares(INITIAL_TOKEN_HOLDER, _sharesOf(INITIAL_TOKEN_HOLDER));
    }
}
