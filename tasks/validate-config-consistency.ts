import fs from "fs";
import { task } from "hardhat/config";

import * as toml from "@iarna/toml";

// Re-implement parameter reading without hardhat dependencies
const UPGRADE_PARAMETERS_FILE = process.env.UPGRADE_PARAMETERS_FILE || "scripts/upgrade/upgrade-params-mainnet.toml";
const SCRATCH_PARAMETERS_FILE = process.env.SCRATCH_PARAMETERS_FILE || "scripts/scratch/deploy-params-testnet.toml";

interface UpgradeParameters {
  chainSpec: {
    slotsPerEpoch: number;
    secondsPerSlot: number;
    genesisTime: number;
    depositContract: string;
  };
  gateSealForVaults: {
    address: string;
  };
  validatorExitDelayVerifier: {
    gIFirstValidatorPrev: string;
    gIFirstValidatorCurr: string;
    gIFirstHistoricalSummaryPrev: string;
    gIFirstHistoricalSummaryCurr: string;
    gIFirstBlockRootInSummaryPrev: string;
    gIFirstBlockRootInSummaryCurr: string;
  };
  vaultHub: {
    relativeShareLimitBP: number;
  };
  lazyOracle: {
    quarantinePeriod: number;
    maxRewardRatioBP: number;
  };
  predepositGuarantee: {
    genesisForkVersion: string;
    gIndex: string;
    gIndexAfterChange: string;
    changeSlot: number;
  };
  delegation: {
    wethContract: string;
  };
  operatorGrid: Record<string, unknown>;
  aragonAppVersions: Record<string, unknown>;
  burner: {
    isMigrationAllowed: boolean;
  };
  oracleVersions: Record<string, unknown>;
  triggerableWithdrawals: Record<string, unknown>;
  triggerableWithdrawalsGateway: Record<string, unknown>;
}

interface ScratchParameters {
  chainSpec: {
    slotsPerEpoch: number;
    secondsPerSlot: number;
  };
  gateSeal: {
    sealDuration: number;
    expiryTimestamp: number;
    sealingCommittee: string[];
  };
  lidoApm: {
    ensName: string;
    ensRegDurationSec: number;
  };
  dao: Record<string, unknown>;
  vesting: Record<string, unknown>;
  burner: {
    isMigrationAllowed: boolean;
  };
  vaultHub: {
    maxRelativeShareLimitBP: number;
  };
  lazyOracle: {
    quarantinePeriod: number;
    maxRewardRatioBP: number;
  };
  predepositGuarantee: {
    genesisForkVersion: string;
    gIndex: string;
    gIndexAfterChange: string;
    changeSlot: number;
  };
  operatorGrid: Record<string, unknown>;
  appVersions: Record<string, unknown>;
  triggerableWithdrawalsGateway: Record<string, unknown>;
}

function readUpgradeParameters(): UpgradeParameters {
  if (!fs.existsSync(UPGRADE_PARAMETERS_FILE)) {
    throw new Error(`Upgrade parameters file not found: ${UPGRADE_PARAMETERS_FILE}`);
  }

  const content = fs.readFileSync(UPGRADE_PARAMETERS_FILE, "utf8");
  return toml.parse(content) as unknown as UpgradeParameters;
}

