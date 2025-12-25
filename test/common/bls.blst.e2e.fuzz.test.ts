import { expect } from "chai";
import { getBytes, hexlify, keccak256, toBeHex, zeroPadValue } from "ethers";
import { ethers } from "hardhat";

import { PublicKey, SecretKey, Signature, verify } from "@chainsafe/blst";

import { BLS12_381__Harness } from "typechain-types";

import { computeDepositDomain, computeDepositMessageRoot, ONE_GWEI } from "lib";

type FpStruct = { a: string; b: string };
type Fp2Struct = { c0_a: string; c0_b: string; c1_a: string; c1_b: string };
type DepositYStruct = { pubkeyY: FpStruct; signatureY: Fp2Struct };

function fpFrom48(y48: Uint8Array): FpStruct {
  if (y48.length !== 48) throw new Error(`invariant: expected 48 bytes, got ${y48.length}`);
  const a16 = y48.slice(0, 16);
  const b32 = y48.slice(16, 48);
  return {
    a: zeroPadValue(hexlify(a16), 32),
    b: zeroPadValue(hexlify(b32), 32),
  };
}

function signatureFp2From96(y96: Uint8Array): Fp2Struct {
  if (y96.length !== 96) throw new Error(`invariant: expected 96 bytes, got ${y96.length}`);

  // IMPORTANT: The byte layout used by `@chainsafe/blst` is `c1 || c0` for an Fp2 element.
  // Our Solidity struct is `Fp2 { c0, c1 }`, so we swap halves.
  const c1 = y96.slice(0, 48);
  const c0 = y96.slice(48, 96);
  const c0Fp = fpFrom48(c0);
  const c1Fp = fpFrom48(c1);
  return {
    c0_a: c0Fp.a,
    c0_b: c0Fp.b,
    c1_a: c1Fp.a,
    c1_b: c1Fp.b,
  };
}

function buildDepositY(pubkey: PublicKey, signature: Signature): DepositYStruct {
  // G1 uncompressed = 96 bytes (x||y), each 48 bytes.
  const pubkeyUncompressed = pubkey.toBytes(false);
  const pubkeyY = pubkeyUncompressed.slice(48);

  // G2 uncompressed = 192 bytes (x||y), each 96 bytes.
  const signatureUncompressed = signature.toBytes(false);
  const signatureY = signatureUncompressed.slice(96);

  return {
    pubkeyY: fpFrom48(pubkeyY),
    signatureY: signatureFp2From96(signatureY),
  };
}

function flipFirstByte(hex: string, mask: number): string {
  const b = getBytes(hex);
  b[0] ^= mask;
  return hexlify(b);
}

function flipByte(hex: string, index: number, mask: number): string {
  const b = getBytes(hex);
  b[index] ^= mask;
  return hexlify(b);
}

function truncateHex(hex: string, newLenBytes: number): string {
  const b = getBytes(hex);
  return hexlify(b.slice(0, newLenBytes));
}

function extendHexWithZeros(hex: string, newLenBytes: number): string {
  const b = getBytes(hex);
  if (b.length >= newLenBytes) throw new Error("invariant: use truncateHex for shrinking");
  const out = new Uint8Array(newLenBytes);
  out.set(b);
  return hexlify(out);
}

function blstVerifyDeposit(messageRoot: Uint8Array, pubkey: string, signature: string): boolean {
  try {
    return verify(messageRoot, PublicKey.fromHex(pubkey, false), Signature.fromHex(signature, false), true, true);
  } catch {
    return false;
  }
}

// BLS12-381 base field modulus p (from EIP-2537).
const FP_MODULUS = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaabn;
const FP_MODULUS_HALF = FP_MODULUS / 2n;

function fp48FromFpStruct(fp: FpStruct): Uint8Array {
  const a = getBytes(fp.a);
  const b = getBytes(fp.b);
  if (a.length !== 32 || b.length !== 32) throw new Error("invariant: fp struct must be 32+32 bytes");
  const out = new Uint8Array(48);
  out.set(a.slice(16), 0);
  out.set(b, 16);
  return out;
}

