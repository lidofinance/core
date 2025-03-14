import { PublicKey, Signature, verify } from "@chainsafe/blst";

type ByteArray = Uint8Array;

export const sanitazeHex = (hex: string) => hex.replace("0x", "").toLowerCase();

export const toHexString = (value: unknown): string => {
  if (typeof value === "string" && !value.startsWith("0x")) {
    return `0x${value}`;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return `0x${value.toString(16)}`;
  }

  throw new Error("Unsupported value type");
};

export const computeDepositDomain = async () => {
  // ssz ESM is not compatible with require
  const ssz = await eval(`import("@chainsafe/ssz")`);

  const { fromHexString, ByteVectorType, ContainerType } = ssz;

  const ZERO_HASH = Buffer.alloc(32, 0);
  const DOMAIN_DEPOSIT = Uint8Array.from([3, 0, 0, 0]);

  const Root = new ByteVectorType(32);
  const Bytes4 = new ByteVectorType(4);
  const Version = Bytes4;

  const ForkData = new ContainerType(
    {
      currentVersion: Version,
      genesisValidatorsRoot: Root,
    },
    { typeName: "ForkData", jsonCase: "eth2" },
  );

  const computeDomain = (
    domainType: ByteArray,
    forkVersion: ByteArray,
    genesisValidatorRoot: ByteArray,
  ): Uint8Array => {
    const forkDataRoot = computeForkDataRoot(forkVersion, genesisValidatorRoot);
    const domain = new Uint8Array(32);
    domain.set(domainType, 0);
    domain.set(forkDataRoot.slice(0, 28), 4);
    return domain;
  };

  const computeForkDataRoot = (currentVersion: ByteArray, genesisValidatorsRoot: ByteArray): Uint8Array => {
    return ForkData.hashTreeRoot({ currentVersion, genesisValidatorsRoot });
  };

  return computeDomain(DOMAIN_DEPOSIT, fromHexString("0x00000000"), ZERO_HASH);
};

export const computeDepositMessageRoot = async (
  pubkey: string,
  withdrawalCredentials: string,
  amount: bigint,
): Promise<Uint8Array> => {
  const ssz = await eval(`import("@chainsafe/ssz")`);

  const { ByteVectorType, ContainerType, UintNumberType } = ssz;

  const Bytes48 = new ByteVectorType(48);
  const Bytes32 = new ByteVectorType(32);
  const UintNum64 = new UintNumberType(8);
  const Root = new ByteVectorType(32);
  const Domain = Bytes32;

  const BLSPubkey = Bytes48;

  const DepositMessage = new ContainerType(
    { pubkey: BLSPubkey, withdrawalCredentials: Bytes32, amount: UintNum64 },
    { typeName: "DepositMessage", jsonCase: "eth2" },
  );

  const SigningData = new ContainerType(
    {
      objectRoot: Root,
      domain: Domain,
    },
    { typeName: "SigningData", jsonCase: "eth2" },
  );

  const depositMessage = {
    pubkey: BLSPubkey.fromJson(toHexString(pubkey)),
    withdrawalCredentials: Bytes32.fromJson(toHexString(withdrawalCredentials)),
    amount: UintNum64.fromJson(amount / 1000000000n),
  };

  const domain = await computeDepositDomain();

  return SigningData.hashTreeRoot({
    objectRoot: DepositMessage.hashTreeRoot(depositMessage),
    domain,
  });
};

export const extractYCoordinates = (pubkey: string, signature: string) => {
  const pubkeyObj = PublicKey.fromHex(sanitazeHex(pubkey));
  const signatureObj = Signature.fromHex(sanitazeHex(signature));

  // Y coordinate of Fp component of pubkey is last 48 bytes of uncompressed pubkey(g1 point)
  const pubkeyY = Buffer.from(pubkeyObj.toBytes(false).slice(48)).toString("hex");
  // the signature is a G2 point, so we need to extract the two components of Y coordinate (which is Fp2) from it
  // first Fp of Y coordinate is last 48 bytes of signature
  const sigY_c0 = Buffer.from(signatureObj.toBytes(false).slice(96 + 48, 96 + 48 * 2)).toString("hex");
  // second Fp is 48 bytes before first one
  const sigY_c1 = Buffer.from(signatureObj.toBytes(false).slice(96, 96 + 48)).toString("hex");

  return {
    pubkey: pubkeyObj.toHex(true),
    pubkeyY,
    pubkeyFull: pubkeyObj.toHex(false),
    signature: signatureObj.toHex(true),
    signatureY: {
      c0: sigY_c0,
      c1: sigY_c1,
    },
    signatureFull: signatureObj.toHex(false),
  };
};

export const verifyDepositMessage = async (
  pubkey: string,
  withdrawalCredentials: string,
  amount: bigint,
  signature: string,
) => {
  const message = await computeDepositMessageRoot(pubkey, withdrawalCredentials, amount);

  const pubkeyObj = PublicKey.fromHex(sanitazeHex(pubkey));
  const signatureObj = Signature.fromHex(sanitazeHex(signature));

  return verify(message, pubkeyObj, signatureObj);
};
