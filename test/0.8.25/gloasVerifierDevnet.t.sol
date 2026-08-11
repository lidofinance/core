// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {BeaconBlockHeader, Validator} from "contracts/common/lib/BeaconTypes.sol";
import {GIndex, pack} from "contracts/common/lib/GIndex.sol";
import {SSZ} from "contracts/common/lib/SSZ.sol";
import {GIndices} from "contracts/0.8.25/ValidatorExitDelayVerifier.sol";

import {ValidatorExitDelayVerifier__Harness} from "./contracts/ValidatorExitDelayVerifier__Harness.sol";

/**
 * Feeds a proof built by late-prover-bot from a live Gloas devnet through the verifier.
 *
 * The fixture (scripts/devnet-proof-fixture.ts in late-prover-bot) carries real chain data: a
 * finalized block whose root was read back from the EIP-4788 predeploy, the target block proven
 * against that block's state.block_roots, and a Lido validator proven against the target state.
 * Nothing here is synthesised, so a passing run means the bot and the contract agree on the Gloas
 * state layout - including the progressive-list generalized indices introduced by EIP-7916.
 *
 * FIXTURE=<path> forge test --match-path test/0.8.25/gloasVerifierDevnet.t.sol
 */
contract GloasVerifierDevnetTest is Test {
    using stdJson for string;

    string internal fixture;

    ValidatorExitDelayVerifier__Harness internal verifier;

    uint64 internal recentSlot;
    uint64 internal targetSlot;
    uint64 internal validatorIndex;

    function setUp() public {
        string memory path = vm.envOr("FIXTURE", string("fixture.json"));
        fixture = vm.readFile(path);

        recentSlot = uint64(fixture.readUint(".recent.slot"));
        targetSlot = uint64(fixture.readUint(".target.slot"));
        validatorIndex = uint64(fixture.readUint(".validator.index"));

        GIndices memory gIndices = GIndices({
            gIFirstValidatorPreGloas: GIndex.wrap(fixture.readBytes32(".gIndices.gIFirstValidatorPreGloas")),
            gIValidators: GIndex.wrap(fixture.readBytes32(".gIndices.gIValidators")),
            gIFirstHistoricalSummaryPrev: GIndex.wrap(fixture.readBytes32(".gIndices.gIFirstHistoricalSummaryPreGloas")),
            gIFirstHistoricalSummaryCurr: GIndex.wrap(fixture.readBytes32(".gIndices.gIFirstHistoricalSummary")),
            gIFirstBlockRootInSummaryPrev: GIndex.wrap(fixture.readBytes32(".gIndices.gIFirstBlockRootInSummary")),
            gIFirstBlockRootInSummaryCurr: GIndex.wrap(fixture.readBytes32(".gIndices.gIFirstBlockRootInSummary")),
            gIBlockRootsPreGloas: GIndex.wrap(fixture.readBytes32(".gIndices.gIBlockRootsPreGloas")),
            gIBlockRoots: GIndex.wrap(fixture.readBytes32(".gIndices.gIBlockRoots"))
        });

        verifier = new ValidatorExitDelayVerifier__Harness(
            fixture.readAddress(".chain.lidoLocator"),
            gIndices,
            uint64(fixture.readUint(".chain.gloasForkSlot")), // firstSupportedSlot
            uint64(fixture.readUint(".chain.gloasForkSlot")), // pivotSlot - the Gloas fork
            uint64(fixture.readUint(".chain.capellaSlot")),
            uint64(fixture.readUint(".chain.slotsPerHistoricalRoot")),
            32, // slotsPerEpoch
            uint32(fixture.readUint(".chain.secondsPerSlot")),
            uint64(fixture.readUint(".chain.genesisTime")),
            uint32(fixture.readUint(".chain.shardCommitteePeriodInSeconds"))
        );
    }

    /// The contract walks into the progressive list itself; SSZ computed the same index off the
    /// real state. If these ever diverge, every proof the bot builds is rejected on chain.
    function test_validatorGIndexMatchesSSZ() public view {
        uint256 expected = fixture.readUint(".validator.gindex");

        GIndex actual = verifier.getValidatorGI(validatorIndex, targetSlot);

        assertEq(actual.index(), expected, "validator generalized index");
    }

    function test_blockRootsGIndexMatchesSSZ() public view {
        uint256 expected = fixture.readUint(".target.gindex");

        GIndex actual = verifier.getBlockRootsBlockGI(recentSlot, targetSlot);

        assertEq(actual.index(), expected, "block_roots generalized index");
    }

    /// The target block header, proven against the recent block's state root
    function test_targetBlockProofVerifies() public view {
        this.verifyProofExternal(
            fixture.readBytes32Array(".target.proof"),
            fixture.readBytes32(".recent.stateRoot"),
            SSZ.hashTreeRoot(_targetHeader()),
            verifier.getBlockRootsBlockGI(recentSlot, targetSlot)
        );
    }

    /// The validator, proven against the target block's state root, with the leaf rebuilt exactly
    /// the way the verifier rebuilds it - pubkey from the exit request, exitEpoch pinned to
    /// FAR_FUTURE_EPOCH.
    function test_validatorProofVerifies() public view {
        Validator memory validator = Validator({
            pubkey: fixture.readBytes(".validator.pubkey"),
            withdrawalCredentials: fixture.readBytes32(".validator.witness.withdrawalCredentials"),
            effectiveBalance: uint64(fixture.readUint(".validator.witness.effectiveBalance")),
            slashed: fixture.readBool(".validator.witness.slashed"),
            activationEligibilityEpoch: uint64(fixture.readUint(".validator.witness.activationEligibilityEpoch")),
            activationEpoch: uint64(fixture.readUint(".validator.witness.activationEpoch")),
            exitEpoch: type(uint64).max,
            withdrawableEpoch: uint64(fixture.readUint(".validator.witness.withdrawableEpoch"))
        });

        this.verifyProofExternal(
            fixture.readBytes32Array(".validator.witness.validatorProof"),
            fixture.readBytes32(".target.stateRoot"),
            SSZ.hashTreeRoot(validator),
            verifier.getValidatorGI(validatorIndex, targetSlot)
        );
    }

    /// The same proof must not verify at a neighbouring validator index. Progressive lists make the
    /// branch length depend on the index, so this fails on the branch length rather than the root.
    function test_validatorProofFailsAtWrongIndex() public {
        bytes32[] memory proof = fixture.readBytes32Array(".validator.witness.validatorProof");
        bytes32 root = fixture.readBytes32(".target.stateRoot");
        bytes32 leaf = SSZ.hashTreeRoot(_targetHeader());
        GIndex wrongGI = verifier.getValidatorGI(validatorIndex + 1, targetSlot);

        vm.expectRevert();
        this.verifyProofExternal(proof, root, leaf, wrongGI);
    }

    /// SSZ.verifyProof takes the proof as calldata, so it is reached through an external call
    function verifyProofExternal(bytes32[] calldata proof, bytes32 root, bytes32 leaf, GIndex gI) external view {
        SSZ.verifyProof({proof: proof, root: root, leaf: leaf, gI: gI});
    }

    function _targetHeader() internal view returns (BeaconBlockHeader memory) {
        return
            BeaconBlockHeader({
                slot: targetSlot,
                proposerIndex: uint64(fixture.readUint(".target.proposerIndex")),
                parentRoot: fixture.readBytes32(".target.parentRoot"),
                stateRoot: fixture.readBytes32(".target.stateRoot"),
                bodyRoot: fixture.readBytes32(".target.bodyRoot")
            });
    }
}
