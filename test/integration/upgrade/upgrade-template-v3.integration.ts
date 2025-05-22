import { expect } from "chai";
import hre from "hardhat";
import { beforeEach } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { OssifiableProxy, V3Template } from "typechain-types";

import { deployUpgrade, loadContract, readNetworkState, Sk } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

function needToSkipTemplateTests() {
  return !process.env.TEMPLATE_TEST;
}

describe("Integration: Upgrade Template V3 tests", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;
  let template: V3Template;
  let deployer: HardhatEthersSigner;
  let agentSigner: HardhatEthersSigner;

  before(async () => {
    originalSnapshot = await Snapshot.take();

    if (needToSkipTemplateTests()) {
      return;
    }

    [deployer] = await hre.ethers.getSigners();

    await deployUpgrade(hre.network.name, "upgrade/steps-deploy.json");
    const state = readNetworkState();

    template = await loadContract<V3Template>("V3Template", state[Sk.v3Template].address);

    ctx = await getProtocolContext(true);

    agentSigner = await ctx.getSigner("agent");
  });

  after(async () => await Snapshot.restore(originalSnapshot));

  beforeEach(async () => {
    snapshot = await Snapshot.take();
  });

  afterEach(async () => await Snapshot.restore(snapshot));

  function it_(title: string, fn: () => Promise<void>) {
    it(title, async function () {
      if (needToSkipTemplateTests()) {
        this.skip();
      }
      await fn();
    });
  }

  it_("should revert when startUpgrade is called by non-voting address", async function () {
    await expect(template.connect(deployer).startUpgrade()).to.be.revertedWithCustomError(
      template,
      "OnlyVotingCanUpgrade",
    );
  });

  it_("should revert when startUpgrade is called after expiration", async function () {
    await time.setNextBlockTimestamp(await template.EXPIRE_SINCE_INCLUSIVE());
    await expect(template.connect(agentSigner).startUpgrade()).to.be.revertedWithCustomError(template, "Expired");
  });

  it_(
    "should revert with IncorrectProxyImplementation when startUpgrade is called with incorrect proxy implementation",
    async function () {
      const locatorProxy = await loadContract<OssifiableProxy>("OssifiableProxy", ctx.contracts.locator.address);
      const unexpectedLocatorImplementation = ctx.contracts.burner.address;
      await locatorProxy.connect(agentSigner).proxy__upgradeTo(unexpectedLocatorImplementation);

      // Attempt to start the upgrade, which should revert with IncorrectProxyImplementation
      await expect(template.connect(agentSigner).startUpgrade()).to.be.revertedWithCustomError(
        template,
        "IncorrectProxyImplementation",
      );
    },
  );

  it_("should revert when startUpgrade is called after it has already been started", async function () {
    // First call should succeed
    await template.connect(agentSigner).startUpgrade();

    // Second call should revert with UpgradeAlreadyStarted
    await expect(template.connect(agentSigner).startUpgrade()).to.be.revertedWithCustomError(
      template,
      "UpgradeAlreadyStarted",
    );
  });
});
