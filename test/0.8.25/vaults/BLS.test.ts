import { expect } from "chai";

import { SecretKey, verify } from "@chainsafe/blst";

import { ether } from "lib";

import { computeDepositMessageRoot } from "./ssz-utils";

const BLS_TEST_KEY = "18f020b98eb798752a50ed0563b079c125b0db5dd0b1060d1c1b47d4a193e1e4";

const STATIC_DEPOSIT = {
  amount: ether("1"),
  withdrawalCredentials: "0xf3d93f9fbc6a229f3b11340b4b52ae53833813efab76e812d1d014163259ef1f",
};

describe("BLS.sol", () => {
  it("can create a deposit from test key", async () => {
    // deposit message
    const privateKey = SecretKey.fromHex(BLS_TEST_KEY);
    const pubkey = privateKey.toPublicKey();
    const pubkeyCompressed = pubkey.toHex(true);

    const withdrawalCredentials = STATIC_DEPOSIT.withdrawalCredentials;
    const amount = STATIC_DEPOSIT.amount;

    // deposit message + domain
    const message = await computeDepositMessageRoot(pubkey.toHex(true), withdrawalCredentials, amount);
    const messageHex = Buffer.from(message).toString("hex");

    const signature = privateKey.sign(message);
    const signatureCompressed = signature.toHex(true);

    const result = verify(message, pubkey, signature);
    expect(result).to.be.true;

    // Y coordinate of Fp component of pubkey is last 48 bytes of uncompressed pubkey(g1 point)
    const pubkeyY = Buffer.from(pubkey.toBytes(false).slice(48)).toString("hex");
    // the signature is a G2 point, so we need to extract the two components of Y coordinate (which is Fp2) from it
    // first Fp of Y coordinate is last 48 bytes of signature
    const sigY_c0 = Buffer.from(signature.toBytes(false).slice(96 + 48, 96 + 48 * 2)).toString("hex");
    // second Fp is 48 bytes before first one
    const sigY_c1 = Buffer.from(signature.toBytes(false).slice(96, 96 + 48)).toString("hex");

    console.log({
      pubkey: pubkeyCompressed,
      withdrawalCredentials: withdrawalCredentials,
      amount: amount.toString(),
      signature: signatureCompressed,
      signatureFull: Buffer.from(signature.toBytes(false)).toString("hex"),
      pubkeyY,
      sigY: {
        c0: sigY_c0,
        c1: sigY_c1,
      },
      messageHex,
    });
  });
});
