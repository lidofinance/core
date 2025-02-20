import { expect } from "chai";
import { ContractTransactionReceipt, keccak256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForVaultHub,
  LidoLocator,
  StakingVault__MockForVaultHub,
  StETH__HarnessForVaultHub,
  VaultFactory__MockForVaultHub,
  VaultHub,
} from "typechain-types";

import { ether, findEvents, randomAddress } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot, VAULTS_RELATIVE_SHARE_LIMIT_BP, ZERO_HASH } from "test/suite";

const ZERO_BYTES32 = "0x" + Buffer.from(ZERO_HASH).toString("hex");

const SHARE_LIMIT = ether("1");
const RESERVE_RATIO_BP = 10_00n;
const RESERVE_RATIO_THRESHOLD_BP = 8_00n;
const TREASURY_FEE_BP = 5_00n;

const TOTAL_BASIS_POINTS = 100_00n; // 100%
const CONNECT_DEPOSIT = ether("1");

const VAULTS_CONNECTED_VAULTS_LIMIT = 5; // Low limit to test the overflow

describe("VaultHub.sol:hub", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let locator: LidoLocator;
  let vaultHub: VaultHub;
  let depositContract: DepositContract__MockForVaultHub;
  let vaultFactory: VaultFactory__MockForVaultHub;
  let steth: StETH__HarnessForVaultHub;

  let codehash: string;

  let originalState: string;

  async function createVault(factory: VaultFactory__MockForVaultHub) {
    const vaultCreationTx = (await factory
      .createVault(await user.getAddress(), await user.getAddress())
      .then((tx) => tx.wait())) as ContractTransactionReceipt;

    const events = findEvents(vaultCreationTx, "VaultCreated");
    const vaultCreatedEvent = events[0];

    const vault = await ethers.getContractAt("StakingVault__MockForVaultHub", vaultCreatedEvent.args.vault, user);
    return vault;
  }

  async function connectVault(vault: StakingVault__MockForVaultHub) {
    await vaultHub
      .connect(user)
      .connectVault(
        await vault.getAddress(),
        SHARE_LIMIT,
        RESERVE_RATIO_BP,
        RESERVE_RATIO_THRESHOLD_BP,
        TREASURY_FEE_BP,
      );
  }

  async function createVaultAndConnect(factory: VaultFactory__MockForVaultHub) {
    const vault = await createVault(factory);
    await connectVault(vault);
    return vault;
  }

  async function makeVaultBalanced(vault: StakingVault__MockForVaultHub) {
    await vault.fund({ value: ether("1") });
    await vaultHub.mintShares(await vault.getAddress(), user, ether("0.9"));
    await vault.report(ether("0.9"), ether("1"), ether("1.1")); // slashing
  }

  before(async () => {
    [deployer, user, stranger] = await ethers.getSigners();

    locator = await deployLidoLocator();
    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [user], { value: ether("1000.0") });
    depositContract = await ethers.deployContract("DepositContract__MockForVaultHub");

    const vaultHubImpl = await ethers.deployContract("Accounting", [
      locator,
      steth,
      VAULTS_CONNECTED_VAULTS_LIMIT,
      VAULTS_RELATIVE_SHARE_LIMIT_BP,
    ]);

    const proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, deployer, new Uint8Array()]);

    const accounting = await ethers.getContractAt("Accounting", proxy);
    await accounting.initialize(deployer);

    vaultHub = await ethers.getContractAt("Accounting", proxy, user);
    await accounting.grantRole(await vaultHub.PAUSE_ROLE(), user);
    await accounting.grantRole(await vaultHub.RESUME_ROLE(), user);
    await accounting.grantRole(await vaultHub.VAULT_MASTER_ROLE(), user);
    await accounting.grantRole(await vaultHub.VAULT_REGISTRY_ROLE(), user);

    const stakingVaultImpl = await ethers.deployContract("StakingVault__MockForVaultHub", [
      await vaultHub.getAddress(),
      await depositContract.getAddress(),
    ]);

    vaultFactory = await ethers.deployContract("VaultFactory__MockForVaultHub", [await stakingVaultImpl.getAddress()]);
    const vault = await createVault(vaultFactory);

    codehash = keccak256(await ethers.provider.getCode(await vault.getAddress()));
    await vaultHub.connect(user).addVaultProxyCodehash(codehash);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Constants", () => {
    it("returns the STETH address", async () => {
      expect(await vaultHub.STETH()).to.equal(await steth.getAddress());
    });
  });

  context("initialState", () => {
    it("returns the initial state", async () => {
      expect(await vaultHub.vaultsCount()).to.equal(0);
    });
  });

  context("addVaultProxyCodehash", () => {
    it("reverts if called by non-VAULT_REGISTRY_ROLE", async () => {
      await expect(vaultHub.connect(stranger).addVaultProxyCodehash(ZERO_BYTES32))
        .to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await vaultHub.VAULT_REGISTRY_ROLE());
    });

    it("reverts if codehash is zero", async () => {
      await expect(vaultHub.connect(user).addVaultProxyCodehash(ZERO_BYTES32)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroArgument",
      );
    });

    it("reverts if codehash is already added", async () => {
      await expect(vaultHub.connect(user).addVaultProxyCodehash(codehash))
        .to.be.revertedWithCustomError(vaultHub, "AlreadyExists")
        .withArgs(codehash);
    });

    it("adds the codehash", async () => {
      const newCodehash = codehash.slice(0, -10) + "0000000000";
      await expect(vaultHub.addVaultProxyCodehash(newCodehash))
        .to.emit(vaultHub, "VaultProxyCodehashAdded")
        .withArgs(newCodehash);
    });
  });

  context("vaultsCount", () => {
    it("returns the number of connected vaults", async () => {
      expect(await vaultHub.vaultsCount()).to.equal(0);

      await createVaultAndConnect(vaultFactory);

      expect(await vaultHub.vaultsCount()).to.equal(1);
    });
  });

  context("vault", () => {
    it("reverts if index is out of bounds", async () => {
      await expect(vaultHub.vault(100n)).to.be.reverted;
    });

    it("returns the vault", async () => {
      const vault = await createVaultAndConnect(vaultFactory);
      const lastVaultId = (await vaultHub.vaultsCount()) - 1n;
      const lastVaultAddress = await vaultHub.vault(lastVaultId);

      expect(lastVaultAddress).to.equal(await vault.getAddress());
    });
  });

  context("vaultSocket(uint256)", () => {
    it("reverts if index is out of bounds", async () => {
      await expect(vaultHub["vaultSocket(uint256)"](100n)).to.be.reverted;
    });

    it("returns the vault socket by index", async () => {
      const vault = await createVaultAndConnect(vaultFactory);
      const lastVaultId = (await vaultHub.vaultsCount()) - 1n;
      expect(lastVaultId).to.equal(0n);

      const lastVaultSocket = await vaultHub["vaultSocket(uint256)"](lastVaultId);

      expect(lastVaultSocket.vault).to.equal(await vault.getAddress());
      expect(lastVaultSocket.sharesMinted).to.equal(0n);
      expect(lastVaultSocket.shareLimit).to.equal(SHARE_LIMIT);
      expect(lastVaultSocket.reserveRatioBP).to.equal(RESERVE_RATIO_BP);
      expect(lastVaultSocket.reserveRatioThresholdBP).to.equal(RESERVE_RATIO_THRESHOLD_BP);
      expect(lastVaultSocket.treasuryFeeBP).to.equal(TREASURY_FEE_BP);
      expect(lastVaultSocket.isDisconnected).to.equal(false);
    });
  });

  context("vaultSocket(address)", () => {
    it("returns empty vault socket data if vault was never connected", async () => {
      const address = await randomAddress();
      const vaultSocket = await vaultHub["vaultSocket(address)"](address);

      expect(vaultSocket.vault).to.equal(ZeroAddress);
      expect(vaultSocket.sharesMinted).to.equal(0n);
      expect(vaultSocket.shareLimit).to.equal(0n);
      expect(vaultSocket.reserveRatioBP).to.equal(0n);
      expect(vaultSocket.reserveRatioThresholdBP).to.equal(0n);
      expect(vaultSocket.treasuryFeeBP).to.equal(0n);
      expect(vaultSocket.isDisconnected).to.equal(true);
    });

    it("returns the vault socket for a vault that was connected", async () => {
      const vault = await createVaultAndConnect(vaultFactory);
      const vaultAddress = await vault.getAddress();
      const vaultSocket = await vaultHub["vaultSocket(address)"](vaultAddress);

      expect(vaultSocket.vault).to.equal(vaultAddress);
      expect(vaultSocket.sharesMinted).to.equal(0n);
      expect(vaultSocket.shareLimit).to.equal(SHARE_LIMIT);
      expect(vaultSocket.reserveRatioBP).to.equal(RESERVE_RATIO_BP);
      expect(vaultSocket.reserveRatioThresholdBP).to.equal(RESERVE_RATIO_THRESHOLD_BP);
      expect(vaultSocket.treasuryFeeBP).to.equal(TREASURY_FEE_BP);
      expect(vaultSocket.isDisconnected).to.equal(false);
    });
  });

  context("isVaultBalanced", () => {
    let vault: StakingVault__MockForVaultHub;
    let vaultAddress: string;

    before(async () => {
      vault = await createVaultAndConnect(vaultFactory);
      vaultAddress = await vault.getAddress();
    });

    it("returns true if the vault is healthy", async () => {
      expect(await vaultHub.isVaultBalanced(vaultAddress)).to.be.true;
    });

    it("returns false if the vault is unhealthy", async () => {
      await makeVaultBalanced(vault);
      expect(await vaultHub.isVaultBalanced(vaultAddress)).to.be.false;
    });
  });

  context("connectVault", () => {
    let vault: StakingVault__MockForVaultHub;
    let vaultAddress: string;

    before(async () => {
      vault = await createVault(vaultFactory);
      vaultAddress = await vault.getAddress();
    });

    it("reverts if called by non-VAULT_MASTER_ROLE", async () => {
      await expect(
        vaultHub
          .connect(stranger)
          .connectVault(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP),
      ).to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount");
    });

    it("reverts if vault address is zero", async () => {
      await expect(
        vaultHub
          .connect(user)
          .connectVault(ZeroAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP),
      ).to.be.revertedWithCustomError(vaultHub, "ZeroArgument");
    });

    it("reverts if reserve ratio BP is zero", async () => {
      await expect(
        vaultHub.connect(user).connectVault(vaultAddress, 0n, 0n, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP),
      ).to.be.revertedWithCustomError(vaultHub, "ZeroArgument");
    });

    it("reverts if reserve ration is too high", async () => {
      const tooHighReserveRatioBP = TOTAL_BASIS_POINTS + 1n;
      await expect(
        vaultHub
          .connect(user)
          .connectVault(vaultAddress, SHARE_LIMIT, tooHighReserveRatioBP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP),
      )
        .to.be.revertedWithCustomError(vaultHub, "ReserveRatioTooHigh")
        .withArgs(vaultAddress, tooHighReserveRatioBP, TOTAL_BASIS_POINTS);
    });

    it("reverts if reserve ratio threshold BP is zero", async () => {
      await expect(
        vaultHub.connect(user).connectVault(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, 0n, TREASURY_FEE_BP),
      ).to.be.revertedWithCustomError(vaultHub, "ZeroArgument");
    });

    it("reverts if reserve ratio threshold BP is higher than reserve ratio BP", async () => {
      await expect(
        vaultHub
          .connect(user)
          .connectVault(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_BP + 1n, TREASURY_FEE_BP),
      )
        .to.be.revertedWithCustomError(vaultHub, "ReserveRatioThresholdTooHigh")
        .withArgs(vaultAddress, RESERVE_RATIO_BP + 1n, RESERVE_RATIO_BP);
    });

    it("reverts if treasury fee is too high", async () => {
      const tooHighTreasuryFeeBP = TOTAL_BASIS_POINTS + 1n;
      await expect(
        vaultHub
          .connect(user)
          .connectVault(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, tooHighTreasuryFeeBP),
      ).to.be.revertedWithCustomError(vaultHub, "TreasuryFeeTooHigh");
    });

    it("reverts if max vault size is exceeded", async () => {
      const vaultsCount = await vaultHub.vaultsCount();
      for (let i = vaultsCount; i < VAULTS_CONNECTED_VAULTS_LIMIT; i++) {
        await createVaultAndConnect(vaultFactory);
      }

      await expect(
        vaultHub
          .connect(user)
          .connectVault(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP),
      ).to.be.revertedWithCustomError(vaultHub, "TooManyVaults");
    });

    it("reverts if vault is already connected", async () => {
      const connectedVault = await createVaultAndConnect(vaultFactory);
      const connectedVaultAddress = await connectedVault.getAddress();

      await expect(
        vaultHub
          .connect(user)
          .connectVault(
            connectedVaultAddress,
            SHARE_LIMIT,
            RESERVE_RATIO_BP,
            RESERVE_RATIO_THRESHOLD_BP,
            TREASURY_FEE_BP,
          ),
      ).to.be.revertedWithCustomError(vaultHub, "AlreadyConnected");
    });

    it("reverts if proxy codehash is not added", async () => {
      const stakingVault2Impl = await ethers.deployContract("StakingVault__MockForVaultHub", [
        await vaultHub.getAddress(),
        await depositContract.getAddress(),
      ]);
      const vault2Factory = await ethers.deployContract("VaultFactory__MockForVaultHub", [
        await stakingVault2Impl.getAddress(),
      ]);
      const vault2 = await createVault(vault2Factory);

      await expect(
        vaultHub
          .connect(user)
          .connectVault(
            await vault2.getAddress(),
            SHARE_LIMIT,
            RESERVE_RATIO_BP,
            RESERVE_RATIO_THRESHOLD_BP,
            TREASURY_FEE_BP,
          ),
      ).to.be.revertedWithCustomError(vaultHub, "VaultProxyNotAllowed");
    });

    it("connects the vault", async () => {
      const vaultCountBefore = await vaultHub.vaultsCount();

      const vaultSocketBefore = await vaultHub["vaultSocket(address)"](vaultAddress);
      expect(vaultSocketBefore.vault).to.equal(ZeroAddress);
      expect(vaultSocketBefore.isDisconnected).to.be.true;

      await expect(
        vaultHub
          .connect(user)
          .connectVault(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP),
      )
        .to.emit(vaultHub, "VaultConnected")
        .withArgs(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP);

      expect(await vaultHub.vaultsCount()).to.equal(vaultCountBefore + 1n);

      const vaultSocketAfter = await vaultHub["vaultSocket(address)"](vaultAddress);
      expect(vaultSocketAfter.vault).to.equal(vaultAddress);
      expect(vaultSocketAfter.isDisconnected).to.be.false;

      expect(await vault.locked()).to.equal(CONNECT_DEPOSIT);
    });

    it("allows to connect the vault with 0 share limit", async () => {
      await expect(
        vaultHub
          .connect(user)
          .connectVault(vaultAddress, 0n, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP),
      )
        .to.emit(vaultHub, "VaultConnected")
        .withArgs(vaultAddress, 0n, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP);
    });

    it("allows to connect the vault with 0 treasury fee", async () => {
      await expect(
        vaultHub
          .connect(user)
          .connectVault(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, 0n),
      )
        .to.emit(vaultHub, "VaultConnected")
        .withArgs(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, 0n);
    });
  });

  context("updateShareLimit", () => {
    let vault: StakingVault__MockForVaultHub;
    let vaultAddress: string;

    before(async () => {
      vault = await createVaultAndConnect(vaultFactory);
      vaultAddress = await vault.getAddress();
    });

    it("reverts if called by non-VAULT_MASTER_ROLE", async () => {
      await expect(
        vaultHub.connect(stranger).updateShareLimit(vaultAddress, SHARE_LIMIT),
      ).to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount");
    });

    it("reverts if vault address is zero", async () => {
      await expect(vaultHub.connect(user).updateShareLimit(ZeroAddress, SHARE_LIMIT)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroArgument",
      );
    });

    it("reverts if share limit exceeds the maximum vault limit", async () => {
      const insaneLimit = ether("1000000000000000000000000");
      const totalShares = await steth.getTotalShares();
      const relativeShareLimitBP = VAULTS_RELATIVE_SHARE_LIMIT_BP;
      const relativeShareLimitPerVault = (totalShares * relativeShareLimitBP) / TOTAL_BASIS_POINTS;

      await expect(vaultHub.connect(user).updateShareLimit(vaultAddress, insaneLimit))
        .to.be.revertedWithCustomError(vaultHub, "ShareLimitTooHigh")
        .withArgs(vaultAddress, insaneLimit, relativeShareLimitPerVault);
    });

    it("updates the share limit", async () => {
      const newShareLimit = SHARE_LIMIT * 2n;

      await expect(vaultHub.connect(user).updateShareLimit(vaultAddress, newShareLimit))
        .to.emit(vaultHub, "ShareLimitUpdated")
        .withArgs(vaultAddress, newShareLimit);

      const vaultSocket = await vaultHub["vaultSocket(address)"](vaultAddress);
      expect(vaultSocket.shareLimit).to.equal(newShareLimit);
    });
  });

  context("disconnect", () => {
    let vault: StakingVault__MockForVaultHub;
    let vaultAddress: string;

    before(async () => {
      vault = await createVaultAndConnect(vaultFactory);
      vaultAddress = await vault.getAddress();
    });

    it("reverts if called by non-VAULT_MASTER_ROLE", async () => {
      await expect(vaultHub.connect(stranger).disconnect(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if vault address is zero", async () => {
      await expect(vaultHub.connect(user).disconnect(ZeroAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroArgument",
      );
    });

    it("reverts if vault is not connected", async () => {
      await expect(vaultHub.connect(user).disconnect(randomAddress())).to.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
    });

    it("reverts if vault has shares minted", async () => {
      await vault.fund({ value: ether("1") });
      await vaultHub.connect(user).mintShares(vaultAddress, user.address, 1n);

      await expect(vaultHub.connect(user).disconnect(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "NoMintedSharesShouldBeLeft",
      );
    });

    it("disconnects the vault", async () => {
      await expect(vaultHub.connect(user).disconnect(vaultAddress))
        .to.emit(vaultHub, "VaultDisconnected")
        .withArgs(vaultAddress);

      const vaultSocket = await vaultHub["vaultSocket(address)"](vaultAddress);
      expect(vaultSocket.isDisconnected).to.be.true;
    });
  });

  context("voluntaryDisconnect", () => {
    let vault: StakingVault__MockForVaultHub;
    let vaultAddress: string;

    before(async () => {
      vault = await createVaultAndConnect(vaultFactory);
      vaultAddress = await vault.getAddress();
    });

    it("reverts if minting paused", async () => {
      await vaultHub.connect(user).pauseFor(1000n);

      await expect(vaultHub.connect(user).voluntaryDisconnect(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "ResumedExpected",
      );
    });

    it("reverts if vault is zero address", async () => {
      await expect(vaultHub.connect(user).voluntaryDisconnect(ZeroAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroArgument",
      );
    });

    it("reverts if called as non-vault owner", async () => {
      await expect(vaultHub.connect(stranger).voluntaryDisconnect(vaultAddress))
        .to.be.revertedWithCustomError(vaultHub, "NotAuthorized")
        .withArgs("disconnect", stranger);
    });

    it("reverts if vault is not connected", async () => {
      await vaultHub.connect(user).disconnect(vaultAddress);

      await expect(vaultHub.connect(user).voluntaryDisconnect(vaultAddress))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(vaultAddress);
    });

    it("reverts if vault has shares minted", async () => {
      await vault.fund({ value: ether("1") });
      await vaultHub.connect(user).mintShares(vaultAddress, user.address, 1n);

      await expect(vaultHub.connect(user).disconnect(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "NoMintedSharesShouldBeLeft",
      );
    });

    it("disconnects the vault", async () => {
      await expect(vaultHub.connect(user).disconnect(vaultAddress))
        .to.emit(vaultHub, "VaultDisconnected")
        .withArgs(vaultAddress);

      const vaultSocket = await vaultHub["vaultSocket(address)"](vaultAddress);
      expect(vaultSocket.isDisconnected).to.be.true;
    });
  });
});
