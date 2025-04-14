// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";

import {BeaconBlockHeader, Validator} from "../../../contracts/0.8.25/lib/BeaconTypes.sol";
import {GIndex, pack} from "../../../contracts/0.8.25/lib/GIndex.sol";
import {Utilities} from "../contracts/Utilities.sol";
import {SSZ} from "../../../contracts/0.8.25/lib/SSZ.sol";

// Wrap the library internal methods to make an actual call to them.
// Supposed to be used with `expectRevert` cheatcode and to pass
// calldata arguments.
contract Library {
    function verifyProof(bytes32[] calldata proof, bytes32 root, bytes32 leaf, GIndex gI) external view {
        SSZ.verifyProof(proof, root, leaf, gI);
    }
}

contract SSZTest is Utilities, Test {
    Library internal lib;

    function setUp() public {
        lib = new Library();
    }

    function test_toLittleEndianUint() public pure {
        uint256 v = 0x1234567890ABCDEF;
        bytes32 expected = bytes32(bytes.concat(hex"EFCDAB9078563412", bytes24(0)));
        bytes32 actual = SSZ.toLittleEndian(v);
        assertEq(actual, expected);
    }

    function test_toLittleEndianUintZero() public pure {
        bytes32 actual = SSZ.toLittleEndian(0);
        assertEq(actual, bytes32(0));
    }

    function test_toLittleEndianFalse() public pure {
        bool v = false;
        bytes32 expected = 0x0000000000000000000000000000000000000000000000000000000000000000;
        bytes32 actual = SSZ.toLittleEndian(v);
        assertEq(actual, expected);
    }

    function test_toLittleEndianTrue() public pure {
        bool v = true;
        bytes32 expected = 0x0100000000000000000000000000000000000000000000000000000000000000;
        bytes32 actual = SSZ.toLittleEndian(v);
        assertEq(actual, expected);
    }

    function testFuzz_toLittleEndian_Idempotent(uint256 v) public pure {
        uint256 n = v;
        n = uint256(SSZ.toLittleEndian(n));
        n = uint256(SSZ.toLittleEndian(n));
        assertEq(n, v);
    }

    function test_ValidatorRootExitedSlashed() public view {
        Validator memory v = Validator({
            pubkey: hex"91760f8a17729cfcb68bfc621438e5d9dfa831cd648e7b2b7d33540a7cbfda1257e4405e67cd8d3260351ab3ff71b213",
            withdrawalCredentials: 0x01000000000000000000000006676e8584342cc8b6052cfdf381c3a281f00ac8,
            effectiveBalance: 30000000000,
            slashed: true,
            activationEligibilityEpoch: 242529,
            activationEpoch: 242551,
            exitEpoch: 242556,
            withdrawableEpoch: 250743
        });

        bytes32 expected = 0xe4674dc5c27e7d3049fcd298745c00d3e314f03d33c877f64bf071d3b77eb942;
        bytes32 actual = SSZ.hashTreeRoot(v);
        assertEq(actual, expected);
    }

    function test_ValidatorRootActive() public view {
        Validator memory v = Validator({
            pubkey: hex"8fb78536e82bcec34e98fff85c907f0a8e6f4b1ccdbf1e8ace26b59eb5a06d16f34e50837f6c490e2ad6a255db8d543b",
            withdrawalCredentials: 0x0023b9d00bf66e7f8071208a85afde59b3148dea046ee3db5d79244880734881,
            effectiveBalance: 32000000000,
            slashed: false,
            activationEligibilityEpoch: 2593,
            activationEpoch: 5890,
            exitEpoch: type(uint64).max,
            withdrawableEpoch: type(uint64).max
        });

        bytes32 expected = 0x60fb91184416404ddfc62bef6df9e9a52c910751daddd47ea426aabaf19dfa09;
        bytes32 actual = SSZ.hashTreeRoot(v);
        assertEq(actual, expected);
    }

    function test_ValidatorRootExtraBytesInPubkey() public view {
        Validator memory v = Validator({
            pubkey: hex"8fb78536e82bcec34e98fff85c907f0a8e6f4b1ccdbf1e8ace26b59eb5a06d16f34e50837f6c490e2ad6a255db8d543bDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
            withdrawalCredentials: 0x0023b9d00bf66e7f8071208a85afde59b3148dea046ee3db5d79244880734881,
            effectiveBalance: 32000000000,
            slashed: false,
            activationEligibilityEpoch: 2593,
            activationEpoch: 5890,
            exitEpoch: type(uint64).max,
            withdrawableEpoch: type(uint64).max
        });

        bytes32 expected = 0x60fb91184416404ddfc62bef6df9e9a52c910751daddd47ea426aabaf19dfa09;
        bytes32 actual = SSZ.hashTreeRoot(v);
        assertEq(actual, expected);
    }

    function test_ValidatorRoot_AllZeroes() public view {
        Validator memory v = Validator({
            pubkey: hex"000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
            withdrawalCredentials: 0x0000000000000000000000000000000000000000000000000000000000000000,
            effectiveBalance: 0,
            slashed: false,
            activationEligibilityEpoch: 0,
            activationEpoch: 0,
            exitEpoch: 0,
            withdrawableEpoch: 0
        });

        bytes32 expected = 0xfa324a462bcb0f10c24c9e17c326a4e0ebad204feced523eccaf346c686f06ee;
        bytes32 actual = SSZ.hashTreeRoot(v);
        assertEq(actual, expected);
    }

    function test_ValidatorRoot_AllOnes() public view {
        Validator memory v = Validator({
            pubkey: hex"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            withdrawalCredentials: 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff,
            effectiveBalance: type(uint64).max,
            slashed: true,
            activationEligibilityEpoch: type(uint64).max,
            activationEpoch: type(uint64).max,
            exitEpoch: type(uint64).max,
            withdrawableEpoch: type(uint64).max
        });

        bytes32 expected = 0x29c03a7cc9a8047ff05619a04bb6e60440a791e6ac3fe7d72e6fe9037dd3696f;
        bytes32 actual = SSZ.hashTreeRoot(v);
        assertEq(actual, expected);
    }

    function testFuzz_validatorRoot_memory(Validator memory v) public view brutalizeMemory {
        SSZ.hashTreeRoot(v);
    }

    function test_BeaconBlockHeaderRoot() public view {
        // Can be obtained via /eth/v1/beacon/headers/{block_id}.
        BeaconBlockHeader memory h = BeaconBlockHeader({
            slot: 7472518,
            proposerIndex: 152834,
            parentRoot: 0x4916af1ff31b06f1b27125d2d20cd26e123c425a4b34ebd414e5f0120537e78d,
            stateRoot: 0x76ca64f3732754bc02c7966271fb6356a9464fe5fce85be8e7abc403c8c7b56b,
            bodyRoot: 0x6d858c959f1c95f411dba526c4ae9ab8b2690f8b1e59ed1b79ad963ab798b01a
        });

        bytes32 expected = 0x26631ee28ab4dd44a39c3756e03714d6a35a256560de5e2885caef9c3efd5516;
        bytes32 actual = SSZ.hashTreeRoot(h);
        assertEq(actual, expected);
    }

    function test_BeaconBlockHeaderRoot_AllZeroes() public view {
        BeaconBlockHeader memory h = BeaconBlockHeader({
            slot: 0,
            proposerIndex: 0,
            parentRoot: 0x0000000000000000000000000000000000000000000000000000000000000000,
            stateRoot: 0x0000000000000000000000000000000000000000000000000000000000000000,
            bodyRoot: 0x0000000000000000000000000000000000000000000000000000000000000000
        });

        bytes32 expected = 0xc78009fdf07fc56a11f122370658a353aaa542ed63e44c4bc15ff4cd105ab33c;
        bytes32 actual = SSZ.hashTreeRoot(h);
        assertEq(actual, expected);
    }

    function test_BeaconBlockHeaderRoot_AllOnes() public view {
        BeaconBlockHeader memory h = BeaconBlockHeader({
            slot: type(uint64).max,
            proposerIndex: type(uint64).max,
            parentRoot: 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff,
            stateRoot: 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff,
            bodyRoot: 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
        });

        bytes32 expected = 0x5ebe9f2b0267944bd80dd5cde20317a91d07225ff12e9cd5ba1e834c05cc2b05;
        bytes32 actual = SSZ.hashTreeRoot(h);
        assertEq(actual, expected);
    }

    function testFuzz_BeaconBlockHeaderRoot_memory(BeaconBlockHeader memory h) public view brutalizeMemory {
        SSZ.hashTreeRoot(h);
    }

    // For the tests below, assume there's the following tree from the bottom up:
    // --
    // 0x0000000000000000000000000000000000000000000000000000000000000000
    // 0xad3228b676f7d3cd4284a5443f17f1962b36e491b30a40b2405849e597ba5fb5
    // 0xb4c11951957c6f8f642c4af61cd6b24640fec6dc7fc607ee8206a99e92410d30
    // 0x21ddb9a356815c3fac1026b6dec5df3124afbadb485c9ba5a3e3398a04b7ba85
    // --
    // 0x0a4b105f69a6f41c3b3efc9bb5ac525b5b557a524039a13c657a916d8eb04451
    // 0xf4551dd23f47858f0e66957db62a0bced8cfd5e9cbd63f2fd73672ed0db7c124
    // --
    // 0xda1c902c54a4386439ce622d7e527dc11decace28ebb902379cba91c4a116b1c

    function test_verifyProof_HappyPath() public view {
        bytes32[] memory proof = new bytes32[](2);

        // prettier-ignore
        {
            proof[0] = 0xad3228b676f7d3cd4284a5443f17f1962b36e491b30a40b2405849e597ba5fb5;
            proof[1] = 0xf4551dd23f47858f0e66957db62a0bced8cfd5e9cbd63f2fd73672ed0db7c124;
        }

        lib.verifyProof(
            proof,
            0xda1c902c54a4386439ce622d7e527dc11decace28ebb902379cba91c4a116b1c,
            0x0000000000000000000000000000000000000000000000000000000000000000,
            pack(4, 0)
        );

        // prettier-ignore
        {
            proof[0] = 0x0000000000000000000000000000000000000000000000000000000000000000;
            proof[1] = 0xf4551dd23f47858f0e66957db62a0bced8cfd5e9cbd63f2fd73672ed0db7c124;
        }

        lib.verifyProof(
            proof,
            0xda1c902c54a4386439ce622d7e527dc11decace28ebb902379cba91c4a116b1c,
            0xad3228b676f7d3cd4284a5443f17f1962b36e491b30a40b2405849e597ba5fb5,
            pack(5, 0)
        );
    }

    function test_verifyProof_OneItem() public view brutalizeMemory {
        bytes32[] memory proof = new bytes32[](1);

        // prettier-ignore
        proof[0] = 0xf4551dd23f47858f0e66957db62a0bced8cfd5e9cbd63f2fd73672ed0db7c124;

        lib.verifyProof(
            proof,
            0xda1c902c54a4386439ce622d7e527dc11decace28ebb902379cba91c4a116b1c,
            0x0a4b105f69a6f41c3b3efc9bb5ac525b5b557a524039a13c657a916d8eb04451,
            pack(2, 0)
        );
    }

    function test_verifyProof_RevertWhen_NoProof() public brutalizeMemory {
        vm.expectRevert(SSZ.InvalidProof.selector);

        // bytes32(0) is a valid proof for the inputs.
        lib.verifyProof(
            new bytes32[](0),
            0xf5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b,
            0x0000000000000000000000000000000000000000000000000000000000000000,
            pack(2, 0)
        );
    }

    function test_verifyProof_RevertWhen_ProvingRoot() public brutalizeMemory {
        vm.expectRevert(SSZ.InvalidProof.selector);

        lib.verifyProof(
            new bytes32[](0),
            0xf5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b,
            0xf5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b,
            pack(1, 0)
        );
    }

    function test_verifyProof_RevertWhen_InvalidProof() public brutalizeMemory {
        bytes32[] memory proof = new bytes32[](2);

        // prettier-ignore
        {
            proof[0] = 0xb4c11951957c6f8f642c4af61cd6b24640fec6dc7fc607ee8206a99e92410d30;
            proof[1] = 0xf4551dd23f47858f0e66957db62a0bced8cfd5e9cbd63f2fd73672ed0db7c124;
        }

        vm.expectRevert(SSZ.InvalidProof.selector);

        lib.verifyProof(
            proof,
            0xda1c902c54a4386439ce622d7e527dc11decace28ebb902379cba91c4a116b1c,
            0xad3228b676f7d3cd4284a5443f17f1962b36e491b30a40b2405849e597ba5fb5,
            pack(4, 0)
        );
    }

    function test_verifyProof_RevertWhen_WrongGIndex() public brutalizeMemory {
        bytes32[] memory proof = new bytes32[](2);

        // prettier-ignore
        {
            proof[0] = 0xad3228b676f7d3cd4284a5443f17f1962b36e491b30a40b2405849e597ba5fb5;
            proof[1] = 0xf4551dd23f47858f0e66957db62a0bced8cfd5e9cbd63f2fd73672ed0db7c124;
        }

        vm.expectRevert(SSZ.InvalidProof.selector);

        lib.verifyProof(
            proof,
            0xda1c902c54a4386439ce622d7e527dc11decace28ebb902379cba91c4a116b1c,
            0x0000000000000000000000000000000000000000000000000000000000000000,
            pack(5, 0)
        );
    }

    function test_verifyProof_RevertWhen_BranchHasExtraItem() public brutalizeMemory {
        bytes32[] memory proof = new bytes32[](2);

        // prettier-ignore
        {
            proof[0] = 0xb4c11951957c6f8f642c4af61cd6b24640fec6dc7fc607ee8206a99e92410d30;
            proof[1] = 0xf4551dd23f47858f0e66957db62a0bced8cfd5e9cbd63f2fd73672ed0db7c124;
        }

        vm.expectRevert(SSZ.BranchHasExtraItem.selector);

        lib.verifyProof(
            proof,
            0xda1c902c54a4386439ce622d7e527dc11decace28ebb902379cba91c4a116b1c,
            0xad3228b676f7d3cd4284a5443f17f1962b36e491b30a40b2405849e597ba5fb5,
            pack(2, 0)
        );
    }

    function test_verifyProof_RevertWhen_BranchHasMissingItem() public brutalizeMemory {
        bytes32[] memory proof = new bytes32[](2);

        // prettier-ignore
        {
            proof[0] = 0xb4c11951957c6f8f642c4af61cd6b24640fec6dc7fc607ee8206a99e92410d30;
            proof[1] = 0xf4551dd23f47858f0e66957db62a0bced8cfd5e9cbd63f2fd73672ed0db7c124;
        }

        vm.expectRevert(SSZ.BranchHasMissingItem.selector);

        lib.verifyProof(
            proof,
            0xda1c902c54a4386439ce622d7e527dc11decace28ebb902379cba91c4a116b1c,
            0xad3228b676f7d3cd4284a5443f17f1962b36e491b30a40b2405849e597ba5fb5,
            pack(8, 0)
        );
    }

    function testFuzz_verifyProof_MemorySafe(
        bytes32[] calldata proof,
        bytes32 root,
        bytes32 leaf,
        GIndex gI
    ) public view {
        try this.verifyProofCallJunkMemory(proof, root, leaf, gI) {} catch {}
    }

    function verifyProofCallJunkMemory(
        bytes32[] calldata proof,
        bytes32 root,
        bytes32 leaf,
        GIndex gI
    ) external view brutalizeMemory {
        SSZ.verifyProof(proof, root, leaf, gI);
    }
}
