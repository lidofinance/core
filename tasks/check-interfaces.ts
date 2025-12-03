import fs from "node:fs";
import path from "node:path";

import { task } from "hardhat/config";

const SKIP_NAMES_REGEX = /(^@|Mock|Harness|deposit_contract|build-info|^test)/;

const PAIRS_TO_SKIP: {
  interfaceFqn: string;
  contractFqn: string;
  reason: string;
  skipInterfaceSignatures?: string[];
}[] = [
  {
    interfaceFqn: "contracts/0.4.24/Lido.sol:IOracleReportSanityChecker",
    contractFqn: "contracts/0.8.9/sanity_checks/OracleReportSanityChecker.sol:OracleReportSanityChecker",
    reason: "Fixing requires Lido redeploy",
  },
  {
    interfaceFqn: "contracts/0.4.24/Lido.sol:IWithdrawalQueue",
    contractFqn: "contracts/0.8.9/WithdrawalQueue.sol:WithdrawalQueue",
    reason: "Fixing requires Lido redeploy",
  },
  {
    interfaceFqn: "contracts/0.4.24/oracle/LegacyOracle.sol:IHashConsensus",
    contractFqn: "contracts/0.8.9/oracle/HashConsensus.sol:HashConsensus",
    reason: "LegacyOracle is deprecated",
  },
  {
    interfaceFqn: "contracts/0.8.9/Burner.sol:IStETH",
    contractFqn: "contracts/0.4.24/StETH.sol:StETH",
    reason: "Fixing requires Burner redeploy",
  },
  {
    interfaceFqn: "contracts/0.8.9/WithdrawalQueue.sol:IStETH",
    contractFqn: "contracts/0.4.24/StETH.sol:StETH",
    reason: "Fixing requires WithdrawalQueue redeploy",
  },
  {
    interfaceFqn: "contracts/0.8.25/vaults/dashboard/Dashboard.sol:IWstETH",
    contractFqn: "contracts/0.6.12/WstETH.sol:WstETH",
    reason: "Cannot redeploy WstETH",
  },
  {
    interfaceFqn: "contracts/0.8.9/Burner.sol:ILido",
    contractFqn: "contracts/0.4.24/Lido.sol:Lido",
    reason: "Parameter name mismatches - fixing requires Burner redeploy",
    skipInterfaceSignatures: [
      "function allowance(address owner, address spender) returns (uint256)",
      "function approve(address spender, uint256 amount) returns (bool)",
      "function balanceOf(address account) returns (uint256)",
      "function transfer(address recipient, uint256 amount) returns (bool)",
      "function transferFrom(address sender, address recipient, uint256 amount) returns (bool)",
    ],
  },
];