function signBitFromFpStruct(fp: FpStruct): boolean {
  const y = BigInt(hexlify(fp48FromFpStruct(fp)));
  return y > FP_MODULUS_HALF;
}

function isZeroFpStruct(fp: FpStruct): boolean {
  return BigInt(fp.a) === 0n && BigInt(fp.b) === 0n;
}

function negateFpStruct(fp: FpStruct): FpStruct {
  const y = BigInt(hexlify(fp48FromFpStruct(fp)));
  const neg = (FP_MODULUS - y) % FP_MODULUS;
  const y48 = getBytes(`0x${neg.toString(16).padStart(96, "0")}`);
  return fpFrom48(y48);
}

function negateFp2Struct(fp2: Fp2Struct): Fp2Struct {
  const c0 = negateFpStruct({ a: fp2.c0_a, b: fp2.c0_b });
  const c1 = negateFpStruct({ a: fp2.c1_a, b: fp2.c1_b });
  return { c0_a: c0.a, c0_b: c0.b, c1_a: c1.a, c1_b: c1.b };
}

function signatureSignBitFromFp2Struct(fp2: Fp2Struct): boolean {
  const c1 = { a: fp2.c1_a, b: fp2.c1_b };
  const chosen = isZeroFpStruct(c1) ? ({ a: fp2.c0_a, b: fp2.c0_b } satisfies FpStruct) : c1;
  return signBitFromFpStruct(chosen);
}

async function computeSigningRootOrNull(
  pubkey: string,
  withdrawalCredentials: string,
  amount: bigint,
  depositDomain: string,
): Promise<Uint8Array | null> {
  try {
    return await computeDepositMessageRoot(pubkey, withdrawalCredentials, amount, depositDomain);
  } catch {
    return null;
  }
}

function tryBuildDepositY(pubkeyHex: string, signatureHex: string): DepositYStruct | null {
  try {
    const pk = PublicKey.fromHex(pubkeyHex, false);
    const sig = Signature.fromHex(signatureHex, false);
    return buildDepositY(pk, sig);
  } catch {
    return null;
  }
}

