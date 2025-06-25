import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { LidoLocator } from "typechain-types";

import { randomAddress } from "lib";

const services = [
  "accountingOracle",
  "depositSecurityModule",
  "elRewardsVault",
  "lido",
  "oracleReportSanityChecker",
  "burner",
  "stakingRouter",
  "treasury",
  "validatorsExitBusOracle",
  "withdrawalQueue",
  "withdrawalVault",
  "oracleDaemonConfig",
  "validatorExitDelayVerifier",
  "triggerableWithdrawalsGateway",
  "accounting",
  "predepositGuarantee",
  "wstETH",
  "vaultHub",
  "vaultFactory",
  "lazyOracle",
  "operatorGrid",
  "vaultFactory",
  "lazyOracle",
] as const;

type ArrayToUnion<A extends readonly unknown[]> = A[number];
type Service = ArrayToUnion<typeof services>;
type Config = Record<Service, string> & {
  postTokenRebaseReceiver: string; // can be ZeroAddress
};

function randomConfig(): Config {
  return {
    ...services.reduce<Config>((config, service) => {
      config[service] = randomAddress();
      return config;
    }, {} as Config),
    postTokenRebaseReceiver: ZeroAddress,
  };
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
        const randomConfiguration = randomConfig();
        randomConfiguration[service] = ZeroAddress;

        await expect(ethers.deployContract("LidoLocator", [randomConfiguration])).to.be.revertedWithCustomError(
          locator,
          "ZeroAddress",
        );
      });
    }

    it("Does not revert if `postTokenRebaseReceiver` is zero address", async () => {
      const randomConfiguration = randomConfig();
      await expect(ethers.deployContract("LidoLocator", [randomConfiguration])).to.not.be.reverted;
    });
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

  context("oracleReportComponents", () => {
    it("Returns correct services in correct order", async () => {
      const {
        accountingOracle,
        oracleReportSanityChecker,
        burner,
        withdrawalQueue,
        postTokenRebaseReceiver,
        stakingRouter,
        vaultHub,
      } = config;

      expect(await locator.oracleReportComponents()).to.deep.equal([
        accountingOracle,
        oracleReportSanityChecker,
        burner,
        withdrawalQueue,
        postTokenRebaseReceiver,
        stakingRouter,
        vaultHub,
      ]);
    });
  });
});
