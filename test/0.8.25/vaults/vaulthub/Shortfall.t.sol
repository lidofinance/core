// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";


contract ShortfallTest is Test {
    function testFuzz_ShortfallOnAnyTotalValue(
        uint256 totalValue,
        uint256 liabilityShares
    ) public {
        uint256 totalPooledEther = 1.5 ether;
        uint256 totalShares = 1 ether;

        vm.assume(totalValue > 1 ether);
        vm.assume(totalValue < 2 ether);
        vm.assume(liabilityShares > 1 ether);
        vm.assume(liabilityShares < 2 ether);

        uint256 liability = (liabilityShares * totalPooledEther + totalShares - 1) / totalShares;
        vm.assume(liability <= totalValue);

        uint256 reserveRatioBP = 2000;

        Vault vault = new Vault(totalValue, liabilityShares, reserveRatioBP);
        
        if (vault.isHealthy(totalPooledEther, totalShares)) {
            return;
        }

        uint256 shortfall = vault.shortfall(totalPooledEther, totalShares);
        vault.withdraw(shortfall);
        
        assertTrue(vault.isHealthy(totalPooledEther, totalShares));
    }
}

contract Vault {
    uint256 internal constant TOTAL_BASIS_POINTS = 10_000;

    uint256 public totalValue;
    uint256 public liabilityShares;
    uint256 public reserveRatioBP;

    constructor(uint256 _totalValue, uint256 _liabilityShares, uint256 _reserveRatioBP) {
        totalValue = _totalValue;
        liabilityShares = _liabilityShares;
        reserveRatioBP = _reserveRatioBP;
    }

    function withdraw(uint256 amount) external {
        totalValue -= amount;
    }

    function decreaseLiabilityShares(uint256 amount) external {
        liabilityShares -= amount;
    }

    function shortfall(uint256 totalPooledEther, uint256 totalShares) external view returns (uint256) {
        uint256 maxMintableRatio = (TOTAL_BASIS_POINTS - reserveRatioBP);

        return (
            totalPooledEther * TOTAL_BASIS_POINTS * liabilityShares +
            TOTAL_BASIS_POINTS * totalShares +
            maxMintableRatio * totalShares -
            TOTAL_BASIS_POINTS -
            maxMintableRatio * totalShares * totalValue -
            maxMintableRatio
        ) / (
            totalPooledEther * (TOTAL_BASIS_POINTS - maxMintableRatio)
        );
    }

    function isHealthy(uint256 totalPooledEther, uint256 totalShares) external view returns (bool) {
        uint256 liability = ((liabilityShares * totalPooledEther) - totalShares - 1) / totalShares;
        return liability > totalValue * (TOTAL_BASIS_POINTS - reserveRatioBP) / TOTAL_BASIS_POINTS;
    }
}
