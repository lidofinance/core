import fs from "fs";
import { task } from "hardhat/config";

import * as toml from "@iarna/toml";

import {
  safeValidateScratchParameters,
  safeValidateUpgradeParameters,
  ScratchParameters,
  UpgradeParameters,
} from "lib/config-schemas";

// Re-implement parameter reading without hardhat dependencies
const UPGRADE_PARAMETERS_FILE = process.env.UPGRADE_PARAMETERS_FILE || "scripts/upgrade/upgrade-params-mainnet.toml";
const SCRATCH_DEPLOY_CONFIG = process.env.SCRATCH_DEPLOY_CONFIG || "scripts/scratch/deploy-params-testnet.toml";

function readUpgradeParameters(): UpgradeParameters {
  if (!fs.existsSync(UPGRADE_PARAMETERS_FILE)) {
    throw new Error(`Upgrade parameters file not found: ${UPGRADE_PARAMETERS_FILE}`);
  }

  const content = fs.readFileSync(UPGRADE_PARAMETERS_FILE, "utf8");
  const parsedData = toml.parse(content);
  const result = safeValidateUpgradeParameters(parsedData);

  if (!result.success) {
    throw new Error(`Invalid upgrade parameters: ${result.error.message}`);
  }

  return result.data;
}

function readScratchParameters(): ScratchParameters {
  if (!fs.existsSync(SCRATCH_DEPLOY_CONFIG)) {
    throw new Error(`Scratch parameters file not found: ${SCRATCH_DEPLOY_CONFIG}`);
  }

  const content = fs.readFileSync(SCRATCH_DEPLOY_CONFIG, "utf8");
  const parsedData = toml.parse(content);
  const result = safeValidateScratchParameters(parsedData);

  if (!result.success) {
    throw new Error(`Invalid scratch parameters: ${result.error.message}`);
  }

  return result.data;
}

interface ValidationResult {
  path: string;
  upgradeValue: unknown;
  scratchValue: unknown;
  match: boolean;
  existsInScratch: boolean;
}

interface MissingInScratch {
  path: string;
  upgradeValue: unknown;
}

// Parameters that should intentionally differ between upgrade and scratch
const EXPECTED_DIFFERENCES = [
  {
    path: "burner.isMigrationAllowed",
    reason: "Upgrade needs migration enabled (true), scratch disables it (false)",
  },
  {
    path: "delegation.wethContract",
    reason: "Delegation is upgrade-specific configuration",
  },
  {
    path: "gateSealForVaults.address",
    reason: "Gate seal address differs between upgrade and scratch contexts",
  },
];

// Parameters that are expected to be missing in scratch (upgrade-only)
const EXPECTED_MISSING_IN_SCRATCH = [
  {
    path: "chainSpec.genesisTime",
    reason: "Genesis time is set via environment variables in scratch deployment",
  },
  {
    path: "chainSpec.depositContract",
    reason: "Deposit contract address is set via environment variables in scratch deployment",
  },
  {
    path: "chainSpec.isHoodi",
    reason: "Scratch is on fork",
  },
  {
    path: "gateSealForVaults.address",
    reason: "Gate seal configuration differs between upgrade and scratch contexts",
  },
  {
    path: "gateSealForVaults.sealingCommittee",
    reason: "Gate seal configuration differs between upgrade and scratch contexts",
  },
  {
    path: "gateSealForVaults.sealDuration",
    reason: "Gate seal configuration differs between upgrade and scratch contexts",
  },
  {
    path: "easyTrack.vaultsAdapter",
    reason: "EasyTrack configuration is upgrade-specific",
  },
  {
    path: "easyTrack.trustedCaller",
    reason: "EasyTrack configuration is upgrade-specific",
  },
  {
    path: "easyTrack.initialValidatorExitFeeLimit",
    reason: "EasyTrack configuration is upgrade-specific",
  },
  {
    path: "easyTrack.maxGroupShareLimit",
    reason: "EasyTrack configuration is upgrade-specific",
  },
  {
    path: "easyTrack.maxDefaultTierShareLimit",
    reason: "EasyTrack configuration is upgrade-specific",
  },
  {
    path: "easyTrack.newFactories",
    reason: "EasyTrack new factories configuration is upgrade-specific",
  },
  {
    path: "predepositGuarantee.genesisForkVersion",
    reason: "Genesis fork version is upgrade-specific configuration",
  },
  {
    path: "delegation.wethContract",
    reason: "Delegation is upgrade-specific configuration",
  },
  {
    path: "oracleVersions.vebo_consensus_version",
    reason: "Oracle versions are upgrade-specific configuration",
  },
  {
    path: "oracleVersions.ao_consensus_version",
    reason: "Oracle versions are upgrade-specific configuration",
  },
  {
    path: "v3VoteScript.expiryTimestamp",
    reason: "V3 vote script expiry timestamp is upgrade-specific configuration",
  },
  {
    path: "v3VoteScript.initialMaxExternalRatioBP",
    reason: "V3 vote script initial max external ratio BP is upgrade-specific configuration",
  },
];

