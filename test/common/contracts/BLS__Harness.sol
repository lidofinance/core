// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.25;

import {BLS12_381} from "contracts/common/lib/BLS.sol";
import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

struct PrecomputedDepositMessage {
    IStakingVault.Deposit deposit;
    BLS12_381.DepositY depositYComponents;
    bytes32 withdrawalCredentials;
}

// Used for deployment on testnets/devnets to test BLS support on the network
contract BLS__Harness {
    BLS__HarnessVerifier public verifier;

    bytes32 public immutable DEPOSIT_DOMAIN;

    function verifyDepositMessage(
        IStakingVault.Deposit calldata deposit,
        BLS12_381.DepositY calldata depositY,
        bytes32 withdrawalCredentials
    ) public view {
        BLS12_381.verifyDepositMessage(
            deposit.pubkey,
            deposit.signature,
            deposit.amount,
            depositY,
            withdrawalCredentials,
            DEPOSIT_DOMAIN
        );
    }

    function verifyDepositMessageCustomDomain(
        IStakingVault.Deposit calldata deposit,
        BLS12_381.DepositY calldata depositY,
        bytes32 withdrawalCredentials,
        bytes32 customDomain
    ) public view {
        BLS12_381.verifyDepositMessage(
            deposit.pubkey,
            deposit.signature,
            deposit.amount,
            depositY,
            withdrawalCredentials,
            customDomain
        );
    }

    constructor(bytes32 _depositDomain) {
        DEPOSIT_DOMAIN = _depositDomain;
        verifier = new BLS__HarnessVerifier(this);
    }

    function LOCAL_MESSAGE_1() external pure returns (PrecomputedDepositMessage memory) {
        return
            PrecomputedDepositMessage(
                IStakingVault.Deposit(
                    hex"b79902f435d268d6d37ac3ab01f4536a86c192fa07ba5b63b5f8e4d0e05755cfeab9d35fbedb9c02919fe02a81f8b06d",
                    hex"b357f146f53de27ae47d6d4bff5e8cc8342d94996143b2510452a3565701c3087a0ba04bed41d208eb7d2f6a50debeac09bf3fcf5c28d537d0fe4a52bb976d0c19ea37a31b6218f321a308f8017e5fd4de63df270f37df58c059c75f0f98f980",
                    1 ether,
                    bytes32(0) // deposit data root is not checked
                ),
                BLS12_381.DepositY(
                    BLS12_381.Fp(
                        0x0000000000000000000000000000000019b71bd2a9ebf09809b6c380a1d1de0c,
                        0x2d9286a8d368a2fc75ad5ccc8aec572efdff29d50b68c63e00f6ce017c24e083
                    ),
                    BLS12_381.Fp2(
                        0x00000000000000000000000000000000160f8d804d277c7a079f451bce224fd4,
                        0x2397e75676d965a1ebe79e53beeb2cb48be01f4dc93c0bad8ae7560c3e8048fb,
                        0x0000000000000000000000000000000010d96c5dcc6e32bcd43e472317e18ad9,
                        0x4dde89c9361d79bec5378c72214083ea40f3dc43ee759025eb4c25150e1943bf
                    )
                ),
                0xf3d93f9fbc6a229f3b11340b4b52ae53833813efab76e812d1d014163259ef1f
            );
    }

    function verifyBLSSupport() external view {
        verifier.verifyBLSSupport();
    }
}

contract BLS__HarnessVerifier {
    BLS__Harness harness;

    constructor(BLS__Harness _harness) {
        harness = _harness;
    }

    function verifyBLSSupport() external view {
        PrecomputedDepositMessage memory message = harness.LOCAL_MESSAGE_1();
        harness.verifyDepositMessageCustomDomain(
            message.deposit,
            message.depositYComponents,
            message.withdrawalCredentials,
            // mainnet domain
            0x03000000f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a9
        );
    }
}
