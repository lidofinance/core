// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {BeaconBlockHeader} from "contracts/common/lib/BeaconTypes.sol";
import {GIndex} from "contracts/common/lib/GIndex.sol";
import {StakingModule} from "contracts/0.8.25/sr/SRTypes.sol";
import {
    ValidatorExitDelayVerifier,
    GIndices,
    ProvableBeaconBlockHeader,
    BlockRootsHeaderWitness,
    ValidatorWitness,
    ExitRequestData
} from "contracts/0.8.25/ValidatorExitDelayVerifier.sol";

interface ILocator {
    function validatorExitDelayVerifier() external view returns (address);
    function validatorsExitBusOracle() external view returns (address);
    function stakingRouter() external view returns (address);
}

interface IStakingRouterModules {
    function getStakingModule(uint256 id) external view returns (StakingModule memory);
}

interface IVEB {
    function getDeliveryTimestamp(bytes32 exitRequestsHash) external view returns (uint256);
}

/**
 * End-to-end run of a late-prover-bot proof against a live Gloas devnet, forked.
 *
 * The proof is real (see gloasVerifierDevnet.t.sol for the fixture), the chain state is real - the
 * EIP-4788 root comes out of the forked predeploy, and the report lands in the real StakingRouter
 * and NodeOperatorsRegistry for a Lido key that is actually deposited on that devnet.
 *
 * Two things are arranged rather than observed, neither of them Gloas-specific:
 *   - the new verifier's code is etched onto the address the LidoLocator already points at, since
 *     StakingRouter authorises exactly that address;
 *   - the VEB delivery timestamp is mocked to a moment before the validator became eligible to exit,
 *     because a fork cannot be made to have submitted an exit request in its own past. The reported
 *     delay is therefore still derived from real chain data (activation epoch + shard committee
 *     period), not from the mock.
 *
 * EL_API_URL=<el> FIXTURE=<path> forge test --match-path test/0.8.25/gloasVerifierDevnetFork.t.sol
 */
