import fs from "node:fs/promises";
import path from "node:path";

import { task } from "hardhat/config";

import { log, yl } from "#lib/log.js";

const ABI_OUTPUT_PATH = path.resolve(process.cwd(), "lib", "abi");
const LIDO_ARTIFACT_PREFIX = "contracts/";
const ARAGON_ARTIFACT_PATHS = [
  "@aragon/apps-finance/contracts/Finance.sol:Finance",
  "@aragon/apps-vault/contracts/Vault.sol:Vault",
  "@aragon/apps-lido/apps/voting/contracts/Voting.sol:Voting",
  "@aragon/apps-lido/apps/token-manager/contracts/TokenManager.sol:TokenManager",
];

const SKIP_NAMES_REGEX = /(Mock|Harness|test_helpers|Imports|deposit_contract|Pausable|.dbg.json|build-info)/;

export const extractAbisTask = task("abis:extract", "Extract ABIs from artifacts")
  .setInlineAction(async (_, hre) => {
    await hre.tasks.getTask("clean").run();
    await hre.tasks.getTask("compile").run();

    const artifactNames = [...(await hre.artifacts.getAllFullyQualifiedNames())];

    const artifactNamesToPublish = artifactNames
      .filter((name) => !SKIP_NAMES_REGEX.test(name) && name.startsWith(LIDO_ARTIFACT_PREFIX))
      .concat(ARAGON_ARTIFACT_PATHS);

    await fs.rm(ABI_OUTPUT_PATH, { recursive: true, force: true });
    await fs.mkdir(ABI_OUTPUT_PATH, { recursive: true });

    for (const name of artifactNamesToPublish) {
      const artifact = await hre.artifacts.readArtifact(name);
      if (artifact.abi && artifact.abi.length > 0) {
        const abiData = JSON.stringify(artifact.abi, null, 2);
        await fs.writeFile(path.join(ABI_OUTPUT_PATH, `${artifact.contractName}.json`), abiData);
        log.success(`ABI for ${yl(artifact.contractName)} has been saved!`);
      }
    }

    log.success("All ABIs have been extracted and saved!");
  })
  .build();
