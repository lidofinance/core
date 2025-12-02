import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, PredepositGuarantee, StakingVault, VaultHub } from "typechain-types";

// TS interface aligned with contracts/common/interfaces/IGateSeal.sol
interface IGateSeal {
  connect(signer: HardhatEthersSigner): IGateSeal;
  seal(_sealables: string[]): Promise<unknown>;
  is_expired(): Promise<boolean>;
  get_sealing_committee(): Promise<string>;
}

// Minimal ABI reflecting IGateSeal.sol
const IGateSeal_ABI = [
  "function seal(address[] memory _sealables) external",
  "function is_expired() external view returns (bool)",
  "function get_sealing_committee() external view returns (address)",
];

import { ether, generateValidator } from "lib";
import {
  createVaultWithDashboard,
  generatePredepositData,
  getProtocolContext,
  ProtocolContext,
  setupLidoForVaults,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: GateSeal pause functionality for VaultHub and PredepositGuarantee", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let stakingVault: StakingVault;
  let dashboard: Dashboard;
  let vaultHub: VaultHub;
  let predepositGuarantee: PredepositGuarantee;
  let gateSeal: IGateSeal;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let sealingCommittee: HardhatEthersSigner;
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

    // Get the gateSeal from the state file
    // Note: In actual deployment, this would be the gateSealForVaults created during V3 upgrade
    const state = await import("lib/state-file").then((m) => m.readNetworkState());
    const gateSealAddress = state.gateSealV3?.address;

    if (!gateSealAddress) {
      throw new Error("GateSeal address not found in state file. Make sure V3 upgrade has been deployed.");
    }

    // Create GateSeal contract instance typed via IGateSeal interface
    gateSeal = new ethers.Contract(gateSealAddress, IGateSeal_ABI, ethers.provider) as unknown as IGateSeal;

    // Get the actual sealing committee address and impersonate it
    const sealingCommitteeAddress = await gateSeal.get_sealing_committee();
    await ethers.provider.send("hardhat_impersonateAccount", [sealingCommitteeAddress]);
    await ethers.provider.send("hardhat_setBalance", [sealingCommitteeAddress, "0x56BC75E2D63100000"]); // 100 ETH
    sealingCommittee = await ethers.getSigner(sealingCommitteeAddress);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  it("GateSeal can pause VaultHub", async function () {
    if (ctx.isScratch) {
      this.skip();
    }
    // Verify VaultHub is not paused initially
    expect(await vaultHub.isPaused()).to.equal(false);

    // Verify gateSeal is not expired
    expect(await gateSeal.is_expired()).to.equal(false);

    // Seal VaultHub using the sealing committee
    await expect(gateSeal.connect(sealingCommittee).seal([await vaultHub.getAddress()])).to.emit(vaultHub, "Paused");

    // Verify VaultHub is now paused
    expect(await vaultHub.isPaused()).to.equal(true);

    // Verify that VaultHub operations are blocked
    await expect(dashboard.connect(owner).fund({ value: ether("1") })).to.be.revertedWithCustomError(
      vaultHub,
      "ResumedExpected",
    );
  });

  it("GateSeal can pause PredepositGuarantee", async function () {
    if (ctx.isScratch) {
      this.skip();
    }
    // Verify PDG is not paused initially
    expect(await predepositGuarantee.isPaused()).to.equal(false);

    // Verify gateSeal is not expired
    expect(await gateSeal.is_expired()).to.equal(false);

    // Setup for testing PDG operations (before sealing)
    const withdrawalCredentials = await stakingVault.withdrawalCredentials();
    const validator = generateValidator(withdrawalCredentials);

    // Top up node operator balance before sealing
    await predepositGuarantee.connect(nodeOperator).topUpNodeOperatorBalance(nodeOperator, { value: ether("1") });

    const predepositData = await generatePredepositData(
      Object.assign(predepositGuarantee, { address: await predepositGuarantee.getAddress() }),
      dashboard,
      owner,
      nodeOperator,
      validator,
    );

    // Seal PredepositGuarantee using the sealing committee
    await expect(gateSeal.connect(sealingCommittee).seal([await predepositGuarantee.getAddress()])).to.emit(
      predepositGuarantee,
      "Paused",
    );

    // Verify PredepositGuarantee is now paused
    expect(await predepositGuarantee.isPaused()).to.equal(true);

    // Verify that PDG operations are blocked when paused
    await expect(
      predepositGuarantee
        .connect(nodeOperator)
        .predeposit(stakingVault, [predepositData.deposit], [predepositData.depositY]),
    ).to.be.revertedWithCustomError(predepositGuarantee, "ResumedExpected");
  });

  it("GateSeal can pause both VaultHub and PredepositGuarantee simultaneously", async function () {
    if (ctx.isScratch) {
      this.skip();
    }
    // Verify both are not paused initially
    expect(await vaultHub.isPaused()).to.equal(false);
    expect(await predepositGuarantee.isPaused()).to.equal(false);

    // Verify gateSeal is not expired
    expect(await gateSeal.is_expired()).to.equal(false);

    // Setup for testing PDG operations (before sealing)
    const withdrawalCredentials = await stakingVault.withdrawalCredentials();
    const validator = generateValidator(withdrawalCredentials);

    // Top up node operator balance before sealing
    await predepositGuarantee.connect(nodeOperator).topUpNodeOperatorBalance(nodeOperator, { value: ether("1") });

    const predepositData = await generatePredepositData(
      Object.assign(predepositGuarantee, { address: await predepositGuarantee.getAddress() }),
      dashboard,
      owner,
      nodeOperator,
      validator,
    );

    // Seal both VaultHub and PredepositGuarantee
    await expect(
      gateSeal.connect(sealingCommittee).seal([await vaultHub.getAddress(), await predepositGuarantee.getAddress()]),
    )
      .to.emit(vaultHub, "Paused")
      .to.emit(predepositGuarantee, "Paused");

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
    if (ctx.isScratch) {
      this.skip();
    }
    // Grant RESUME_ROLE to agent for both contracts
    await vaultHub.connect(agent).grantRole(await vaultHub.RESUME_ROLE(), agent);
    await predepositGuarantee.connect(agent).grantRole(await predepositGuarantee.RESUME_ROLE(), agent);

    // Seal both contracts
    await gateSeal
      .connect(sealingCommittee)
      .seal([await vaultHub.getAddress(), await predepositGuarantee.getAddress()]);

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

  it("Non-sealing committee member cannot seal", async function () {
    if (ctx.isScratch) {
      this.skip();
    }
    // Attempt to seal with unauthorized address should fail
    // Note: The actual error will depend on the GateSeal implementation
    // This test verifies that access control is working
    await expect(gateSeal.connect(stranger).seal([await vaultHub.getAddress()])).to.be.reverted;
  });

  it("Cannot seal when VaultHub is already paused", async function () {
    if (ctx.isScratch) {
      this.skip();
    }
    // First, pause VaultHub manually using PAUSE_ROLE
    await vaultHub.connect(agent).grantRole(await vaultHub.PAUSE_ROLE(), agent);
    await vaultHub.connect(agent).pauseFor(1000);

    expect(await vaultHub.isPaused()).to.equal(true);

    // Attempt to seal already paused contract should revert
    // Note: The GateSeal is a Vyper contract that may not properly bubble up custom errors
    await expect(gateSeal.connect(sealingCommittee).seal([await vaultHub.getAddress()])).to.be.reverted;
  });

  it("Cannot seal when PredepositGuarantee is already paused", async function () {
    if (ctx.isScratch) {
      this.skip();
    }
    // First, pause PDG manually using PAUSE_ROLE
    await predepositGuarantee.connect(agent).grantRole(await predepositGuarantee.PAUSE_ROLE(), agent);
    await predepositGuarantee.connect(agent).pauseFor(1000);

    expect(await predepositGuarantee.isPaused()).to.equal(true);

    // Attempt to seal already paused contract should revert
    // Note: The GateSeal is a Vyper contract that may not properly bubble up custom errors
    await expect(gateSeal.connect(sealingCommittee).seal([await predepositGuarantee.getAddress()])).to.be.reverted;
  });
});
