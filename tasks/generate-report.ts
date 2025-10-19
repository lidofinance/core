import fs from "node:fs/promises";
import path from "node:path";

import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";

import { generateReport, openReport, ReportData, TimelineEvent } from "lib/report-generator";
import { cy, log, yl } from "lib/log";

task("report:generate", "Generates a modern HTML report with SVG timeline visualization")
  .addOptionalParam("file", "Path to deployment state file", "deployed-mainnet.json")
  .addOptionalParam("output", "Output path for the HTML report", "reports/deployment-report.html")
  .setAction(async (taskArgs: TaskArguments, hre: HardhatRuntimeEnvironment) => {
    try {
      const network = hre.network.name;
      log("Generating deployment report for network:", network);

      const stateFile = taskArgs.file;
      log("Using state file:", stateFile);

      const stateFilePath = path.resolve("./", stateFile);
      const data = await fs.readFile(stateFilePath, "utf8");
      const networkState = JSON.parse(data);

      // Parse deployment data and create timeline events
      const events: TimelineEvent[] = [];
      const startTime = new Date();

      // Extract contracts from the state file
      Object.entries(networkState).forEach(([key, value], index) => {
        if (typeof value === "object" && value !== null) {
          const contract = value as any;

          // Handle proxy contracts
          if (contract.proxy && contract.implementation) {
            events.push({
              id: `${key}-proxy`,
              title: `${key} Proxy`,
              description: `Deployed proxy contract`,
              timestamp: new Date(startTime.getTime() + index * 1000),
              status: "success",
              address: contract.proxy.address,
            });

            events.push({
              id: `${key}-impl`,
              title: `${key} Implementation`,
              description: `Deployed implementation contract: ${contract.implementation.contract || "Unknown"}`,
              timestamp: new Date(startTime.getTime() + index * 1000 + 500),
              status: "success",
              address: contract.implementation.address,
            });
          }
          // Handle regular contracts
          else if (contract.address && contract.contract) {
            events.push({
              id: key,
              title: key,
              description: `Deployed contract: ${contract.contract}`,
              timestamp: new Date(startTime.getTime() + index * 1000),
              status: "success",
              address: contract.address,
            });
          }
        }
      });

      const reportData: ReportData = {
        title: "Lido Protocol Deployment Report",
        subtitle: `Network: ${network}`,
        network: network,
        deployer: networkState.deployer || "Unknown",
        events: events,
        summary: {
          totalTransactions: events.length,
          duration: `~${Math.ceil(events.length / 60)} minutes`,
        },
      };

      const outputPath = taskArgs.output;
      generateReport(reportData, outputPath);
      openReport(outputPath);

      log.success(`Report generated successfully!`);
      log(`📊 View report: ${cy(path.resolve(outputPath))}`);
    } catch (error) {
      log.error("Error generating report:", error as Error);
      throw error;
    }
  });

task("report:example", "Generates an example deployment report with sample data").setAction(
  async (taskArgs: TaskArguments, hre: HardhatRuntimeEnvironment) => {
    try {
      log("Generating example deployment report...");

      const now = new Date();
      const events: TimelineEvent[] = [
        {
          id: "1",
          title: "Deploy DepositContract",
          description: "Ethereum 2.0 Deposit Contract",
          timestamp: new Date(now.getTime() - 10 * 60 * 1000),
          status: "success",
          gasUsed: "1,234,567",
          txHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          address: "0x00000000219ab540356cBB839Cbe05303d7705Fa",
        },
        {
          id: "2",
          title: "Deploy Lido Implementation",
          description: "Main Lido staking contract implementation",
          timestamp: new Date(now.getTime() - 8 * 60 * 1000),
          status: "success",
          gasUsed: "2,345,678",
          txHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
          address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
        },
        {
          id: "3",
          title: "Deploy Lido Proxy",
          description: "Proxy contract for upgradeable Lido",
          timestamp: new Date(now.getTime() - 7 * 60 * 1000),
          status: "success",
          gasUsed: "987,654",
          txHash: "0x567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234",
          address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
        },
        {
          id: "4",
          title: "Deploy NodeOperatorsRegistry",
          description: "Registry for managing node operators",
          timestamp: new Date(now.getTime() - 5 * 60 * 1000),
          status: "success",
          gasUsed: "3,456,789",
          txHash: "0x234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12",
          address: "0x55032650b14df07b85bF18A3a3eC8E0Af2e028d5",
        },
        {
          id: "5",
          title: "Deploy Oracle",
          description: "Oracle contract for reporting validators state",
          timestamp: new Date(now.getTime() - 3 * 60 * 1000),
          status: "success",
          gasUsed: "1,876,543",
          txHash: "0x7890abcdef1234567890abcdef1234567890abcdef1234567890abcdef123456",
          address: "0x442af784A788A5bd6F42A01Ebe9F287a871243fb",
        },
        {
          id: "6",
          title: "Initialize Lido",
          description: "Initialize the Lido contract with initial parameters",
          timestamp: new Date(now.getTime() - 2 * 60 * 1000),
          status: "success",
          gasUsed: "876,543",
          txHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        },
        {
          id: "7",
          title: "Grant Roles",
          description: "Grant necessary roles to contracts and addresses",
          timestamp: new Date(now.getTime() - 1 * 60 * 1000),
          status: "success",
          gasUsed: "654,321",
          txHash: "0xdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abc",
        },
        {
          id: "8",
          title: "Deployment Complete",
          description: "All contracts deployed and initialized successfully",
          timestamp: now,
          status: "success",
        },
      ];

      const reportData: ReportData = {
        title: "Lido Protocol Deployment Report",
        subtitle: "Example Deployment - Mainnet",
        network: "mainnet",
        deployer: "0x1234567890123456789012345678901234567890",
        events: events,
        summary: {
          totalTransactions: events.length,
          totalGasUsed: "11,431,095",
          duration: "10 minutes",
        },
      };

      const outputPath = "reports/example-deployment-report.html";
      generateReport(reportData, outputPath);
      openReport(outputPath);

      log.success(`Example report generated successfully!`);
      log(`📊 View report: ${cy(path.resolve(outputPath))}`);
    } catch (error) {
      log.error("Error generating example report:", error as Error);
      throw error;
    }
  },
);
