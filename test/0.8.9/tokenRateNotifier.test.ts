import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  NoInterface__Mock,
  TokenRateNotifier,
  TokenRatePusher__Mock,
  TokenRatePusherDualSupport__Mock,
  TokenRatePusherWithArgs__Mock,
} from "typechain-types";

import { Snapshot } from "test/suite";

// Mirrors `enum ObserverKind { Legacy, WithArgs }` in TokenRateNotifier.sol.
const KIND_LEGACY = 0;
const KIND_WITH_ARGS = 1;

const MAX_OBSERVERS_COUNT = 32n;

// A non-trivial rebase payload used in handlePostTokenRebase happy-path tests.
const REPORT = {
  reportTimestamp: 1_700_000_000n,
  timeElapsed: 86_400n,
  preTotalShares: 1_000_000n * 10n ** 18n,
  preTotalEther: 1_050_000n * 10n ** 18n,
  postTotalShares: 1_000_100n * 10n ** 18n,
  postTotalEther: 1_050_500n * 10n ** 18n,
  sharesMintedAsFees: 42n * 10n ** 18n,
};

const ZERO_REPORT = {
  reportTimestamp: 0n,
  timeElapsed: 0n,
  preTotalShares: 0n,
  preTotalEther: 0n,
  postTotalShares: 0n,
  postTotalEther: 0n,
  sharesMintedAsFees: 0n,
};

function reportTuple(report: typeof REPORT): [bigint, bigint, bigint, bigint, bigint, bigint, bigint] {
  return [
    report.reportTimestamp,
    report.timeElapsed,
    report.preTotalShares,
    report.preTotalEther,
    report.postTotalShares,
    report.postTotalEther,
    report.sharesMintedAsFees,
  ];
}

