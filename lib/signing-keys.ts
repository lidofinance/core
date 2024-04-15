import { de0x, hexSplit, randomString } from "lib";

export const PUBKEY_LENGTH = 48;
export const SIGNATURE_LENGTH = 96;
export const EMPTY_PUBLIC_KEY = "0x" + "0".repeat(2 * PUBKEY_LENGTH);
export const EMPTY_SIGNATURE = "0x" + "0".repeat(2 * SIGNATURE_LENGTH);

export class ValidatorKeys {
  count: number;
  publicKeysList: string[];
  signaturesList: string[];

  constructor(publicKeys: string[], signatures: string[]) {
    if (publicKeys.length !== signatures.length) {
      throw new Error("Public keys & signatures length mismatch");
    }

    publicKeys = publicKeys.map(de0x);
    signatures = signatures.map(de0x);

    if (!publicKeys.every((pk) => pk.length !== PUBKEY_LENGTH)) {
      throw new Error("Invalid Public Key length");
    }

    if (!signatures.every((s) => s.length !== SIGNATURE_LENGTH)) {
      throw new Error("Invalid Signature length");
    }
    this.count = publicKeys.length;
    this.publicKeysList = publicKeys;
    this.signaturesList = signatures;
  }

  get(index: number) {
    if (index >= this.count) {
      throw new Error(`Index out of range`);
    }
    return ["0x" + this.publicKeysList[index], "0x" + this.signaturesList[index]];
  }

  slice(start = 0, end = this.count): [string, string] {
    return ["0x" + this.publicKeysList.slice(start, end).join(), "0x" + this.signaturesList.slice(start, end).join()];
  }
}

export class FakeValidatorKeys extends ValidatorKeys {
  constructor(length: number, { seed = BigInt(randomString(16)), kFill = "f", sFill = "e" } = {}) {
    super(
      Array(length)
        .fill(0)
        .map((_, i) => (seed + BigInt(i)).toString(16))
        .map((v) => "0x" + v.padStart(PUBKEY_LENGTH, kFill)),
      Array(length)
        .fill(0)
        .map((_, i) => (seed + BigInt(i)).toString(16))
        .map((v) => "0x" + v.padStart(SIGNATURE_LENGTH, sFill)),
    );
  }
}

export function splitPublicKeysBatch(batch: string) {
  return hexSplit(batch, PUBKEY_LENGTH);
}

export function splitSignaturesBatch(batch: string) {
  return hexSplit(batch, SIGNATURE_LENGTH);
}
