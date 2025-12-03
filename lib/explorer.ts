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

  // Import ethers lazily at runtime to avoid circular dependency with hardhat.config.ts
  const { ethers } = await import("hardhat");
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  cachedExplorer = BLOCK_EXPLORERS[chainId] || null;
  return cachedExplorer;
}

export async function getTxLink(txHash: string): Promise<string | null> {
  const explorer = await getBlockExplorer();
  return explorer ? `${explorer.baseUrl}/tx/${txHash}` : null;
}
