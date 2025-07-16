import fs from "node:fs";
import path from "node:path";

import { Interface } from "ethers";
import { task } from "hardhat/config";

const SKIP_NAMES_REGEX = /(^@|Mock|Harness|deposit_contract|build-info|^test)/;

const PAIRS_TO_SKIP: {
  commonInterfaceFqn: string;
  otherContractFqn: string;
  reason: string;
}[] = [
  {
    commonInterfaceFqn: "contracts/common/interfaces/IHashConsensus.sol:IHashConsensus",
    otherContractFqn: "contracts/0.4.24/oracle/LegacyOracle.sol:IHashConsensus",
    reason: "LegacyOracle is obsolete",
  },
  {
    commonInterfaceFqn: "contracts/common/interfaces/IVersioned.sol:IVersioned",
    otherContractFqn: "contracts/0.4.24/utils/Versioned.sol:Versioned",
    reason: "Versioned for 0.4.24 differs by design",
  },
  {
    commonInterfaceFqn: "contracts/common/interfaces/IBurner.sol:IBurner",
    otherContractFqn: "contracts/0.8.9/Burner.sol:Burner",
    reason: "Burner is scheduled for V3 upgrade",
  },
  {
    commonInterfaceFqn: "contracts/common/interfaces/IEIP712StETH.sol:IEIP712StETH",
    otherContractFqn: "contracts/0.8.9/EIP712StETH.sol:EIP712StETH",
    reason: "StETH is scheduled for V3 upgrade",
  },
];

const ADDITIONAL_INTERFACES: {
  commonInterfaceFqn: string;
  additionalInterfaces: string[];
}[] = [
  {
    commonInterfaceFqn: "contracts/common/interfaces/IBaseOracle.sol:IBaseOracle",
    additionalInterfaces: [
      "contracts/0.8.9/utils/access/AccessControlEnumerable.sol:AccessControlEnumerable",
      "contracts/0.8.9/utils/Versioned.sol:Versioned",
    ],
  },
  {
    commonInterfaceFqn: "contracts/common/interfaces/IValidatorsExitBus.sol:IValidatorsExitBus",
    additionalInterfaces: [
      "contracts/0.8.9/oracle/BaseOracle.sol:BaseOracle",
      "contracts/0.8.9/lib/ExitLimitUtils.sol:ExitLimitUtils",
      "contracts/0.8.9/utils/PausableUntil.sol:PausableUntil",
    ],
  },
  {
    commonInterfaceFqn: "contracts/common/interfaces/IValidatorsExitBusOracle.sol:IValidatorsExitBusOracle",
    additionalInterfaces: ["contracts/0.8.9/oracle/ValidatorsExitBus.sol:ValidatorsExitBus"],
  },
  {
    commonInterfaceFqn: "contracts/common/interfaces/ITriggerableWithdrawalsGateway.sol:ITriggerableWithdrawalsGateway",
    additionalInterfaces: [
      "contracts/0.8.9/lib/ExitLimitUtils.sol:ExitLimitUtils",
      "contracts/0.8.9/utils/access/AccessControlEnumerable.sol:AccessControlEnumerable",
      "contracts/0.8.9/utils/PausableUntil.sol:PausableUntil",
    ],
  },
];

