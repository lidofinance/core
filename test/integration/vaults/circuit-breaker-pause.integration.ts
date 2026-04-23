import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, PredepositGuarantee, StakingVault, VaultHub } from "typechain-types";

import { ether, generateValidator } from "lib";
import {
  createVaultWithDashboard,
  ensurePredepositGuaranteeUnpaused,
  generatePredepositData,
  getProtocolContext,
  ProtocolContext,
  setupLidoForVaults,
} from "lib/protocol";

import { Snapshot } from "test/suite";

// TS interface aligned with the CircuitBreaker contract.
interface ICircuitBreaker {
  connect(signer: HardhatEthersSigner): ICircuitBreaker;
  pause(pausable: string): Promise<unknown>;
  heartbeat(): Promise<unknown>;
  getPauser(pausable: string): Promise<string>;
  getPausables(): Promise<string[]>;
  isPauserLive(pauser: string): Promise<boolean>;
  pauseDuration(): Promise<bigint>;
}

// Minimal ABI reflecting the CircuitBreaker surface used by these tests.
const ICircuitBreaker_ABI = [
  "function pause(address _pausable) external",
  "function heartbeat() external",
  "function getPauser(address _pausable) external view returns (address)",
  "function getPausables() external view returns (address[])",
  "function isPauserLive(address _pauser) external view returns (bool)",
  "function pauseDuration() external view returns (uint256)",
  "event PauseTriggered(address indexed pausable, address indexed pauser, uint256 pauseDuration)",
  "error SenderNotPauser()",
  "error PauseFailed()",
  "error HeartbeatExpired()",
];