task("check-interfaces").setAction(async (_, hre) => {
  const mismatchedInterfaces: {
    interfaceFqn: string;
    contractFqn: string;
    missingInContract: string[];
    missingInInterface: string[];
    isFullMatchExpected: boolean;
    parameterNameMismatches: string[];
  }[] = [];

  console.log("Checking interfaces defined within contracts...");

  const artifactNames = (await hre.artifacts.getAllFullyQualifiedNames()).filter(
    (name) => !SKIP_NAMES_REGEX.test(name),
  );

  // Helper to get contract name from fully qualified name
  function getContractName(fqn: string): string {
    const parts = fqn.split(":");
    return parts[parts.length - 1];
  }

  // Helper to extract interfaces defined within a contract file
  async function extractInterfacesFromContract(contractFqn: string): Promise<
    {
      interfaceName: string;
      interfaceFqn: string;
      sourceCode: string;
    }[]
  > {
    const interfaces: { interfaceName: string; interfaceFqn: string; sourceCode: string }[] = [];

    try {
      const artifact = await hre.artifacts.readArtifact(contractFqn);
      if (!artifact.sourceName) return interfaces;

      const sourcePath = path.join(hre.config.paths.root, artifact.sourceName);
      if (!fs.existsSync(sourcePath)) return interfaces;

      const sourceCode = fs.readFileSync(sourcePath, "utf8");

      // Find all interface definitions in the source code
      const interfaceRegex = /interface\s+(\w+)(?:\s+is\s+[^{]*)?\s*{([^}]*)}/g;
      let match;

      while ((match = interfaceRegex.exec(sourceCode)) !== null) {
        const interfaceName = match[1];
        const interfaceBody = match[2];

        // Skip interfaces that are just imports or external interfaces
        if (interfaceName.startsWith("I") && interfaceBody.trim().length > 0) {
          const interfaceFqn = `${artifact.sourceName}:${interfaceName}`;
          interfaces.push({
            interfaceName,
            interfaceFqn,
            sourceCode: interfaceBody,
          });
        }
      }
    } catch {
      // Skip contracts that can't be read
    }

    return interfaces;
  }

  // Helper to find corresponding contract for an interface
  function findCorrespondingContract(interfaceName: string): string | null {
    // Remove the "I" prefix to get the contract name
    const contractName = interfaceName.startsWith("I") ? interfaceName.slice(1) : interfaceName;

    // Look for a contract with the same name
    const contractFqn = artifactNames.find(
      (name) => getContractName(name) === contractName && !name.includes("/interfaces/"),
    );

    return contractFqn || null;
  }

  // Helper to find all contracts that use a given interface
  async function findContractsUsingInterface(interfaceName: string): Promise<string[]> {
    const usingContracts: string[] = [];

    for (const artifactName of artifactNames) {
      if (artifactName.includes("/interfaces/")) {
        continue; // Skip interface files themselves
      }

      try {
        const artifact = await hre.artifacts.readArtifact(artifactName);
        if (!artifact.sourceName) continue;

        const sourcePath = path.join(hre.config.paths.root, artifact.sourceName);
        if (!fs.existsSync(sourcePath)) continue;

        const sourceCode = fs.readFileSync(sourcePath, "utf8");

        // Check if this contract uses the interface
        const importPatterns = [
          // Direct import: import {IInterface} from "...";
          new RegExp(`import\\s*{[^}]*\\b${interfaceName}\\b[^}]*}\\s*from\\s*["'][^"']*["']`),
          // Direct inheritance: contract X is IInterface
          new RegExp(`contract\\s+\\w+\\s+is\\s+[^{]*\\b${interfaceName}\\b[^{]*{`),
          // Multiple inheritance: contract X is A, IInterface, B
          new RegExp(`contract\\s+\\w+\\s+is\\s+[^{]*\\b${interfaceName}\\b[^{]*{`),
          // Simple import: import "path/IInterface.sol";
          new RegExp(`import\\s*["'][^"']*${interfaceName}\\.sol["']`),
          // Import with braces: import {IInterface} from "...";
          new RegExp(`import\\s*{[^}]*}\\s*from\\s*["'][^"']*${interfaceName}\\.sol["']`),
        ];

        const hasImport = importPatterns.some((pattern) => pattern.test(sourceCode));
        if (hasImport) {
          // Only add if it's a contract or library, not an interface
          const contractMatch = sourceCode.match(/contract\s+(\w+)/);
          const libraryMatch = sourceCode.match(/library\s+(\w+)/);
          if (contractMatch || libraryMatch) {
            usingContracts.push(artifact.sourceName);
          }
        }
      } catch {
        // Skip contracts that can't be read
        continue;
      }
    }

    return usingContracts;
  }

  // Process all contracts to find interfaces defined within them
  const processedPairs = new Set<string>(); // Track processed interface-contract pairs

  for (const contractFqn of artifactNames) {
    if (contractFqn.includes("/interfaces/")) {
      continue; // Skip interface files themselves
    }

    const interfaces = await extractInterfacesFromContract(contractFqn);

    for (const { interfaceName, interfaceFqn } of interfaces) {
      // Find corresponding contract for this interface
      const correspondingContractFqn = findCorrespondingContract(interfaceName);

      if (!correspondingContractFqn) {
        // console.log(`•  skipping '${interfaceFqn}' - no corresponding contract found`);
        // TODO: restore this log
        continue;
      }

      // Create a unique key for this interface-contract pair
      const pairKey = `${interfaceFqn}::${correspondingContractFqn}`;

      // Skip if we've already processed this pair
      if (processedPairs.has(pairKey)) {
        continue;
      }

      processedPairs.add(pairKey);

      // Check if this pair should be skipped
      const skipPair = PAIRS_TO_SKIP.find(
        (pair) =>
          (pair.interfaceFqn === interfaceFqn && pair.contractFqn === correspondingContractFqn) ||
          (pair.interfaceFqn === correspondingContractFqn && pair.contractFqn === interfaceFqn),
      );
      if (skipPair && !skipPair.skipInterfaceSignatures) {
        console.log(`ℹ️  skipping '${interfaceFqn}' and '${correspondingContractFqn}' (${skipPair.reason})`);
        continue;
      }

      try {
        // Get ABIs for comparison
        const interfaceAbi = (await hre.artifacts.readArtifact(interfaceFqn)).abi;
        const contractAbi = (await hre.artifacts.readArtifact(correspondingContractFqn)).abi;

        // Helper function to get function signatures with parameter names for strict comparison
        function getFunctionSignaturesWithNames(
          abi: Array<{
            type: string;
            name: string;
            inputs: Array<{ type: string; name: string }>;
            outputs?: Array<{ type: string }>;
          }>,
        ): string[] {
          return abi
            .filter((item) => item.type === "function")
            .map((func) => {
              const inputs = func.inputs.map((input) => `${input.type} ${input.name}`).join(", ");
              const outputs = func.outputs ? ` returns (${func.outputs.map((output) => output.type).join(", ")})` : "";
              return `function ${func.name}(${inputs})${outputs}`;
            })
            .sort();
        }

        // Helper function to get function signatures without parameter names for basic compatibility check
        function getFunctionSignaturesWithoutNames(
          abi: Array<{
            type: string;
            name: string;
            inputs: Array<{ type: string }>;
            outputs?: Array<{ type: string }>;
          }>,
        ): string[] {
          return abi
            .filter((item) => item.type === "function")
            .map((func) => {
              const inputs = func.inputs.map((input) => input.type).join(",");
              const outputs = func.outputs ? ` returns (${func.outputs.map((output) => output.type).join(",")})` : "";
              return `function ${func.name}(${inputs})${outputs}`;
            })
            .sort();
        }

        const interfaceSignaturesWithNames = getFunctionSignaturesWithNames(interfaceAbi);
        const contractSignaturesWithNames = getFunctionSignaturesWithNames(contractAbi);
        const interfaceSignaturesWithoutNames = getFunctionSignaturesWithoutNames(interfaceAbi);
        const contractSignaturesWithoutNames = getFunctionSignaturesWithoutNames(contractAbi);

        // Validate that skipped signatures actually exist in the interface
        if (skipPair?.skipInterfaceSignatures && skipPair.skipInterfaceSignatures.length > 0) {
          const invalidSignatures = skipPair.skipInterfaceSignatures.filter(
            (sig) => !interfaceSignaturesWithNames.includes(sig),
          );
          if (invalidSignatures.length > 0) {
            console.error(
              `❌ Invalid signatures in skipInterfaceSignatures for '${interfaceFqn}' and '${correspondingContractFqn}':`,
            );
            invalidSignatures.forEach((sig) => {
              console.error(`   ${sig}`);
            });
            console.error(`Available signatures in interface:`);
            interfaceSignaturesWithNames.forEach((sig) => {
              console.error(`   ${sig}`);
            });
            console.error();
            process.exit(1);
          }
        }

        // Find entries in interface ABI that are missing from contract ABI (by signature only)
        const missingInContractBySignature = interfaceSignaturesWithoutNames.filter(
          (ifaceEntry) => !contractSignaturesWithoutNames.includes(ifaceEntry),
        );

        // Find entries in contract ABI that are missing from interface ABI (by signature only)
        const missingInInterfaceBySignature = contractSignaturesWithoutNames.filter(
          (contractEntry) => !interfaceSignaturesWithoutNames.includes(contractEntry),
        );

        // Find parameter name mismatches (functions that exist in both but have different parameter names)
        const parameterNameMismatches: string[] = [];
        for (const ifaceSig of interfaceSignaturesWithNames) {
          // Check if this signature should be skipped
          if (skipPair?.skipInterfaceSignatures?.includes(ifaceSig)) {
            continue;
          }

          // Extract function signature without parameter names for matching
          const ifaceSigWithoutNames = ifaceSig.replace(/\(([^)]+)\)/, (match, params) => {
            const paramList = params
              .split(", ")
              .map((param: string) => {
                const parts = param.trim().split(" ");
                return parts[0]; // Keep only the type part
              })
              .join(", ");
            return `(${paramList})`;
          });

          const matchingContractSig = contractSignaturesWithNames.find((contractSig) => {
            const contractSigWithoutNames = contractSig.replace(/\(([^)]+)\)/, (match, params) => {
              const paramList = params
                .split(", ")
                .map((param: string) => {
                  const parts = param.trim().split(" ");
                  return parts[0]; // Keep only the type part
                })
                .join(", ");
              return `(${paramList})`;
            });
            return contractSigWithoutNames === ifaceSigWithoutNames;
          });

          if (matchingContractSig && ifaceSig !== matchingContractSig) {
            parameterNameMismatches.push(`Interface: ${ifaceSig}`);
            parameterNameMismatches.push(`Contract:  ${matchingContractSig}`);
            parameterNameMismatches.push(""); // Empty line for readability
          }
        }

        // Use the signature-based comparison for basic compatibility
        const missingInContract = missingInContractBySignature;
        const missingInInterface = missingInInterfaceBySignature;

        // // Determine if full match is expected (interface name matches contract name)
        // const [, contractFileName, contractName] = correspondingContractFqn.match(/([^/]+)\.sol:(.+)$/) || [];
        // const isFullMatchExpected = contractFileName === contractName;
        const isFullMatchExpected = false;
        // TODO: full match mode is yet disabled

        // Check for any type of mismatch: missing functions or parameter name mismatches
        const hasMismatch = missingInContract.length > 0 || parameterNameMismatches.length > 0;

        // Log info about skipped signatures if any
        if (skipPair?.skipInterfaceSignatures && skipPair.skipInterfaceSignatures.length > 0) {
          console.log(
            `ℹ️  skipping ${skipPair.skipInterfaceSignatures.length} signature(s) for '${interfaceFqn}' and '${correspondingContractFqn}' (${skipPair.reason})`,
          );
        }

        if (hasMismatch) {
          mismatchedInterfaces.push({
            interfaceFqn,
            contractFqn: correspondingContractFqn,
            missingInContract,
            missingInInterface,
            isFullMatchExpected,
            parameterNameMismatches,
          });
        } else {
          const matchType = isFullMatchExpected ? "fully matches" : "is sub-interface of";
          console.log(`✅ ${interfaceFqn} ${matchType} ${correspondingContractFqn}`);
        }
      } catch (error) {
        console.log(`⚠️  skipping '${interfaceFqn}' - error reading artifacts: ${error}`);
        continue;
      }
    }
  }

  if (mismatchedInterfaces.length > 0) {
    console.error();
  }

  for (const mismatch of mismatchedInterfaces) {
    const {
      interfaceFqn,
      contractFqn,
      missingInContract,
      missingInInterface,
      isFullMatchExpected,
      parameterNameMismatches,
    } = mismatch;

    console.error(`~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~`);
    console.error();
    console.error(`❌ ABI mismatch between:`);
    console.error(`   Interface: ${interfaceFqn}`);
    console.error(`   Contract:  ${contractFqn}`);
    console.error(`   Match type: ${isFullMatchExpected ? "Full match expected" : "Sub-interface"}`);
    console.error();

    // Find and log all contracts that use the interface
    const interfaceName = getContractName(interfaceFqn);
    const usingContracts = await findContractsUsingInterface(interfaceName);

    if (usingContracts.length > 0) {
      console.error(`📋 This interface used ${usingContracts.length} times in the following contracts:`);
      [...new Set(usingContracts)].forEach((contract) => {
        console.error(`   ${contract}`);
      });
      console.error();
    }

    if (parameterNameMismatches.length > 0) {
      console.error(`📋 Parameter name mismatches (${parameterNameMismatches.length / 3} functions):`);
      parameterNameMismatches.forEach((entry) => {
        console.error(`   ${entry}`);
      });
      console.error();
    }

    if (isFullMatchExpected && missingInInterface.length > 0) {
      console.error(`📋 Entries missing in interface (${missingInInterface.length}):`);
      missingInInterface.forEach((entry) => {
        console.error(`   ${entry};`);
      });
      console.error();
    }

    if (missingInContract.length > 0) {
      console.error(`📋 Entries missing in contract (${missingInContract.length}):`);
      missingInContract.forEach((entry) => {
        console.error(`   ${entry};`);
      });
      console.error();
    }
  }

  if (mismatchedInterfaces.length === 0) {
    console.log("✅ All interfaces are properly aligned with their corresponding contracts!");
  }
});
