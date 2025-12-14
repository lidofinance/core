import { expect } from "chai";
import { ethers } from "hardhat";
import { beforeEach } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { PredepositGuarantee, StakingVault } from "typechain-types";

import { days, ether, impersonate, randomValidatorPubkey } from "lib";
import {
  createVaultWithDashboard,
  ensurePredepositGuaranteeUnpaused,
  getProtocolContext,
  ProtocolContext,
  setupLidoForVaults,
  testMethod,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: PredepositGuarantee Roles and Access Control", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let agent: HardhatEthersSigner;
  let pauseRole: HardhatEthersSigner;
  let resumeRole: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let depositor: HardhatEthersSigner;
  let roles: HardhatEthersSigner[];

  let predepositGuarantee: PredepositGuarantee;
  let stakingVault: StakingVault;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    await ensurePredepositGuaranteeUnpaused(ctx);

    predepositGuarantee = ctx.contracts.predepositGuarantee;

    // Get DAO agent - it has DEFAULT_ADMIN_ROLE on PredepositGuarantee
    agent = await ctx.getSigner("agent");

    [pauseRole, resumeRole, stranger, nodeOperator, depositor] = await ethers.getSigners();

    // Grant roles from agent
    await predepositGuarantee.connect(agent).grantRole(await predepositGuarantee.PAUSE_ROLE(), pauseRole);
    await predepositGuarantee.connect(agent).grantRole(await predepositGuarantee.RESUME_ROLE(), resumeRole);

    roles = [pauseRole, resumeRole, stranger, nodeOperator, depositor];

    // Create a vault for testing
    const [vaultOwner] = await ethers.getSigners();
    ({ stakingVault } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      vaultOwner,
      nodeOperator,
      nodeOperator,
    ));

    // Set depositor for node operator
    await predepositGuarantee.connect(nodeOperator).setNodeOperatorDepositor(depositor);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Role-protected methods", () => {
    it("pauseFor - requires PAUSE_ROLE", async () => {
      await testMethod(
        predepositGuarantee,
        "pauseFor",
        {
          successUsers: [pauseRole],
          failingUsers: [...roles.filter((r) => r !== pauseRole), agent],
        },
        [days(1n)],
        await predepositGuarantee.PAUSE_ROLE(),
      );
    });

    it("pauseUntil - requires PAUSE_ROLE", async () => {
      const futureTimestamp = BigInt(Math.floor(Date.now() / 1000) + 86400);
      await testMethod(
        predepositGuarantee,
        "pauseUntil",
        {
          successUsers: [pauseRole],
          failingUsers: [...roles.filter((r) => r !== pauseRole), agent],
        },
        [futureTimestamp],
        await predepositGuarantee.PAUSE_ROLE(),
      );
    });

    it("resume - requires RESUME_ROLE", async () => {
      // First pause the contract
      await predepositGuarantee.connect(pauseRole).pauseFor(days(1n));

      await testMethod(
        predepositGuarantee,
        "resume",
        {
          successUsers: [resumeRole],
          failingUsers: [...roles.filter((r) => r !== resumeRole), agent],
        },
        [],
        await predepositGuarantee.RESUME_ROLE(),
      );
    });
  });

  describe("Sender-specific methods", () => {
    it("predeposit - requires depositor for node operator", async () => {
      const method = "predeposit";
      const deposits = [
        {
          pubkey: randomValidatorPubkey(),
          amount: ether("1"),
          signature: new Uint8Array(96),
          depositDataRoot: new Uint8Array(32),
        },
      ];
      const depositsY = [
        {
          pubkeyY: {
            a: "0x" + "0".repeat(64),
            b: "0x" + "0".repeat(64),
          },
          signatureY: {
            c0_a: "0x" + "0".repeat(64),
            c0_b: "0x" + "0".repeat(64),
            c1_a: "0x" + "0".repeat(64),
            c1_b: "0x" + "0".repeat(64),
          },
        },
      ];
      const args: [typeof stakingVault, typeof deposits, typeof depositsY] = [stakingVault, deposits, depositsY];

      // Should fail for non-depositor
      for (const user of [...roles.filter((r) => r !== depositor), agent]) {
        await expect(predepositGuarantee.connect(user)[method](...args)).to.be.revertedWithCustomError(
          predepositGuarantee,
          "NotDepositor",
        );
      }

      // Should succeed for depositor (but might fail for other reasons like balance)
      await expect(predepositGuarantee.connect(depositor)[method](...args)).to.not.be.revertedWithCustomError(
        predepositGuarantee,
        "NotDepositor",
      );
    });

    it("proveUnknownValidator - requires staking vault owner", async () => {
      const method = "proveUnknownValidator";
      const witness = {
        proof: [
          "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        ],
        pubkey: "0x",
        validatorIndex: 0n,
        childBlockTimestamp: 0n,
        slot: 0n,
        proposerIndex: 0n,
      };
      const args: [typeof witness, typeof stakingVault] = [witness, stakingVault];

      // Should fail for non-owner
      for (const user of [...roles, agent]) {
        await expect(predepositGuarantee.connect(user)[method](...args)).to.be.revertedWithCustomError(
          predepositGuarantee,
          "NotStakingVaultOwner",
        );
      }

      // Should succeed for vault owner (VaultHub, since vault is connected to VaultHub)
      const vaultOwner = await stakingVault.owner();
      const vaultOwnerSigner = await impersonate(vaultOwner, ether("10"));
      await expect(predepositGuarantee.connect(vaultOwnerSigner)[method](...args)).to.not.be.revertedWithCustomError(
        predepositGuarantee,
        "NotStakingVaultOwner",
      );
    });

    it("topUpExistingValidators - requires depositor for node operator of each validator", async () => {
      const method = "topUpExistingValidators";
      const topUps = [
        {
          pubkey: randomValidatorPubkey(),
          amount: ether("1"),
        },
      ];
      const args: [typeof topUps] = [topUps];

      // Should fail for unauthorized users (not a depositor)
      for (const user of [...roles, agent]) {
        await expect(predepositGuarantee.connect(user)[method](...args)).to.be.revertedWithCustomError(
          predepositGuarantee,
          "NotDepositor",
        );
      }

      // Note: To properly test that depositor can call this, we would need a fully activated validator
      // with nodeOperator set, which is beyond the scope of this ACL test
    });

    it("topUpNodeOperatorBalance - requires guarantor", async () => {
      const method = "topUpNodeOperatorBalance";
      const args: [string] = [nodeOperator.address];

      // Should fail for unauthorized users (not a guarantor)
      for (const user of [...roles.filter((r) => r !== nodeOperator), agent]) {
        await expect(
          predepositGuarantee.connect(user)[method](...args, { value: ether("1") }),
        ).to.be.revertedWithCustomError(predepositGuarantee, "NotGuarantor");
      }

      // Should succeed for node operator (default guarantor is the node operator itself)
      await expect(predepositGuarantee.connect(nodeOperator)[method](...args, { value: ether("1") })).to.not.be
        .reverted;
    });

    it("setNodeOperatorGuarantor - can be called by node operator", async () => {
      const method = "setNodeOperatorGuarantor";
      const [newGuarantor] = await ethers.getSigners();
      const args: [string] = [newGuarantor.address];

      // Should succeed for node operator (permissionless for the node operator to set their own guarantor)
      await expect(predepositGuarantee.connect(nodeOperator)[method](...args)).to.not.be.reverted;
    });

    it("setNodeOperatorDepositor - can be called by node operator", async () => {
      const method = "setNodeOperatorDepositor";
      const [newDepositor] = await ethers.getSigners();
      const args: [string] = [newDepositor.address];

      // Should succeed for node operator (permissionless for the node operator to set their own depositor)
      await expect(predepositGuarantee.connect(nodeOperator)[method](...args)).to.not.be.reverted;
    });
  });
});
