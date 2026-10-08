/** Components checked separately from the fixed YAML, including optional external deployments.
 * Metadata within these entries (parameters, source refs, artifacts) is not an address.
 */
export const SUPPLEMENTAL_COMPONENTS = [
  "beaconChainDepositor",
  "srLib",
  "circuitBreaker",
  "vaultViewer",
  "wstETHReferralStaker",
  "delegationFactory",
  "easyTrackEVMScriptExecutor",
  "sepoliaDepositAdapter",
  "sm:CSM",
  "sm:CM",
] as const;

type Entry = {
  address?: string;
  addresses?: string[];
  proxy?: { address: string };
  implementation?: { address: string };
  contracts?: Record<string, Entry>;
  deployArtifact?: Record<string, unknown>;
};
export type Component = { label: string; address: string; implementation?: string };

export function collectSupplementalComponents(state: Record<string, unknown>): Component[] {
  const result: Component[] = [];
  const visit = (label: string, entry: Entry) => {
    if (entry.proxy?.address)
      result.push({ label, address: entry.proxy.address, implementation: entry.implementation?.address });
    else if (entry.address) result.push({ label, address: entry.address });
    if (entry.implementation?.address)
      result.push({ label: `${label}.implementation`, address: entry.implementation.address });
    entry.addresses?.forEach((address, i) => result.push({ label: `${label}[${i}]`, address }));
    for (const [key, contract] of Object.entries(entry.contracts ?? {})) visit(`${label}.${key}`, contract);
  };
  for (const key of SUPPLEMENTAL_COMPONENTS) {
    if (!state[key]) continue;
    const entry = state[key] as Entry;
    visit(key, entry);
    // External artifacts also contain deployed contracts absent from canonical
    // substate (e.g. HashConsensus, Ejector, factories and linked libraries).
    // Configuration/source metadata is explicitly excluded, never scanned for addresses.
    for (const [name, value] of Object.entries(entry.deployArtifact ?? {})) {
      if (["ChainId", "DeployParams", "CuratedDeployParams", "git-ref"].includes(name)) continue;
      const addresses =
        name === "ExternalLibraries" && value && typeof value === "object"
          ? Object.values(value)
          : Array.isArray(value)
            ? value
            : [value];
      for (const [i, address] of addresses.entries()) {
        if (typeof address === "string" && /^0x[0-9a-f]{40}$/i.test(address) && !/^0x0{40}$/.test(address)) {
          result.push({ label: `${key}.deployArtifact.${name}[${i}]`, address });
        }
      }
    }
  }
  return result;
}
