/** Offline ABI/specification consistency check. Never queries deployed getter values. */
import fs from "node:fs";
import path from "node:path";

import { FunctionFragment, Interface, InterfaceAbi } from "ethers";
import { isMap, parseDocument } from "yaml";

const ROOT = path.resolve(__dirname, "../../..");

export function findArtifacts(root: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  if (!fs.existsSync(root)) return found;
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "build-info") walk(fullPath);
      } else if (
        entry.name.endsWith(".json") &&
        !entry.name.endsWith(".dbg.json") &&
        path.basename(directory).endsWith(".sol")
      ) {
        const name = path.basename(entry.name, ".json");
        found.set(name, [...(found.get(name) ?? []), fullPath]);
      }
    }
  };
  walk(root);
  return found;
}

/** Inspect YAML nodes without resolving address/input aliases: no deployment is required. */
export function checkAbiCoverage(source: string, loadAbi: (name: string) => InterfaceAbi, sections = ["l1"]): number {
  const document = parseDocument(source);
  if (document.errors.length) throw new Error(document.errors.map((e) => e.message).join("\n"));
  const errors: string[] = [];
  let count = 0;
  for (const section of sections) {
    const contracts = document.getIn([section, "contracts"]);
    if (!isMap(contracts) || !contracts.items.length) throw new Error(`No contracts in ${section}`);
    for (const { key, value: entry } of contracts.items) {
      if (!isMap(entry)) throw new Error(`Invalid contract ${section}.${String(key)}`);
      for (const kind of ["checks", "proxyChecks", "implementationChecks"]) {
        const checks = entry.get(kind);
        if (checks === undefined && kind !== "checks") continue;
        const label = `${section}.${String(key)}.${kind}`;
        if (!isMap(checks)) throw new Error(`Missing check map: ${label}`);
        const name = entry.get(kind === "proxyChecks" ? "proxyName" : "name");
        if (typeof name !== "string") throw new Error(`Missing ABI name: ${label}`);
        const iface = new Interface(loadAbi(name));
        const functions = iface.fragments.filter((f): f is FunctionFragment => f.type === "function");
        const methods = checks.items.map(({ key: method }) => String(method));
        // state-mate requires all view/pure names to be acknowledged (null means explicitly skipped).
        if (kind !== "implementationChecks") {
          for (const f of functions) {
            if (["view", "pure"].includes(f.stateMutability) && !methods.includes(f.name)) {
              errors.push(`${label}: uncovered ${f.name}`);
            }
          }
        }
        for (const method of methods) {
          if (!functions.some((f) => f.name === method)) errors.push(`${label}: removed/unknown function ${method}`);
        }
        count++;
      }
    }
  }
  if (errors.length) throw new Error(`State-mate ABI drift:\n${[...new Set(errors)].join("\n")}`);
  return count;
}

export function checkScratchAbis(includeDg = false): number {
  const hardhat = findArtifacts(path.join(ROOT, "artifacts"));
  const forge = includeDg
    ? findArtifacts(path.join(ROOT, "foundry/lib/dual-governance/out"))
    : new Map<string, string[]>();
  return checkAbiCoverage(
    fs.readFileSync(path.join(__dirname, "scratch.yaml"), "utf8"),
    (name) => {
      const candidates = hardhat.get(name) ?? forge.get(name) ?? [];
      const artifactPath = [...candidates].sort((a, b) => a.length - b.length)[0];
      if (!artifactPath) throw new Error(`No compiled artifact for ${name}; compile contracts first`);
      return JSON.parse(fs.readFileSync(artifactPath, "utf8")).abi as InterfaceAbi;
    },
    includeDg ? ["l1", "l2"] : ["l1"],
  );
}

if (require.main === module) {
  console.log(
    `State-mate ABI consistency: ${checkScratchAbis(process.argv.includes("--include-dg"))} check maps passed`,
  );
}