contract GloasVerifierDevnetForkTest is Test {
    using stdJson for string;

    event ValidatorExitStatusUpdated(
        uint256 indexed nodeOperatorId,
        bytes publicKey,
        uint256 eligibleToExitInSec,
        uint256 proofSlotTimestamp
    );

    string internal fixture;
    ILocator internal locator;
    address internal verifierAddress;
    address internal veb;
    address internal nor;

    function setUp() public {
        vm.createSelectFork(vm.envString("EL_API_URL"));

        fixture = vm.readFile(vm.envOr("FIXTURE", string("test/fixtures/gloas-devnet-proof.json")));
        locator = ILocator(fixture.readAddress(".chain.lidoLocator"));
        verifierAddress = locator.validatorExitDelayVerifier();
        veb = locator.validatorsExitBusOracle();
        nor = IStakingRouterModules(locator.stakingRouter())
            .getStakingModule(fixture.readUint(".exitRequests.moduleId"))
            .stakingModuleAddress;

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

        ValidatorExitDelayVerifier deployed = new ValidatorExitDelayVerifier(
            address(locator),
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

        // The StakingRouter grants REPORT_VALIDATOR_EXITING_STATUS_ROLE to the address the locator
        // points at, and the verifier keeps all of its configuration in immutables, so moving the
        // code is enough to run the new implementation in the deployed one's place.
        vm.etch(verifierAddress, address(deployed).code);
    }

    function test_botProofIsAcceptedAndReportsTheDelay() public {
        uint256 genesisTime = fixture.readUint(".chain.genesisTime");
        uint256 secondsPerSlot = fixture.readUint(".chain.secondsPerSlot");
        uint256 targetSlot = fixture.readUint(".target.slot");
        uint256 nodeOpId = fixture.readUint(".exitRequests.nodeOpId");

        uint256 proofSlotTimestamp = genesisTime + targetSlot * secondsPerSlot;
        uint256 eligibleSince = genesisTime +
            fixture.readUint(".validator.witness.activationEpoch") *
            32 *
            secondsPerSlot +
            fixture.readUint(".chain.shardCommitteePeriodInSeconds");

        // Delivered before the validator could have exited, so the reported delay is the real one
        vm.mockCall(veb, abi.encodeWithSelector(IVEB.getDeliveryTimestamp.selector), abi.encode(eligibleSince - 1 days));

        vm.recordLogs();

        ValidatorExitDelayVerifier(verifierAddress).verifyValidatorExitDelay(
            _recentBlock(),
            _targetBlock(),
            _validatorWitnesses(),
            _exitRequests()
        );

        // The module recorded the delay for exactly this key, with the delay derived from the chain
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("ValidatorExitStatusUpdated(uint256,bytes,uint256,uint256)");
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != nor || logs[i].topics[0] != topic) continue;
            assertEq(uint256(logs[i].topics[1]), nodeOpId, "node operator");
            (bytes memory pubkey, uint256 eligibleToExitInSec, uint256 reportedAt) = abi.decode(
                logs[i].data,
                (bytes, uint256, uint256)
            );
            assertEq(pubkey, fixture.readBytes(".validator.pubkey"), "public key");
            assertEq(eligibleToExitInSec, proofSlotTimestamp - eligibleSince, "reported exit delay");
            assertEq(reportedAt, proofSlotTimestamp, "proof slot timestamp");
            found = true;
        }
        assertTrue(found, "the module did not record the exit delay");
    }

    /// The same call with the target block's proof pointing at a slot it was not taken from
    function test_wrongTargetSlotIsRejected() public {
        vm.mockCall(veb, abi.encodeWithSelector(IVEB.getDeliveryTimestamp.selector), abi.encode(uint256(1)));

        BlockRootsHeaderWitness memory target = _targetBlock();
        target.header.slot = target.header.slot - 1;

        vm.expectRevert();
        ValidatorExitDelayVerifier(verifierAddress).verifyValidatorExitDelay(
            _recentBlock(),
            target,
            _validatorWitnesses(),
            _exitRequests()
        );
    }

    function _recentBlock() internal view returns (ProvableBeaconBlockHeader memory) {
        return
            ProvableBeaconBlockHeader({
                header: BeaconBlockHeader({
                    slot: uint64(fixture.readUint(".recent.slot")),
                    proposerIndex: uint64(fixture.readUint(".recent.proposerIndex")),
                    parentRoot: fixture.readBytes32(".recent.parentRoot"),
                    stateRoot: fixture.readBytes32(".recent.stateRoot"),
                    bodyRoot: fixture.readBytes32(".recent.bodyRoot")
                }),
                rootsTimestamp: uint64(fixture.readUint(".recent.rootsTimestamp"))
            });
    }

    function _targetBlock() internal view returns (BlockRootsHeaderWitness memory) {
        return
            BlockRootsHeaderWitness({
                header: BeaconBlockHeader({
                    slot: uint64(fixture.readUint(".target.slot")),
                    proposerIndex: uint64(fixture.readUint(".target.proposerIndex")),
                    parentRoot: fixture.readBytes32(".target.parentRoot"),
                    stateRoot: fixture.readBytes32(".target.stateRoot"),
                    bodyRoot: fixture.readBytes32(".target.bodyRoot")
                }),
                proof: fixture.readBytes32Array(".target.proof")
            });
    }

    function _validatorWitnesses() internal view returns (ValidatorWitness[] memory witnesses) {
        witnesses = new ValidatorWitness[](1);
        witnesses[0] = ValidatorWitness({
            exitRequestIndex: uint32(fixture.readUint(".validator.witness.exitRequestIndex")),
            withdrawalCredentials: fixture.readBytes32(".validator.witness.withdrawalCredentials"),
            effectiveBalance: uint64(fixture.readUint(".validator.witness.effectiveBalance")),
            slashed: fixture.readBool(".validator.witness.slashed"),
            activationEligibilityEpoch: uint64(fixture.readUint(".validator.witness.activationEligibilityEpoch")),
            activationEpoch: uint64(fixture.readUint(".validator.witness.activationEpoch")),
            withdrawableEpoch: uint64(fixture.readUint(".validator.witness.withdrawableEpoch")),
            validatorProof: fixture.readBytes32Array(".validator.witness.validatorProof")
        });
    }

    function _exitRequests() internal view returns (ExitRequestData memory) {
        return
            ExitRequestData({
                data: fixture.readBytes(".exitRequests.data"),
                dataFormat: fixture.readUint(".exitRequests.dataFormat")
            });
    }
}
