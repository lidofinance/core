// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {GIndex, pack, unwrap, index, pow, shr} from "contracts/common/lib/GIndex.sol";
import {CLProofVerifier__Harness} from "test/0.8.25/vaults/predepositGuarantee/contracts/CLProofVerifier__harness.sol";

contract CLProofVerifierFuzzTest is Test {
    CLProofVerifier__Harness internal verifier;

    GIndex internal giPrev;
    GIndex internal giCurr;
    uint64 internal pivotSlot;

    function setUp() external {
        // Keep depth high enough so bounded offsets remain valid for .shr().
        giPrev = pack((1 << 40) + 0x1234, 40);
        giCurr = pack((1 << 40) + 0x2345, 40);
        pivotSlot = 1_000_000;

        verifier = new CLProofVerifier__Harness(giPrev, giCurr, pivotSlot);
    }

    function testFuzz_getValidatorGI_UsesPrevBeforePivot(uint64 provenSlot, uint32 offset) external view {
        vm.assume(provenSlot < pivotSlot);

        // Bound offsets to avoid expected IndexOutOfRange reverts from GIndex.shr().
        uint256 boundedOffset = bound(uint256(offset), 0, 1_000_000);

        GIndex expected = giPrev.shr(boundedOffset);
        GIndex actual = verifier.TEST_getValidatorGI(boundedOffset, provenSlot);

        assertEq(unwrap(actual), unwrap(expected), "slot<pivot must use GI_FIRST_VALIDATOR_PREV");
    }

    function testFuzz_getValidatorGI_UsesCurrAtOrAfterPivot(uint64 provenSlot, uint32 offset) external view {
        vm.assume(provenSlot >= pivotSlot);

        uint256 boundedOffset = bound(uint256(offset), 0, 1_000_000);

        GIndex expected = giCurr.shr(boundedOffset);
        GIndex actual = verifier.TEST_getValidatorGI(boundedOffset, provenSlot);

        assertEq(unwrap(actual), unwrap(expected), "slot>=pivot must use GI_FIRST_VALIDATOR_CURR");
    }

    function testFuzz_getParentBlockRoot_RevertsWhenRootMissing(uint64 childBlockTimestamp) external {
        vm.expectRevert(bytes4(keccak256("RootNotFound()")));
        verifier.TEST_getParentBlockRoot(childBlockTimestamp);
    }

    function test_ConstructorStoresPivotAndGIndexes() external view {
        assertEq(verifier.PIVOT_SLOT(), pivotSlot, "pivot slot mismatch");
        assertEq(unwrap(verifier.GI_FIRST_VALIDATOR_PREV()), unwrap(giPrev), "prev gindex mismatch");
        assertEq(unwrap(verifier.GI_FIRST_VALIDATOR_CURR()), unwrap(giCurr), "curr gindex mismatch");
        assertEq(index(verifier.GI_FIRST_VALIDATOR_PREV()), index(giPrev), "prev index mismatch");
        assertEq(pow(verifier.GI_FIRST_VALIDATOR_PREV()), pow(giPrev), "prev depth mismatch");
    }
}
