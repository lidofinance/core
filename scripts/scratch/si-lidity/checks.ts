import { Contract, getAddress, isAddress, Provider } from "ethers";

export type SiLidityBindings = {
  lidoLocator: string;
  vaultHub: string;
  lazyOracle: string;
  stETH: string;
  wstETH: string;
};

export function resolveSiLidityRpcUrl(config: { url?: string }): string {
  if (!config.url) {
    throw new Error(
      "si-lidity requires an external HTTP RPC network. Use --network local or set SI_LIDITY_DEPLOYMENT_ENABLED=false.",
    );
  }
  return config.url;
}

export function parseSiLidityAddresses(artifact: Record<string, unknown>) {
  const address = (key: string) => {
    const value = artifact[`ScratchHelpers#${key}`];
    if (typeof value !== "string") throw new Error(`Missing si-lidity deployment address: ${key}`);
    return getAddress(value);
  };
  return { vaultViewer: address("VaultViewer"), wstETHReferralStaker: address("WstETHReferralStaker") };
}

export function assertSiLidityBindings(
  recorded: Partial<SiLidityBindings> | undefined,
  current: SiLidityBindings,
): void {
  for (const key of Object.keys(current) as (keyof SiLidityBindings)[]) {
    const value = recorded?.[key];
    if (typeof value !== "string" || !isAddress(value)) {
      throw new Error(`si-lidity retained deployment is missing a valid ${key} binding; restore its metadata`);
    }
    if (getAddress(value) !== getAddress(current[key])) {
      throw new Error(`si-lidity retained deployment has a different ${key}; cannot reuse its Ignition journal`);
    }
  }
}

export function requireSiLidityAddresses(addresses: { vaultViewer?: unknown; wstETHReferralStaker?: unknown }) {
  for (const key of ["vaultViewer", "wstETHReferralStaker"] as const) {
    const value = addresses[key];
    if (typeof value !== "string" || !isAddress(value)) {
      throw new Error(`si-lidity deployment incomplete: missing or invalid ${key} address`);
    }
  }
  return {
    vaultViewer: getAddress(addresses.vaultViewer as string),
    wstETHReferralStaker: getAddress(addresses.wstETHReferralStaker as string),
  };
}

// Also used by the standalone post-deployment checker. No Hardhat dependency.
export async function checkSiLidityDeployment(
  provider: Provider,
  addresses: { vaultViewer: string; wstETHReferralStaker: string },
  bindings: SiLidityBindings,
  blockTag?: number,
): Promise<void> {
  addresses = requireSiLidityAddresses(addresses);
  const at = blockTag === undefined ? {} : { blockTag };
  await Promise.all(
    Object.values(addresses).map(async (address) => {
      if ((await provider.getCode(address, blockTag)) === "0x") throw new Error(`si-lidity: no code at ${address}`);
    }),
  );
  const viewer = new Contract(
    addresses.vaultViewer,
    [
      "function LIDO_LOCATOR() view returns (address)",
      "function VAULT_HUB() view returns (address)",
      "function LAZY_ORACLE() view returns (address)",
      "function vaultsCount() view returns (uint256)",
      "function vaultAddressesBatch(uint256,uint256) view returns (address[])",
    ],
    provider,
  );
  const staker = new Contract(
    addresses.wstETHReferralStaker,
    ["function stETH() view returns (address)", "function wstETH() view returns (address)"],
    provider,
  );
  const hub = new Contract(bindings.vaultHub, ["function vaultsCount() view returns (uint256)"], provider);
  const [locator, vaultHub, lazyOracle, stETH, wstETH, count, viewerCount] = await Promise.all([
    viewer.LIDO_LOCATOR(at),
    viewer.VAULT_HUB(at),
    viewer.LAZY_ORACLE(at),
    staker.stETH(at),
    staker.wstETH(at),
    hub.vaultsCount(at),
    viewer.vaultsCount(at),
  ]);
  for (const [key, actual, expected] of [
    ["LIDO_LOCATOR", locator, bindings.lidoLocator],
    ["VAULT_HUB", vaultHub, bindings.vaultHub],
    ["LAZY_ORACLE", lazyOracle, bindings.lazyOracle],
    ["stETH", stETH, bindings.stETH],
    ["wstETH", wstETH, bindings.wstETH],
  ]) {
    if (getAddress(actual) !== getAddress(expected)) {
      throw new Error(`si-lidity ${key} mismatch: expected ${expected}, got ${actual}`);
    }
  }
  if (viewerCount !== count) throw new Error("VaultViewer vault count mismatch");
  if ((await viewer.vaultAddressesBatch(count, 1, at)).length !== 0) {
    throw new Error("VaultViewer pagination beyond the last vault must be empty");
  }
}
