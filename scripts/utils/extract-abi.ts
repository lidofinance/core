import fs from "node:fs/promises";
import path from "node:path";

type Artifact = {
  contractName: string;
  abi: Record<string, unknown>[];
};

const ARTIFACTS_PATH = path.resolve(process.cwd(), "artifacts");
const ABIS_PATH = path.resolve(process.cwd(), "lib", "abi");

const LIDO_ARTIFACT_PREFIX = "contracts/";

const ARAGON_ARTIFACT_PATHS = [
  "@aragon/apps-finance/contracts/Finance.sol/Finance.json",
  "@aragon/apps-vault/contracts/Vault.sol/Vault.json",
  "@aragon/apps-lido/apps/voting/contracts/Voting.sol/Voting.json",
  "@aragon/apps-lido/apps/token-manager/contracts/TokenManager.sol/TokenManager.json",
];

const SKIP_NAMES_REGEX = /(Mock|test_helpers|Imports|deposit_contract|Pausable|.dbg.json|build-info|interfaces)/;

async function exportABIs(): Promise<void> {
  const artifactPaths = await getArtifacts(ARTIFACTS_PATH);
  const paths = artifactPaths
    .map((p) => path.relative(ARTIFACTS_PATH, p))
    .filter((p) => !SKIP_NAMES_REGEX.test(p))
    .filter((p) => p.startsWith(LIDO_ARTIFACT_PREFIX))
    .concat(ARAGON_ARTIFACT_PATHS);

  await extractABIs(paths, ABIS_PATH);
}

async function extractABIs(artifactPaths: string[], abiPath: string): Promise<void> {
  await prepareDirectory(abiPath);

  for (const artifactPath of artifactPaths) {
    const artifact = await loadArtifact(artifactPath);
    if (artifact.abi && artifact.abi.length > 0) {
      await saveABI(artifact, abiPath);
    }
  }
}

async function prepareDirectory(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (error) {
    // Ignore
  } finally {
    await fs.mkdir(dir, { recursive: true });
  }
}

async function loadArtifact(artifactPath: string): Promise<Artifact> {
  const artifactContent = await fs.readFile(path.join(ARTIFACTS_PATH, artifactPath), "utf-8");
  return JSON.parse(artifactContent);
}

async function saveABI(artifact: Artifact, abiPath: string): Promise<void> {
  console.log(`Extracting ABI for ${artifact.contractName}...`);
  const abiData = JSON.stringify(artifact.abi);
  await fs.writeFile(path.join(abiPath, `${artifact.contractName}.json`), abiData);
}

async function getArtifacts(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((dirent) => {
      const res = path.join(dir, dirent.name);
      return dirent.isDirectory() ? getArtifacts(res) : res;
    }),
  );
  return files.flat();
}

exportABIs()
  .then(() => console.log(`All done!`))
  .catch((err: Error) => {
    console.error(err.stack);
    process.exit(10);
  });
