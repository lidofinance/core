import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ActiveRebalancingConfigManager, OracleDaemonConfig } from "typechain-types";

import { en0x, ether, impersonate, loadContract } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { LoadedContract } from "lib/protocol/types";
import { getAddressValidated, readNetworkState, Sk } from "lib/state-file";

import { Snapshot } from "test/suite";

// Curated Module Committee multisig by chain id: the manager role holder after the SR phase 2 vote (LIP-38).
// Forks only: a scratch deploy has no committee, so the suite grants the role to a test signer there.
const CURATED_MODULE_COMMITTEE: Record<string, string> = {
  "1": "0x2570e0b22AD904501dfB0d49575991ACB801dD91",
  "560048": "0x84DffcfB232594975C608DE92544Ff239a24c9E9",
};

type NumericSetter = "setRateLimit" | "setOperatorExcessBP" | "setModuleExcessBP" | "setGracePeriodEpochs";
type BoundsName = "rateLimit" | "operatorExcessBP" | "moduleExcessBP" | "gracePeriodEpochs";

const NUMERIC_KEYS: { key: string; setter: NumericSetter; bounds: BoundsName }[] = [
  { key: "ACTIVE_REBALANCING_RATE_LIMIT", setter: "setRateLimit", bounds: "rateLimit" },
  { key: "ACTIVE_REBALANCING_OPERATOR_EXCESS_BP", setter: "setOperatorExcessBP", bounds: "operatorExcessBP" },
  { key: "ACTIVE_REBALANCING_MODULE_EXCESS_BP", setter: "setModuleExcessBP", bounds: "moduleExcessBP" },
  { key: "ACTIVE_REBALANCING_GRACE_PERIOD_EPOCHS", setter: "setGracePeriodEpochs", bounds: "gracePeriodEpochs" },
];

describe("Integration: ActiveRebalancingConfigManager", () => {
  let ctx: ProtocolContext;
  let originalSnapshot: string;
  let snapshot: string;

  let daemonConfig: LoadedContract<OracleDaemonConfig>;
  let manager: ActiveRebalancingConfigManager;
  let committee: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  before(async function () {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    // Deployed by the scratch deploy and by the SR phase 2 upgrade; absent on a fork without the upgrade
    const managerAddress = getAddressValidated(Sk.activeRebalancingConfigManager, readNetworkState());
    if (!managerAddress || (await ethers.provider.getCode(managerAddress)) === "0x") {
      return this.skip();
    }

    let scratchCommittee: HardhatEthersSigner;
    [stranger, scratchCommittee] = await ethers.getSigners();
    daemonConfig = ctx.contracts.oracleDaemonConfig;
    manager = await loadContract<ActiveRebalancingConfigManager>("ActiveRebalancingConfigManager", managerAddress);

    const role = await manager.ACTIVE_REBALANCING_MANAGER_ROLE();
    if (ctx.isScratch) {
      committee = scratchCommittee;
      await manager.connect(await ctx.getSigner("agent")).grantRole(role, committee.address);
    } else {
      const [committeeAddress] = await manager.getRoleMembers(role);
      committee = await impersonate(committeeAddress, ether("10"));
    }
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));

  it("is the CONFIG_MANAGER_ROLE holder of the OracleDaemonConfig and is owned by the Agent", async () => {
    expect(await manager.ORACLE_DAEMON_CONFIG()).to.equal(await daemonConfig.getAddress());
    expect(await daemonConfig.hasRole(await daemonConfig.CONFIG_MANAGER_ROLE(), manager)).to.equal(true);

    const agent = await ctx.getSigner("agent");
    const adminRole = await manager.DEFAULT_ADMIN_ROLE();
    expect(await manager.getRoleMembers(adminRole)).to.deep.equal([agent.address]);
  });

  it("has the Curated Module Committee as its only manager after the vote", async function () {
    if (ctx.isScratch) return this.skip();

    const { chainId } = await ethers.provider.getNetwork();
    const expected = CURATED_MODULE_COMMITTEE[chainId.toString()];
    if (!expected) return this.skip();

    const role = await manager.ACTIVE_REBALANCING_MANAGER_ROLE();
    expect(await manager.getRoleMembers(role)).to.deep.equal([expected]);
  });

  it("rejects a caller without the manager role", async () => {
    await expect(manager.connect(stranger).setEnabled(true)).to.be.revertedWithCustomError(
      manager,
      "AccessControlUnauthorizedAccount",
    );
  });

  it("lets the committee switch Phase 3 on and off", async () => {
    const wasEnabled = BigInt(await daemonConfig.get("ACTIVE_REBALANCING_ENABLED")) === 1n;

    await manager.connect(committee).setEnabled(!wasEnabled);
    expect(await daemonConfig.get("ACTIVE_REBALANCING_ENABLED")).to.equal(en0x(wasEnabled ? 0n : 1n));

    await manager.connect(committee).setEnabled(wasEnabled);
    expect(await daemonConfig.get("ACTIVE_REBALANCING_ENABLED")).to.equal(en0x(wasEnabled ? 1n : 0n));
  });

  for (const { key, setter, bounds } of NUMERIC_KEYS) {
    it(`keeps ${key} within its bounds`, async () => {
      const { min, max } = (await manager.getBounds())[bounds];
      const current = BigInt(await daemonConfig.get(key));

      await expect(manager.connect(committee)[setter](max + 1n))
        .to.be.revertedWithCustomError(manager, "ValueOutOfBounds")
        .withArgs(key, max + 1n, min, max);
      if (min > 0n) {
        await expect(manager.connect(committee)[setter](min - 1n))
          .to.be.revertedWithCustomError(manager, "ValueOutOfBounds")
          .withArgs(key, min - 1n, min, max);
      }

      // Any bound that differs from the live value is a valid update; pinned bounds equal to it leave none
      const target = [max, min].find((value) => value !== current);
      if (target === undefined) return;

      await expect(manager.connect(committee)[setter](target))
        .to.emit(daemonConfig, "ConfigValueUpdated")
        .withArgs(key, en0x(target));
      expect(await daemonConfig.get(key)).to.equal(en0x(target));
    });
  }
});
