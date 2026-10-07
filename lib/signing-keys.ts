import { PUBKEY_LENGTH_HEX, SIGNATURE_LENGTH_HEX } from "./constants.js";
import { de0x } from "./string.js";

class ValidatorKeys {
  public readonly count: number;
  public readonly publicKeysList: string[];
  public readonly signaturesList: string[];

  constructor(publicKeys: string[], signatures: string[]) {
    if (publicKeys.length !== signatures.length) {
      throw new Error("Public keys and signatures length mismatch");
    }

    this.publicKeysList = publicKeys.map((k) => this.normalizeAndValidate("Public Key", k, PUBKEY_LENGTH_HEX));
    this.signaturesList = signatures.map((s) => this.normalizeAndValidate("Signature", s, SIGNATURE_LENGTH_HEX));

    this.count = this.publicKeysList.length;
  }

  get(index: number): string[] {
    if (index < 0 || index >= this.count) {
      throw new Error("Index out of range");
    }
    return [`0x${this.publicKeysList[index]}`, `0x${this.signaturesList[index]}`];
  }

  slice(start: number = 0, end: number = this.count): string[] {
    const slicedPublicKeys = this.publicKeysList.slice(start, end);
    const slicedSignatures = this.signaturesList.slice(start, end);

    return [`0x${slicedPublicKeys.join("")}`, `0x${slicedSignatures.join("")}`];
  }

  private normalizeAndValidate(label: string, hexString: string, expectedLength: number): string {
    const strippedHex = de0x(hexString);
    if (strippedHex.length !== expectedLength) {
      throw new Error(`Invalid ${label} length`);
    }

    return strippedHex;
  }
}

interface FakeValidatorKeysOptions {
  seed?: number;
  kFill?: string;
  sFill?: string;
}

class FakeValidatorKeys extends ValidatorKeys {
  constructor(length: number, { seed, kFill = "f", sFill = "e" }: FakeValidatorKeysOptions = {}) {
    const seedMin = 10;
    const seedMax = 10 ** 9;
    const seedDefault = Math.min(Math.floor(Math.random() * (seedMax - seedMin + 1)) + seedMin, seedMax);
    const effectiveSeed = seed || seedDefault;

    super(
      FakeValidatorKeys.generateKeys(length, effectiveSeed, PUBKEY_LENGTH_HEX, kFill),
      FakeValidatorKeys.generateKeys(length, effectiveSeed, SIGNATURE_LENGTH_HEX, sFill),
    );
  }

  private static generateKeys(length: number, seed: number, targetLength: number, fill: string): string[] {
    return Array.from({ length }, (_, i) => {
      const hex = Number(seed + i)
        .toString(16)
        .padStart(targetLength, fill);
      return `0x${hex}`;
    });
  }
}

export { ValidatorKeys, FakeValidatorKeys };
