export type ArrayToUnion<A extends readonly unknown[]> = A[number];

export type TraceableTransaction = {
  from: string;
  to: string;
  value: string;
  gasUsed: string;
  gasPrice: string;
  gasLimit: string;
  gasUsedPercent: string;
  nonce: number;
  blockNumber: number;
  hash: string;
  status: boolean;
};