describe("BLS.sol <-> @chainsafe/blst E2E fuzz", function () {
  // Pairing precompile calls are expensive; keep default runs moderate and allow overriding via env.
  this.timeout(180_000);

  const RUNS = Number(process.env.BLS_BLST_FUZZ_RUNS ?? 50);
  const NEG_RUNS = Number(process.env.BLS_BLST_FUZZ_NEG_RUNS ?? 25);
  const MUT_RUNS = Number(process.env.BLS_BLST_MUTATION_RUNS ?? 10);
  const MUTATIONS_PER_RUN = Number(process.env.BLS_BLST_MUTATIONS_PER_RUN ?? 20);

  // Deterministic master key for reproducible failures.
  // blst expects a 32-byte IKM for EIP-2333.
  const IKM_SEED = process.env.BLS_BLST_FUZZ_SEED ?? "lido-bls-e2e-fuzz";
  const master = SecretKey.deriveMasterEip2333(getBytes(keccak256(Buffer.from(IKM_SEED, "utf-8"))));

  // Runtime seed for generating different starting indices on each run.
  // This ensures different keys are tested each run while maintaining reproducibility via logged seed.
  const RUNTIME_SEED = process.env.BLS_BLST_RUNTIME_SEED ?? Date.now().toString();

  // Compute a deterministic starting index for a given test name.
  // This gives each test a unique, reproducible key range that varies across runs.
  function computeStartingIndex(testName: string): number {
    const hash = keccak256(Buffer.from(RUNTIME_SEED + testName, "utf-8"));
    // Use modulo to get a reasonable starting index (max ~1 billion to avoid overflow)
    return Number(BigInt(hash.slice(0, 18)) % 1_000_000_000n);
  }

  let harness: BLS12_381__Harness;

  before(async () => {
    // Log runtime seed for reproducibility. To reproduce a specific run, set BLS_BLST_RUNTIME_SEED env var.
    console.log(`    BLS fuzz runtime seed: ${RUNTIME_SEED} (set BLS_BLST_RUNTIME_SEED to reproduce)`);
    harness = (await ethers.deployContract("BLS12_381__Harness")) as unknown as BLS12_381__Harness;
  });

  it("matches consensus spec roots and accepts exactly the signatures that blst accepts (valid deposits)", async () => {
    const testName = "valid-deposits";
    const startingIndex = computeStartingIndex(testName);
    console.log(`      [${testName}] starting key index: ${startingIndex}`);

    for (let i = 0; i < RUNS; i++) {
      // Deterministic forkVersion and withdrawal credentials from i.
      const salt = keccak256(toBeHex(startingIndex + i, 32));
      const forkVersion = `0x${salt.slice(2, 10)}`; // bytes4
      const withdrawalCredentials = keccak256(`0x${salt.slice(2, 2 + 64)}`); // bytes32

      // Amount in wei, must be a multiple of 1 gwei.
      const gweiAmount = 1_000_000_000n + (BigInt(i) % (32_000_000_000n - 1_000_000_000n + 1n)); // [1 ETH..32 ETH] in gwei
      const amount = gweiAmount * ONE_GWEI;

      const depositDomainBytes = await computeDepositDomain(forkVersion);
      const depositDomain = hexlify(depositDomainBytes);

      // Cross-check deposit domain vs Solidity.
      expect(await harness.computeDepositDomain(forkVersion), `depositDomain mismatch (i=${i})`).to.equal(
        depositDomain,
      );

      const sk = master.deriveChildEip2333(startingIndex + i);
      const pk = sk.toPublicKey();

      const pubkey = pk.toHex(true); // 48 bytes (compressed)
      const signingRoot = await computeDepositMessageRoot(pubkey, withdrawalCredentials, amount, depositDomain);
      const signingRootHex = hexlify(signingRoot);

      // Cross-check signing root vs Solidity.
      expect(
        await harness.depositMessageSigningRoot(pubkey, amount, withdrawalCredentials, depositDomain),
        `depositMessageSigningRoot mismatch (i=${i})`,
      ).to.equal(signingRootHex);

      const sig = sk.sign(signingRoot);
      const signature = sig.toHex(true); // 96 bytes (compressed)

      const depositY = buildDepositY(pk, sig);

      // CL oracle: signature must verify.
      expect(blstVerifyDeposit(signingRoot, pubkey, signature), `blst rejected a valid vector (i=${i})`).to.equal(true);

      // Solidity must accept.
      await expect(
        harness.verifyDepositMessage(pubkey, signature, amount, depositY, withdrawalCredentials, depositDomain),
        `solidity rejected a valid vector (i=${i})`,
      ).not.to.be.reverted;
    }
  });

  it("rejects CL-invalid encodings (service-bit flips + length mismatches) using blst as oracle", async () => {
    const testName = "cl-invalid-encodings";
    const startingIndex = computeStartingIndex(testName);
    console.log(`      [${testName}] starting key index: ${startingIndex}`);

    for (let i = 0; i < NEG_RUNS; i++) {
      const salt = keccak256(toBeHex(startingIndex + i, 32));
      const forkVersion = `0x${salt.slice(2, 10)}`; // bytes4
      const withdrawalCredentials = keccak256(`0x${salt.slice(2, 2 + 64)}`); // bytes32
      const amount = (1_000_000_000n + BigInt(i)) * ONE_GWEI; // >= 1 ETH
      const depositDomain = hexlify(await computeDepositDomain(forkVersion));

      const sk = master.deriveChildEip2333(startingIndex + i);
      const pk = sk.toPublicKey();
      const pubkey = pk.toHex(true);
      const signingRoot = await computeDepositMessageRoot(pubkey, withdrawalCredentials, amount, depositDomain);
      const sig = sk.sign(signingRoot);
      const signature = sig.toHex(true);
      const depositY = buildDepositY(pk, sig);

      // Sanity: valid case must be accepted by both.
      expect(blstVerifyDeposit(signingRoot, pubkey, signature), `invariant: blst valid failed (i=${i})`).to.equal(true);
      await expect(
        harness.verifyDepositMessage(pubkey, signature, amount, depositY, withdrawalCredentials, depositDomain),
      ).not.to.be.reverted;

      const cases: Array<{
        name: string;
        mutate: () => {
          pubkey?: string;
          signature?: string;
          amount?: bigint;
          withdrawalCredentials?: string;
          depositDomain?: string;
        };
        expectError?: { name: string; args?: unknown[] };
      }> = [
        {
          name: "pubkey: flip compression flag",
          mutate: () => ({ pubkey: flipFirstByte(pubkey, 0x80) }),
          expectError: { name: "InvalidCompressedComponent", args: [0] },
        },
        {
          name: "pubkey: flip infinity flag",
          mutate: () => ({ pubkey: flipFirstByte(pubkey, 0x40) }),
          expectError: { name: "InvalidCompressedComponent", args: [0] },
        },
        {
          name: "pubkey: flip sign bit",
          mutate: () => ({ pubkey: flipFirstByte(pubkey, 0x20) }),
          expectError: { name: "InvalidCompressedComponentSignBit", args: [0] },
        },
        {
          name: "signature: flip compression flag",
          mutate: () => ({ signature: flipFirstByte(signature, 0x80) }),
          expectError: { name: "InvalidCompressedComponent", args: [1] },
        },
        {
          name: "signature: flip infinity flag",
          mutate: () => ({ signature: flipFirstByte(signature, 0x40) }),
          expectError: { name: "InvalidCompressedComponent", args: [1] },
        },
        {
          name: "signature: flip sign bit",
          mutate: () => ({ signature: flipFirstByte(signature, 0x20) }),
          expectError: { name: "InvalidCompressedComponentSignBit", args: [1] },
        },
        {
          name: "pubkey: flip a non-header bit (forces point validation / pairing failure)",
          mutate: () => ({ pubkey: flipByte(pubkey, 1, 0x01) }),
        },
        {
          name: "signature: flip a non-header bit (forces point validation / pairing failure)",
          mutate: () => ({ signature: flipByte(signature, 1, 0x01) }),
        },
        {
          name: "pubkey: invalid length (short)",
          mutate: () => ({ pubkey: truncateHex(pubkey, 47) }),
          expectError: { name: "InvalidPubkeyLength" },
        },
        {
          name: "pubkey: invalid length (long)",
          mutate: () => ({ pubkey: extendHexWithZeros(pubkey, 49) }),
          expectError: { name: "InvalidPubkeyLength" },
        },
        {
          name: "signature: invalid length (short)",
          mutate: () => ({ signature: truncateHex(signature, 95) }),
          expectError: { name: "InvalidSignatureLength" },
        },
        {
          name: "signature: invalid length (long)",
          mutate: () => ({ signature: extendHexWithZeros(signature, 97) }),
          expectError: { name: "InvalidSignatureLength" },
        },
        {
          name: "message: wrong depositDomain (flip 1 bit)",
          mutate: () => ({ depositDomain: flipFirstByte(depositDomain, 0x01) }),
          expectError: { name: "InvalidSignature" },
        },
        {
          name: "message: wrong withdrawalCredentials (flip 1 bit)",
          mutate: () => ({ withdrawalCredentials: flipFirstByte(withdrawalCredentials, 0x01) }),
          expectError: { name: "InvalidSignature" },
        },
        {
          name: "message: wrong amount (+1 gwei)",
          mutate: () => ({ amount: amount + ONE_GWEI }),
          expectError: { name: "InvalidSignature" },
        },
      ];

      for (const c of cases) {
        const patch = c.mutate();
        const mutatedPubkey = patch.pubkey ?? pubkey;
        const mutatedSignature = patch.signature ?? signature;
        const mutatedAmount = patch.amount ?? amount;
        const mutatedWithdrawalCredentials = patch.withdrawalCredentials ?? withdrawalCredentials;
        const mutatedDepositDomain = patch.depositDomain ?? depositDomain;

        const mutatedRoot = await computeSigningRootOrNull(
          mutatedPubkey,
          mutatedWithdrawalCredentials,
          mutatedAmount,
          mutatedDepositDomain,
        );
        const blstOk = mutatedRoot ? blstVerifyDeposit(mutatedRoot, mutatedPubkey, mutatedSignature) : false;
        expect(blstOk, `invariant: blst unexpectedly accepted case "${c.name}" (i=${i})`).to.equal(false);

        const tx = harness.verifyDepositMessage(
          mutatedPubkey,
          mutatedSignature,
          mutatedAmount,
          depositY, // attacker-controlled; keep original Y to emulate "on-chain must not be weaker than CL"
          mutatedWithdrawalCredentials,
          mutatedDepositDomain,
        );

        if (c.expectError) {
          if (c.expectError.args) {
            await expect(tx, `case "${c.name}" (i=${i})`)
              .to.be.revertedWithCustomError(harness, c.expectError.name)
              .withArgs(...c.expectError.args);
          } else {
            await expect(tx, `case "${c.name}" (i=${i})`).to.be.revertedWithCustomError(harness, c.expectError.name);
          }
        } else {
          await expect(tx, `case "${c.name}" (i=${i})`).to.be.reverted;
        }
      }
    }
  });

  it("rejects mismatched DepositY even when blst accepts the compressed bytes", async () => {
    // This tests the on-chain invariant that the provided Y-coordinates must correspond
    // to the compressed sign bits (to avoid being weaker than CL verification).
    const testName = "mismatched-deposit-y";
    const startingIndex = computeStartingIndex(testName);
    console.log(`      [${testName}] starting key index: ${startingIndex}`);

    for (let i = 0; i < Math.min(NEG_RUNS, 25); i++) {
      const salt = keccak256(toBeHex(startingIndex + i, 32));
      const forkVersion = `0x${salt.slice(2, 10)}`; // bytes4
      const withdrawalCredentials = keccak256(`0x${salt.slice(2, 2 + 64)}`); // bytes32
      const amount = (1_000_000_000n + BigInt(i)) * ONE_GWEI;
      const depositDomain = hexlify(await computeDepositDomain(forkVersion));

      const sk = master.deriveChildEip2333(startingIndex + i);
      const pk = sk.toPublicKey();
      const pubkey = pk.toHex(true);
      const signingRoot = await computeDepositMessageRoot(pubkey, withdrawalCredentials, amount, depositDomain);
      const sig = sk.sign(signingRoot);
      const signature = sig.toHex(true);
      const depositY = buildDepositY(pk, sig);

      // CL oracle accepts the compressed bytes.
      expect(blstVerifyDeposit(signingRoot, pubkey, signature), `invariant: blst valid failed (i=${i})`).to.equal(true);

      // Sanity: Solidity accepts when DepositY matches.
      await expect(
        harness.verifyDepositMessage(pubkey, signature, amount, depositY, withdrawalCredentials, depositDomain),
      ).not.to.be.reverted;

      // Pubkey: flip Y to p - Y => must mismatch sign bit.
      const pubkeyYNeg = negateFpStruct(depositY.pubkeyY);
      if (signBitFromFpStruct(pubkeyYNeg) !== signBitFromFpStruct(depositY.pubkeyY)) {
        const badDepositY = { ...depositY, pubkeyY: pubkeyYNeg };
        await expect(
          harness.verifyDepositMessage(pubkey, signature, amount, badDepositY, withdrawalCredentials, depositDomain),
          `pubkeyY negation must be rejected (i=${i})`,
        )
          .to.be.revertedWithCustomError(harness, "InvalidCompressedComponentSignBit")
          .withArgs(0);
      }

      // Signature: flip Y to p - Y => must mismatch sign bit.
      const sigYNeg = negateFp2Struct(depositY.signatureY);
      if (signatureSignBitFromFp2Struct(sigYNeg) !== signatureSignBitFromFp2Struct(depositY.signatureY)) {
        const badDepositY = { ...depositY, signatureY: sigYNeg };
        await expect(
          harness.verifyDepositMessage(pubkey, signature, amount, badDepositY, withdrawalCredentials, depositDomain),
          `signatureY negation must be rejected (i=${i})`,
        )
          .to.be.revertedWithCustomError(harness, "InvalidCompressedComponentSignBit")
          .withArgs(1);
      }
    }
  });

  it("rejects on-curve but non-subgroup pubkeys (EIP-2537 subgroup checks) using blst as oracle", async () => {
    // This test is specifically about the EIP-2537 *input validation* behavior:
    // pairing precompile must reject points not in the correct subgroup.
    //
    // We deterministically search for a compressed G1 encoding that:
    // - deserializes to an on-curve point (PublicKey.fromHex(..., pkValidate=false) succeeds)
    // - fails subgroup validation (pk.keyValidate() throws)

    const testName = "non-subgroup-pubkeys";
    const startingIndex = computeStartingIndex(testName);
    console.log(`      [${testName}] starting key index: ${startingIndex}`);

    function candidatePubkey(i: number): string {
      const seed = keccak256(toBeHex(startingIndex + i, 32));
      const seed2 = keccak256(seed);
      const b = new Uint8Array(48);
      b.set(getBytes(seed), 0);
      // Only 16 bytes remain after offset 32.
      b.set(getBytes(seed2).slice(0, 16), 32);
      // Force service bits: compressed=1, infinity=0, keep sign bit as generated.
      b[0] = (b[0] & 0x3f) | 0x80;
      return hexlify(b);
    }

    let pubkey = "";
    let pk: PublicKey | null = null;
    for (let i = 0; i < 2048; i++) {
      const cand = candidatePubkey(i);
      try {
        const candPk = PublicKey.fromHex(cand, false);
        // We expect subgroup validation to fail for almost any on-curve point (G1 cofactor is huge).
        try {
          candPk.keyValidate();
          // Extremely unlikely: point in the correct subgroup; keep searching.
          continue;
        } catch {
          pubkey = cand;
          pk = candPk;
          break;
        }
      } catch {
        // Not on-curve / invalid encoding; keep searching.
      }
    }

    if (!pk) throw new Error("invariant: failed to find an on-curve non-subgroup pubkey");

    // Oracle: blst subgroup validation must reject this pubkey.
    expect(() => pk!.keyValidate()).to.throw();

    // Any valid signature point is fine here (we're not testing correctness of the BLS equation itself).
    const sigSk = master.deriveChildEip2333(startingIndex);
    const sig = sigSk.sign(getBytes(keccak256(Buffer.from("non-subgroup-test", "utf-8"))));
    const signature = sig.toHex(true);

    const depositY = buildDepositY(pk, sig);

    // Arbitrary message parameters; signature is not expected to match.
    const forkVersion = "0x00000000";
    const withdrawalCredentials = keccak256(toBeHex(424242, 32));
    const amount = 1_000_000_000n * ONE_GWEI; // 1 ETH in gwei, in wei.
    const depositDomain = hexlify(await computeDepositDomain(forkVersion));

    // On-chain must reject: pairing precompile should fail on subgroup checks => PairingFailed().
    // Note: PairingFailed is reverted from inline assembly in BLS.sol, so it may not be present
    // in the harness ABI; assert by checking the revert selector directly.
    const pairingFailedSelector = keccak256(Buffer.from("PairingFailed()", "utf-8")).slice(0, 10);
    try {
      await harness.verifyDepositMessage(pubkey, signature, amount, depositY, withdrawalCredentials, depositDomain);
      expect.fail("invariant: expected revert");
    } catch (e) {
      const err = e as { data?: string; error?: { data?: string } };
      const data = err.data ?? err.error?.data;
      expect(data, "missing revert data").to.be.a("string");
      expect(data!.slice(0, 10)).to.equal(pairingFailedSelector);
    }
  });

  it("rejects on-curve but non-subgroup signatures (EIP-2537 subgroup checks for G2)", async () => {
    // This test is specifically about the EIP-2537 *input validation* behavior for G2 points:
    // pairing precompile must reject G2 points not in the correct subgroup.
    //
    // We deterministically search for a compressed G2 encoding that:
    // - deserializes to an on-curve point (Signature.fromHex(..., sigValidate=false) succeeds)
    // - fails subgroup validation (sig.sigValidate() throws)

    const testName = "non-subgroup-signatures";
    const startingIndex = computeStartingIndex(testName);
    console.log(`      [${testName}] starting key index: ${startingIndex}`);

    function candidateSignature(i: number): string {
      const seed = keccak256(toBeHex(startingIndex + i, 32));
      const seed2 = keccak256(seed);
      const seed3 = keccak256(seed2);
      const b = new Uint8Array(96);
      b.set(getBytes(seed), 0);
      b.set(getBytes(seed2), 32);
      b.set(getBytes(seed3), 64);
      // Force service bits: compressed=1, infinity=0, keep sign bit as generated.
      b[0] = (b[0] & 0x3f) | 0x80;
      return hexlify(b);
    }

    let signature = "";
    let sig: Signature | null = null;
    for (let i = 0; i < 4096; i++) {
      const cand = candidateSignature(i);
      try {
        const candSig = Signature.fromHex(cand, false);
        // We expect subgroup validation to fail for almost any on-curve G2 point.
        try {
          candSig.sigValidate();
          // Unlikely: point in the correct subgroup; keep searching.
          continue;
        } catch {
          signature = cand;
          sig = candSig;
          break;
        }
      } catch {
        // Not on-curve / invalid encoding; keep searching.
      }
    }

    if (!sig) throw new Error("invariant: failed to find an on-curve non-subgroup signature");

    // Oracle: blst subgroup validation must reject this signature.
    expect(() => sig!.sigValidate()).to.throw();

    // Use a valid pubkey.
    const sk = master.deriveChildEip2333(startingIndex);
    const pk = sk.toPublicKey();
    const pubkey = pk.toHex(true);

    const depositY = buildDepositY(pk, sig);

    // Arbitrary message parameters; signature is not expected to match anyway.
    const forkVersion = "0x00000000";
    const withdrawalCredentials = keccak256(toBeHex(525252, 32));
    const amount = 1_000_000_000n * ONE_GWEI;
    const depositDomain = hexlify(await computeDepositDomain(forkVersion));

    // On-chain must reject: pairing precompile should fail on subgroup checks => PairingFailed().
    const pairingFailedSelector = keccak256(Buffer.from("PairingFailed()", "utf-8")).slice(0, 10);
    try {
      await harness.verifyDepositMessage(pubkey, signature, amount, depositY, withdrawalCredentials, depositDomain);
      expect.fail("invariant: expected revert");
    } catch (e) {
      const err = e as { data?: string; error?: { data?: string } };
      const data = err.data ?? err.error?.data;
      expect(data, "missing revert data").to.be.a("string");
      expect(data!.slice(0, 10)).to.equal(pairingFailedSelector);
    }
  });

  it("mutation oracle parity: accept/reject matches blst for randomized mutations", async () => {
    const testName = "mutation-oracle-parity";
    const startingIndex = computeStartingIndex(testName);
    console.log(`      [${testName}] starting key index: ${startingIndex}`);

    for (let i = 0; i < MUT_RUNS; i++) {
      const salt = keccak256(toBeHex(startingIndex + i, 32));
      const forkVersion = `0x${salt.slice(2, 10)}`; // bytes4
      const baseWithdrawalCredentials = keccak256(`0x${salt.slice(2, 2 + 64)}`); // bytes32
      const baseAmount = (1_000_000_000n + BigInt(i)) * ONE_GWEI; // >= 1 ETH
      const baseDepositDomain = hexlify(await computeDepositDomain(forkVersion));

      const sk = master.deriveChildEip2333(startingIndex + i);
      const pk = sk.toPublicKey();
      const basePubkey = pk.toHex(true);
      const baseSigningRoot = await computeDepositMessageRoot(
        basePubkey,
        baseWithdrawalCredentials,
        baseAmount,
        baseDepositDomain,
      );
      const sig = sk.sign(baseSigningRoot);
      const baseSignature = sig.toHex(true);
      const baseDepositY = buildDepositY(pk, sig);

      // Sanity.
      expect(
        blstVerifyDeposit(baseSigningRoot, basePubkey, baseSignature),
        `invariant: blst valid failed (i=${i})`,
      ).to.equal(true);
      await expect(
        harness.verifyDepositMessage(
          basePubkey,
          baseSignature,
          baseAmount,
          baseDepositY,
          baseWithdrawalCredentials,
          baseDepositDomain,
        ),
      ).not.to.be.reverted;

      for (let m = 0; m < MUTATIONS_PER_RUN; m++) {
        const msalt = keccak256(`0x${salt.slice(2)}${toBeHex(m, 32).slice(2)}`);
        const r = getBytes(msalt);
        const choice = r[0] % 13;

        let pubkey = basePubkey;
        let signature = baseSignature;
        let withdrawalCredentials = baseWithdrawalCredentials;
        let depositDomain = baseDepositDomain;
        let amount = baseAmount;

        // Mutations: keep deterministic and cheap.
        switch (choice) {
          // Service-bit flips.
          case 0:
            pubkey = flipFirstByte(pubkey, 0x80);
            break;
          case 1:
            pubkey = flipFirstByte(pubkey, 0x40);
            break;
          case 2:
            pubkey = flipFirstByte(pubkey, 0x20);
            break;
          case 3:
            signature = flipFirstByte(signature, 0x80);
            break;
          case 4:
            signature = flipFirstByte(signature, 0x40);
            break;
          case 5:
            signature = flipFirstByte(signature, 0x20);
            break;
          // Non-header bit flips.
          case 6: {
            const idx = 1 + (r[1] % 47); // [1..47]
            const mask = 1 << r[2] % 8;
            pubkey = flipByte(pubkey, idx, mask);
            break;
          }
          case 7: {
            const idx = 1 + (r[1] % 95); // [1..95]
            const mask = 1 << r[2] % 8;
            signature = flipByte(signature, idx, mask);
            break;
          }
          // Message mutations.
          case 8:
            depositDomain = flipFirstByte(depositDomain, 1 << r[1] % 8);
            break;
          case 9: {
            const idx = r[1] % 32;
            const mask = 1 << r[2] % 8;
            withdrawalCredentials = flipByte(withdrawalCredentials, idx, mask);
            break;
          }
          case 10:
            amount = amount + ONE_GWEI;
            break;
          // Length mutations.
          case 11:
            pubkey = truncateHex(pubkey, 47);
            break;
          case 12:
            signature = truncateHex(signature, 95);
            break;
          default:
            throw new Error("invariant");
        }

        const root = await computeSigningRootOrNull(pubkey, withdrawalCredentials, amount, depositDomain);
        const blstOk = root ? blstVerifyDeposit(root, pubkey, signature) : false;

        const depositY = tryBuildDepositY(pubkey, signature) ?? baseDepositY;

        const tx = harness.verifyDepositMessage(
          pubkey,
          signature,
          amount,
          depositY,
          withdrawalCredentials,
          depositDomain,
        );
        if (blstOk) {
          await expect(tx, `mutation accepted by blst must be accepted by solidity (i=${i},m=${m},choice=${choice})`)
            .not.to.be.reverted;
        } else {
          await expect(tx, `mutation rejected by blst must be rejected by solidity (i=${i},m=${m},choice=${choice})`).to
            .be.reverted;
        }
      }
    }
  });
});
