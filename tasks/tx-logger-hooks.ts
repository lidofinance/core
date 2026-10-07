import chalk from "chalk";
import { formatUnits, Interface, type TransactionReceipt, type TransactionResponse } from "ethers";
import type { ArtifactManager } from "hardhat/types/artifacts";
import type { NetworkHooks } from "hardhat/types/hooks";
import type { ChainType, NetworkConnection } from "hardhat/types/network";

const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const DEFAULT_BLOCK_GAS_LIMIT = 30_000_000n;
const FUNCTION_SIGNATURE_LENGTH = 10;
const SEND_METHODS = new Set(["eth_sendTransaction", "eth_sendRawTransaction"]);

type Call = { contract: string; function: string };

const interfaceCache = new Map<string, Interface>();
const callCache = new Map<string, Call>();

export default async (): Promise<Partial<NetworkHooks>> => {
  if (LOG_LEVEL !== "debug" && LOG_LEVEL !== "all") return {};

  return {
    async onRequest(context, connection, request, next) {
      const response = await next(context, connection, request);

      if (SEND_METHODS.has(request.method) && "result" in response && typeof response.result === "string") {
        await logTransaction(response.result, connection, context.artifacts).catch((error) =>
          console.error("Error logging transaction:", error),
        );
      }

      return response;
    },
  };
};

async function logTransaction(
  hash: string,
  connection: NetworkConnection<ChainType | string>,
  artifacts: ArtifactManager,
) {
  const tx = await connection.ethers.provider.getTransaction(hash);
  if (!tx) throw new Error(`Transaction ${hash} not found`);

  const receipt = await tx.wait();
  if (!receipt) throw new Error(`Receipt for ${hash} not found`);

  const { networkConfig } = connection;
  const blockGasLimit =
    "blockGasLimit" in networkConfig && networkConfig.blockGasLimit
      ? BigInt(networkConfig.blockGasLimit)
      : DEFAULT_BLOCK_GAS_LIMIT;

  outputTransaction(tx, receipt, await getCall(tx, artifacts), blockGasLimit);
}

function outputTransaction(tx: TransactionResponse, receipt: TransactionReceipt, call: Call, blockGasLimit: bigint) {
  const gasUsedPercent = (Number(receipt.gasUsed) * 100) / Number(blockGasLimit);
  const gasPrice = formatUnits(receipt.gasPrice || 0n, "gwei");

  console.log(`Transaction sent: ${chalk.yellow(receipt.hash)}`);
  console.log(`  From: ${chalk.cyan(tx.from)}   To: ${chalk.cyan(tx.to || receipt.contractAddress)}`);
  console.log(
    `  Gas price: ${chalk.yellow(gasPrice)} gwei   Gas limit: ${chalk.yellow(tx.gasLimit)}   Gas used: ${chalk.yellow(`${receipt.gasUsed} (${gasUsedPercent.toFixed(2)}%)`)}`,
  );
  console.log(`  Block: ${chalk.yellow(receipt.blockNumber)}   Nonce: ${chalk.yellow(tx.nonce)}`);

  if (receipt.contractAddress) {
    console.log(`  Contract deployed: ${chalk.cyan(receipt.contractAddress)}`);
  } else if (!tx.data || tx.data === "0x") {
    console.log(`  ETH transfer: ${chalk.yellow(tx.value)}`);
  } else {
    const status = receipt.status ? chalk.green("confirmed") : chalk.red("failed");
    console.log(
      `  ${chalk.cyan(call.contract || tx.data.slice(0, FUNCTION_SIGNATURE_LENGTH))}.${chalk.cyan(call.function)} ${status}`,
    );
  }
  console.log();
}

async function getCall(tx: TransactionResponse, artifacts: ArtifactManager): Promise<Call> {
  if (!tx.data || tx.data === "0x" || !tx.to) return { contract: "", function: "" };

  const cacheKey = `${tx.to}-${tx.data.slice(0, FUNCTION_SIGNATURE_LENGTH)}`;
  const cached = callCache.get(cacheKey);
  if (cached) return cached;

  const call = await extractCallDetails(tx.data, artifacts);
  callCache.set(cacheKey, call);
  return call;
}

async function extractCallDetails(data: string, artifacts: ArtifactManager): Promise<Call> {
  for (const name of await artifacts.getAllFullyQualifiedNames()) {
    const iface = await getOrCreateInterface(name, artifacts);
    const result = iface.parseTransaction({ data });
    if (result) {
      return { contract: name.split(":").pop() || "", function: result.name };
    }
  }
  return { contract: "", function: "" };
}

async function getOrCreateInterface(artifactName: string, artifacts: ArtifactManager) {
  const cached = interfaceCache.get(artifactName);
  if (cached) return cached;

  const iface = new Interface((await artifacts.readArtifact(artifactName)).abi);
  interfaceCache.set(artifactName, iface);
  return iface;
}