describe("Integration: CircuitBreaker pause functionality for VaultHub and PredepositGuarantee", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let stakingVault: StakingVault;
  let dashboard: Dashboard;
  let vaultHub: VaultHub;
  let predepositGuarantee: PredepositGuarantee;
  let circuitBreaker: ICircuitBreaker;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let vaultHubPauser: HardhatEthersSigner;
  let predepositGuaranteePauser: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  before(async function () {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    if (ctx.isScratch) {
      this.skip();
    }
    await setupLidoForVaults(ctx);

    [owner, nodeOperator, stranger] = await ethers.getSigners();

    // Create a vault for testing
    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
      [],
    ));

    agent = await ctx.getSigner("agent");

    vaultHub = ctx.contracts.vaultHub;
    predepositGuarantee = ctx.contracts.predepositGuarantee;

    // Look up the CircuitBreaker address from the state file (replaces the previous GateSeal flow).
    const state = await import("lib/state-file").then((m) => m.readNetworkState());
    const circuitBreakerAddress = state.circuitBreaker?.address;

    if (!circuitBreakerAddress) {
      throw new Error("CircuitBreaker address not found in state file. Make sure the upgrade has been deployed.");
    }

    circuitBreaker = new ethers.Contract(
      circuitBreakerAddress,
      ICircuitBreaker_ABI,
      ethers.provider,
    ) as unknown as ICircuitBreaker;

    const vaultHubPauserAddress = await circuitBreaker.getPauser(await vaultHub.getAddress());
    const predepositGuaranteePauserAddress = await circuitBreaker.getPauser(await predepositGuarantee.getAddress());

    if (vaultHubPauserAddress === ZeroAddress) {
      throw new Error(`CircuitBreaker at ${circuitBreakerAddress} has no registered pauser for VaultHub.`);
    }
    if (predepositGuaranteePauserAddress === ZeroAddress) {
      throw new Error(`CircuitBreaker at ${circuitBreakerAddress} has no registered pauser for PredepositGuarantee.`);
    }

    for (const address of new Set([vaultHubPauserAddress, predepositGuaranteePauserAddress])) {
      await ethers.provider.send("hardhat_impersonateAccount", [address]);
      await ethers.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]); // 100 ETH
    }

    vaultHubPauser = await ethers.getSigner(vaultHubPauserAddress);
    predepositGuaranteePauser = await ethers.getSigner(predepositGuaranteePauserAddress);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  it("CircuitBreaker can pause VaultHub", async function () {
    if (ctx.isScratch) {
      this.skip();
    }
    // Verify VaultHub is not paused initially
    expect(await vaultHub.isPaused()).to.equal(false);

    // Verify the registered pauser is live (heartbeat not expired)
    expect(await circuitBreaker.isPauserLive(vaultHubPauser.address)).to.equal(true);

    // Pause VaultHub through the CircuitBreaker via its registered pauser
    await expect(circuitBreaker.connect(vaultHubPauser).pause(await vaultHub.getAddress())).to.emit(vaultHub, "Paused");

    // Verify VaultHub is now paused
    expect(await vaultHub.isPaused()).to.equal(true);

    // Verify that VaultHub operations are blocked
    await expect(dashboard.connect(owner).fund({ value: ether("1") })).to.be.revertedWithCustomError(
      vaultHub,
      "ResumedExpected",
    );
  });

  it("CircuitBreaker can pause PredepositGuarantee", async function () {
    await ensurePredepositGuaranteeUnpaused(ctx);
    if (ctx.isScratch) {
      this.skip();
    }
    // Verify PDG is not paused initially
    expect(await predepositGuarantee.isPaused()).to.equal(false);

    // Verify the registered pauser is live (heartbeat not expired)
    expect(await circuitBreaker.isPauserLive(predepositGuaranteePauser.address)).to.equal(true);

    // Setup for testing PDG operations (before pausing)
    const withdrawalCredentials = await stakingVault.withdrawalCredentials();
    const validator = generateValidator(withdrawalCredentials);

    // Top up node operator balance before pausing
    await predepositGuarantee.connect(nodeOperator).topUpNodeOperatorBalance(nodeOperator, { value: ether("1") });

    const predepositData = await generatePredepositData(
      Object.assign(predepositGuarantee, { address: await predepositGuarantee.getAddress() }),
      dashboard,
      owner,
      nodeOperator,
      validator,
    );

    // Pause PredepositGuarantee through the CircuitBreaker via its registered pauser
    await expect(
      circuitBreaker.connect(predepositGuaranteePauser).pause(await predepositGuarantee.getAddress()),
    ).to.emit(predepositGuarantee, "Paused");

    // Verify PredepositGuarantee is now paused
    expect(await predepositGuarantee.isPaused()).to.equal(true);

    // Verify that PDG operations are blocked when paused
    await expect(
      predepositGuarantee
        .connect(nodeOperator)
        .predeposit(stakingVault, [predepositData.deposit], [predepositData.depositY]),
    ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
  });

  it("CircuitBreaker can pause both VaultHub and PredepositGuarantee", async function () {
    await ensurePredepositGuaranteeUnpaused(ctx);
    if (ctx.isScratch) {
      this.skip();
    }
    // Verify both are not paused initially
    expect(await vaultHub.isPaused()).to.equal(false);
    expect(await predepositGuarantee.isPaused()).to.equal(false);

    // Setup for testing PDG operations (before pausing)
    const withdrawalCredentials = await stakingVault.withdrawalCredentials();
    const validator = generateValidator(withdrawalCredentials);

    // Top up node operator balance before pausing
    await predepositGuarantee.connect(nodeOperator).topUpNodeOperatorBalance(nodeOperator, { value: ether("1") });

    const predepositData = await generatePredepositData(
      Object.assign(predepositGuarantee, { address: await predepositGuarantee.getAddress() }),
      dashboard,
      owner,
      nodeOperator,
      validator,
    );

    // CircuitBreaker pauses a single target per call, so VaultHub and PDG are paused in sequence
    await expect(circuitBreaker.connect(vaultHubPauser).pause(await vaultHub.getAddress())).to.emit(vaultHub, "Paused");
    await expect(
      circuitBreaker.connect(predepositGuaranteePauser).pause(await predepositGuarantee.getAddress()),
    ).to.emit(predepositGuarantee, "Paused");

    // Verify both are now paused
    expect(await vaultHub.isPaused()).to.equal(true);
    expect(await predepositGuarantee.isPaused()).to.equal(true);

    // Verify VaultHub operations are blocked
    await expect(dashboard.connect(owner).fund({ value: ether("1") })).to.be.revertedWithCustomError(
      vaultHub,
      "ResumedExpected",
    );

    // Verify PDG operations are blocked
    await expect(
      predepositGuarantee
        .connect(nodeOperator)
        .predeposit(stakingVault, [predepositData.deposit], [predepositData.depositY]),
    ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
  });

  it("Operations resume after RESUME_ROLE holder resumes the contracts", async function () {
    await ensurePredepositGuaranteeUnpaused(ctx);
    if (ctx.isScratch) {
      this.skip();
    }
    // Grant RESUME_ROLE to agent for both contracts
    await vaultHub.connect(agent).grantRole(await vaultHub.RESUME_ROLE(), agent);
    await predepositGuarantee.connect(agent).grantRole(await predepositGuarantee.RESUME_ROLE(), agent);

    // Pause both contracts through the CircuitBreaker
    await circuitBreaker.connect(vaultHubPauser).pause(await vaultHub.getAddress());
    await circuitBreaker.connect(predepositGuaranteePauser).pause(await predepositGuarantee.getAddress());

    expect(await vaultHub.isPaused()).to.equal(true);
    expect(await predepositGuarantee.isPaused()).to.equal(true);

    // Resume VaultHub
    await expect(vaultHub.connect(agent).resume()).to.emit(vaultHub, "Resumed");
    expect(await vaultHub.isPaused()).to.equal(false);

    // Resume PredepositGuarantee
    await expect(predepositGuarantee.connect(agent).resume()).to.emit(predepositGuarantee, "Resumed");
    expect(await predepositGuarantee.isPaused()).to.equal(false);

    // Verify VaultHub operations work again
    await expect(dashboard.connect(owner).fund({ value: ether("1") }))
      .to.emit(stakingVault, "EtherFunded")
      .withArgs(ether("1"));

    // Verify PDG operations work again
    await expect(
      predepositGuarantee.connect(nodeOperator).topUpNodeOperatorBalance(nodeOperator, { value: ether("1") }),
    )
      .to.emit(predepositGuarantee, "BalanceToppedUp")
      .withArgs(nodeOperator, nodeOperator, ether("1"));
  });

  it("Non-registered pauser cannot pause", async function () {
    if (ctx.isScratch) {
      this.skip();
    }
    // Attempt to pause with an unauthorized address should revert
    await expect(circuitBreaker.connect(stranger).pause(await vaultHub.getAddress())).to.be.reverted;
  });

  it("Cannot pause when VaultHub is already paused", async function () {
    if (ctx.isScratch) {
      this.skip();
    }
    // First, pause VaultHub manually using PAUSE_ROLE
    await vaultHub.connect(agent).grantRole(await vaultHub.PAUSE_ROLE(), agent);
    await vaultHub.connect(agent).pauseFor(1000);

    expect(await vaultHub.isPaused()).to.equal(true);

    // Attempt to pause an already-paused contract should revert
    await expect(circuitBreaker.connect(vaultHubPauser).pause(await vaultHub.getAddress())).to.be.reverted;
  });

  it("Cannot pause when PredepositGuarantee is already paused", async function () {
    await ensurePredepositGuaranteeUnpaused(ctx);
    if (ctx.isScratch) {
      this.skip();
    }
    // First, pause PDG manually using PAUSE_ROLE
    await predepositGuarantee.connect(agent).grantRole(await predepositGuarantee.PAUSE_ROLE(), agent);
    await predepositGuarantee.connect(agent).pauseFor(1000);

    expect(await predepositGuarantee.isPaused()).to.equal(true);

    // Attempt to pause an already-paused contract should revert
    await expect(circuitBreaker.connect(predepositGuaranteePauser).pause(await predepositGuarantee.getAddress())).to.be
      .reverted;
  });
});
