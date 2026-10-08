import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ethers, network } from "hardhat";
import { HttpNetworkConfig } from "hardhat/types";
import {
  assertSiLidityBindings,
  checkSiLidityDeployment,
  parseSiLidityAddresses,
  requireSiLidityAddresses,
  resolveSiLidityRpcUrl,
  SiLidityBindings,
} from "scripts/scratch/si-lidity/checks";
import {
  assertSiLidityVerificationSupported,
  requireSiLidityArchive,
  siLiditySignerAccounts,
  siLidityToolingEnv,
} from "scripts/scratch/si-lidity/tooling";
import { runExternal } from "scripts/utils/subprocess";

import { isSiLidityDeploymentEnabled } from "lib/env-flags";
import { log } from "lib/log";
import { warmUpJsonRpcProvider } from "lib/provider";
import { getAddress, persistNetworkState, readNetworkState, Sk } from "lib/state-file";

const REPOSITORY = "https://github.com/lidofinance/si-lidity.git";
const BRANCH = "main";
const REPO_ROOT = path.resolve(__dirname, "../../..");
const ARCHIVE_ROOT = path.join(REPO_ROOT, ".local/si-lidity-deployments");
const TEMPLATES = path.resolve(__dirname, "../si-lidity");

type RetainedDeployment = {
  directory: string;
  chainId: string;
  deployer: string;
  bindings: SiLidityBindings;
  sourceBranch: string;
  sourceRevision?: string;
  deploymentStarted?: boolean;
};

export async function main() {
  if (!isSiLidityDeploymentEnabled()) {
    log("si-lidity deployment disabled");
    return;
  }
  assertSiLidityVerificationSupported();
  const rpcUrl = resolveSiLidityRpcUrl(network.config as { url?: string });
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });
  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  const bindings: SiLidityBindings = {
    lidoLocator: getAddress(Sk.lidoLocator, state),
    vaultHub: getAddress(Sk.vaultHub, state),
    lazyOracle: getAddress(Sk.lazyOracle, state),
    stETH: getAddress(Sk.appLido, state),
    wstETH: getAddress(Sk.wstETH, state),
  };
  if (state[Sk.vaultViewer] || state[Sk.wstETHReferralStaker]) {
    requireSiLidityAddresses({
      vaultViewer: state[Sk.vaultViewer]?.address,
      wstETHReferralStaker: state[Sk.wstETHReferralStaker]?.address,
    });
  }
  let retained = state[Sk.siLidityDeployment] as RetainedDeployment | undefined;
  if (retained) {
    if (
      retained.chainId !== chainId ||
      typeof retained.deployer !== "string" ||
      retained.deployer.toLowerCase() !== deployer.toLowerCase()
    ) {
      throw new Error("si-lidity retained deployment chain/signer mismatch");
    }
    assertSiLidityBindings(retained.bindings, bindings);
  } else {
    fs.mkdirSync(ARCHIVE_ROOT, { recursive: true });
    retained = {
      directory: path.relative(REPO_ROOT, fs.mkdtempSync(path.join(ARCHIVE_ROOT, `${chainId}-`))),
      chainId,
      deployer,
      bindings,
      sourceBranch: BRANCH,
    };
    // Persist before any child deployment: retries reuse the same Ignition journal.
    state[Sk.siLidityDeployment] = retained;
    persistNetworkState(state);
  }
  if (state[Sk.vaultViewer]?.address && state[Sk.wstETHReferralStaker]?.address) {
    await checkSiLidityDeployment(
      ethers.provider,
      {
        vaultViewer: getAddress(Sk.vaultViewer, state),
        wstETHReferralStaker: getAddress(Sk.wstETHReferralStaker, state),
      },
      bindings,
    );
    log("si-lidity already deployed and verified");
    return;
  }
  if (typeof retained.directory !== "string" || !retained.directory) {
    throw new Error(
      "si-lidity retained deployment is missing its directory; restore its metadata and Ignition journal",
    );
  }
  const directory = path.resolve(REPO_ROOT, retained.directory);
  requireSiLidityArchive(directory, retained.sourceRevision, retained.deploymentStarted);
  const toolingEnv = siLidityToolingEnv();
  const repo = path.join(directory, "repo");
  if (!fs.existsSync(path.join(repo, ".git"))) {
    runExternal(
      "git",
      ["clone", "--depth", "1", "--branch", BRANCH, "--single-branch", REPOSITORY, repo],
      directory,
      toolingEnv,
    );
  }
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", env: toolingEnv }).trim();
  if (retained.sourceRevision && retained.sourceRevision !== revision) {
    throw new Error("si-lidity retained checkout changed; cannot reuse its Ignition journal");
  }
  retained.sourceRevision = revision;
  persistNetworkState(state);
  log(`Deploying si-lidity ${BRANCH} (${revision}) using its own Hardhat/Ignition tooling`);
  runExternal(
    "git",
    ["submodule", "update", "--init", "--depth", "1", "submodules/lidofinance-core"],
    repo,
    toolingEnv,
  );
  // Corepack selects si-lidity's packageManager, independently of core's Yarn 4.
  runExternal(
    "corepack",
    ["yarn", "install", "--frozen-lockfile", "--ignore-scripts", "--non-interactive"],
    repo,
    toolingEnv,
  );
  const config = path.join(repo, "hardhat.scratch.config.ts");
  const module = path.join(repo, "ignition/modules/ScratchHelpers.ts");
  const parameters = path.join(directory, "parameters.json");
  fs.copyFileSync(path.join(TEMPLATES, "hardhat.config.ts.template"), config);
  fs.mkdirSync(path.dirname(module), { recursive: true });
  fs.copyFileSync(path.join(TEMPLATES, "module.ts.template"), module);
  fs.writeFileSync(
    parameters,
    JSON.stringify({ ScratchHelpers: { lidoLocator: bindings.lidoLocator, wstETH: bindings.wstETH } }, null, 2),
  );
  const env: NodeJS.ProcessEnv = { ...toolingEnv };
  env.CI = "true";
  env.HARDHAT_IGNITION_CONFIRM_DEPLOYMENT = "true";
  env.SI_LIDITY_RPC_URL = rpcUrl;
  env.SI_LIDITY_ACCOUNTS = JSON.stringify(
    siLiditySignerAccounts((network.config as HttpNetworkConfig).accounts, deployer),
  );
  retained.deploymentStarted = true;
  persistNetworkState(state);
  // Credentials stay in the child environment, never command arguments or artifacts.
  runExternal(
    "corepack",
    [
      "yarn",
      "hardhat",
      "--config",
      config,
      "ignition",
      "deploy",
      module,
      "--network",
      "scratch",
      "--parameters",
      parameters,
      "--deployment-id",
      "scratch",
      "--default-sender",
      deployer,
    ],
    repo,
    env,
  );
  const artifact = path.join(repo, "ignition/deployments/scratch/deployed_addresses.json");
  const addresses = parseSiLidityAddresses(JSON.parse(fs.readFileSync(artifact, "utf8")));
  for (const key of [Sk.vaultViewer, Sk.wstETHReferralStaker] as const) {
    state[key] = { address: addresses[key], sourceRevision: revision };
  }
  // Preserve addresses even if an RPC check fails; retry verifies rather than redeploying.
  persistNetworkState(state);
  await warmUpJsonRpcProvider();
  await checkSiLidityDeployment(ethers.provider, addresses, bindings);
  log.success("si-lidity helpers deployed and verified");
}
