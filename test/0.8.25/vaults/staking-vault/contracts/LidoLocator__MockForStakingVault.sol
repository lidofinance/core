// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

contract LidoLocator__MockForStakingVault {
    address public immutable PREDEPOSIT_GUARANTEE;

    constructor(address _predepositGuarantee) {
        PREDEPOSIT_GUARANTEE = _predepositGuarantee;
    }

    function predepositGuarantee() external view returns (address) {
        return PREDEPOSIT_GUARANTEE;
    }
}
