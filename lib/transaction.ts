import {
  ContractTransactionReceipt,
  ContractTransactionResponse,
  TransactionReceipt,
  TransactionResponse,
} from "ethers";
import hre, { ethers } from "hardhat";

import { log } from "lib";

type Transaction = TransactionResponse | ContractTransactionResponse;
type Receipt = TransactionReceipt | ContractTransactionReceipt;

export const trace = async <T extends Receipt>(name: string, tx: Transaction) => {
  const receipt = await tx.wait();

  if (!receipt) {
    log.error("Failed to trace transaction: no receipt!");
    throw new Error(`Failed to trace transaction for ${name}: no receipt!`);
  }

  const network = await tx.provider.getNetwork();
  const config = hre.config.networks[network.name];
  const blockGasLimit = "blockGasLimit" in config ? config.blockGasLimit : 30_000_000;
  const gasUsedPercent = (Number(receipt.gasUsed) / blockGasLimit) * 100;

  log.traceTransaction(name, {
    from: tx.from,
    to: tx.to ?? `New contract @ ${receipt.contractAddress}`,
    value: ethers.formatEther(tx.value),
    gasUsed: ethers.formatUnits(receipt.gasUsed, "wei"),
    gasPrice: ethers.formatUnits(receipt.gasPrice, "gwei"),
    gasUsedPercent: `${gasUsedPercent.toFixed(2)}%`,
    gasLimit: blockGasLimit.toString(),
    nonce: tx.nonce,
    blockNumber: receipt.blockNumber,
    hash: receipt.hash,
    status: !!receipt.status,
  });

  return receipt as T;
};
