import path from "node:path";

import { network } from "hardhat";
import { ScratchParameters } from "scripts/utils/scratch";

import { isTruthyEnv } from "lib/env-flags";
import { log } from "lib/log";

// Checks shared between the deploy preflight (scripts/scratch/preflight.ts) and
// the DG deploy step (0160). The preflight runs them before any gas is spent;
// 0160 keeps them as a backstop for entry points that bypass the preflight.

export const DG_SUBMODULE_DIR = path.resolve(__dirname, "../../foundry/lib/dual-governance");

// Forge must broadcast against the same node the JS side is deploying to.
// That is the *hardhat network's* URL, not the raw RPC_URL env var: in the
// MODE=scratch integration phase `--network local` resolves to
// LOCAL_RPC_URL while a dotenv-loaded RPC_URL may point at a remote
// provider (exactly the CI layout, where .env carries the public default).
export function resolveDgForgeRpcUrl(): string {
  const rpcUrl = (network.config as { url?: string }).url || process.env.RPC_URL;
  if (!rpcUrl) {
    throw new Error(
      "Cannot resolve an RPC URL for the DG forge script: the selected hardhat network has no `url` " +
        "(in-process network?) and RPC_URL is not set. Run scratch deploy against an external node.",
    );
  }
  return rpcUrl;
}

// First 10 anvil default mnemonic accounts ("test test test test test test test test test test test junk").
// Used as committee/proposer placeholders in deploy-params-testnet.toml. If they reach a non-fork
// production chain via misconfigured per-network params, the deployer can replay txs and steal control.
const ANVIL_DEV_ADDRESSES = new Set(
  [
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
    "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
    "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
  ].map((a) => a.toLowerCase()),
);

// Fail-closed: a non-fork public chain whose DG committees are anvil dev keys is
// a hijack waiting to happen (the deployer holds the keys and can replay txs to
// seize control). Refuse the deploy unless explicitly overridden — escape hatch
// mirrors DG_DEPLOYMENT_ENABLED, for the case of a public-chain *fork* whose
// chainId isn't 31337/1337 (e.g. a forked mainnet under a custom chainId).
export function assertNoDevCommitteesOnPublicChain(
  dg: NonNullable<ScratchParameters["dualGovernance"]>,
  chainId: number,
): void {
  // Local hardhat / anvil chain ids — dev addresses are expected.
  if (chainId === 31337 || chainId === 1337) return;

  const allCommitteeAddresses = [
    dg.resealCommittee,
    dg.timelock.emergencyProtection.emergencyGovernanceProposer,
    dg.timelock.emergencyProtection.emergencyActivationCommittee,
    dg.timelock.emergencyProtection.emergencyExecutionCommittee,
    ...dg.tiebreaker.committees.flatMap((c) => c.members),
  ];
  const hits = allCommitteeAddresses.filter((a) => ANVIL_DEV_ADDRESSES.has(a.toLowerCase()));
  if (hits.length === 0) return;

  const message =
    `[dualGovernance] config references ${hits.length} anvil dev address(es) on chainId=${chainId}: ` +
    `${hits.join(", ")}. These are publicly-known private keys — using them for DG committees on a ` +
    `non-local chain hands control to anyone. Replace them with real multisigs.`;

  if (isTruthyEnv("DG_ALLOW_DEV_COMMITTEES")) {
    log.warning(`${message} Continuing anyway because DG_ALLOW_DEV_COMMITTEES is set (forks only).`);
    return;
  }
  throw new Error(`${message} Set DG_ALLOW_DEV_COMMITTEES=1 to override (intended for public-chain forks only).`);
}