// Special mappings where the same concept has different names
const PATH_MAPPINGS: Record<string, string> = {
  "vaultHub.relativeShareLimitBP": "vaultHub.maxRelativeShareLimitBP",
  "aragonAppVersions": "appVersions", // Handle different naming
};

function getNestedValue(obj: unknown, path: string): unknown {
  return path.split(".").reduce((current, key) => {
    if (current && typeof current === "object" && key in current) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function hasPath(obj: unknown, path: string): boolean {
  const keys = path.split(".");
  let current = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object" || !(key in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return true;
}

function getAllPaths(obj: unknown, currentPath: string = ""): string[] {
  const paths: string[] = [];

  if (obj === null || obj === undefined) {
    return paths;
  }

  if (typeof obj !== "object" || Array.isArray(obj)) {
    if (currentPath) {
      paths.push(currentPath);
    }
    return paths;
  }

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj as Record<string, unknown>, key)) {
      const newPath = currentPath ? `${currentPath}.${key}` : key;
      const subPaths = getAllPaths((obj as Record<string, unknown>)[key], newPath);
      if (subPaths.length === 0) {
        paths.push(newPath);
      } else {
        paths.push(...subPaths);
      }
    }
  }

  return paths;
}

function isExpectedDifference(path: string): boolean {
  return EXPECTED_DIFFERENCES.some((diff) => path.startsWith(diff.path));
}

function isExpectedMissingInScratch(path: string): boolean {
  return EXPECTED_MISSING_IN_SCRATCH.some((missing) => path.startsWith(missing.path));
}

function validateParameterConsistency(): {
  results: ValidationResult[];
  missingInScratch: MissingInScratch[];
  expectedMissingInScratch: MissingInScratch[];
  matchCount: number;
  totalChecked: number;
} {
  let upgradeParams: UpgradeParameters;
  let scratchParams: ScratchParameters;

  try {
    upgradeParams = readUpgradeParameters();
  } catch (error) {
    console.error("❌ Failed to read upgrade parameters:", (error as Error).message);
    process.exit(1);
  }

  try {
    scratchParams = readScratchParameters();
  } catch (error) {
    console.error("❌ Failed to read scratch parameters:", (error as Error).message);
    process.exit(1);
  }

  const results: ValidationResult[] = [];
  const missingInScratch: MissingInScratch[] = [];
  const expectedMissingInScratch: MissingInScratch[] = [];

  // Get all paths from upgrade config
  const upgradePaths = getAllPaths(upgradeParams);

  for (const path of upgradePaths) {
    const upgradeValue = getNestedValue(upgradeParams, path);

    // Check if this path should be mapped to a different path in scratch
    const scratchPath = PATH_MAPPINGS[path] || path;
    const existsInScratch = hasPath(scratchParams, scratchPath);

    if (!existsInScratch) {
      const missingParam = {
        path,
        upgradeValue,
      };

      if (isExpectedMissingInScratch(path)) {
        expectedMissingInScratch.push(missingParam);
      } else {
        missingInScratch.push(missingParam);
      }
      continue;
    }

    const scratchValue = getNestedValue(scratchParams, scratchPath);
    const match = JSON.stringify(upgradeValue) === JSON.stringify(scratchValue);

    results.push({
      path: path === scratchPath ? path : `${path} -> ${scratchPath}`,
      upgradeValue,
      scratchValue,
      match,
      existsInScratch: true,
    });
  }

  const matchCount = results.filter((r) => r.match).length;
  const totalChecked = results.length;

  return { results, missingInScratch, expectedMissingInScratch, matchCount, totalChecked };
}

