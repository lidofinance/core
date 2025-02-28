import { expect } from "chai";

import { SecretKey, verify } from "@chainsafe/blst";

import { ether } from "lib";

import { computeDepositMessageRoot, extractYCoordinates, verifyDepositMessage } from "./bls-utils";

// test deposit data
const STATIC_DEPOSIT = {
  amount: ether("1"),
  testPrivateKey: "0x18f020b98eb798752a50ed0563b079c125b0db5dd0b1060d1c1b47d4a193e1e4",
  withdrawalCredentials: "0xf3d93f9fbc6a229f3b11340b4b52ae53833813efab76e812d1d014163259ef1f",
};

// actual deposit from mainnet validator
const MAINNET_DEPOSIT_MESSAGE = {
  pubkey: "0x88841E426F271030AD2257537F4EABD216B891DA850C1E0E2B92EE0D6E2052B1DAC5F2D87BEF51B8AC19D425ED024DD1",
  withdrawalCredentials: "0x004AAD923FC63B40BE3DDE294BDD1BBB064E34A4A4D51B68843FEA44532D6147",
  amount: ether("32"),
  signature:
    "0x99A9E9ABD7D4A4DE2D33B9C3253FF8440AD237378CE37250D96D5833FE84BA87BBF288BF3825763C04C3B8CDBA323A3B02D542CDF5940881F55E5773766B1B185D9CA7B6E239BDD3FB748F36C0F96F6A00D2E1D314760011F2F17988E248541D",
};

describe("BLS.sol", () => {
  it("can create a deposit from test key", async () => {
    // deposit message
    const privateKey = SecretKey.fromHex(STATIC_DEPOSIT.testPrivateKey);
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

    // Mock data for forge test
    const depositTestObject = {
      withdrawalCredentials: withdrawalCredentials,
      messageHex,
      ...extractYCoordinates(pubkeyCompressed, signatureCompressed),
    };

    //console.log(depositTestObject);

    expect(depositTestObject).to.not.be.undefined;
  });

  it("can create full signature from existing validator deposit message", async () => {
    expect(
      await verifyDepositMessage(
        MAINNET_DEPOSIT_MESSAGE.pubkey,
        MAINNET_DEPOSIT_MESSAGE.withdrawalCredentials,
        MAINNET_DEPOSIT_MESSAGE.amount,
        MAINNET_DEPOSIT_MESSAGE.signature,
      ),
    ).to.be.true;

    // Mainnet data for forge test
    const depositTestObject = {
      withdrawalCredentials: MAINNET_DEPOSIT_MESSAGE.withdrawalCredentials,
      ...extractYCoordinates(MAINNET_DEPOSIT_MESSAGE.pubkey, MAINNET_DEPOSIT_MESSAGE.signature),
    };

    //console.log(depositTestObject);

    expect(depositTestObject).to.not.be.undefined;
  });
});
