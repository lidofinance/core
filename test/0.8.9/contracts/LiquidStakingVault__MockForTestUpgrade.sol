// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

import {StakingVault} from "contracts/0.8.9/vaults/StakingVault.sol";
import {ILiquid} from "contracts/0.8.9/vaults/interfaces/ILiquid.sol";
import {ILockable} from "contracts/0.8.9/vaults/interfaces/ILockable.sol";
import {ILiquidity} from "contracts/0.8.9/vaults/interfaces/ILiquidity.sol";
import {BeaconChainDepositor} from "contracts/0.8.9/BeaconChainDepositor.sol";

pragma solidity 0.8.9;

contract LiquidStakingVault__MockForTestUpgrade is StakingVault, ILiquid, ILockable {

    uint8 private constant _version = 2;

    function version() public pure override returns(uint8) {
        return _version;
    }

    constructor(
        address _depositContract
    ) StakingVault(_depositContract) {
    }

    function finalizeUpgrade_v2() external {
        _checkContractVersion(1);
        _updateContractVersion(2);
    }

    function burn(uint256 _amountOfShares) external {}
    function isHealthy() external view returns (bool) {}
    function lastReport() external view returns (
        uint128 value,
        int128 netCashFlow
    ) {}
    function locked() external view returns (uint256) {}
    function mint(address _receiver, uint256 _amountOfTokens) external payable {}
    function netCashFlow() external view returns (int256) {}
    function rebalance(uint256 amountOfETH) external payable {}
    function update(uint256 value, int256 ncf, uint256 locked) external {}
    function value() external view returns (uint256) {}

    function testMock() external view returns(uint256) {
        return 123;
    }
}
