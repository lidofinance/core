import { ethers } from "hardhat";

import { log } from "./log";

const CONNECTION_RESET_RETRY_ATTEMPTS = 3;
const CONNECTION_RESET_RETRY_DELAY_MS = 250;

function isConnectionReset(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const {
    code,
    cause,
    error: nestedError,
    message,
  } = error as {
    code?: unknown;
    cause?: unknown;
    error?: unknown;
    message?: unknown;
  };

  return (
    code === "ECONNRESET" ||
    isConnectionReset(cause) ||
    isConnectionReset(nestedError) ||
    (typeof message === "string" && message.includes("ECONNRESET"))
  );
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function warmUpJsonRpcProvider() {
  for (let attempt = 1; attempt <= CONNECTION_RESET_RETRY_ATTEMPTS; attempt++) {
    try {
      await ethers.provider.getBlockNumber();
      return;
    } catch (error) {
      if (!isConnectionReset(error) || attempt === CONNECTION_RESET_RETRY_ATTEMPTS) {
        throw error;
      }

      log.warning(`JSON-RPC connection reset after external broadcast, retrying (${attempt + 1})...`);
      await sleep(CONNECTION_RESET_RETRY_DELAY_MS * attempt);
    }
  }
}
