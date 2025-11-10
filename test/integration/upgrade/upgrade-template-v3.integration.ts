import { expect } from "chai";
import hre from "hardhat";
import { beforeEach } from "mocha";
import { main as mockV3AragonVoting, setValidUpgradeTimestamp } from "scripts/upgrade/steps/0500-mock-v3-aragon-voting";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { OssifiableProxy, V3Template, V3Template__Harness, V3Template__Harness__factory } from "typechain-types";

import { deployUpgrade, loadContract, readNetworkState, Sk } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

const SECONDS_PER_DAY = 86400n;

function needToSkipTemplateTests() {
  return !process.env.TEMPLATE_TEST;
}

if (!needToSkipTemplateTests())
  describe("Integration: Upgrade Template V3 tests", () => {
    let ctx: ProtocolContext;
    let snapshot: string;
    let originalSnapshot: string;
    let template: V3Template;
    let deployer: HardhatEthersSigner;
    let agentSigner: HardhatEthersSigner;
    let agentMock: V3Template__Harness;

    // Helper function to set timestamp within valid upgrade window
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

      agentMock = await new V3Template__Harness__factory(deployer).deploy(await template.getAddress());
      await agentMock.waitForDeployment();
    });

    after(async () => await Snapshot.restore(originalSnapshot));

    beforeEach(async () => {
      snapshot = await Snapshot.take();
    });

    afterEach(async () => await Snapshot.restore(snapshot));

    function it_(title: string, fn: () => Promise<void>) {
      return it(title, async function () {
        if (needToSkipTemplateTests()) {
          this.skip();
        }
        await fn();
      });
    }

    it_("happy path", async function () {
      // Note: mockV3AragonVoting internally advances time, so we set it right before the call
      await expect((async () => (await mockV3AragonVoting()).proposalExecutedReceipt)())
        .to.emit(template, "UpgradeStarted")
        .and.to.emit(template, "UpgradeFinished");
      expect(await template.upgradeBlockNumber()).to.not.equal(0);
      expect(await template.isUpgradeFinished()).to.equal(true);
    });

    describe("time constraints", () => {
      it_("should have sane immutable values set from constructor", async function () {
        const disabledBefore = await template.DISABLED_BEFORE();
        const disabledAfter = await template.DISABLED_AFTER();
        const enabledDaySpanStart = await template.ENABLED_DAY_SPAN_START();
        const enabledDaySpanEnd = await template.ENABLED_DAY_SPAN_END();

        expect(disabledBefore).to.be.greaterThan(0);
        expect(disabledAfter).to.be.greaterThan(disabledBefore);
        expect(enabledDaySpanStart).to.be.lessThan(SECONDS_PER_DAY);
        expect(enabledDaySpanEnd).to.be.lessThan(SECONDS_PER_DAY);
        expect(enabledDaySpanEnd).to.be.greaterThan(enabledDaySpanStart);
      });
    });

    describe("startUpgrade", () => {
      it_("should revert when startUpgrade is called by non-agent address", async function () {
        await expect(template.connect(deployer).startUpgrade()).to.be.revertedWithCustomError(
          template,
          "OnlyAgentCanUpgrade",
        );
      });

      it_(
        "should revert with IncorrectProxyImplementation when startUpgrade is called with incorrect proxy implementation for locator and accountingOracle",
        async function () {
          await setValidUpgradeTimestamp(false, template);

          const unexpectedImpl = ctx.contracts.kernel.address;
          const testCases = [
            {
              address: ctx.contracts.locator.address,
            },
            {
              address: ctx.contracts.accountingOracle.address,
            },
          ];

          for (const { address } of testCases) {
            const proxy = await loadContract<OssifiableProxy>("OssifiableProxy", address);
            await proxy.connect(agentSigner).proxy__upgradeTo(unexpectedImpl);

            // Attempt to start the upgrade, which should revert with IncorrectProxyImplementation
            await expect(template.connect(agentSigner).startUpgrade()).to.be.revertedWithCustomError(
              template,
              "IncorrectProxyImplementation",
            );
          }
        },
      );

      it_("should revert when startUpgrade is called after it has already been started", async function () {
        await setValidUpgradeTimestamp(false, template);

        await template.connect(agentSigner).startUpgrade();
        await expect(template.connect(agentSigner).startUpgrade()).to.be.revertedWithCustomError(
          template,
          "UpgradeAlreadyStarted",
        );
      });

      it_("should revert when startUpgrade is called after upgrade is already finished", async function () {
        // Note: mockV3AragonVoting internally advances time, so we set it right before the call
        await mockV3AragonVoting();
        await expect(template.connect(agentSigner).startUpgrade()).to.be.revertedWithCustomError(
          template,
          "UpgradeAlreadyFinished",
        );
      });

      it_("should revert when startUpgrade is called twice in the same transaction", async function () {
        await setValidUpgradeTimestamp(false, template);

        await hre.ethers.provider.send("hardhat_setCode", [agentSigner.address, await agentMock.getDeployedCode()]);
        const harness = (await new V3Template__Harness__factory(deployer).attach(
          agentSigner.address,
        )) as V3Template__Harness;

        await expect(harness.startUpgradeTwice()).to.be.revertedWithCustomError(template, "StartAlreadyCalledInThisTx");
      });
    });

    describe("finishUpgrade", () => {
      it_("should revert when finishUpgrade is called by non-agent address", async function () {
        await setValidUpgradeTimestamp(false, template);

        await template.connect(agentSigner).startUpgrade();
        await expect(template.connect(deployer).finishUpgrade()).to.be.revertedWithCustomError(
          template,
          "OnlyAgentCanUpgrade",
        );
      });

      it_("should revert when finishUpgrade is called before startUpgrade", async function () {
        await expect(template.connect(agentSigner).finishUpgrade()).to.be.revertedWithCustomError(
          template,
          "StartAndFinishMustBeInSameTx",
        );
      });

      it_("should revert when finishUpgrade is called after upgrade is already finished", async function () {
        // Note: mockV3AragonVoting internally advances time, so we set it right before the call
        await mockV3AragonVoting();
        await expect(template.connect(agentSigner).finishUpgrade()).to.be.revertedWithCustomError(
          template,
          "UpgradeAlreadyFinished",
        );
      });
    });
  });
