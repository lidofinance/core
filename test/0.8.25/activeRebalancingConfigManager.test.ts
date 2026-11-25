import { expect } from "chai";
import { MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ActiveRebalancingConfigManager,
  ActiveRebalancingConfigManager__factory,
  OracleDaemonConfig,
  OracleDaemonConfig__factory,
} from "typechain-types";

import { en0x } from "lib";

import { Snapshot } from "test/suite";

type Bounds = { min: bigint; max: bigint };
type KeyBounds = {
  rateLimit: Bounds;
  operatorExcessBP: Bounds;
  moduleExcessBP: Bounds;
  gracePeriodEpochs: Bounds;
};

const BOUNDS: KeyBounds = {
  rateLimit: { min: 100n, max: 1_000n },
  operatorExcessBP: { min: 500n, max: 5_000n },
  moduleExcessBP: { min: 100n, max: 2_000n },
  gracePeriodEpochs: { min: 225n, max: 6_750n },
};

// Values the DAO vote sets before the manager gets the role; the manager only updates existing keys
const INITIAL_VALUES: Record<string, bigint> = {
  EXIT_ITERATION_CHUNK: 32n,
  ACTIVE_REBALANCING_ENABLED: 0n,
  ACTIVE_REBALANCING_RATE_LIMIT: 0n,
  ACTIVE_REBALANCING_OPERATOR_EXCESS_BP: 0n,
  ACTIVE_REBALANCING_MODULE_EXCESS_BP: 0n,
  ACTIVE_REBALANCING_GRACE_PERIOD_EPOCHS: 0n,
};

type NumericSetter = "setRateLimit" | "setOperatorExcessBP" | "setModuleExcessBP" | "setGracePeriodEpochs";

const NUMERIC_KEYS: { key: string; setter: NumericSetter; bounds: keyof KeyBounds }[] = [
  { key: "ACTIVE_REBALANCING_RATE_LIMIT", setter: "setRateLimit", bounds: "rateLimit" },
  { key: "ACTIVE_REBALANCING_OPERATOR_EXCESS_BP", setter: "setOperatorExcessBP", bounds: "operatorExcessBP" },
  { key: "ACTIVE_REBALANCING_MODULE_EXCESS_BP", setter: "setModuleExcessBP", bounds: "moduleExcessBP" },
  { key: "ACTIVE_REBALANCING_GRACE_PERIOD_EPOCHS", setter: "setGracePeriodEpochs", bounds: "gracePeriodEpochs" },
];

