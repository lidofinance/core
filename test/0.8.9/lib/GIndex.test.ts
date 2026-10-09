import { expect } from "chai";
import { randomBytes } from "ethers";
import { ethers } from "hardhat";

import { GIndex__Harness, GIndexLibrary__Harness } from "typechain-types";

import {
  concatGIndices,
  progressiveListNodeGIndexReference,
  staticListNodeGIndexReference,
  vectorNodeGIndexReference,
} from "test/common/lib/clGIndices";
import { Snapshot } from "test/suite";

const LARGEST_PROGRESSIVE_LIST_INDEX = ((4n ** 84n - 1n) * 4n) / 3n;

const randomBigInt = (bytes: number): bigint => BigInt(ethers.hexlify(randomBytes(bytes)));

describe("GIndex", () => {
  let originalState: string;

  let gIndex: GIndex__Harness;
  let library: GIndexLibrary__Harness;

  const ZERO = 0n;
  const ROOT = 1n;
  const MAX = ethers.MaxUint256;

  before(async () => {
    gIndex = await ethers.deployContract("GIndex__Harness");
    library = await ethers.deployContract("GIndexLibrary__Harness");
  });

  beforeEach(async () => (originalState = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(originalState));

  it("test_wrap_unwrap", async () => {
    expect(await gIndex.unwrap(await gIndex.wrap(42n))).to.equal(42n);
    expect(await gIndex.unwrap(await gIndex.toGIndex(42n))).to.equal(42n);
    expect(await gIndex.unwrap(MAX)).to.equal(MAX);
  });

  it("test_isRootTrue", async () => {
    expect(await gIndex.isRoot(ROOT)).to.be.true;
  });

  it("test_isRootFalse", async () => {
    expect(await gIndex.isRoot(0n)).to.be.false;
    expect(await gIndex.isRoot(2n)).to.be.false;
    expect(await gIndex.isRoot(42n)).to.be.false;
    expect(await gIndex.isRoot(2048n)).to.be.false;
    expect(await gIndex.isRoot(MAX)).to.be.false;
  });

  it("test_concat", async () => {
    expect(await gIndex.concat(2n, 3n)).to.equal(5n);
    expect(await gIndex.concat(31n, 3n)).to.equal(63n);
    expect(await gIndex.concat(31n, 6n)).to.equal(126n);
    expect(await gIndex.concat(await gIndex.concat(await gIndex.concat(ROOT, 2n), 5n), 9n)).to.equal(73n);

    expect(await gIndex.concat(ROOT, MAX)).to.equal(MAX);
    expect(await gIndex.concat(MAX, ROOT)).to.equal(MAX);
  });

  it("test_concat_RevertsIfZeroGIndex", async () => {
    await expect(library.concat(ZERO, 1024n)).to.be.revertedWithCustomError(library, "IndexOutOfRange");
    await expect(library.concat(1024n, ZERO)).to.be.revertedWithCustomError(library, "IndexOutOfRange");
  });

  it("test_concat_BigIndicesBorderCases", async () => {
    await expect(library.concat(2n ** 9n, 2n ** 246n)).to.not.be.reverted;
    await expect(library.concat(2n ** 55n, 2n ** 200n)).to.not.be.reverted;
    await expect(library.concat(2n ** 199n, 2n ** 56n)).to.not.be.reverted;
  });

  it("test_concat_RevertsIfTooBigIndices", async () => {
    await expect(library.concat(MAX, MAX)).to.be.revertedWithCustomError(library, "IndexOutOfRange");
    await expect(library.concat(2n ** 56n, 2n ** 200n)).to.be.revertedWithCustomError(library, "IndexOutOfRange");
    await expect(library.concat(2n ** 200n, 2n ** 56n)).to.be.revertedWithCustomError(library, "IndexOutOfRange");
  });

  it("testFuzz_concat_WithRoot", async () => {
    for (let i = 0; i < 10; i++) {
      const randomGIndex = randomBigInt(32) || 1n;

      expect(await gIndex.concat(ROOT, randomGIndex)).to.equal(
        randomGIndex,
        "`concat` with a root should return right-hand side value",
      );
    }
  });

  it("testFuzz_concat", async () => {
    for (let i = 0; i < 10; i++) {
      const lhs = (randomBigInt(16) || 1n) | 1n;
      const rhs = (randomBigInt(15) || 1n) | 1n;

      expect(await gIndex.concat(lhs, rhs)).to.equal(concatGIndices(lhs, rhs));
    }
  });

  it("test_fls", async () => {
    for (let i = 1; i < 255; i++) {
      expect(await gIndex.fls((1n << BigInt(i)) - 1n)).to.equal(BigInt(i - 1));
      expect(await gIndex.fls(1n << BigInt(i))).to.equal(BigInt(i));
      expect(await gIndex.fls((1n << BigInt(i)) + 1n)).to.equal(BigInt(i));
    }

    expect(await gIndex.fls(3n)).to.equal(1n); // 0011
    expect(await gIndex.fls(7n)).to.equal(2n); // 0111
    expect(await gIndex.fls(10n)).to.equal(3n); // 1010
    expect(await gIndex.fls(300n)).to.equal(8n); // 0001 0010 1100
    expect(await gIndex.fls(0n)).to.equal(256n);
  });

  it("test_ceilLog2", async () => {
    expect(await gIndex.ceilLog2(0n)).to.equal(0n);
    expect(await gIndex.ceilLog2(1n)).to.equal(0n);
    expect(await gIndex.ceilLog2(2n)).to.equal(1n);
    expect(await gIndex.ceilLog2(3n)).to.equal(2n);
    expect(await gIndex.ceilLog2(8191n)).to.equal(13n);
    expect(await gIndex.ceilLog2(8192n)).to.equal(13n);
    expect(await gIndex.ceilLog2(8193n)).to.equal(14n);
    expect(await gIndex.ceilLog2(MAX)).to.equal(256n);
  });

  it("test_staticListNode", async () => {
    expect(await gIndex.staticListNode(0n, 40n)).to.equal(0x020000000000n);
    expect(await gIndex.staticListNode(12345678n, 40n)).to.equal(0x020000bc614en);
    expect(await gIndex.staticListNode((1n << 40n) - 1n, 40n)).to.equal(0x02ffffffffffn);

    await expect(library.staticListNode(0n, 255n)).to.be.revertedWithCustomError(library, "IndexOutOfRange");
    await expect(library.staticListNode(1n << 40n, 40n)).to.be.revertedWithCustomError(library, "IndexOutOfRange");
  });

  it("testFuzz_staticListNode", async () => {
    for (let run = 0; run < 20; run++) {
      const depth = randomBigInt(1) % 255n;
      const i = randomBigInt(32) % (1n << depth);

      expect(await gIndex.staticListNode(i, depth)).to.equal(staticListNodeGIndexReference(i, depth));
    }
  });

  it("test_vectorNode", async () => {
    expect(await gIndex.vectorNode(0n, 6n)).to.equal(8n);
    expect(await gIndex.vectorNode(5n, 6n)).to.equal(13n);
    expect(await gIndex.vectorNode(0n, 8192n)).to.equal(8192n);
    expect(await gIndex.vectorNode(8191n, 8192n)).to.equal(16383n);

    await expect(library.vectorNode(0n, 0n)).to.be.revertedWithCustomError(library, "IndexOutOfRange");
    await expect(library.vectorNode(6n, 6n)).to.be.revertedWithCustomError(library, "IndexOutOfRange");
    await expect(library.vectorNode(0n, (1n << 255n) + 1n)).to.be.revertedWithCustomError(library, "IndexOutOfRange");
  });

  it("testFuzz_vectorNode", async () => {
    for (let run = 0; run < 20; run++) {
      const length = (randomBigInt(31) || 1n) + 1n;
      const i = randomBigInt(32) % length;

      expect(await gIndex.vectorNode(i, length)).to.equal(vectorNodeGIndexReference(i, length));
    }
  });

  it("test_progressiveListNode", async () => {
    expect(await gIndex.progressiveListNode(0)).to.equal(0x4n);
    expect(await gIndex.progressiveListNode(1)).to.equal(0x28n);
    expect(await gIndex.progressiveListNode(12345678)).to.equal(0x5ffe670bf9n);
    expect(await gIndex.progressiveListNode(LARGEST_PROGRESSIVE_LIST_INDEX)).to.equal(
      0x5ffffffffffffffffffffeffffffffffffffffffffffffffffffffffffffffffn,
    );

    await expect(library.progressiveListNode(LARGEST_PROGRESSIVE_LIST_INDEX + 1n)).to.be.revertedWithCustomError(
      library,
      "IndexOutOfRange",
    );
    await expect(library.progressiveListNode(ethers.MaxUint256 / 3n)).to.be.revertedWithCustomError(
      library,
      "IndexOutOfRange",
    );
    await expect(library.progressiveListNode(ethers.MaxUint256)).to.be.revertedWithCustomError(
      library,
      "IndexOutOfRange",
    );
  });

  it("testFuzz_progressiveListNode", async () => {
    for (let run = 0; run < 20; run++) {
      const i = randomBigInt(32) % (LARGEST_PROGRESSIVE_LIST_INDEX + 1n);

      expect(await gIndex.progressiveListNode(i)).to.equal(progressiveListNodeGIndexReference(i));
    }
  });
});