task("validate-configs", "Validate configuration consistency between upgrade and scratch parameters")
  .addFlag("silent", "Run in silent mode (no output on success)")
  .setAction(async (taskArgs) => {
    const silent = taskArgs.silent;

    if (!silent) {
      console.log("🔍 Validating configuration consistency between upgrade and scratch parameters...\n");
    }

    const { results, missingInScratch, expectedMissingInScratch, matchCount, totalChecked } =
      validateParameterConsistency();

    let unexpectedMismatches = 0;
    const expectedDifferencesFound = results.filter((r) => !r.match && isExpectedDifference(r.path.split(" -> ")[0]));

    if (!silent) {
      console.log("📊 Parameter Comparison Results:");
      console.log("=".repeat(80));

      for (const result of results) {
        const isExpected = !result.match ? isExpectedDifference(result.path.split(" -> ")[0]) : false;
        let status: string;
        if (result.match) {
          status = "✅ MATCH";
        } else if (isExpected) {
          status = "🆗 EXPECTED MISMATCH";
        } else {
          status = "❌ MISMATCH";
        }
        console.log(`${status} ${result.path}`);

        if (!result.match && !isExpected) {
          unexpectedMismatches++;
          console.log(`  Upgrade: ${JSON.stringify(result.upgradeValue)}`);
          console.log(`  Scratch: ${JSON.stringify(result.scratchValue)}`);
        }
      }

      if (missingInScratch.length > 0) {
        console.log("\n📋 Unexpected parameters missing in scratch:");
        console.log("=".repeat(80));

        for (const missing of missingInScratch) {
          console.log(`⚠️  ${missing.path} - Value: ${JSON.stringify(missing.upgradeValue)}`);
        }
      }

      if (expectedMissingInScratch.length > 0) {
        console.log("\n📋 Expected parameters missing in scratch (by design):");
        console.log("=".repeat(80));

        for (const missing of expectedMissingInScratch) {
          const expectedMissing = EXPECTED_MISSING_IN_SCRATCH.find((exp) => missing.path.startsWith(exp.path));
          console.log(
            `ℹ️  ${missing.path} - Reason: ${expectedMissing?.reason} - Value: ${JSON.stringify(missing.upgradeValue)}`,
          );
        }
      }

      console.log("\n📋 Expected Differences (by design):");
      console.log("=".repeat(80));

      for (const result of expectedDifferencesFound) {
        const originalPath = result.path.split(" -> ")[0];
        const expectedDiff = EXPECTED_DIFFERENCES.find((diff) => originalPath.startsWith(diff.path));
        console.log(
          `ℹ️  ${result.path} - Reason: ${expectedDiff?.reason} - Upgrade: ${JSON.stringify(result.upgradeValue)} - Scratch: ${JSON.stringify(result.scratchValue)}`,
        );
      }

      console.log("📈 Summary:");
      console.log("=".repeat(80));

      console.log(`✅ Matching parameters: ${matchCount}/${totalChecked}`);
      console.log(`ℹ️  Expected differences: ${expectedDifferencesFound.length}`);
      console.log(`📋 Unexpected missing in scratch: ${missingInScratch.length}`);
      console.log(`📋 Expected missing in scratch: ${expectedMissingInScratch.length}`);
    } else {
      // In silent mode, count unexpected mismatches without logging details
      for (const result of results) {
        if (!result.match && !isExpectedDifference(result.path.split(" -> ")[0])) {
          unexpectedMismatches++;
        }
      }
    }

    if (unexpectedMismatches > 0 || missingInScratch.length > 0) {
      if (!silent) {
        console.log(`❌ Unexpected mismatches: ${unexpectedMismatches}`);
        console.log(`❌ Unexpected missing parameters: ${missingInScratch.length}`);
        console.log("\n⚠️  Configuration validation FAILED!");
        console.log("Please review the mismatched and missing parameters and ensure they are intentional.");
      } else {
        // In silent mode, show details on failure
        console.log("❌ Configuration validation FAILED!");
        console.log("📊 Parameter Comparison Results:");
        console.log("=".repeat(80));

        for (const result of results) {
          if (!result.match && !isExpectedDifference(result.path.split(" -> ")[0])) {
            console.log(`❌ MISMATCH ${result.path}`);
            console.log(`  Upgrade: ${JSON.stringify(result.upgradeValue)}`);
            console.log(`  Scratch: ${JSON.stringify(result.scratchValue)}`);
          }
        }

        if (missingInScratch.length > 0) {
          console.log("\n📋 Unexpected parameters missing in scratch:");
          console.log("=".repeat(80));

          for (const missing of missingInScratch) {
            console.log(`⚠️  ${missing.path} - Value: ${JSON.stringify(missing.upgradeValue)}`);
          }
        }

        console.log(`\n❌ Unexpected mismatches: ${unexpectedMismatches}`);
        console.log(`❌ Unexpected missing parameters: ${missingInScratch.length}`);
        console.log("Please review the mismatched and missing parameters and ensure they are intentional.");
      }
      process.exit(1);
    } else {
      if (!silent) {
        console.log(`✅ Configuration validation PASSED!`);
        console.log("All parameters that should match are consistent between upgrade and scratch configs.");
      }
    }
  });
