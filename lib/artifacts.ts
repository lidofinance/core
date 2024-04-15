import fs from "fs";
import { artifacts } from "hardhat";
import path from "path";

export async function loadArtifact(artifactName: string, networkName: string) {
  if (artifactName.startsWith("external:")) {
    let extArtifactsDir = path.resolve(__dirname, "..", "scripts", "external-artifacts", networkName);
    if (!fs.existsSync(extArtifactsDir)) {
      // fallback to mainnet
      extArtifactsDir = path.resolve(__dirname, "..", "scripts", "external-artifacts", "default");
    }
    const artifactPath = path.join(extArtifactsDir, artifactName.substring(9) + ".json");
    return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  } else {
    return await artifacts.readArtifact(artifactName);
  }
}
