import { expect } from "chai";

import { getPublicKey, PointG1, PointG2, sign, verify } from "@noble/bls12-381";

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
    const pubkey = Buffer.from(getPublicKey(BLS_TEST_KEY)).toString("hex");
    const withdrawalCredentials = STATIC_DEPOSIT.withdrawalCredentials;
    const amount = STATIC_DEPOSIT.amount;

    // deposit message + domain
    const messageHex = Buffer.from(await computeDepositMessageRoot(pubkey, withdrawalCredentials, amount)).toString(
      "hex",
    );

    const sig = await sign(messageHex, BLS_TEST_KEY);
    const signature = Buffer.from(sig).toString("hex");
    const sigG2 = PointG2.fromSignature(sig);

    const result = await verify(sig, messageHex, pubkey);
    expect(result).to.be.true;

    const pubkeyG1 = PointG1.fromHex(pubkey);

    console.log({
      pubkey,
      withdrawalCredentials: withdrawalCredentials,
      amount: amount.toString(),
      signature,
      pubkeyX: pubkeyG1.x.value.toString(16),
      pubkeyY: pubkeyG1.y.value.toString(16),
      signatureX: { c0: sigG2.x.c0.value.toString(16), c1: sigG2.x.c1.value.toString(16) },
      signatureY: { c0: sigG2.y.c0.value.toString(16), c1: sigG2.y.c1.value.toString(16) },

      messageHex,
    });
  });
});
