import { ethers } from "hardhat";

import { impersonate } from "lib";
import { log } from "lib";

// https://github.com/ethereum/EIPs/blob/master/EIPS/eip-7002.md#configuration
export const EIP7002_ADDRESS = "0x00000961Ef480Eb55e80D19ad83579A64c007002";
export const EIP7002_MIN_WITHDRAWAL_REQUEST_FEE = 1n;

const EIP7002_RUNTIME_BYTECODE =
  "0x3373fffffffffffffffffffffffffffffffffffffffe1460cb5760115f54807fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff146101f457600182026001905f5b5f82111560685781019083028483029004916001019190604d565b909390049250505036603814608857366101f457346101f4575f5260205ff35b34106101f457600154600101600155600354806003026004013381556001015f35815560010160203590553360601b5f5260385f601437604c5fa0600101600355005b6003546002548082038060101160df575060105b5f5b8181146101835782810160030260040181604c02815460601b8152601401816001015481526020019060020154807fffffffffffffffffffffffffffffffff00000000000000000000000000000000168252906010019060401c908160381c81600701538160301c81600601538160281c81600501538160201c81600401538160181c81600301538160101c81600201538160081c81600101535360010160e1565b910180921461019557906002556101a0565b90505f6002555f6003555b5f54807fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff14156101cd57505f5b6001546002828201116101e25750505f6101e8565b01600290035b5f555f600155604c025ff35b5f5ffd";

export const deployEIP7002WithdrawalRequestContract = async (): Promise<void> => {
  // Inject the byte-code directly at the fixed address.
  await ethers.provider.send("hardhat_setCode", [EIP7002_ADDRESS, EIP7002_RUNTIME_BYTECODE]);
};

export const ensureEIP7002WithdrawalRequestContractPresent = async (): Promise<void> => {
  const code = await ethers.provider.getCode(EIP7002_ADDRESS);

  if (code === "0x") {
    log.warning(`EIP7002 withdrawal request contract not found at ${EIP7002_ADDRESS}`);

    await deployEIP7002WithdrawalRequestContract();
    log.success("EIP7002 withdrawal request contract is present");
  }
};

export type EIP7002WithdrawalRequest = {
  address: string; // hex string, 0x-prefixed
  pubkey: string; // hex string, 0x-prefixed
  amount: bigint;
};

// Pop withdrawal request from queue, update fee accumulator.
// Reads as many requests as available from the queue, until the max withdrawal request per
// block is reached. The requests are returned as a contiguous array of bytes
export const readWithdrawalRequests = async (): Promise<EIP7002WithdrawalRequest[]> => {
  const sysAddress = await impersonate("0xfffffffffffffffffffffffffffffffffffffffe", 999999999999999999999999999n);

  // Use a call to get the return data (simulate the transaction)
  const callResult: string = await ethers.provider.call({
    to: EIP7002_ADDRESS,
    from: await sysAddress.getAddress(),
    value: 0,
    data: "0x",
  });

  // Send a transaction
  await sysAddress.sendTransaction({
    to: EIP7002_ADDRESS,
    value: 0,
  });

  if (!callResult || callResult === "0x") return [];

  const buf = Buffer.from(callResult.slice(2), "hex");
  const REQUEST_SIZE = 76;
  const requests: EIP7002WithdrawalRequest[] = [];
  for (let i = 0; i + REQUEST_SIZE <= buf.length; i += REQUEST_SIZE) {
    const chunk = buf.subarray(i, i + REQUEST_SIZE);
    const address = "0x" + chunk.subarray(0, 20).toString("hex");
    const pubkey = "0x" + chunk.subarray(20, 68).toString("hex");
    const amount = chunk.readBigUInt64LE(68);
    requests.push({ address, pubkey, amount });
  }

  return requests;
};
