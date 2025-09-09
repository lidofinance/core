export const ONE_DAY = 24n * 60n * 60n;
export const MAX_BASIS_POINTS = 100_00n;

export const MAX_DEPOSIT = 150n;
export const CURATED_MODULE_ID = 1n;
export const SIMPLE_DVT_MODULE_ID = 2n;

export const SHARE_RATE_PRECISION = BigInt(10 ** 27);

export const ZERO_HASH = new Uint8Array(32).fill(0);
export const ZERO_BYTES32 = "0x" + Buffer.from(ZERO_HASH).toString("hex");

export const VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP = 10_00n;
