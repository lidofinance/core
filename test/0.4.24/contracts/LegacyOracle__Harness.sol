// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {LegacyOracle} from "contracts/0.4.24/oracle/LegacyOracle.sol";

interface ITimeProvider {
    function getTime() external view returns (uint256);
}

contract LegacyOracle__Harness is LegacyOracle {
    // @dev this is a way to not use block.timestamp in the tests
    function _getTime() internal view returns (uint256) {
        address accountingOracle = ACCOUNTING_ORACLE_POSITION.getStorageAddress();
        return ITimeProvider(accountingOracle).getTime();
    }

    function getTime() external view returns (uint256) {
        return _getTime();
    }

    function harness__setContractDeprecatedVersion(uint256 _contractVersion) external {
        CONTRACT_VERSION_POSITION_DEPRECATED.setStorageUint256(_contractVersion);
    }

    function harness__setAccountingOracle(address _accountingOracle) external {
        ACCOUNTING_ORACLE_POSITION.setStorageAddress(_accountingOracle);
    }

    function harness__updateChainSpec(address _consensusContract) external {
        _setChainSpec(_getAccountingOracleChainSpec(_consensusContract));
    }

    function harness__getTime() external view returns (uint256) {
        return super._getTime();
    }
}
