import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { StakingVault, VaultHub__MockForStakingVault } from "typechain-types";

import { computeDepositDataRoot, ether, impersonate, streccak } from "lib";

import { deployStakingVaultBehindBeaconProxy } from "test/deploy";
import { Snapshot, Tracing } from "test/suite";

const getValidatorPubkey = (index: number) => "0x" + "ab".repeat(48 * index);

describe("StakingVault.sol:ValidatorsManagement", () => {
  let vaultOwner: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let vaultHubSigner: HardhatEthersSigner;

  let stakingVault: StakingVault;
  let vaultHub: VaultHub__MockForStakingVault;

  let vaultOwnerAddress: string;
  let vaultHubAddress: string;
  let operatorAddress: string;
  let originalState: string;

  before(async () => {
    [vaultOwner, operator, stranger] = await ethers.getSigners();
    ({ stakingVault, vaultHub } = await deployStakingVaultBehindBeaconProxy(vaultOwner, operator));

    vaultOwnerAddress = await vaultOwner.getAddress();
    vaultHubAddress = await vaultHub.getAddress();
    operatorAddress = await operator.getAddress();

    vaultHubSigner = await impersonate(vaultHubAddress, ether("10"));
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  context("pauseBeaconChainDeposits", () => {
    it("reverts if called by a non-owner", async () => {
      await expect(stakingVault.connect(stranger).pauseBeaconChainDeposits())
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(await stranger.getAddress());
    });

    it("reverts if the beacon deposits are already paused", async () => {
      await stakingVault.connect(vaultOwner).pauseBeaconChainDeposits();

      await expect(stakingVault.connect(vaultOwner).pauseBeaconChainDeposits()).to.be.revertedWithCustomError(
        stakingVault,
        "BeaconChainDepositsResumeExpected",
      );
    });

    it("allows to pause deposits", async () => {
      await expect(stakingVault.connect(vaultOwner).pauseBeaconChainDeposits()).to.emit(
        stakingVault,
        "BeaconChainDepositsPaused",
      );
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
    });
  });

  context("resumeBeaconChainDeposits", () => {
    it("reverts if called by a non-owner", async () => {
      await expect(stakingVault.connect(stranger).resumeBeaconChainDeposits())
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(await stranger.getAddress());
    });

    it("reverts if the beacon deposits are already resumed", async () => {
      await expect(stakingVault.connect(vaultOwner).resumeBeaconChainDeposits()).to.be.revertedWithCustomError(
        stakingVault,
        "BeaconChainDepositsPauseExpected",
      );
    });

    it("allows to resume deposits", async () => {
      await stakingVault.connect(vaultOwner).pauseBeaconChainDeposits();

      await expect(stakingVault.connect(vaultOwner).resumeBeaconChainDeposits()).to.emit(
        stakingVault,
        "BeaconChainDepositsResumed",
      );
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
    });
  });

  context("depositToBeaconChain", () => {
    it("reverts if called by a non-operator", async () => {
      await expect(
        stakingVault
          .connect(stranger)
          .depositToBeaconChain([
            { pubkey: "0x", signature: "0x", amount: 0, depositDataRoot: streccak("random-root") },
          ]),
      )
        .to.be.revertedWithCustomError(stakingVault, "NotAuthorized")
        .withArgs("depositToBeaconChain", stranger);
    });

    it("reverts if the number of deposits is zero", async () => {
      await expect(stakingVault.depositToBeaconChain([]))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_deposits");
    });

    it("reverts if the vault is not balanced", async () => {
      await stakingVault.connect(vaultHubSigner).lock(ether("1"));
      await expect(
        stakingVault
          .connect(operator)
          .depositToBeaconChain([
            { pubkey: "0x", signature: "0x", amount: 0, depositDataRoot: streccak("random-root") },
          ]),
      ).to.be.revertedWithCustomError(stakingVault, "Unbalanced");
    });

    it("reverts if the deposits are paused", async () => {
      await stakingVault.connect(vaultOwner).pauseBeaconChainDeposits();
      await expect(
        stakingVault
          .connect(operator)
          .depositToBeaconChain([
            { pubkey: "0x", signature: "0x", amount: 0, depositDataRoot: streccak("random-root") },
          ]),
      ).to.be.revertedWithCustomError(stakingVault, "BeaconChainDepositsArePaused");
    });

    it("makes deposits to the beacon chain and emits the DepositedToBeaconChain event", async () => {
      await stakingVault.fund({ value: ether("32") });

      const pubkey = "0x" + "ab".repeat(48);
      const signature = "0x" + "ef".repeat(96);
      const amount = ether("32");
      const withdrawalCredentials = await stakingVault.withdrawalCredentials();
      const depositDataRoot = computeDepositDataRoot(withdrawalCredentials, pubkey, signature, amount);

      await expect(
        stakingVault.connect(operator).depositToBeaconChain([{ pubkey, signature, amount, depositDataRoot }]),
      )
        .to.emit(stakingVault, "DepositedToBeaconChain")
        .withArgs(operator, 1, amount);
    });
  });

  context("calculateExitRequestFee", () => {
    it("reverts if the number of keys is zero", async () => {
      await expect(stakingVault.calculateExitRequestFee(0))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("_numberOfKeys");
    });

    it("returns the total fee for given number of validator keys", async () => {
      const fee = await stakingVault.calculateExitRequestFee(1);
      expect(fee).to.equal(1);
    });
  });

  context("requestValidatorsExit", () => {
    before(async () => {
      Tracing.enable();
    });

    after(async () => {
      Tracing.disable();
    });

    context("vault is balanced", () => {
      it("reverts if called by a non-owner or non-node operator", async () => {
        const keys = getValidatorPubkey(1);
        await expect(stakingVault.connect(stranger).requestValidatorsExit(keys))
          .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
          .withArgs(await stranger.getAddress());
      });

      it("reverts if passed fee is less than the required fee", async () => {
        const numberOfKeys = 4;
        const pubkeys = getValidatorPubkey(numberOfKeys);
        const fee = await stakingVault.calculateExitRequestFee(numberOfKeys - 1);

        await expect(stakingVault.connect(vaultOwner).requestValidatorsExit(pubkeys, { value: fee }))
          .to.be.revertedWithCustomError(stakingVault, "InsufficientExitFee")
          .withArgs(fee, numberOfKeys);
      });

      it("allows owner to request validators exit providing a fee", async () => {
        const numberOfKeys = 1;
        const pubkeys = getValidatorPubkey(numberOfKeys);
        const fee = await stakingVault.calculateExitRequestFee(numberOfKeys);

        await expect(stakingVault.connect(vaultOwner).requestValidatorsExit(pubkeys, { value: fee }))
          .to.emit(stakingVault, "ValidatorsExitRequested")
          .withArgs(vaultOwnerAddress, pubkeys);
      });

      it("allows node operator to request validators exit", async () => {
        const numberOfKeys = 1;
        const pubkeys = getValidatorPubkey(numberOfKeys);
        const fee = await stakingVault.calculateExitRequestFee(numberOfKeys);

        await expect(stakingVault.connect(operator).requestValidatorsExit(pubkeys, { value: fee }))
          .to.emit(stakingVault, "ValidatorsExitRequested")
          .withArgs(operatorAddress, pubkeys);
      });

      it("works with multiple pubkeys", async () => {
        const numberOfKeys = 2;
        const pubkeys = getValidatorPubkey(numberOfKeys);
        const fee = await stakingVault.calculateExitRequestFee(numberOfKeys);

        await expect(stakingVault.connect(vaultOwner).requestValidatorsExit(pubkeys, { value: fee }))
          .to.emit(stakingVault, "ValidatorsExitRequested")
          .withArgs(vaultOwnerAddress, pubkeys);
      });
    });

    context("vault is unbalanced", () => {
      beforeEach(async () => {
        await stakingVault.connect(vaultHubSigner).report(ether("1"), ether("0.1"), ether("1.1"));
        expect(await stakingVault.isBalanced()).to.be.false;
      });

      it("reverts if timelocked", async () => {
        await expect(stakingVault.requestValidatorsExit("0x")).to.be.revertedWithCustomError(
          stakingVault,
          "ExitTimelockNotElapsed",
        );
      });
    });
  });

  context("computeDepositDataRoot", () => {
    it("computes the deposit data root", async () => {
      // sample tx data: https://etherscan.io/tx/0x02980d44c119b0a8e3ca0d31c288e9f177c76fb4d7ab616563e399dd9c7c6507
      const pubkey =
        "0x8d6aa059b52f6b11d07d73805d409feba07dffb6442c4ef6645f7caa4038b1047e072cba21eb766579f8286ccac630b0";
      const withdrawalCredentials = "0x010000000000000000000000b8b5da17a1b7a8ad1cf45a12e1e61d3577052d35";
      const signature =
        "0xab95e358d002fd79bc08564a2db057dd5164af173915eba9e3e9da233d404c0eb0058760bc30cb89abbc55cf57f0c5a6018cdb17df73ca39ddc80a323a13c2e7ba942faa86757b26120b3a58dcce5d89e95ea1ee8fa3276ffac0f0ad9313211d";
      const amount = ether("32");
      const expectedDepositDataRoot = "0xb28f86815813d7da8132a2979836b326094a350e7aa301ba611163d4b7ca77be";

      computeDepositDataRoot(withdrawalCredentials, pubkey, signature, amount);

      expect(await stakingVault.computeDepositDataRoot(pubkey, withdrawalCredentials, signature, amount)).to.equal(
        expectedDepositDataRoot,
      );
    });
  });
});
