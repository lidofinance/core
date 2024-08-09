import { expect } from "chai";
import { solidityPackedKeccak256 } from "ethers";
import { ethers } from "hardhat";

import { SigningKeys__Harness } from "typechain-types";

import { EMPTY_PUBLIC_KEY, EMPTY_SIGNATURE, FakeValidatorKeys } from "lib";

import { Snapshot } from "test/suite";

const NODE_OPERATOR_1 = 1;
const NODE_OPERATOR_2 = 2;

const UINT64_MAX = 2n ** 64n - 1n;

describe("SigningKeys.sol", () => {
  let signingKeys: SigningKeys__Harness;

  const firstNodeOperatorId = 0;
  const firstNodeOperatorStartIndex = 0;
  const firstNodeOperatorKeys = new FakeValidatorKeys(5, { kFill: "a", sFill: "b" });
  const firstNodeOperatorLastIndex = firstNodeOperatorKeys.count - 1;

  const secondNodeOperatorId = 1;
  const secondNodeOperatorStartIndex = 0;
  const secondNodeOperatorKeys = new FakeValidatorKeys(7, { kFill: "c", sFill: "d" });

  let originalState: string;

  before(async () => {
    signingKeys = await ethers.deployContract("SigningKeys__Harness", [[NODE_OPERATOR_1, NODE_OPERATOR_2]]);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("getKeyOffset", () => {
    it("Returns the correct offset", async () => {
      const offset = await signingKeys.getKeyOffset(NODE_OPERATOR_1, 0);

      const position = await signingKeys.KEYSSIGS_POSITION();
      // keccak256(abi.encodePacked(KEYSSIGS_POSITION, NODE_OPERATOR_1, 0))
      const packedData = solidityPackedKeccak256(["bytes32", "uint256", "uint256"], [position, NODE_OPERATOR_1, 0]);

      expect(offset).to.equal(packedData);
    });

    it("Returns the correct offset for the second node operator", async () => {
      const offset = await signingKeys.getKeyOffset(NODE_OPERATOR_2, 0);

      const position = await signingKeys.KEYSSIGS_POSITION();
      // keccak256(abi.encodePacked(KEYSSIGS_POSITION, NODE_OPERATOR_2, 0))
      const packedData = solidityPackedKeccak256(["bytes32", "uint256", "uint256"], [position, NODE_OPERATOR_2, 0]);

      expect(offset).to.equal(packedData);
    });
  });

  context("saveKeysSigs", () => {
    context("Reverts", () => {
      it("if start index is UINT64_MAX", async () => {
        const keysCount = 1;
        const [publicKeys, signatures] = firstNodeOperatorKeys.slice(0, keysCount);

        await expect(
          signingKeys.saveKeysSigs(firstNodeOperatorId, UINT64_MAX, keysCount, publicKeys, signatures),
        ).to.be.revertedWith("INVALID_KEYS_COUNT");
      });

      it("if start index is > UINT64_MAX", async () => {
        const keysCount = 1;
        const [publicKeys, signatures] = firstNodeOperatorKeys.slice(0, keysCount);

        await expect(
          signingKeys.saveKeysSigs(firstNodeOperatorId, UINT64_MAX + 1n, keysCount, publicKeys, signatures),
        ).to.be.revertedWith("INVALID_KEYS_COUNT");
      });

      it("if keys count is 0", async () => {
        const keysCount = 1;
        const [publicKeys, signatures] = firstNodeOperatorKeys.slice(0, keysCount);

        await expect(signingKeys.saveKeysSigs(firstNodeOperatorId, 0, 0, publicKeys, signatures)).to.be.revertedWith(
          "INVALID_KEYS_COUNT",
        );
      });

      it("if public keys length is invalid", async () => {
        const keysCount = 2;
        const [publicKeys, signatures] = firstNodeOperatorKeys.slice(0, keysCount);

        await expect(
          signingKeys.saveKeysSigs(
            firstNodeOperatorId,
            firstNodeOperatorStartIndex,
            keysCount,
            publicKeys + "deadbeef",
            signatures,
          ),
        ).to.be.revertedWith("LENGTH_MISMATCH");
      });

      it("if signatures length is invalid", async () => {
        const keysCount = 2;
        const [publicKeys, signatures] = firstNodeOperatorKeys.slice(0, keysCount);

        await expect(
          signingKeys.saveKeysSigs(
            firstNodeOperatorId,
            firstNodeOperatorStartIndex,
            keysCount,
            publicKeys,
            signatures.slice(0, -2),
          ),
        ).to.be.revertedWith("LENGTH_MISMATCH");
      });

      it("if public keys and signatures length is unaligned", async () => {
        const keysCount = 2;
        const [publicKeys] = firstNodeOperatorKeys.slice(0, keysCount);
        const [, signatures] = firstNodeOperatorKeys.slice(0, keysCount + 1);

        await expect(
          signingKeys.saveKeysSigs(
            firstNodeOperatorId,
            firstNodeOperatorStartIndex,
            keysCount,
            publicKeys,
            signatures.slice(0, -2),
          ),
        ).to.be.revertedWith("LENGTH_MISMATCH");
      });

      it("if public key is zero bytes batch (at 1st position)", async () => {
        const keysCount = 1;
        const [, signature] = firstNodeOperatorKeys.get(0);

        await expect(
          signingKeys.saveKeysSigs(
            firstNodeOperatorId,
            firstNodeOperatorStartIndex,
            keysCount,
            EMPTY_PUBLIC_KEY,
            signature,
          ),
        ).to.be.revertedWith("EMPTY_KEY");
      });

      it("if public key is zero bytes batch (at last position)", async () => {
        const keysCount = 3;
        let [publicKeys] = firstNodeOperatorKeys.slice(0, keysCount - 1);
        const [, signatures] = firstNodeOperatorKeys.slice(0, keysCount);
        publicKeys += EMPTY_PUBLIC_KEY.substring(2);

        await expect(
          signingKeys.saveKeysSigs(firstNodeOperatorId, firstNodeOperatorStartIndex, keysCount, publicKeys, signatures),
        ).to.be.revertedWith("EMPTY_KEY");
      });
    });

    it("Saves the keys and signatures correctly", async () => {
      const [publicKeys1, signatures1] = firstNodeOperatorKeys.slice();
      const tx1 = await signingKeys.saveKeysSigs(
        firstNodeOperatorId,
        firstNodeOperatorStartIndex,
        firstNodeOperatorKeys.count,
        publicKeys1,
        signatures1,
      );

      for (let i = 0; i < firstNodeOperatorKeys.count; ++i) {
        await expect(tx1)
          .to.emit(signingKeys, "SigningKeyAdded")
          .withArgs(firstNodeOperatorId, firstNodeOperatorKeys.get(i)[0]);
      }

      const [publicKeys2, signatures2] = secondNodeOperatorKeys.slice();
      const tx2 = await signingKeys.saveKeysSigs(
        secondNodeOperatorId,
        secondNodeOperatorStartIndex,
        secondNodeOperatorKeys.count,
        publicKeys2,
        signatures2,
      );

      for (let i = 0; i < secondNodeOperatorKeys.count; ++i) {
        await expect(tx2)
          .to.emit(signingKeys, "SigningKeyAdded")
          .withArgs(secondNodeOperatorId, secondNodeOperatorKeys.get(i)[0]);
      }
    });

    it("Saves the keys and signatures for last slot", async () => {
      const keysCount = 1;
      const startIndex = UINT64_MAX - 1n;
      const [publicKeys, signatures] = firstNodeOperatorKeys.slice(0, keysCount);

      await signingKeys.saveKeysSigs(firstNodeOperatorId, startIndex, keysCount, publicKeys, signatures);

      const { pubkeys: actualPublicKey, signatures: actualSignature } = await signingKeys.loadKeysSigs(
        firstNodeOperatorId,
        startIndex,
        1,
      );
      const [expectedPublicKey, expectedSignature] = firstNodeOperatorKeys.get(0);

      expect(actualPublicKey).to.equal(expectedPublicKey);
      expect(actualSignature).to.equal(expectedSignature);
    });
  });

  context("removeKeysSigs", () => {
    beforeEach(async () => {
      const [publicKeys1, signatures1] = firstNodeOperatorKeys.slice();
      await signingKeys.saveKeysSigs(
        firstNodeOperatorId,
        firstNodeOperatorStartIndex,
        firstNodeOperatorKeys.count,
        publicKeys1,
        signatures1,
      );

      const [publicKeys2, signatures2] = secondNodeOperatorKeys.slice();
      await signingKeys.saveKeysSigs(
        secondNodeOperatorId,
        secondNodeOperatorStartIndex,
        secondNodeOperatorKeys.count,
        publicKeys2,
        signatures2,
      );
    });

    context("Reverts", () => {
      it("if keys count is 0", async () => {
        await expect(
          signingKeys.removeKeysSigs(firstNodeOperatorId, firstNodeOperatorStartIndex, 0, firstNodeOperatorLastIndex),
        ).to.be.revertedWith("INVALID_KEYS_COUNT");
      });

      it("if index is greater than last keys index", async () => {
        await expect(
          signingKeys.removeKeysSigs(
            firstNodeOperatorId,
            firstNodeOperatorLastIndex + 1,
            1,
            firstNodeOperatorLastIndex,
          ),
        ).to.be.revertedWith("INVALID_KEYS_COUNT");
      });

      it("if keys count is greater than last keys index", async () => {
        await expect(
          signingKeys.removeKeysSigs(
            firstNodeOperatorId,
            firstNodeOperatorStartIndex,
            firstNodeOperatorKeys.count + 1,
            firstNodeOperatorLastIndex,
          ),
        ).to.be.revertedWith("INVALID_KEYS_COUNT");
      });
    });

    it("Removes the keys and signatures correctly (clear storage)", async () => {
      const tx = await signingKeys.removeKeysSigs(
        firstNodeOperatorId,
        firstNodeOperatorStartIndex,
        firstNodeOperatorKeys.count,
        firstNodeOperatorKeys.count,
      );

      for (let i = firstNodeOperatorStartIndex; i < firstNodeOperatorKeys.count; ++i) {
        const { pubkeys, signatures } = await signingKeys.loadKeysSigs(firstNodeOperatorId, i, 1);

        expect(pubkeys).to.equal(EMPTY_PUBLIC_KEY);
        expect(signatures).to.equal(EMPTY_SIGNATURE);

        await expect(tx)
          .to.emit(signingKeys, "SigningKeyRemoved")
          .withArgs(firstNodeOperatorId, firstNodeOperatorKeys.get(i)[0]);
      }
    });

    it("Removes the keys and signatures correctly (move last to deleted position)", async () => {
      const keyIndex = 0;
      await signingKeys.removeKeysSigs(firstNodeOperatorId, keyIndex, 1, firstNodeOperatorKeys.count);

      const { pubkeys, signatures } = await signingKeys.loadKeysSigs(firstNodeOperatorId, keyIndex, 1);
      const [expectedPublicKey, expectedSignature] = firstNodeOperatorKeys.get(firstNodeOperatorLastIndex);

      expect(pubkeys).to.equal(expectedPublicKey);
      expect(signatures).to.equal(expectedSignature);
    });
  });

  // @note This also tests the `initKeysSigsBuf` function, because they are related
  context("loadKeysSigs", () => {
    it("Loads the keys and signatures correctly", async () => {
      const [publicKeys, keySignatures] = firstNodeOperatorKeys.slice();
      await signingKeys.saveKeysSigs(
        firstNodeOperatorId,
        firstNodeOperatorStartIndex,
        firstNodeOperatorKeys.count,
        publicKeys,
        keySignatures,
      );

      for (let i = 0; i < firstNodeOperatorKeys.count; ++i) {
        const { pubkeys, signatures } = await signingKeys.loadKeysSigs(firstNodeOperatorId, i, 1);
        const [expectedPublicKey, expectedSignature] = firstNodeOperatorKeys.get(i);

        expect(pubkeys).to.equal(expectedPublicKey);
        expect(signatures).to.equal(expectedSignature);
      }

      const [publicKeys2, signatures2] = secondNodeOperatorKeys.slice();
      await signingKeys.saveKeysSigs(
        secondNodeOperatorId,
        secondNodeOperatorStartIndex,
        secondNodeOperatorKeys.count,
        publicKeys2,
        signatures2,
      );

      for (let i = 0; i < secondNodeOperatorKeys.count; ++i) {
        const { pubkeys, signatures } = await signingKeys.loadKeysSigs(secondNodeOperatorId, i, 1);
        const [expectedPublicKey, expectedSignature] = secondNodeOperatorKeys.get(i);

        expect(pubkeys).to.equal(expectedPublicKey);
        expect(signatures).to.equal(expectedSignature);
      }
    });
  });
});
