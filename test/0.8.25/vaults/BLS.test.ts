import { expect } from "chai";

import { PointG1, PointG2, sign, verify } from "@noble/bls12-381";

import { ether } from "lib";

import { computeDepositMessageRoot } from "./ssz-utils";

const BLS_TEST_KEY = "18f020b98eb798752a50ed0563b079c125b0db5dd0b1060d1c1b47d4a193e1e4";

const STATIC_DEPOSIT = {
  amount: ether("1"),
  withdrawalCredentials: "0xf3d93f9fbc6a229f3b11340b4b52ae53833813efab76e812d1d014163259ef1f",
};

describe("BLS.sol", () => {
  it("can create a deposit from test key", async () => {
    const pubkeyG1 = PointG1.fromPrivateKey(BLS_TEST_KEY);
    const pubkeyShort = pubkeyG1.toHex(true);
    const withdrawalCredentials = STATIC_DEPOSIT.withdrawalCredentials;
    const amount = STATIC_DEPOSIT.amount;

    const messageRoot = await computeDepositMessageRoot(pubkeyShort, withdrawalCredentials, amount);
    const messageHex = Buffer.from(messageRoot).toString("hex");

    const sig = await sign(messageRoot, BLS_TEST_KEY);
    const sigG2 = PointG2.fromSignature(sig);
    const sigShort = sigG2.toHex(true);

    const result = await verify(sigShort, messageHex, pubkeyG1);
    expect(result).to.be.true;

    console.log({
      pubkey: pubkeyShort,
      withdrawalCredentials: withdrawalCredentials,
      amount: amount.toString(),
      signature: sigShort,
      pubkeyY: pubkeyG1.toAffine()[1].value.toString(16),
      signatureY: { c0: sigG2.toAffine()[1].c0.value.toString(16), c1: sigG2.toAffine()[1].c1.value.toString(16) },
      messageHex,
    });
  });
});
