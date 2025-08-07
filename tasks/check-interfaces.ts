import fs from "node:fs";
import path from "node:path";

import { Interface } from "ethers";
import { task } from "hardhat/config";

const SKIP_NAMES_REGEX = /(^@|Mock|Harness|deposit_contract|build-info|^test)/;

const PAIRS_TO_SKIP: {
  interfaceFqn: string;
  contractFqn: string;
  reason: string;
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
];

task("check-interfaces").setAction(async (_, hre) => {
  const mismatchedInterfaces: {
    interfaceFqn: string;
    contractFqn: string;
    missingInContract: string[];
    missingInInterface: string[];
    isFullMatchExpected: boolean;
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
      if (skipPair) {
        console.log(`ℹ️  skipping '${interfaceFqn}' and '${correspondingContractFqn}' (${skipPair.reason})`);
        continue;
      }

      try {
        // Get ABIs for comparison
        const interfaceAbi = (await hre.artifacts.readArtifact(interfaceFqn)).abi;
        const contractAbi = (await hre.artifacts.readArtifact(correspondingContractFqn)).abi;

        const interfaceSignatures = new Interface(interfaceAbi)
          .format()
          .filter((entry) => !entry.startsWith("constructor("))
          .sort();

        const contractSignatures = new Interface(contractAbi)
          .format()
          .filter((entry) => !entry.startsWith("constructor("))
          .sort();

        // Find entries in interface ABI that are missing from contract ABI
        const missingInContract = interfaceSignatures.filter((ifaceEntry) => !contractSignatures.includes(ifaceEntry));

        // Find entries in contract ABI that are missing from interface ABI
        const missingInInterface = contractSignatures.filter(
          (contractEntry) => !interfaceSignatures.includes(contractEntry),
        );

        // // Determine if full match is expected (interface name matches contract name)
        // const [, contractFileName, contractName] = correspondingContractFqn.match(/([^/]+)\.sol:(.+)$/) || [];
        // const isFullMatchExpected = contractFileName === contractName;
        const isFullMatchExpected = false;
        // TODO: full match mode is yet disabled

        // const hasMismatch = (isFullMatchExpected && missingInContract.length > 0) || missingInInterface.length > 0;
        const hasMismatch = missingInContract.length > 0;

        if (hasMismatch) {
          mismatchedInterfaces.push({
            interfaceFqn,
            contractFqn: correspondingContractFqn,
            missingInContract,
            missingInInterface,
            isFullMatchExpected,
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
    const { interfaceFqn, contractFqn, missingInContract, missingInInterface, isFullMatchExpected } = mismatch;

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
      console.error(`📋 Contracts using this interface (${usingContracts.length}):`);
      usingContracts.forEach((contract) => {
        console.error(`   ${contract}`);
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