function readScratchParameters(): ScratchParameters {
  if (!fs.existsSync(SCRATCH_PARAMETERS_FILE)) {
    throw new Error(`Scratch parameters file not found: ${SCRATCH_PARAMETERS_FILE}`);
  }

  const content = fs.readFileSync(SCRATCH_PARAMETERS_FILE, "utf8");
  return toml.parse(content) as unknown as ScratchParameters;
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

function validateParameterConsistency(): {
  results: ValidationResult[];
  missingInScratch: MissingInScratch[];
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

  // Get all paths from upgrade config
  const upgradePaths = getAllPaths(upgradeParams);

  for (const path of upgradePaths) {
    const upgradeValue = getNestedValue(upgradeParams, path);

    // Check if this path should be mapped to a different path in scratch
    const scratchPath = PATH_MAPPINGS[path] || path;
    const existsInScratch = hasPath(scratchParams, scratchPath);

    if (!existsInScratch) {
      missingInScratch.push({
        path,
        upgradeValue,
      });
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

  return { results, missingInScratch, matchCount, totalChecked };
}

task("validate-config-consistency", "Validate configuration consistency between upgrade and scratch parameters")
  .addFlag("silent", "Run in silent mode (no output on success)")
  .setAction(async (taskArgs) => {
    const silent = taskArgs.silent;

    if (!silent) {
      console.log("🔍 Validating configuration consistency between upgrade and scratch parameters...\n");
    }

    const { results, missingInScratch, matchCount, totalChecked } = validateParameterConsistency();

    let unexpectedMismatches = 0;
    const expectedDifferencesFound = results.filter((r) => !r.match && isExpectedDifference(r.path.split(" -> ")[0]));

    if (!silent) {
      console.log("📊 Parameter Comparison Results:");
      console.log("=".repeat(80));

      for (const result of results) {
        const status = result.match ? "✅ MATCH" : "❌ MISMATCH";
        console.log(`${status} ${result.path}`);

        if (!result.match) {
          // Check if this is an expected difference
          if (!isExpectedDifference(result.path.split(" -> ")[0])) {
            unexpectedMismatches++;
            console.log(`  Upgrade: ${JSON.stringify(result.upgradeValue)}`);
            console.log(`  Scratch: ${JSON.stringify(result.scratchValue)}`);
          }
        }
      }

      if (missingInScratch.length > 0) {
        console.log("\n📋 Parameters present in upgrade but missing in scratch:");
        console.log("=".repeat(80));

        for (const missing of missingInScratch) {
          console.log(`⚠️  ${missing.path}`);
          console.log(`   Value: ${JSON.stringify(missing.upgradeValue)}`);
        }
      }

      console.log("\n📋 Expected Differences (by design):");
      console.log("=".repeat(80));

      for (const result of expectedDifferencesFound) {
        const originalPath = result.path.split(" -> ")[0];
        const expectedDiff = EXPECTED_DIFFERENCES.find((diff) => originalPath.startsWith(diff.path));
        console.log(`ℹ️  ${result.path}`);
        console.log(`   Reason: ${expectedDiff?.reason}`);
        console.log(`   Upgrade: ${JSON.stringify(result.upgradeValue)}`);
        console.log(`   Scratch: ${JSON.stringify(result.scratchValue)}\n`);
      }

      console.log("📈 Summary:");
      console.log("=".repeat(80));

      console.log(`✅ Matching parameters: ${matchCount}/${totalChecked}`);
      console.log(`ℹ️  Expected differences: ${expectedDifferencesFound.length}`);
      console.log(`📋 Missing in scratch: ${missingInScratch.length}`);
    } else {
      // In silent mode, count unexpected mismatches without logging details
      for (const result of results) {
        if (!result.match && !isExpectedDifference(result.path.split(" -> ")[0])) {
          unexpectedMismatches++;
        }
      }
    }

    if (unexpectedMismatches > 0) {
      if (!silent) {
        console.log(`❌ Unexpected mismatches: ${unexpectedMismatches}`);
        console.log("\n⚠️  Configuration validation FAILED!");
        console.log("Please review the mismatched parameters and ensure they are intentional.");
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
          console.log("\n📋 Parameters present in upgrade but missing in scratch:");
          console.log("=".repeat(80));

          for (const missing of missingInScratch) {
            console.log(`⚠️  ${missing.path}`);
            console.log(`   Value: ${JSON.stringify(missing.upgradeValue)}`);
          }
        }

        console.log(`\n❌ Unexpected mismatches: ${unexpectedMismatches}`);
        console.log("Please review the mismatched parameters and ensure they are intentional.");
      }
      process.exit(1);
    } else {
      if (!silent) {
        console.log(`✅ Configuration validation PASSED!`);
        console.log("All parameters that should match are consistent between upgrade and scratch configs.");
      }
    }
  });
