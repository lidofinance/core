import fs from "node:fs";
import path from "node:path";

import * as toml from "@iarna/toml";

/** Isolate runtime files while keeping compiler inputs and cache paths stable. */
export function createDGDeploymentDirectory(submodule: string, archiveRoot: string, chainId: number): string {
  submodule = path.resolve(submodule);
  fs.mkdirSync(archiveRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(archiveRoot, `${chainId}-`));
  const config = toml.parse(fs.readFileSync(path.join(submodule, "foundry.toml"), "utf8"));
  const profile = (config.profile as toml.JsonMap).default as toml.JsonMap;
  for (const key of ["src", "script", "test", "out", "cache_path"]) {
    profile[key] = path.resolve(submodule, profile[key] as string);
  }
  profile.libs = (profile.libs as string[]).map((entry) => path.resolve(submodule, entry));
  // Resolve project-root imports to the same physical sources in every run.
  const remappings = fs
    .readFileSync(path.join(submodule, "remappings.txt"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      return `${line.slice(0, separator + 1)}${path.resolve(submodule, line.slice(separator + 1))}/`;
    });
  profile.remappings = [
    ...remappings,
    ...["contracts", "scripts", "test"].map((name) => `${name}/=${path.join(submodule, name)}/`),
  ];
  fs.writeFileSync(path.join(directory, "foundry.toml"), toml.stringify(config));
  for (const name of ["deploy-config", "deploy-artifacts"]) fs.mkdirSync(path.join(directory, name));
  return directory;
}

/** A fresh runtime directory must contain exactly one artifact for this chain. */
export function pickDGDeploymentArtifact(chainId: number, artifactsDirectory: string): string {
  const pattern = new RegExp(`^deploy-artifact-${chainId}-\\d+\\.toml$`);
  const artifacts = fs.readdirSync(artifactsDirectory).filter((name) => pattern.test(name));
  if (artifacts.length !== 1) {
    throw new Error(
      `Expected exactly one DG deployment artifact for chain ${chainId} in ${artifactsDirectory}; found ${artifacts.length}`,
    );
  }
  return path.join(artifactsDirectory, artifacts[0]);
}
