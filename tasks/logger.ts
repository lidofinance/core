import "hardhat/types/runtime";
import chalk from "chalk";
import { formatUnits, Interface, TransactionReceipt, TransactionResponse } from "ethers";
import { extendEnvironment } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

// Custom errors
class NoReceiptError extends Error {
  constructor() {
    super("Transaction receipt not found");
  }
}

// Types
interface FunctionDetails {
  name?: string;
  functionName?: string;
}

enum TransactionType {
  CONTRACT_DEPLOYMENT = "Contract deployment",
  ETH_TRANSFER = "ETH transfer",
  CONTRACT_CALL = "Contract call",
}

// Constants
const DEFAULT_BLOCK_GAS_LIMIT = 30_000_000;
const FUNCTION_SIGNATURE_LENGTH = 10;

// Cache for contract interfaces and function details
const interfaceCache = new Map<string, Interface>();
const functionDetailsCache = new Map<string, FunctionDetails>();

// Helper functions
function formatGasUsage(gasUsed: bigint, blockGasLimit: number): string {
  const gasUsedPercent = (Number(gasUsed) * 100) / blockGasLimit;
  return `${gasUsed} (${gasUsedPercent.toFixed(2)}%)`;
}

function formatTransactionLines(
  tx: TransactionResponse,
  receipt: TransactionReceipt,
  txType: string,
  name: string | undefined,
  functionName: string | undefined,
  blockGasLimit: number,
  gasPrice: string,
): string[] {
  const lines = [
    `Transaction sent: ${chalk.yellow(receipt.hash)}`,
    `  From: ${chalk.cyan(tx.from)}   To: ${chalk.cyan(tx.to || receipt.contractAddress)}`,
    `  Gas price: ${chalk.yellow(gasPrice)} gwei   Gas limit: ${chalk.yellow(blockGasLimit)}   Gas used: ${chalk.yellow(formatGasUsage(receipt.gasUsed, blockGasLimit))}`,
    `  Block: ${chalk.yellow(receipt.blockNumber)}   Nonce: ${chalk.yellow(tx.nonce)}`,
  ];

  const color = receipt.status ? chalk.green : chalk.red;
  const status = receipt.status ? "confirmed" : "failed";

  if (txType === TransactionType.CONTRACT_DEPLOYMENT) {
    lines.push(`  Contract address: ${chalk.cyan(receipt.contractAddress)}`);
    lines.push(`  ${color(name || "Contract deployment")} ${color(status)}`);
  } else if (txType === TransactionType.ETH_TRANSFER) {
    lines.push(`  ETH transfer: ${chalk.cyan(tx.value)}`);
    lines.push(`  ${color("ETH transfer")} ${color(status)}`);
  } else {
    const txName = name && functionName ? `${name}.${functionName}` : functionName || "Contract call";
    lines.push(`  ${color(txName)} ${color(status)}`);
  }

  return lines;
}

extendEnvironment((hre: HardhatRuntimeEnvironment) => {
  const originalSendTransaction = hre.ethers.provider.send;

  // Wrap the provider's send method to intercept transactions
  hre.ethers.provider.send = async function (method: string, params: unknown[]) {
    const result = await originalSendTransaction.apply(this, [method, params]);

    // Only log eth_sendTransaction and eth_sendRawTransaction calls
    if (method === "eth_sendTransaction" || method === "eth_sendRawTransaction") {
      const tx = (await this.getTransaction(result)) as TransactionResponse;
      await logTransaction(tx);
    }

    return result;
  };

  async function getFunctionDetails(tx: TransactionResponse): Promise<FunctionDetails> {
    if (!tx.data || tx.data === "0x" || !tx.to) return {};

    // Check cache first
    const cacheKey = `${tx.to}-${tx.data.slice(0, FUNCTION_SIGNATURE_LENGTH)}`;
    if (functionDetailsCache.has(cacheKey)) {
      return functionDetailsCache.get(cacheKey)!;
    }

    try {
      // Try to get contract name and function name from all available artifacts
      const allArtifacts = await hre.artifacts.getAllFullyQualifiedNames();

      for (const artifactName of allArtifacts) {
        try {
          let iface: Interface;

          // Check interface cache
          if (interfaceCache.has(artifactName)) {
            iface = interfaceCache.get(artifactName)!;
          } else {
            const artifact = await hre.artifacts.readArtifact(artifactName);
            iface = new Interface(artifact.abi);
            interfaceCache.set(artifactName, iface);
          }

          const result = iface.parseTransaction({ data: tx.data });

          if (result) {
            const details = {
              name: artifactName.split(":").pop() || "",
              functionName: result.name,
            };
            functionDetailsCache.set(cacheKey, details);
            return details;
          }
        } catch {
          continue; // Skip artifacts that can't be parsed
        }
      }
    } catch (error) {
      console.warn("Error getting function details:", error);
    }

    // Cache and return function signature if we can't decode
    const details = {
      functionName: tx.data.slice(0, FUNCTION_SIGNATURE_LENGTH),
    };
    functionDetailsCache.set(cacheKey, details);
    return details;
  }

  async function logTransaction(tx: TransactionResponse): Promise<TransactionReceipt> {
    const receipt = await tx.wait();
    if (!receipt) {
      throw new NoReceiptError();
    }

    try {
      const network = await tx.provider.getNetwork();
      const config = hre.config.networks[network.name];
      const blockGasLimit = "blockGasLimit" in config ? config.blockGasLimit : DEFAULT_BLOCK_GAS_LIMIT;

      const txType = await getTxType(tx, receipt);
      const { name, functionName } = await getFunctionDetails(tx);
      const gasPrice = formatUnits(receipt.gasPrice || 0n, "gwei");

      const lines = formatTransactionLines(tx, receipt, txType, name, functionName, blockGasLimit, gasPrice);

      lines.forEach((line) => console.log(line));

      return receipt;
    } catch (error) {
      console.error("Error logging transaction:", error);
      return receipt;
    }
  }

  async function getTxType(tx: TransactionResponse, receipt: TransactionReceipt): Promise<string> {
    if (receipt.contractAddress) {
      return TransactionType.CONTRACT_DEPLOYMENT;
    }

    if (!tx.data || tx.data === "0x") {
      return TransactionType.ETH_TRANSFER;
    }

    const { name, functionName } = await getFunctionDetails(tx);
    return name && functionName ? `${name}.${functionName}` : functionName || TransactionType.CONTRACT_CALL;
  }

  return logTransaction;
});
