import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { LidoLocator } from "typechain-types";

import { ArrayToUnion, randomAddress } from "lib";

const services = [
  "accountingOracle",
  "depositSecurityModule",
  "elRewardsVault",
  "legacyOracle",
  "lido",
  "oracleReportSanityChecker",
  "postTokenRebaseReceiver",
  "burner",
  "stakingRouter",
  "treasury",
  "validatorsExitBusOracle",
  "withdrawalQueue",
  "withdrawalVault",
  "oracleDaemonConfig",
] as const;

type Service = ArrayToUnion<typeof services>;
type Config = Record<Service, string>;

function randomConfig(): Config {
  return services.reduce<Config>((config, service) => {
    config[service] = randomAddress();
    return config;
  }, {} as Config);
}

describe("LidoLocator.sol", () => {
  const config = randomConfig();
  let locator: LidoLocator;

  before(async () => {
    locator = await ethers.deployContract("LidoLocator", [config]);
  });

  context("constructor", () => {
    for (const service of services) {
      it(`Reverts if the \`config.${service}\` is zero address`, async () => {
        const config = randomConfig();
        config[service] = ZeroAddress;

        await expect(ethers.deployContract("LidoLocator", [config])).to.be.revertedWithCustomError(
          locator,
          "ZeroAddress",
        );
      });
    }
  });

  context("coreComponents", () => {
    it("Returns correct services in correct order", async () => {
      const { elRewardsVault, oracleReportSanityChecker, stakingRouter, treasury, withdrawalQueue, withdrawalVault } =
        config;

      expect(await locator.coreComponents()).to.deep.equal([
        elRewardsVault,
        oracleReportSanityChecker,
        stakingRouter,
        treasury,
        withdrawalQueue,
        withdrawalVault,
      ]);
    });
  });

  context("oracleReportComponentsForLido", () => {
    it("Returns correct services in correct order", async () => {
      const {
        accountingOracle,
        elRewardsVault,
        oracleReportSanityChecker,
        burner,
        withdrawalQueue,
        withdrawalVault,
        postTokenRebaseReceiver,
      } = config;

      expect(await locator.oracleReportComponentsForLido()).to.deep.equal([
        accountingOracle,
        elRewardsVault,
        oracleReportSanityChecker,
        burner,
        withdrawalQueue,
        withdrawalVault,
        postTokenRebaseReceiver,
      ]);
    });
  });
});
