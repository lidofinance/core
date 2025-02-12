import "hardhat/types/runtime";
import chalk from "chalk";
import { formatUnits, Interface, TransactionReceipt, TransactionResponse } from "ethers";
import { extendEnvironment } from "hardhat/config";
import { HardhatNetworkConfig, HardhatRuntimeEnvironment } from "hardhat/types";

const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const DEFAULT_BLOCK_GAS_LIMIT = 30_000_000;
const FUNCTION_SIGNATURE_LENGTH = 10;

const interfaceCache = new Map<string, Interface>();
const callCache = new Map<string, Call>();

enum TransactionType {
  CONTRACT_DEPLOYMENT = "Contract deployment",
  ETH_TRANSFER = "ETH transfer",
  CONTRACT_CALL = "Contract call",
}

type Call = {
  contract: string;
  function: string;
};

function outputTransaction(
  tx: TransactionResponse,
  txType: TransactionType,
  receipt: TransactionReceipt,
  call: Call,
  gasLimit: number,
  gasPrice: string,
): void {
  const gasUsedPercent = (Number(receipt.gasUsed) * 100) / gasLimit;

  const txHash = chalk.yellow(receipt.hash);
  const txFrom = chalk.cyan(tx.from);
  const txTo = chalk.cyan(tx.to || receipt.contractAddress);
  const txGasPrice = chalk.yellow(gasPrice);
  const txGasLimit = chalk.yellow(gasLimit);
  const txGasUsed = chalk.yellow(`${receipt.gasUsed} (${gasUsedPercent.toFixed(2)}%)`);
  const txBlock = chalk.yellow(receipt.blockNumber);
  const txNonce = chalk.yellow(tx.nonce);
  const txStatus = receipt.status ? chalk.green("confirmed") : chalk.red("failed");
  const txContract = chalk.cyan(call.contract || "Contract deployment");
  const txFunction = chalk.cyan(call.function || "");
  const txCall = `${txContract}.${txFunction}`;

  console.log(`Transaction sent: ${txHash}`);
  console.log(`  From: ${txFrom}   To: ${txTo}`);
  console.log(`  Gas price: ${txGasPrice} gwei   Gas limit: ${txGasLimit}   Gas used: ${txGasUsed}`);
  console.log(`  Block: ${txBlock}   Nonce: ${txNonce}`);

  if (txType === TransactionType.CONTRACT_DEPLOYMENT) {
    console.log(`  Contract deployed: ${chalk.cyan(receipt.contractAddress)}`);
  } else if (txType === TransactionType.ETH_TRANSFER) {
    console.log(`  ETH transfer: ${chalk.yellow(tx.value)}`);
  } else {
    console.log(`  ${txCall} ${txStatus}`);
  }
  console.log();
}

// Transaction Processing
async function getCall(tx: TransactionResponse, hre: HardhatRuntimeEnvironment): Promise<Call> {
  if (!tx.data || tx.data === "0x" || !tx.to) return { contract: "", function: "" };

  const cacheKey = `${tx.to}-${tx.data.slice(0, FUNCTION_SIGNATURE_LENGTH)}`;
  if (callCache.has(cacheKey)) {
    return callCache.get(cacheKey)!;
  }

  try {
    const call = await extractCallDetails(tx, hre);
    callCache.set(cacheKey, call);
    return call;
  } catch (error) {
    console.warn("Error getting call details:", error);
    const fallbackCall = { contract: tx.data.slice(0, FUNCTION_SIGNATURE_LENGTH), function: "" };
    callCache.set(cacheKey, fallbackCall);
    return fallbackCall;
  }
}

async function extractCallDetails(tx: TransactionResponse, hre: HardhatRuntimeEnvironment): Promise<Call> {
  try {
    const artifacts = await hre.artifacts.getAllFullyQualifiedNames();
    for (const name of artifacts) {
      const iface = await getOrCreateInterface(name, hre);
      const result = iface.parseTransaction({ data: tx.data });
      if (result) {
        return {
          contract: name.split(":").pop() || "",
          function: result.name || "",
        };
      }
    }
  } catch {
    // Ignore errors and return empty call
  }

  return { contract: "", function: "" };
}

async function getOrCreateInterface(artifactName: string, hre: HardhatRuntimeEnvironment) {
  if (interfaceCache.has(artifactName)) {
    return interfaceCache.get(artifactName)!;
  }

  const artifact = await hre.artifacts.readArtifact(artifactName);
  const iface = new Interface(artifact.abi);
  interfaceCache.set(artifactName, iface);
  return iface;
}

async function getTxType(tx: TransactionResponse, receipt: TransactionReceipt): Promise<TransactionType> {
  if (receipt.contractAddress) return TransactionType.CONTRACT_DEPLOYMENT;
  if (!tx.data || tx.data === "0x") return TransactionType.ETH_TRANSFER;
  return TransactionType.CONTRACT_CALL;
}

async function logTransaction(tx: TransactionResponse, hre: HardhatRuntimeEnvironment) {
  const receipt = await tx.wait();
  if (!receipt) throw new Error("Transaction receipt not found");

  try {
    const network = await tx.provider.getNetwork();
    const config = hre.config.networks[network.name] as HardhatNetworkConfig;
    const gasLimit = config.blockGasLimit ?? DEFAULT_BLOCK_GAS_LIMIT;

    const txType = await getTxType(tx, receipt);
    const call = await getCall(tx, hre);
    const gasPrice = formatUnits(receipt.gasPrice || 0n, "gwei");

    outputTransaction(tx, txType, receipt, call, gasLimit, gasPrice);

    return receipt;
  } catch (error) {
    console.error("Error logging transaction:", error);
    return receipt;
  }
}

extendEnvironment((hre: HardhatRuntimeEnvironment) => {
  if (LOG_LEVEL != "debug" && LOG_LEVEL != "all") return;

  const originalSendTransaction = hre.ethers.provider.send;

  hre.ethers.provider.send = async function (method: string, params: unknown[]) {
    const result = await originalSendTransaction.apply(this, [method, params]);

    if (method === "eth_sendTransaction" || method === "eth_sendRawTransaction") {
      const tx = (await this.getTransaction(result)) as TransactionResponse;
      await logTransaction(tx, hre);
    }

    return result;
  };
});