task("check-interfaces").setAction(async (_, hre) => {
  const mismatchedInterfaces: {
    commonInterface: string;
    otherInterface: string;
    missingInOtherIface: string[];
    missingInCommonIface: string[];
    isFullMatchExpected: boolean;
  }[] = [];

  console.log("Checking interfaces...");

  const artifactNames = (await hre.artifacts.getAllFullyQualifiedNames()).filter(
    (name) => !SKIP_NAMES_REGEX.test(name),
  );

  const commonInterfacesFqn = artifactNames.filter((name) => name.startsWith("contracts/common/interfaces"));

  // Helper to get contract name from fully qualified name
  function getContractName(fqn: string): string {
    const parts = fqn.split(":");
    return parts[parts.length - 1];
  }

  // Helper to find all contracts that import a given interface and contracts that import those contracts
  async function findContractsInheritingFrom(interfaceName: string): Promise<{ direct: string[]; indirect: string[] }> {
    const directImports: string[] = [];
    const indirectImports: string[] = [];

    // First, find all contracts that directly import the interface
    for (const artifactName of artifactNames) {
      if (artifactName.startsWith("contracts/common/interfaces")) {
        continue; // Skip interfaces themselves
      }

      try {
        const artifact = await hre.artifacts.readArtifact(artifactName);
        if (artifact.sourceName) {
          // Read the contract source code
          const sourcePath = path.join(hre.config.paths.root, artifact.sourceName);

          if (fs.existsSync(sourcePath)) {
            const sourceCode = fs.readFileSync(sourcePath, "utf8");

            // Check for direct imports of the interface
            // Look for import statements that reference the interface
            const importPatterns = [
              // Direct import: import {IInterface} from "contracts/common/interfaces/IInterface.sol";
              new RegExp(
                `import\\s*{[^}]*\\b${interfaceName}\\b[^}]*}\\s*from\\s*["']contracts/common/interfaces/${interfaceName}\\.sol["']`,
              ),
              // Relative import: import {IInterface} from "../../common/interfaces/IInterface.sol";
              new RegExp(
                `import\\s*{[^}]*\\b${interfaceName}\\b[^}]*}\\s*from\\s*["'][^"']*${interfaceName}\\.sol["']`,
              ),
              // Import with alias: import {IInterface as Alias} from "...";
              new RegExp(`import\\s*{[^}]*\\b${interfaceName}\\b[^}]*}\\s*from\\s*["'][^"']*["']`),
              // Direct inheritance: contract X is IInterface
              new RegExp(`contract\\s+\\w+\\s+is\\s+[^{]*\\b${interfaceName}\\b[^{]*{`),
              // Multiple inheritance: contract X is A, IInterface, B
              new RegExp(`contract\\s+\\w+\\s+is\\s+[^{]*\\b${interfaceName}\\b[^{]*{`),
              // Simple import: import "../common/interfaces/ILidoLocator.sol";
              new RegExp(`import\\s*["'][^"']*${interfaceName}\\.sol["']`),
              // Import with braces: import {ILidoLocator} from "../common/interfaces/ILidoLocator.sol";
              new RegExp(`import\\s*{[^}]*}\\s*from\\s*["'][^"']*${interfaceName}\\.sol["']`),
            ];

            const hasDirectImport = importPatterns.some((pattern) => pattern.test(sourceCode));
            if (hasDirectImport) {
              // Only add if it's a contract or library, not an interface
              const contractMatch = sourceCode.match(/contract\s+(\w+)/);
              const libraryMatch = sourceCode.match(/library\s+(\w+)/);
              if (contractMatch || libraryMatch) {
                // Extract just the file path without the contract name
                const filePath = artifact.sourceName;
                if (!directImports.includes(filePath)) {
                  directImports.push(filePath);
                }
              }
            }
          }
        }
      } catch {
        // Skip contracts that can't be read
        continue;
      }
    }

    // Then, find contracts that import any of the directly importing contracts
    for (const artifactName of artifactNames) {
      if (artifactName.startsWith("contracts/common/interfaces")) {
        continue; // Skip interfaces themselves
      }

      try {
        const artifact = await hre.artifacts.readArtifact(artifactName);
        if (artifact.sourceName) {
          // Skip if this file already directly imports the interface
          if (directImports.includes(artifact.sourceName)) {
            continue;
          }

          const sourcePath = path.join(hre.config.paths.root, artifact.sourceName);

          if (fs.existsSync(sourcePath)) {
            const sourceCode = fs.readFileSync(sourcePath, "utf8");

            // Check if this contract imports any of the directly importing contracts
            for (const directImport of directImports) {
              // Extract the filename without extension from the direct import path
              const directFileName = directImport.split("/").pop()?.replace(".sol", "");

              if (directFileName) {
                // Look for imports of the directly importing contract
                const importPatterns = [
                  // Direct import: import {ContractName} from "contracts/.../ContractName.sol";
                  new RegExp(`import\\s*{[^}]*}\\s*from\\s*["'][^"']*${directFileName}\\.sol["']`),
                  // Relative import: import {ContractName} from "../path/ContractName.sol";
                  new RegExp(`import\\s*{[^}]*}\\s*from\\s*["'][^"']*${directFileName}\\.sol["']`),
                  // Import with alias: import {ContractName as Alias} from "...";
                  new RegExp(`import\\s*{[^}]*}\\s*from\\s*["'][^"']*["']`),
                  // Direct inheritance: contract X is ContractName
                  new RegExp(`contract\\s+\\w+\\s+is\\s+[^{]*\\b${directFileName}\\b[^{]*{`),
                  // Multiple inheritance: contract X is A, ContractName, B
                  new RegExp(`contract\\s+\\w+\\s+is\\s+[^{]*\\b${directFileName}\\b[^{]*{`),
                  // Simple import: import "path/ContractName.sol";
                  new RegExp(`import\\s*["'][^"']*${directFileName}\\.sol["']`),
                ];

                const hasIndirectImport = importPatterns.some((pattern) => pattern.test(sourceCode));
                if (hasIndirectImport) {
                  // Additional verification: check if the contract name actually appears in the import
                  const importMatches = sourceCode.match(
                    new RegExp(`import\\s*{[^}]*}\\s*from\\s*["'][^"']*${directFileName}\\.sol["']`),
                  );
                  const inheritanceMatches = sourceCode.match(
                    new RegExp(`contract\\s+\\w+\\s+is\\s+[^{]*\\b${directFileName}\\b[^{]*{`),
                  );
                  const simpleImportMatches = sourceCode.match(
                    new RegExp(`import\\s*["'][^"']*${directFileName}\\.sol["']`),
                  );

                  // Only add if we have a real match
                  if (importMatches || inheritanceMatches || simpleImportMatches) {
                    // Only add if it's a contract or library, not an interface
                    const contractMatch = sourceCode.match(/contract\s+(\w+)/);
                    const libraryMatch = sourceCode.match(/library\s+(\w+)/);
                    if (contractMatch || libraryMatch) {
                      // Extract just the file path without the contract name
                      const filePath = artifact.sourceName;
                      if (!indirectImports.includes(filePath)) {
                        indirectImports.push(filePath);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } catch {
        // Skip contracts that can't be read
        continue;
      }
    }

    return { direct: directImports, indirect: indirectImports };
  }

  // 1. Check that interfaces in common/interfaces have same ABI as corresponding contract
  for (const commonIfaceFqn of commonInterfacesFqn) {
    const ifaceName = getContractName(commonIfaceFqn);

    // Try to find a contract with the same name outside of interfaces
    const otherIfaceFqn = artifactNames.find(
      (name) =>
        (getContractName(name) === ifaceName || `I${getContractName(name)}` === ifaceName) && name !== commonIfaceFqn,
      // && !getContractPath(name).includes("/interfaces/")
    );

    if (!otherIfaceFqn) {
      console.log(`•  skipping '${commonIfaceFqn}' - no other such interfaces of contracts found`);
      continue;
    }

    const skipPair = PAIRS_TO_SKIP.find(
      (pair) => pair.commonInterfaceFqn === commonIfaceFqn && pair.otherContractFqn === otherIfaceFqn,
    );
    if (skipPair) {
      console.log(`ℹ️  skipping '${commonIfaceFqn}' and '${otherIfaceFqn}' (${skipPair.reason})`);
      continue;
    }

    const commonIfaceAbi = (await hre.artifacts.readArtifact(commonIfaceFqn)).abi;
    let commonIfaceSignatures = new Interface(commonIfaceAbi).format();

    const additionalInterfaces =
      ADDITIONAL_INTERFACES.find((iface) => iface.commonInterfaceFqn === commonIfaceFqn)?.additionalInterfaces || [];
    for (const fqn of additionalInterfaces) {
      const ifaceAbi = (await hre.artifacts.readArtifact(fqn)).abi;
      const additionalSignatures = new Interface(ifaceAbi).format();
      commonIfaceSignatures = [...commonIfaceSignatures, ...additionalSignatures]
        .filter((entry) => !entry.startsWith("constructor("))
        .sort();
    }

    const otherIfaceAbi = (await hre.artifacts.readArtifact(otherIfaceFqn)).abi;
    const otherIfaceSignatures = new Interface(otherIfaceAbi)
      .format()
      .filter((entry) => !entry.startsWith("constructor("))
      .sort();

    const missingInOtherIface = commonIfaceSignatures.filter(
      (ifaceEntry) => !otherIfaceSignatures.includes(ifaceEntry),
    );

    // Find entries in contract ABI that are missing from interface ABI
    const missingInCommonIface = otherIfaceSignatures.filter(
      (contractEntry) => !commonIfaceSignatures.includes(contractEntry),
    );

    const [, otherIfaceFileName, otherIfaceName] = otherIfaceFqn.match(/([^/]+)\.sol:(.+)$/) || [];
    const isFullMatchExpected = otherIfaceFileName === otherIfaceName;

    const hasMismatch = (isFullMatchExpected && missingInOtherIface.length > 0) || missingInCommonIface.length > 0;

    if (hasMismatch) {
      mismatchedInterfaces.push({
        commonInterface: commonIfaceFqn,
        otherInterface: otherIfaceFqn,
        missingInOtherIface,
        missingInCommonIface,
        isFullMatchExpected,
      });
    } else {
      const matchType = isFullMatchExpected ? "fully matches" : "is sub-interface of";
      console.log(`✅ ${otherIfaceFqn} ${matchType} ${commonIfaceFqn}`);
    }
  }

  if (mismatchedInterfaces.length > 0) {
    console.error();
  }

  for (const mismatch of mismatchedInterfaces) {
    const { commonInterface, otherInterface, missingInOtherIface, missingInCommonIface, isFullMatchExpected } =
      mismatch;

    console.error(`~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~`);
    console.error();
    console.error(`❌ ABI mismatch between:`);
    console.error(`   Common interface: ${commonInterface}`);
    console.error(`   Other interface:  ${otherInterface}`);
    console.error(`   Match type:       ${isFullMatchExpected ? "Full match expected" : "Sub-interface"}`);
    console.error();

    // Find and log all contracts that inherit from the common interface
    const interfaceName = getContractName(commonInterface);
    const inheritingContracts = await findContractsInheritingFrom(interfaceName);

    if (inheritingContracts.direct.length > 0) {
      console.error(`📋 Directly importing contracts (${inheritingContracts.direct.length}):`);
      inheritingContracts.direct.forEach((contract) => {
        console.error(`   ${contract}`);
      });
      console.error();
    }

    if (inheritingContracts.indirect.length > 0) {
      console.error(`📋 Indirectly importing contracts (${inheritingContracts.indirect.length}):`);
      inheritingContracts.indirect.forEach((contract) => {
        console.error(`   ${contract}`);
      });
      console.error();
    }

    if (missingInCommonIface.length > 0) {
      console.error(`📋 Entries missing in common interface (${missingInCommonIface.length}):`);
      missingInCommonIface.forEach((entry) => {
        console.error(`   ${entry};`);
      });
      console.error();
    }

    if (isFullMatchExpected && missingInOtherIface.length > 0) {
      console.error(`📋 Entries missing in other interface/contract (${missingInOtherIface.length}):`);
      missingInOtherIface.forEach((entry) => {
        console.error(`   ${entry};`);
      });
      console.error();
    }
  }
});
