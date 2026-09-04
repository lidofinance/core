interface ExplorerConfig {
  name: string;
  baseUrl: string;
}

const BLOCK_EXPLORERS: Record<number, ExplorerConfig> = {
  1: { name: "Etherscan", baseUrl: "https://etherscan.io" },
  560048: { name: "Etherscan Hoodi", baseUrl: "https://hoodi.etherscan.io" },
};

let cachedExplorer: ExplorerConfig | null | undefined = undefined;

async function getBlockExplorer(): Promise<ExplorerConfig | null> {
  if (cachedExplorer !== undefined) {
    return cachedExplorer;
  }

  // Lazy import: hardhat.config.ts transitively imports this module (tasks -> lib/log.ts),
  // so a top-level hardhat import would be circular while the config is loading.
  const hre = (await import("hardhat")).default;
  const { ethers } = await hre.network.getOrCreate();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  cachedExplorer = BLOCK_EXPLORERS[chainId] || null;
  return cachedExplorer;
}

export async function getTxLink(txHash: string): Promise<string | null> {
  let baseUrl = process.env.BLOCK_EXPLORER_BASE_URL || null;
  if (!baseUrl) {
    const explorer = await getBlockExplorer();
    baseUrl = explorer?.baseUrl || null;
  }
  return baseUrl ? `${baseUrl}/tx/${txHash}` : null;
}
