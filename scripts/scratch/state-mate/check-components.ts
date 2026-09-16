import fs from "node:fs";
import path from "node:path";

import { Contract, getAddress, JsonRpcProvider, keccak256, ZeroHash } from "ethers";

import { checkSiLidityDeployment } from "../si-lidity/checks";

import { findArtifacts } from "./check-abi";
import { collectSupplementalComponents } from "./components";

const REPO_ROOT = path.resolve(__dirname, "../../..");

export function componentCheckInputs(env: Record<string, string | undefined>) {
  const rpcUrl = env.LOCAL_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("LOCAL_RPC_URL must be set for the component check");
  const stateFile = path.resolve(REPO_ROOT, env.NETWORK_STATE_FILE || `deployed-${env.NETWORK || "local"}.json`);
  return { rpcUrl, stateFile };
}

async function main() {
  const { rpcUrl, stateFile } = componentCheckInputs(process.env);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    const block = await provider.getBlockNumber();
    if ((await provider.getNetwork()).chainId !== BigInt(state.chainId))
      throw new Error("Component check chain ID mismatch");
    const at = { blockTag: block };
    const components = collectSupplementalComponents(state);
    for (const component of components) {
      const code = await provider.getCode(component.address, block);
      if (code === "0x") throw new Error(`${component.label}: no deployed code at ${component.address}`);
      if (
        component.label === "delegationFactory" &&
        state.delegationFactory.runtimeCodeHash &&
        keccak256(code) !== state.delegationFactory.runtimeCodeHash
      )
        throw new Error("DelegationFactory runtime code hash mismatch");
      if (component.implementation) {
        const proxy = new Contract(
          component.address,
          ["function proxy__getImplementation() view returns (address)"],
          provider,
        );
        if (getAddress(await proxy.proxy__getImplementation(at)) !== getAddress(component.implementation)) {
          throw new Error(`${component.label}: unexpected proxy implementation`);
        }
      }
    }
    if (state.vaultViewer || state.wstETHReferralStaker) {
      await checkSiLidityDeployment(
        provider,
        {
          vaultViewer: state.vaultViewer?.address,
          wstETHReferralStaker: state.wstETHReferralStaker?.address,
        },
        {
          lidoLocator: state.lidoLocator.proxy.address,
          vaultHub: state.vaultHub.proxy.address,
          lazyOracle: state.lazyOracle.proxy.address,
          stETH: state["app:lido"].proxy.address,
          wstETH: state.wstETH.address,
        },
        block,
      );
    }
    const agent = state["app:aragon-agent"].proxy.address;
    if (state.sepoliaDepositAdapter) {
      const adapter = new Contract(
        state.sepoliaDepositAdapter.proxy.address,
        ["function owner() view returns (address)", "function proxy__getAdmin() view returns (address)"],
        provider,
      );
      if (
        getAddress(await adapter.owner(at)) !== getAddress(agent) ||
        getAddress(await adapter.proxy__getAdmin(at)) !== getAddress(agent)
      ) {
        throw new Error("SepoliaDepositAdapter: ownership/admin handoff incomplete");
      }
    }
    // Use the compiled router ABI because the module record is a versioned tuple.
    const candidates = findArtifacts(path.join(REPO_ROOT, "artifacts")).get("StakingRouter") ?? [];
    if (candidates.length !== 1)
      throw new Error(`Expected one compiled StakingRouter artifact; found ${candidates.length}`);
    const artifact = JSON.parse(fs.readFileSync(candidates[0], "utf8"));
    const router = new Contract(state.stakingRouter.proxy.address, artifact.abi, provider);
    const modules = await Promise.all(
      (await router.getStakingModuleIds(at)).map((id: bigint) => router.getStakingModule(id, at)),
    );
    for (const key of ["sm:CSM", "sm:CM"]) {
      const address = state[key]?.proxy?.address;
      if (!address) continue;
      if (!modules.some((module) => getAddress(module.stakingModuleAddress) === getAddress(address))) {
        throw new Error(`${key}: deployed module is not registered with StakingRouter`);
      }
      const module = new Contract(address, ["function hasRole(bytes32,address) view returns (bool)"], provider);
      if (!(await module.hasRole(ZeroHash, agent, at))) throw new Error(`${key}: Agent lacks module admin`);
    }
    console.log(`Verified ${components.length} supplemental component addresses at block ${block}`);
  } finally {
    provider.destroy();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