describe("ActiveRebalancingConfigManager.sol", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let committee: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let daemonConfig: OracleDaemonConfig;
  let manager: ActiveRebalancingConfigManager;

  let originalState: string;

  const deployManager = (bounds: KeyBounds = BOUNDS, daemonConfigAddress?: string) =>
    new ActiveRebalancingConfigManager__factory(deployer).deploy(admin, daemonConfigAddress ?? daemonConfig, bounds);

  before(async () => {
    [deployer, admin, committee, stranger] = await ethers.getSigners();

    daemonConfig = await new OracleDaemonConfig__factory(deployer).deploy(admin, [admin]);
    for (const [key, value] of Object.entries(INITIAL_VALUES)) {
      await daemonConfig.connect(admin).set(key, en0x(value));
    }

    manager = await deployManager();
    await daemonConfig.connect(admin).grantRole(await daemonConfig.CONFIG_MANAGER_ROLE(), manager);
    await manager.connect(admin).grantRole(await manager.ACTIVE_REBALANCING_MANAGER_ROLE(), committee);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("reverts on a zero admin", async () => {
      await expect(new ActiveRebalancingConfigManager__factory(deployer).deploy(ZeroAddress, daemonConfig, BOUNDS))
        .to.be.revertedWithCustomError(manager, "ZeroArgument")
        .withArgs("admin");
    });

    it("reverts on a zero OracleDaemonConfig", async () => {
      await expect(deployManager(BOUNDS, ZeroAddress))
        .to.be.revertedWithCustomError(manager, "ZeroArgument")
        .withArgs("oracleDaemonConfig");
    });

    for (const { key, bounds } of NUMERIC_KEYS) {
      it(`reverts when the ${key} min exceeds its max`, async () => {
        await expect(deployManager({ ...BOUNDS, [bounds]: { min: 2n, max: 1n } }))
          .to.be.revertedWithCustomError(manager, "InvalidBounds")
          .withArgs(key, 2n, 1n);
      });
    }

    it("accepts bounds with min equal to max", async () => {
      const zero = { min: 0n, max: 0n };
      const pinned = await deployManager({
        rateLimit: zero,
        operatorExcessBP: zero,
        moduleExcessBP: zero,
        gracePeriodEpochs: zero,
      });
      expect(await pinned.getBounds()).to.deep.equal([
        [0n, 0n],
        [0n, 0n],
        [0n, 0n],
        [0n, 0n],
      ]);
    });

    it("stores the OracleDaemonConfig and the bounds", async () => {
      expect(await manager.ORACLE_DAEMON_CONFIG()).to.equal(await daemonConfig.getAddress());
      const bounds = await manager.getBounds();
      expect(bounds.rateLimit).to.deep.equal([BOUNDS.rateLimit.min, BOUNDS.rateLimit.max]);
      expect(bounds.operatorExcessBP).to.deep.equal([BOUNDS.operatorExcessBP.min, BOUNDS.operatorExcessBP.max]);
      expect(bounds.moduleExcessBP).to.deep.equal([BOUNDS.moduleExcessBP.min, BOUNDS.moduleExcessBP.max]);
      expect(bounds.gracePeriodEpochs).to.deep.equal([BOUNDS.gracePeriodEpochs.min, BOUNDS.gracePeriodEpochs.max]);
    });

    it("grants only the admin role", async () => {
      const fresh = await deployManager();
      expect(await fresh.getRoleMemberCount(await fresh.DEFAULT_ADMIN_ROLE())).to.equal(1n);
      expect(await fresh.hasRole(await fresh.DEFAULT_ADMIN_ROLE(), admin)).to.equal(true);
      expect(await fresh.getRoleMemberCount(await fresh.ACTIVE_REBALANCING_MANAGER_ROLE())).to.equal(0n);
    });
  });

  context("interface", () => {
    it("has no function that takes a key", async () => {
      const functions = manager.interface.fragments.filter((f) => f.type === "function");
      for (const fragment of functions) {
        const inputs = (fragment as unknown as { inputs: { type: string }[] }).inputs;
        expect(inputs.map((input) => input.type)).to.not.include("string");
        expect(inputs.map((input) => input.type)).to.not.include("bytes");
      }
    });
  });

  context("setEnabled", () => {
    it("reverts for a caller without the manager role", async () => {
      const role = await manager.ACTIVE_REBALANCING_MANAGER_ROLE();
      await expect(manager.connect(stranger).setEnabled(true))
        .to.be.revertedWithCustomError(manager, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, role);
      await expect(manager.connect(admin).setEnabled(true))
        .to.be.revertedWithCustomError(manager, "AccessControlUnauthorizedAccount")
        .withArgs(admin.address, role);
    });

    it("switches the flag on as 0x01 and off as 0x00", async () => {
      await expect(manager.connect(committee).setEnabled(true))
        .to.emit(daemonConfig, "ConfigValueUpdated")
        .withArgs("ACTIVE_REBALANCING_ENABLED", "0x01");
      expect(await daemonConfig.get("ACTIVE_REBALANCING_ENABLED")).to.equal("0x01");

      await manager.connect(committee).setEnabled(false);
      expect(await daemonConfig.get("ACTIVE_REBALANCING_ENABLED")).to.equal("0x00");
    });

    it("reverts when the flag already has the value", async () => {
      await expect(manager.connect(committee).setEnabled(false)).to.be.revertedWithCustomError(
        daemonConfig,
        "ValueIsSame",
      );
    });
  });

  for (const { key, setter, bounds } of NUMERIC_KEYS) {
    const { min, max } = BOUNDS[bounds];

    context(setter, () => {
      it("reverts for a caller without the manager role", async () => {
        await expect(manager.connect(stranger)[setter](min))
          .to.be.revertedWithCustomError(manager, "AccessControlUnauthorizedAccount")
          .withArgs(stranger.address, await manager.ACTIVE_REBALANCING_MANAGER_ROLE());
      });

      it("reverts below the min", async () => {
        await expect(manager.connect(committee)[setter](min - 1n))
          .to.be.revertedWithCustomError(manager, "ValueOutOfBounds")
          .withArgs(key, min - 1n, min, max);
      });

      it("reverts above the max", async () => {
        await expect(manager.connect(committee)[setter](max + 1n))
          .to.be.revertedWithCustomError(manager, "ValueOutOfBounds")
          .withArgs(key, max + 1n, min, max);
      });

      it("sets the min and the max", async () => {
        await expect(manager.connect(committee)[setter](min))
          .to.emit(daemonConfig, "ConfigValueUpdated")
          .withArgs(key, en0x(min));
        expect(await daemonConfig.get(key)).to.equal(en0x(min));

        await manager.connect(committee)[setter](max);
        expect(await daemonConfig.get(key)).to.equal(en0x(max));
      });

      it("reverts when the key already has the value", async () => {
        await manager.connect(committee)[setter](min);
        await expect(manager.connect(committee)[setter](min)).to.be.revertedWithCustomError(
          daemonConfig,
          "ValueIsSame",
        );
      });

      it("leaves the other keys untouched", async () => {
        await manager.connect(committee)[setter](max);
        for (const [otherKey, value] of Object.entries(INITIAL_VALUES)) {
          if (otherKey !== key) expect(await daemonConfig.get(otherKey)).to.equal(en0x(value));
        }
      });
    });
  }

  context("OracleDaemonConfig rules", () => {
    it("reverts when the key does not exist yet", async () => {
      await daemonConfig.connect(admin).unset("ACTIVE_REBALANCING_RATE_LIMIT");
      await expect(manager.connect(committee).setRateLimit(BOUNDS.rateLimit.min))
        .to.be.revertedWithCustomError(daemonConfig, "ValueDoesntExist")
        .withArgs("ACTIVE_REBALANCING_RATE_LIMIT");
    });

    it("reverts when the manager lost CONFIG_MANAGER_ROLE", async () => {
      await daemonConfig.connect(admin).revokeRole(await daemonConfig.CONFIG_MANAGER_ROLE(), manager);
      const role = await daemonConfig.CONFIG_MANAGER_ROLE();
      await expect(manager.connect(committee).setEnabled(true)).to.be.revertedWith(
        `AccessControl: account ${(await manager.getAddress()).toLowerCase()} is missing role ${role}`,
      );
    });
  });

  context("encoding", () => {
    // The shortest big-endian bytes, at least one byte: the encoding of the scratch deploy and the vote
    // Starts away from the initial zero, which the config rejects as unchanged, and returns to it last
    const VALUES = [1n, 32n, 255n, 256n, 11_520n, 65_535n, 65_536n, 2n ** 255n, MaxUint256 - 1n, MaxUint256, 0n];

    it("matches en0x for every width", async () => {
      const unbounded = { min: 0n, max: MaxUint256 };
      const wide = await deployManager({ ...BOUNDS, rateLimit: unbounded });
      await daemonConfig.connect(admin).grantRole(await daemonConfig.CONFIG_MANAGER_ROLE(), wide);
      await wide.connect(admin).grantRole(await wide.ACTIVE_REBALANCING_MANAGER_ROLE(), committee);

      for (const value of VALUES) {
        await wide.connect(committee).setRateLimit(value);
        expect(await daemonConfig.get("ACTIVE_REBALANCING_RATE_LIMIT")).to.equal(en0x(value));
      }
    });
  });
});
