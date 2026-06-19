import { BigNumberish, BytesLike, dataLength, getAddress, solidityPacked, toBeHex } from "ethers";

export type EvmScriptHex = `0x${string}`;

export interface ScriptCall {
  to: string;
  data: BytesLike;
}

export interface ProposalCall {
  target: string;
  value: bigint;
  payload: BytesLike;
}

export interface VoteItem {
  description: string;
  call: ScriptCall;
}

export const CALLS_SCRIPT_SPEC_ID = 1;
export const EMPTY_CALLS_SCRIPT = createExecutorId(CALLS_SCRIPT_SPEC_ID);

export function createExecutorId(id: BigNumberish): EvmScriptHex {
  return toBeHex(id, 4) as EvmScriptHex;
}

// Encodes an array of actions ({ to: address, calldata: bytes }) into the EVM call script format:
// [ 4 bytes (spec id) ] + N * ([ 20 bytes (address) ] + [ 4 bytes (uint32: calldata length) ] + [ calldata ])
export function encodeCallScript(
  calls: readonly ScriptCall[],
  specId: BigNumberish = CALLS_SCRIPT_SPEC_ID,
): EvmScriptHex {
  return calls.reduce<EvmScriptHex>((script, { to, data }) => {
    const encodedAction = solidityPacked(["address", "uint32", "bytes"], [getAddress(to), dataLength(data), data]);

    return `${script}${encodedAction.slice(2)}` as EvmScriptHex;
  }, createExecutorId(specId));
}