describe("TokenRateNotifier.sol", () => {
  let deployer: HardhatEthersSigner;
  let owner: HardhatEthersSigner;
  let provider: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let notifier: TokenRateNotifier;

  let originalState: string;

  // ---------- deploy helpers ----------

  async function deployLegacyMock(): Promise<TokenRatePusher__Mock> {
    return await ethers.deployContract("TokenRatePusher__Mock", [], deployer);
  }

  async function deployWithArgsMock(): Promise<TokenRatePusherWithArgs__Mock> {
    return await ethers.deployContract("TokenRatePusherWithArgs__Mock", [], deployer);
  }

  async function deployDualSupportMock(): Promise<TokenRatePusherDualSupport__Mock> {
    return await ethers.deployContract("TokenRatePusherDualSupport__Mock", [], deployer);
  }

  async function deployNoInterfaceMock(): Promise<NoInterface__Mock> {
    return await ethers.deployContract("NoInterface__Mock", [], deployer);
  }

  before(async () => {
    [deployer, owner, provider, stranger] = await ethers.getSigners();
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
    notifier = await ethers.deployContract("TokenRateNotifier", [owner.address, provider.address], deployer);
  });

  afterEach(async () => await Snapshot.restore(originalState));

  // ---------- constructor ----------

  describe("constructor", () => {
    it("reverts with zero owner", async () => {
      await expect(
        ethers.deployContract("TokenRateNotifier", [ZeroAddress, provider.address], deployer),
      ).to.be.revertedWithCustomError(notifier, "ErrorZeroAddressOwner");
    });

    it("reverts with zero token rate provider", async () => {
      await expect(
        ethers.deployContract("TokenRateNotifier", [owner.address, ZeroAddress], deployer),
      ).to.be.revertedWithCustomError(notifier, "ErrorZeroAddressTokenRateProvider");
    });

    it("sets initial state correctly", async () => {
      expect(await notifier.owner()).to.equal(owner.address);
      expect(await notifier.TOKEN_RATE_PROVIDER()).to.equal(provider.address);
      expect(await notifier.MAX_OBSERVERS_COUNT()).to.equal(MAX_OBSERVERS_COUNT);
      expect(await notifier.INDEX_NOT_FOUND()).to.equal(2n ** 256n - 1n);
      expect(await notifier.observersLength()).to.equal(0n);

      const reqLegacy = await notifier.REQUIRED_INTERFACE();
      const reqWithArgs = await notifier.REQUIRED_INTERFACE_WITH_ARGS();
      expect(reqLegacy).to.not.equal("0x00000000");
      expect(reqWithArgs).to.not.equal("0x00000000");
      expect(reqLegacy).to.not.equal(reqWithArgs);
    });
  });

  // ---------- addObserver ----------

  describe("addObserver", () => {
    it("reverts when called by non-owner", async () => {
      const mock = await deployLegacyMock();
      await expect(notifier.connect(stranger).addObserver(mock)).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("reverts on zero address observer", async () => {
      await expect(notifier.connect(owner).addObserver(ZeroAddress)).to.be.revertedWithCustomError(
        notifier,
        "ErrorZeroAddressObserver",
      );
    });

    it("reverts on observer with no supported interface (no supportsInterface fn)", async () => {
      const bad = await deployNoInterfaceMock();
      await expect(notifier.connect(owner).addObserver(bad)).to.be.revertedWithCustomError(
        notifier,
        "ErrorBadObserverInterface",
      );
    });

    it("registers legacy observer when only ITokenRatePusher is supported", async () => {
      const mock = await deployLegacyMock();
      const addr = await mock.getAddress();

      await expect(notifier.connect(owner).addObserver(mock))
        .to.emit(notifier, "ObserverAdded")
        .withArgs(addr, KIND_LEGACY);

      expect(await notifier.observersLength()).to.equal(1n);
      const entry = await notifier.observers(0);
      expect(entry[0]).to.equal(addr);
      expect(entry[1]).to.equal(KIND_LEGACY);
    });

    it("registers WithArgs observer when only ITokenRatePusherWithArgs is supported", async () => {
      const mock = await deployWithArgsMock();
      const addr = await mock.getAddress();

      await expect(notifier.connect(owner).addObserver(mock))
        .to.emit(notifier, "ObserverAdded")
        .withArgs(addr, KIND_WITH_ARGS);

      expect(await notifier.observersLength()).to.equal(1n);
      const entry = await notifier.observers(0);
      expect(entry[0]).to.equal(addr);
      expect(entry[1]).to.equal(KIND_WITH_ARGS);
    });

    it("registers as WithArgs when both interfaces are claimed (priority rule)", async () => {
      const dual = await deployDualSupportMock();
      const addr = await dual.getAddress();

      await expect(notifier.connect(owner).addObserver(dual))
        .to.emit(notifier, "ObserverAdded")
        .withArgs(addr, KIND_WITH_ARGS);

      const entry = await notifier.observers(0);
      expect(entry[1]).to.equal(KIND_WITH_ARGS);
    });

    it("reverts when registering the same observer twice (legacy)", async () => {
      const mock = await deployLegacyMock();
      await notifier.connect(owner).addObserver(mock);
      await expect(notifier.connect(owner).addObserver(mock)).to.be.revertedWithCustomError(
        notifier,
        "ErrorAddExistedObserver",
      );
    });

    it("reverts when registering the same address twice (cross-kind dedup)", async () => {
      // A dual-support observer registers as WithArgs (priority). Re-registering the same address
      // must be rejected as duplicate regardless of the kind detection path.
      const dual = await deployDualSupportMock();
      await notifier.connect(owner).addObserver(dual);
      await expect(notifier.connect(owner).addObserver(dual)).to.be.revertedWithCustomError(
        notifier,
        "ErrorAddExistedObserver",
      );
    });

    it("respects the combined MAX_OBSERVERS_COUNT cap (mixed kinds)", async () => {
      // Register 32 mixed-kind observers, then assert the 33rd fails.
      for (let i = 0; i < Number(MAX_OBSERVERS_COUNT); i++) {
        const m = i % 2 === 0 ? await deployLegacyMock() : await deployWithArgsMock();
        await notifier.connect(owner).addObserver(m);
      }
      expect(await notifier.observersLength()).to.equal(MAX_OBSERVERS_COUNT);

      const extra = await deployLegacyMock();
      await expect(notifier.connect(owner).addObserver(extra)).to.be.revertedWithCustomError(
        notifier,
        "ErrorMaxObserversCountExceeded",
      );
    });
  });

  // ---------- removeObserver ----------

  describe("removeObserver", () => {
    it("reverts when called by non-owner", async () => {
      const mock = await deployLegacyMock();
      await notifier.connect(owner).addObserver(mock);
      await expect(notifier.connect(stranger).removeObserver(mock)).to.be.revertedWith(
        "Ownable: caller is not the owner",
      );
    });

    it("reverts when removing a non-registered observer", async () => {
      const mock = await deployLegacyMock();
      await expect(notifier.connect(owner).removeObserver(mock)).to.be.revertedWithCustomError(
        notifier,
        "ErrorNoObserverToRemove",
      );
    });

    it("removes a legacy observer and emits the kind", async () => {
      const mock = await deployLegacyMock();
      const addr = await mock.getAddress();
      await notifier.connect(owner).addObserver(mock);

      await expect(notifier.connect(owner).removeObserver(mock))
        .to.emit(notifier, "ObserverRemoved")
        .withArgs(addr, KIND_LEGACY);

      expect(await notifier.observersLength()).to.equal(0n);
    });

    it("removes a WithArgs observer and emits the WithArgs kind", async () => {
      const mock = await deployWithArgsMock();
      const addr = await mock.getAddress();
      await notifier.connect(owner).addObserver(mock);

      await expect(notifier.connect(owner).removeObserver(mock))
        .to.emit(notifier, "ObserverRemoved")
        .withArgs(addr, KIND_WITH_ARGS);

      expect(await notifier.observersLength()).to.equal(0n);
    });

    it("swap-and-pop preserves the moved entry's kind", async () => {
      // Add A(Legacy), B(WithArgs), C(Legacy). Remove B → C slides into B's slot.
      const a = await deployLegacyMock();
      const b = await deployWithArgsMock();
      const c = await deployLegacyMock();

      await notifier.connect(owner).addObserver(a);
      await notifier.connect(owner).addObserver(b);
      await notifier.connect(owner).addObserver(c);

      await expect(notifier.connect(owner).removeObserver(b))
        .to.emit(notifier, "ObserverRemoved")
        .withArgs(await b.getAddress(), KIND_WITH_ARGS);

      expect(await notifier.observersLength()).to.equal(2n);

      const slot0 = await notifier.observers(0);
      expect(slot0[0]).to.equal(await a.getAddress());
      expect(slot0[1]).to.equal(KIND_LEGACY);

      const slot1 = await notifier.observers(1);
      expect(slot1[0]).to.equal(await c.getAddress());
      expect(slot1[1]).to.equal(KIND_LEGACY);
    });
  });

  // ---------- handlePostTokenRebase ----------

  describe("handlePostTokenRebase", () => {
    it("reverts when called by an unauthorized caller", async () => {
      await expect(
        notifier.connect(stranger).handlePostTokenRebase(...reportTuple(REPORT)),
      ).to.be.revertedWithCustomError(notifier, "ErrorNotAuthorizedRebaseCaller");
    });

    it("dispatches no-arg pushTokenRate() to legacy observers", async () => {
      const mock = await deployLegacyMock();
      await notifier.connect(owner).addObserver(mock);

      await notifier.connect(provider).handlePostTokenRebase(...reportTuple(REPORT));

      expect(await mock.pushCount()).to.equal(1n);
    });

    it("dispatches full payload to WithArgs observers", async () => {
      const mock = await deployWithArgsMock();
      await notifier.connect(owner).addObserver(mock);

      await notifier.connect(provider).handlePostTokenRebase(...reportTuple(REPORT));

      expect(await mock.pushCount()).to.equal(1n);
      const received = await mock.lastReceived();
      expect(received[0]).to.equal(REPORT.reportTimestamp);
      expect(received[1]).to.equal(REPORT.timeElapsed);
      expect(received[2]).to.equal(REPORT.preTotalShares);
      expect(received[3]).to.equal(REPORT.preTotalEther);
      expect(received[4]).to.equal(REPORT.postTotalShares);
      expect(received[5]).to.equal(REPORT.postTotalEther);
      expect(received[6]).to.equal(REPORT.sharesMintedAsFees);
    });

    it("dispatches to a mixed set in one rebase", async () => {
      const lg = await deployLegacyMock();
      const wa = await deployWithArgsMock();
      await notifier.connect(owner).addObserver(lg);
      await notifier.connect(owner).addObserver(wa);

      await notifier.connect(provider).handlePostTokenRebase(...reportTuple(REPORT));

      expect(await lg.pushCount()).to.equal(1n);
      expect(await wa.pushCount()).to.equal(1n);

      // WithArgs observer got the right per-rebase value
      const received = await wa.lastReceived();
      expect(received[6]).to.equal(REPORT.sharesMintedAsFees);
    });

    it("forwards _sharesMintedAsFees = 0 (non-profitable rebase) verbatim", async () => {
      const wa = await deployWithArgsMock();
      await notifier.connect(owner).addObserver(wa);

      await notifier.connect(provider).handlePostTokenRebase(...reportTuple(ZERO_REPORT));

      expect(await wa.pushCount()).to.equal(1n);
      const received = await wa.lastReceived();
      expect(received[6]).to.equal(0n);
    });

    it("forwards _sharesMintedAsFees at type(uint256).max (upper boundary) verbatim", async () => {
      const wa = await deployWithArgsMock();
      await notifier.connect(owner).addObserver(wa);

      const max = 2n ** 256n - 1n;
      await notifier.connect(provider).handlePostTokenRebase(0n, 0n, 0n, 0n, 0n, 0n, max);

      const received = await wa.lastReceived();
      expect(received[6]).to.equal(max);
    });

    it("soft-fails when a legacy observer reverts with non-empty data", async () => {
      const mock = await deployLegacyMock();
      await notifier.connect(owner).addObserver(mock);
      await mock.setShouldRevertWithData(true);

      await expect(notifier.connect(provider).handlePostTokenRebase(...reportTuple(REPORT))).to.emit(
        notifier,
        "PushTokenRateFailed",
      );

      expect(await mock.pushCount()).to.equal(0n);
    });

    it("soft-fails when a WithArgs observer reverts with non-empty data", async () => {
      const mock = await deployWithArgsMock();
      await notifier.connect(owner).addObserver(mock);
      await mock.setShouldRevertWithData(true);

      await expect(notifier.connect(provider).handlePostTokenRebase(...reportTuple(REPORT))).to.emit(
        notifier,
        "PushTokenRateFailed",
      );

      expect(await mock.pushCount()).to.equal(0n);
    });

    it("bubbles up empty-data revert from a legacy observer (OOG guard)", async () => {
      const mock = await deployLegacyMock();
      await notifier.connect(owner).addObserver(mock);
      await mock.setShouldRevertWithoutData(true);

      await expect(
        notifier.connect(provider).handlePostTokenRebase(...reportTuple(REPORT)),
      ).to.be.revertedWithCustomError(notifier, "ErrorTokenRateNotifierRevertedWithNoData");
    });

    it("bubbles up empty-data revert from a WithArgs observer (OOG guard, new path)", async () => {
      const mock = await deployWithArgsMock();
      await notifier.connect(owner).addObserver(mock);
      await mock.setShouldRevertWithoutData(true);

      await expect(
        notifier.connect(provider).handlePostTokenRebase(...reportTuple(REPORT)),
      ).to.be.revertedWithCustomError(notifier, "ErrorTokenRateNotifierRevertedWithNoData");
    });

    it("skips a removed observer in subsequent rebases (post-swap-and-pop iteration)", async () => {
      const a = await deployLegacyMock();
      const b = await deployWithArgsMock();
      const c = await deployLegacyMock();

      await notifier.connect(owner).addObserver(a);
      await notifier.connect(owner).addObserver(b);
      await notifier.connect(owner).addObserver(c);
      await notifier.connect(owner).removeObserver(b);

      await notifier.connect(provider).handlePostTokenRebase(...reportTuple(REPORT));

      expect(await a.pushCount()).to.equal(1n);
      expect(await c.pushCount()).to.equal(1n);
      expect(await b.pushCount()).to.equal(0n);
    });
  });
});
