import { expect } from "chai";
import { randomBytes } from "crypto";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Dashboard,
  DepositContract__MockForStakingVault,
  StakingVault,
  StETH__MockForDashboard,
  VaultFactory__MockForDashboard,
  VaultHub__MockForDashboard,
  WETH9__MockForVault,
  WstETH__HarnessForVault,
} from "typechain-types";

import { certainAddress, ether, findEvents } from "lib";

import { Snapshot } from "test/suite";

describe("Dashboard", () => {
  let factoryOwner: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let steth: StETH__MockForDashboard;
  let weth: WETH9__MockForVault;
  let wsteth: WstETH__HarnessForVault;
  let hub: VaultHub__MockForDashboard;
  let depositContract: DepositContract__MockForStakingVault;
  let vaultImpl: StakingVault;
  let dashboardImpl: Dashboard;
  let factory: VaultFactory__MockForDashboard;

  let vault: StakingVault;
  let dashboard: Dashboard;

  let originalState: string;

  const BP_BASE = 10_000n;

  before(async () => {
    [factoryOwner, vaultOwner, operator, stranger] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__MockForDashboard", ["Staked ETH", "stETH"]);
    await steth.mock__setTotalShares(ether("1000000"));
    await steth.mock__setTotalPooledEther(ether("2000000"));

    weth = await ethers.deployContract("WETH9__MockForVault");
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);
    hub = await ethers.deployContract("VaultHub__MockForDashboard", [steth]);
    depositContract = await ethers.deployContract("DepositContract__MockForStakingVault");
    vaultImpl = await ethers.deployContract("StakingVault", [hub, depositContract]);
    expect(await vaultImpl.VAULT_HUB()).to.equal(hub);
    dashboardImpl = await ethers.deployContract("Dashboard", [steth, weth, wsteth]);
    expect(await dashboardImpl.stETH()).to.equal(steth);
    expect(await dashboardImpl.weth()).to.equal(weth);
    expect(await dashboardImpl.wstETH()).to.equal(wsteth);

    factory = await ethers.deployContract("VaultFactory__MockForDashboard", [factoryOwner, vaultImpl, dashboardImpl]);
    expect(await factory.owner()).to.equal(factoryOwner);
    expect(await factory.implementation()).to.equal(vaultImpl);
    expect(await factory.dashboardImpl()).to.equal(dashboardImpl);

    const createVaultTx = await factory.connect(vaultOwner).createVault(operator);
    const createVaultReceipt = await createVaultTx.wait();
    if (!createVaultReceipt) throw new Error("Vault creation receipt not found");

    const vaultCreatedEvents = findEvents(createVaultReceipt, "VaultCreated");
    expect(vaultCreatedEvents.length).to.equal(1);
    const vaultAddress = vaultCreatedEvents[0].args.vault;
    vault = await ethers.getContractAt("StakingVault", vaultAddress, vaultOwner);

    const dashboardCreatedEvents = findEvents(createVaultReceipt, "DashboardCreated");
    expect(dashboardCreatedEvents.length).to.equal(1);
    const dashboardAddress = dashboardCreatedEvents[0].args.dashboard;
    dashboard = await ethers.getContractAt("Dashboard", dashboardAddress, vaultOwner);
    expect(await dashboard.stakingVault()).to.equal(vault);
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  context("constructor", () => {
    it("reverts if stETH is zero address", async () => {
      await expect(ethers.deployContract("Dashboard", [ethers.ZeroAddress, weth, wsteth]))
        .to.be.revertedWithCustomError(dashboard, "ZeroArgument")
        .withArgs("_stETH");
    });

    it("reverts if WETH is zero address", async () => {
      await expect(ethers.deployContract("Dashboard", [steth, ethers.ZeroAddress, wsteth]))
        .to.be.revertedWithCustomError(dashboard, "ZeroArgument")
        .withArgs("_WETH");
    });

    it("reverts if wstETH is zero address", async () => {
      await expect(ethers.deployContract("Dashboard", [steth, weth, ethers.ZeroAddress]))
        .to.be.revertedWithCustomError(dashboard, "ZeroArgument")
        .withArgs("_wstETH");
    });

    it("sets the stETH, wETH, and wstETH addresses", async () => {
      const dashboard_ = await ethers.deployContract("Dashboard", [steth, weth, wsteth]);
      expect(await dashboard_.stETH()).to.equal(steth);
      expect(await dashboard_.weth()).to.equal(weth);
      expect(await dashboard_.wstETH()).to.equal(wsteth);
    });
  });

  context("initialize", () => {
    it("reverts if staking vault is zero address", async () => {
      await expect(dashboard.initialize(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(dashboard, "ZeroArgument")
        .withArgs("_stakingVault");
    });

    it("reverts if already initialized", async () => {
      await expect(dashboard.initialize(vault)).to.be.revertedWithCustomError(dashboard, "AlreadyInitialized");
    });

    it("reverts if called on the implementation", async () => {
      const dashboard_ = await ethers.deployContract("Dashboard", [steth, weth, wsteth]);

      await expect(dashboard_.initialize(vault)).to.be.revertedWithCustomError(dashboard_, "NonProxyCallsForbidden");
    });
  });

  context("initialized state", () => {
    it("post-initialization state is correct", async () => {
      expect(await vault.owner()).to.equal(dashboard);
      expect(await vault.operator()).to.equal(operator);
      expect(await dashboard.isInitialized()).to.equal(true);
      expect(await dashboard.stakingVault()).to.equal(vault);
      expect(await dashboard.vaultHub()).to.equal(hub);
      expect(await dashboard.stETH()).to.equal(steth);
      expect(await dashboard.weth()).to.equal(weth);
      expect(await dashboard.wstETH()).to.equal(wsteth);
      expect(await dashboard.hasRole(await dashboard.DEFAULT_ADMIN_ROLE(), vaultOwner)).to.be.true;
      expect(await dashboard.getRoleMemberCount(await dashboard.DEFAULT_ADMIN_ROLE())).to.equal(1);
      expect(await dashboard.getRoleMember(await dashboard.DEFAULT_ADMIN_ROLE(), 0)).to.equal(vaultOwner);
    });
  });

  context("socket view", () => {
    it("returns the correct vault socket data", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 1000,
        sharesMinted: 555,
        reserveRatio: 1000,
        reserveRatioThreshold: 800,
        treasuryFeeBP: 500,
      };

      await hub.mock__setVaultSocket(vault, sockets);

      expect(await dashboard.vaultSocket()).to.deep.equal(Object.values(sockets));
      expect(await dashboard.shareLimit()).to.equal(sockets.shareLimit);
      expect(await dashboard.sharesMinted()).to.equal(sockets.sharesMinted);
      expect(await dashboard.reserveRatio()).to.equal(sockets.reserveRatio);
      expect(await dashboard.thresholdReserveRatio()).to.equal(sockets.reserveRatioThreshold);
      expect(await dashboard.treasuryFee()).to.equal(sockets.treasuryFeeBP);
    });
  });

  context("maxMintableShares", () => {
    it("returns the trivial max mintable shares", async () => {
      const maxShares = await dashboard.maxMintableShares();

      expect(maxShares).to.equal(0n);
    });

    it("returns correct max mintable shares when not bound by shareLimit", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 1000000000n,
        sharesMinted: 555n,
        reserveRatio: 1000n,
        reserveRatioThreshold: 800n,
        treasuryFeeBP: 500n,
      };
      await hub.mock__setVaultSocket(vault, sockets);

      await dashboard.fund({ value: 1000n });

      const maxMintableShares = await dashboard.maxMintableShares();
      const maxStETHMinted = ((await vault.valuation()) * (BP_BASE - sockets.reserveRatio)) / BP_BASE;
      const maxSharesMinted = await steth.getSharesByPooledEth(maxStETHMinted);

      expect(maxMintableShares).to.equal(maxSharesMinted);
    });

    it("returns correct max mintable shares when bound by shareLimit", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 100n,
        sharesMinted: 0n,
        reserveRatio: 1000n,
        reserveRatioThreshold: 800n,
        treasuryFeeBP: 500n,
      };
      await hub.mock__setVaultSocket(vault, sockets);

      await dashboard.fund({ value: 1000n });

      const availableMintableShares = await dashboard.maxMintableShares();

      expect(availableMintableShares).to.equal(sockets.shareLimit);
    });

    it("returns zero when reserve ratio is does not allow mint", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 1000000000n,
        sharesMinted: 555n,
        reserveRatio: 10_000n,
        reserveRatioThreshold: 800n,
        treasuryFeeBP: 500n,
      };
      await hub.mock__setVaultSocket(vault, sockets);

      await dashboard.fund({ value: 1000n });

      const availableMintableShares = await dashboard.maxMintableShares();

      expect(availableMintableShares).to.equal(0n);
    });

    it("returns funded amount when reserve ratio is zero", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 10000000n,
        sharesMinted: 555n,
        reserveRatio: 0n,
        reserveRatioThreshold: 0n,
        treasuryFeeBP: 500n,
      };
      await hub.mock__setVaultSocket(vault, sockets);
      const funding = 1000n;
      await dashboard.fund({ value: funding });

      const availableMintableShares = await dashboard.maxMintableShares();

      const toShares = await steth.getSharesByPooledEth(funding);
      expect(availableMintableShares).to.equal(toShares);
    });
  });

  context("canMintShares", () => {
    it("returns trivial can mint shares", async () => {
      const canMint = await dashboard.canMintShares();
      expect(canMint).to.equal(0n);
    });

    it("can mint all available shares", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 10000000n,
        sharesMinted: 0n,
        reserveRatio: 1000n,
        reserveRatioThreshold: 800n,
        treasuryFeeBP: 500n,
      };
      await hub.mock__setVaultSocket(vault, sockets);
      const funding = 1000n;
      await dashboard.fund({ value: funding });

      const availableMintableShares = await dashboard.maxMintableShares();

      const canMint = await dashboard.canMintShares();
      expect(canMint).to.equal(availableMintableShares);
    });

    it("cannot mint shares", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 10000000n,
        sharesMinted: 500n,
        reserveRatio: 1000n,
        reserveRatioThreshold: 800n,
        treasuryFeeBP: 500n,
      };
      await hub.mock__setVaultSocket(vault, sockets);
      const funding = 1000n;
      await dashboard.fund({ value: funding });

      const canMint = await dashboard.canMintShares();
      expect(canMint).to.equal(0n);
    });

    it("cannot mint shares when overmint", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 10000000n,
        sharesMinted: 10000n,
        reserveRatio: 1000n,
        reserveRatioThreshold: 800n,
        treasuryFeeBP: 500n,
      };
      await hub.mock__setVaultSocket(vault, sockets);
      const funding = 1000n;
      await dashboard.fund({ value: funding });

      const canMint = await dashboard.canMintShares();
      expect(canMint).to.equal(0n);
    });

    it("can mint to full ratio", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 10000000n,
        sharesMinted: 500n,
        reserveRatio: 1000n,
        reserveRatioThreshold: 800n,
        treasuryFeeBP: 500n,
      };
      await hub.mock__setVaultSocket(vault, sockets);
      const funding = 2000n;
      await dashboard.fund({ value: funding });

      const sharesFunded = await steth.getSharesByPooledEth((funding * (BP_BASE - sockets.reserveRatio)) / BP_BASE);

      const canMint = await dashboard.canMintShares();
      expect(canMint).to.equal(sharesFunded - sockets.sharesMinted);
    });
  });

  context("canMintByEther", () => {
    it("returns the correct can mint shares by ether", async () => {
      const canMint = await dashboard.canMintByEther(ether("1"));
      expect(canMint).to.equal(0n);
    });

    // TODO: add more tests when the vault params are changed
  });

  context("canWithdraw", () => {
    it("returns the correct can withdraw ether", async () => {
      const canWithdraw = await dashboard.canWithdraw();
      expect(canWithdraw).to.equal(0n);
    });

    it("funds and returns the correct can withdraw ether", async () => {
      const amount = ether("1");

      await dashboard.fund({ value: amount });

      const canWithdraw = await dashboard.canWithdraw();
      expect(canWithdraw).to.equal(amount);
    });

    it("funds and returns the correct can withdraw ether minus locked amount", async () => {
      const amount = ether("1");

      await dashboard.fund({ value: amount });

      // TODO: add tests
    });

    // TODO: add more tests when the vault params are changed
  });

  context("transferStVaultOwnership", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).transferStVaultOwnership(vaultOwner))
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.DEFAULT_ADMIN_ROLE());
    });

    it("assigns a new owner to the staking vault", async () => {
      const newOwner = certainAddress("dashboard:test:new-owner");
      await expect(dashboard.transferStVaultOwnership(newOwner))
        .to.emit(vault, "OwnershipTransferred")
        .withArgs(dashboard, newOwner);
      expect(await vault.owner()).to.equal(newOwner);
    });
  });

  context("disconnectFromVaultHub", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).disconnectFromVaultHub())
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.DEFAULT_ADMIN_ROLE());
    });

    it("disconnects the staking vault from the vault hub", async () => {
      await expect(dashboard.disconnectFromVaultHub()).to.emit(hub, "Mock__VaultDisconnected").withArgs(vault);
    });
  });

  context("fund", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).fund()).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("funds the staking vault", async () => {
      const previousBalance = await ethers.provider.getBalance(vault);
      const amount = ether("1");
      await expect(dashboard.fund({ value: amount }))
        .to.emit(vault, "Funded")
        .withArgs(dashboard, amount);
      expect(await ethers.provider.getBalance(vault)).to.equal(previousBalance + amount);
    });
  });

  context("fundByWeth", () => {
    const amount = ether("1");

    before(async () => {
      await setBalance(vaultOwner.address, ether("10"));
    });

    beforeEach(async () => {
      await weth.connect(vaultOwner).deposit({ value: amount });
    });

    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).fundByWeth(ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("funds by weth", async () => {
      await weth.connect(vaultOwner).approve(dashboard, amount);

      await expect(dashboard.fundByWeth(amount, { from: vaultOwner }))
        .to.emit(vault, "Funded")
        .withArgs(dashboard, amount);
      expect(await ethers.provider.getBalance(vault)).to.equal(amount);
    });

    it("reverts without approval", async () => {
      await expect(dashboard.fundByWeth(amount, { from: vaultOwner })).to.be.revertedWith(
        "ERC20: transfer amount exceeds allowance",
      );
    });
  });

  context("withdraw", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).withdraw(vaultOwner, ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("withdraws ether from the staking vault", async () => {
      const amount = ether("1");
      await dashboard.fund({ value: amount });
      const recipient = certainAddress("dashboard:test:recipient");
      const previousBalance = await ethers.provider.getBalance(recipient);

      await expect(dashboard.withdraw(recipient, amount))
        .to.emit(vault, "Withdrawn")
        .withArgs(dashboard, recipient, amount);
      expect(await ethers.provider.getBalance(recipient)).to.equal(previousBalance + amount);
    });
  });

  context("withdrawToWeth", () => {
    const amount = ether("1");

    before(async () => {
      await setBalance(vaultOwner.address, ether("10"));
    });

    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).withdrawToWeth(vaultOwner, ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("withdraws ether from the staking vault to weth", async () => {
      await dashboard.fund({ value: amount });
      const previousBalance = await ethers.provider.getBalance(stranger);

      await expect(dashboard.withdrawToWeth(stranger, amount))
        .to.emit(vault, "Withdrawn")
        .withArgs(dashboard, dashboard, amount);

      expect(await ethers.provider.getBalance(stranger)).to.equal(previousBalance);
      expect(await weth.balanceOf(stranger)).to.equal(amount);
    });
  });

  context("requestValidatorExit", () => {
    it("reverts if called by a non-admin", async () => {
      const validatorPublicKey = "0x" + randomBytes(48).toString("hex");
      await expect(dashboard.connect(stranger).requestValidatorExit(validatorPublicKey)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("requests the exit of a validator", async () => {
      const validatorPublicKey = "0x" + randomBytes(48).toString("hex");
      await expect(dashboard.requestValidatorExit(validatorPublicKey))
        .to.emit(vault, "ValidatorsExitRequest")
        .withArgs(dashboard, validatorPublicKey);
    });
  });

  context("mint", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).mint(vaultOwner, ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("mints stETH backed by the vault through the vault hub", async () => {
      const amount = ether("1");
      await expect(dashboard.mint(vaultOwner, amount))
        .to.emit(steth, "Transfer")
        .withArgs(ZeroAddress, vaultOwner, amount);

      expect(await steth.balanceOf(vaultOwner)).to.equal(amount);
    });

    it("funds and mints stETH backed by the vault", async () => {
      const amount = ether("1");
      await expect(dashboard.mint(vaultOwner, amount, { value: amount }))
        .to.emit(vault, "Funded")
        .withArgs(dashboard, amount)
        .to.emit(steth, "Transfer")
        .withArgs(ZeroAddress, vaultOwner, amount);
    });
  });

  context("burn", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).burn(ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("burns stETH backed by the vault", async () => {
      const amount = ether("1");
      await dashboard.mint(vaultOwner, amount);
      expect(await steth.balanceOf(vaultOwner)).to.equal(amount);

      await expect(steth.connect(vaultOwner).approve(dashboard, amount))
        .to.emit(steth, "Approval")
        .withArgs(vaultOwner, dashboard, amount);
      expect(await steth.allowance(vaultOwner, dashboard)).to.equal(amount);

      await expect(dashboard.burn(amount))
        .to.emit(steth, "Transfer") // tranfer from owner to hub
        .withArgs(vaultOwner, hub, amount)
        .and.to.emit(steth, "Transfer") // burn
        .withArgs(hub, ZeroAddress, amount);
      expect(await steth.balanceOf(vaultOwner)).to.equal(0);
    });
  });

  context("rebalanceVault", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).rebalanceVault(ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("rebalances the vault by transferring ether", async () => {
      const amount = ether("1");
      await dashboard.fund({ value: amount });

      await expect(dashboard.rebalanceVault(amount)).to.emit(hub, "Mock__Rebalanced").withArgs(amount);
    });

    it("funds and rebalances the vault", async () => {
      const amount = ether("1");
      await expect(dashboard.rebalanceVault(amount, { value: amount }))
        .to.emit(vault, "Funded")
        .withArgs(dashboard, amount)
        .to.emit(hub, "Mock__Rebalanced")
        .withArgs(amount);
    });
  });
});
