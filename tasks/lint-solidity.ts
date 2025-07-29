import { spawn } from "child_process";
import { subtask, task } from "hardhat/config";

// Files and their specific rule overrides
const fileOverrides: Record<string, string[]> = {
  "contracts/0.4.24/nos/NodeOperatorsRegistry.sol": ["gas-indexed-events"],
  "contracts/0.4.24/Lido.sol": ["gas-indexed-events"],
  "contracts/0.4.24/lib/StakeLimitUtils.sol": ["one-contract-per-file", "gas-strict-inequalities"],
  "contracts/0.4.24/lib/Packed64x4.sol": ["gas-strict-inequalities"],
  "contracts/0.4.24/lib/SigningKeys.sol": ["gas-strict-inequalities"],
  "contracts/0.4.24/utils/Versioned.sol": ["no-global-import"],
  "contracts/0.8.9/utils/Versioned.sol": ["no-global-import"],
  "contracts/0.8.9/utils/PausableUntil.sol": ["no-global-import"],
  "contracts/0.8.9/proxy/WithdrawalsManagerProxy.sol": ["one-contract-per-file"],
  "contracts/0.8.9/lib/ExitLimitUtils.sol": ["one-contract-per-file"],
  "contracts/0.8.9/proxy/OssifiableProxy.sol": ["no-unused-imports"],
};

// Function to filter solhint output
function filterOutput(output: string): string {
  const lines = output.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      result.push(line);
      i++;
      continue;
    }

    // Check if this line is a file header (doesn't start with spaces and contains .sol)
    if (!line.startsWith(" ") && line.includes(".sol")) {
      const currentFile = line.trim();
      const fileWarnings: string[] = [];
      let j = i + 1;

      // Collect all warning/error lines for this file
      while (j < lines.length) {
        const nextLine = lines[j];

        // If empty line, skip it but don't break
        if (nextLine.trim() === "") {
          j++;
          continue;
        }

        // If we hit another file header, break
        if (!nextLine.startsWith(" ") && nextLine.includes(".sol")) {
          break;
        }

        // This should be a warning/error line
        if (nextLine.startsWith(" ")) {
          const shouldIgnore =
            currentFile &&
            fileOverrides[currentFile] &&
            fileOverrides[currentFile].some((rule) => nextLine.includes(rule));
          if (!shouldIgnore) {
            fileWarnings.push(nextLine);
          }
        } else {
          // Non-space line that isn't a file header - add it as is
          fileWarnings.push(nextLine);
        }

        j++;
      }

      // Only add the file header and warnings if there are non-filtered warnings
      if (fileWarnings.length > 0) {
        result.push(line);
        result.push(...fileWarnings);
        result.push(""); // Add empty line after each file section
      }

      i = j;
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join("\n").trim();
}

async function runSolhintLinting(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["solhint", "--noPoster", "contracts/**/*.sol"], {
      stdio: ["inherit", "pipe", "pipe"],
      shell: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      const output = stdout || stderr;
      const filteredOutput = filterOutput(output);

      if (filteredOutput) {
        console.log(filteredOutput);
      }

      if (code !== 0 && filteredOutput) {
        process.exit(code || 1);
      }

      resolve();
    });

    child.on("error", (error) => {
      reject(error);
    });
  });
}

// Create both a subtask (for internal use) and a task (for CLI)
subtask("lint-solidity:internal", "Internal Solidity linting subtask").setAction(async () => {
  await runSolhintLinting();
});

task("lint-solidity", "Lint Solidity files with custom rule filtering").setAction(async () => {
  await runSolhintLinting();
});
