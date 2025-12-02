import { execSync, SpawnSyncReturns } from "child_process";
import { task } from "hardhat/config";

interface RuleOverride {
  ruleId: string;
  line?: number; // Optional line number - if specified, only filter warnings on this specific line
  // If not specified, filter ALL occurrences of this rule in the file
}

// Helper functions for clearer override definitions
const ruleOnLine = (ruleId: string, line: number): RuleOverride => ({ ruleId, line });
const allOccurrences = (ruleId: string): RuleOverride => ({ ruleId });

// Files and their specific rule overrides with optional line numbers
const fileOverrides: Record<string, RuleOverride[]> = {
  "contracts/0.4.24/lib/StakeLimitUtils.sol": [ruleOnLine("one-contract-per-file", 5)],
  "contracts/0.4.24/utils/Versioned.sol": [ruleOnLine("no-global-import", 5)],
  "contracts/0.8.9/utils/Versioned.sol": [ruleOnLine("no-global-import", 6)],
  "contracts/0.8.9/utils/PausableUntil.sol": [ruleOnLine("no-global-import", 5)],
  "contracts/0.8.9/lib/ExitLimitUtils.sol": [ruleOnLine("one-contract-per-file", 3)],
  "contracts/0.8.9/proxy/OssifiableProxy.sol": [ruleOnLine("no-unused-import", 7)],
  "contracts/0.8.9/WithdrawalQueueBase.sol": [ruleOnLine("no-global-import", 7)],
  "contracts/common/lib/ECDSA.sol": [allOccurrences("gas-custom-errors")],
  "contracts/common/lib/MemUtils.sol": [ruleOnLine("gas-custom-errors", 50)],
  "contracts/common/lib/TriggerableWithdrawals.sol": [ruleOnLine("state-visibility", 13)],
};

interface SolhintWarning {
  filePath: string;
  ruleId: string;
  severity: string;
  message: string;
  line: number;
  column: number;
}

interface SolhintReport {
  filePath: string;
  reports: SolhintWarning[];
}

// Function to filter solhint JSON output
function filterJsonOutput(jsonOutput: string): {
  filteredReports: SolhintReport[];
  totalWarnings: number;
  filteredWarnings: number;
} {
  let warnings: SolhintWarning[];

  try {
    const parsed = JSON.parse(jsonOutput);
    // Filter out the conclusion object that solhint adds at the end
    warnings = parsed.filter((item: SolhintWarning) => item.filePath && item.ruleId);
  } catch (error) {
    console.error("Failed to parse solhint JSON output:", error);
    return { filteredReports: [], totalWarnings: 0, filteredWarnings: 0 };
  }

  const totalWarnings = warnings.length;
  let filteredWarnings = 0;

  // Group warnings by file path
  const warningsByFile = new Map<string, SolhintWarning[]>();

  warnings.forEach((warning) => {
    const overriddenRules = fileOverrides[warning.filePath] || [];
    const shouldIgnore = overriddenRules.some((override) => {
      // Check if rule matches
      if (override.ruleId !== warning.ruleId) {
        return false;
      }
      // If line number is specified, check if it matches; otherwise ignore all occurrences of this rule
      return override.line === undefined || override.line === warning.line;
    });

    if (shouldIgnore) {
      filteredWarnings++;
      return;
    }

    if (!warningsByFile.has(warning.filePath)) {
      warningsByFile.set(warning.filePath, []);
    }
    warningsByFile.get(warning.filePath)!.push(warning);
  });

  // Convert to SolhintReport format
  const filteredReports: SolhintReport[] = Array.from(warningsByFile.entries()).map(([filePath, reports]) => ({
    filePath,
    reports,
  }));

  return { filteredReports, totalWarnings, filteredWarnings };
}

// Function to format filtered output for display
function formatOutput(filteredReports: SolhintReport[]): string {
  if (filteredReports.length === 0) {
    return "";
  }

  const lines: string[] = [];

  filteredReports.forEach((report) => {
    lines.push(report.filePath);

    report.reports.forEach((item) => {
      const severityText = item.severity === "Warning" ? "Warning" : "Error";
      lines.push(`  ${item.line}:${item.column}  ${severityText}  ${item.message}  ${item.ruleId}`);
    });

    lines.push("");
  });

  return lines.join("\n").trim();
}

async function runSolhintLinting(): Promise<void> {
  try {
    const output = execSync("npx solhint --formatter json --noPoster --disc 'contracts/**/*.sol'", {
      encoding: "utf8",
      shell: "/bin/bash",
    });

    const { filteredReports, totalWarnings, filteredWarnings } = filterJsonOutput(output);
    const formattedOutput = formatOutput(filteredReports);

    if (formattedOutput) {
      console.log(formattedOutput);
    }

    const remainingWarnings = totalWarnings - filteredWarnings;
    if (remainingWarnings > 0) {
      console.log(
        `\nFound ${remainingWarnings} unfiltered warning(s) out of ${totalWarnings} total (${filteredWarnings} filtered out)`,
      );
      process.exit(1);
    } else if (filteredWarnings > 0) {
      console.log(`\nAll ${totalWarnings} warning(s) were filtered out`);
    } else {
      console.log("\nNo warnings found");
    }
  } catch (error_) {
    const error = error_ as SpawnSyncReturns<string>;
    if (error.status !== 0) {
      console.error("Error running solhint:", { stderr: error.stderr, stdout: error.stdout });

      // solhint found issues, parse the output
      const { filteredReports, totalWarnings, filteredWarnings } = filterJsonOutput(
        error.stdout || error.output?.toString() || "",
      );
      const formattedOutput = formatOutput(filteredReports);

      if (formattedOutput) {
        console.log(formattedOutput);
      }

      const remainingWarnings = totalWarnings - filteredWarnings;
      if (remainingWarnings > 0) {
        console.log(
          `\nFound ${remainingWarnings} unfiltered warning(s) out of ${totalWarnings} total (${filteredWarnings} filtered out)`,
        );
        process.exit(1);
      } else if (filteredWarnings > 0) {
        console.log(`\nAll ${totalWarnings} warning(s) were filtered out`);
      }
    } else {
      console.error("Error running solhint:", (error_ as Error).message);
      process.exit(1);
    }
  }
}

task("lint-solidity", "Lint Solidity files with custom rule filtering").setAction(async () => {
  await runSolhintLinting();
});
