type ByteArray = Uint8Array;

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
