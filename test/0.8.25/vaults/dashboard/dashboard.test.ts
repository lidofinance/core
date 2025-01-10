import { expect } from "chai";
import { randomBytes } from "crypto";
import { MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Dashboard,
  DepositContract__MockForStakingVault,
  LidoLocator,
  StakingVault,
  StETHPermit__HarnessForDashboard,
  VaultFactory__MockForDashboard,
  VaultHub__MockForDashboard,
  WETH9__MockForVault,
  WstETH__HarnessForVault,
} from "typechain-types";

import { certainAddress, days, ether, findEvents, signPermit, stethDomain, wstethDomain } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("Dashboard", () => {
  let factoryOwner: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let steth: StETHPermit__HarnessForDashboard;
  let weth: WETH9__MockForVault;
  let wsteth: WstETH__HarnessForVault;
  let hub: VaultHub__MockForDashboard;
  let depositContract: DepositContract__MockForStakingVault;
  let vaultImpl: StakingVault;
  let dashboardImpl: Dashboard;
  let factory: VaultFactory__MockForDashboard;
  let lidoLocator: LidoLocator;

  let vault: StakingVault;
  let dashboard: Dashboard;

  let originalState: string;

  const BP_BASE = 10_000n;

  before(async () => {
    [factoryOwner, vaultOwner, operator, stranger] = await ethers.getSigners();

    steth = await ethers.deployContract("StETHPermit__HarnessForDashboard");
    await steth.mock__setTotalShares(ether("1000000"));
    await steth.mock__setTotalPooledEther(ether("1000000"));

    weth = await ethers.deployContract("WETH9__MockForVault");
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);
    hub = await ethers.deployContract("VaultHub__MockForDashboard", [steth]);
    lidoLocator = await deployLidoLocator({ lido: steth, wstETH: wsteth });
    depositContract = await ethers.deployContract("DepositContract__MockForStakingVault");
    vaultImpl = await ethers.deployContract("StakingVault", [hub, depositContract]);
    expect(await vaultImpl.vaultHub()).to.equal(hub);
    dashboardImpl = await ethers.deployContract("Dashboard", [weth, lidoLocator]);
    expect(await dashboardImpl.STETH()).to.equal(steth);
    expect(await dashboardImpl.WETH()).to.equal(weth);
    expect(await dashboardImpl.WSTETH()).to.equal(wsteth);

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
    it("reverts if LidoLocator is zero address", async () => {
      await expect(ethers.deployContract("Dashboard", [weth, ethers.ZeroAddress]))
        .to.be.revertedWithCustomError(dashboard, "ZeroArgument")
        .withArgs("_lidoLocator");
    });

    it("reverts if WETH is zero address", async () => {
      await expect(ethers.deployContract("Dashboard", [ethers.ZeroAddress, lidoLocator]))
        .to.be.revertedWithCustomError(dashboard, "ZeroArgument")
        .withArgs("_WETH");
    });

    it("sets the stETH, wETH, and wstETH addresses", async () => {
      const dashboard_ = await ethers.deployContract("Dashboard", [weth, lidoLocator]);
      expect(await dashboard_.STETH()).to.equal(steth);
      expect(await dashboard_.WETH()).to.equal(weth);
      expect(await dashboard_.WSTETH()).to.equal(wsteth);
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
      const dashboard_ = await ethers.deployContract("Dashboard", [weth, lidoLocator]);

      await expect(dashboard_.initialize(vault)).to.be.revertedWithCustomError(dashboard_, "NonProxyCallsForbidden");
    });
  });

  context("initialized state", () => {
    it("post-initialization state is correct", async () => {
      // vault state
      expect(await vault.owner()).to.equal(dashboard);
      expect(await vault.operator()).to.equal(operator);
      // dashboard state
      expect(await dashboard.isInitialized()).to.equal(true);
      // dashboard contracts
      expect(await dashboard.stakingVault()).to.equal(vault);
      expect(await dashboard.vaultHub()).to.equal(hub);
      expect(await dashboard.STETH()).to.equal(steth);
      expect(await dashboard.WETH()).to.equal(weth);
      expect(await dashboard.WSTETH()).to.equal(wsteth);
      // dashboard roles
      expect(await dashboard.hasRole(await dashboard.DEFAULT_ADMIN_ROLE(), vaultOwner)).to.be.true;
      expect(await dashboard.getRoleMemberCount(await dashboard.DEFAULT_ADMIN_ROLE())).to.equal(1);
      expect(await dashboard.getRoleMember(await dashboard.DEFAULT_ADMIN_ROLE(), 0)).to.equal(vaultOwner);
      // dashboard allowance
      expect(await steth.allowance(dashboard.getAddress(), wsteth.getAddress())).to.equal(MaxUint256);
    });
  });

  context("socket view", () => {
    it("returns the correct vault socket data", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        sharesMinted: 555n,
        shareLimit: 1000n,
        reserveRatioBP: 1000n,
        reserveRatioThresholdBP: 800n,
        treasuryFeeBP: 500n,
        isDisconnected: false,
      };

      await hub.mock__setVaultSocket(vault, sockets);

      expect(await dashboard.vaultSocket()).to.deep.equal(Object.values(sockets));
      expect(await dashboard.shareLimit()).to.equal(sockets.shareLimit);
      expect(await dashboard.sharesMinted()).to.equal(sockets.sharesMinted);
      expect(await dashboard.reserveRatio()).to.equal(sockets.reserveRatioBP);
      expect(await dashboard.thresholdReserveRatio()).to.equal(sockets.reserveRatioThresholdBP);
      expect(await dashboard.treasuryFee()).to.equal(sockets.treasuryFeeBP);
    });
  });

  context("totalMintableShares", () => {
    it("returns the trivial max mintable shares", async () => {
      const maxShares = await dashboard.totalMintableShares();

      expect(maxShares).to.equal(0n);
    });

    it("returns correct max mintable shares when not bound by shareLimit", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 1000000000n,
        sharesMinted: 555n,
        reserveRatioBP: 1000n,
        reserveRatioThresholdBP: 800n,
        treasuryFeeBP: 500n,
        isDisconnected: false,
      };
      await hub.mock__setVaultSocket(vault, sockets);

      await dashboard.fund({ value: 1000n });

      const maxMintableShares = await dashboard.totalMintableShares();
      const maxStETHMinted = ((await vault.valuation()) * (BP_BASE - sockets.reserveRatioBP)) / BP_BASE;
      const maxSharesMinted = await steth.getSharesByPooledEth(maxStETHMinted);

      expect(maxMintableShares).to.equal(maxSharesMinted);
    });

    it("returns correct max mintable shares when bound by shareLimit", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 100n,
        sharesMinted: 0n,
        reserveRatioBP: 1000n,
        reserveRatioThresholdBP: 800n,
        treasuryFeeBP: 500n,
        isDisconnected: false,
      };
      await hub.mock__setVaultSocket(vault, sockets);

      await dashboard.fund({ value: 1000n });

      const availableMintableShares = await dashboard.totalMintableShares();

      expect(availableMintableShares).to.equal(sockets.shareLimit);
    });

    it("returns zero when reserve ratio is does not allow mint", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 1000000000n,
        sharesMinted: 555n,
        reserveRatioBP: 10_000n,
        reserveRatioThresholdBP: 800n,
        treasuryFeeBP: 500n,
        isDisconnected: false,
      };
      await hub.mock__setVaultSocket(vault, sockets);

      await dashboard.fund({ value: 1000n });

      const availableMintableShares = await dashboard.totalMintableShares();

      expect(availableMintableShares).to.equal(0n);
    });

    it("returns funded amount when reserve ratio is zero", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 10000000n,
        sharesMinted: 555n,
        reserveRatioBP: 0n,
        reserveRatioThresholdBP: 0n,
        treasuryFeeBP: 500n,
        isDisconnected: false,
      };
      await hub.mock__setVaultSocket(vault, sockets);
      const funding = 1000n;
      await dashboard.fund({ value: funding });

      const availableMintableShares = await dashboard.totalMintableShares();

      const toShares = await steth.getSharesByPooledEth(funding);
      expect(availableMintableShares).to.equal(toShares);
    });
  });

  context("getMintableShares", () => {
    it("returns trivial can mint shares", async () => {
      const canMint = await dashboard.projectedMintableShares(0n);
      expect(canMint).to.equal(0n);
    });

    it("can mint all available shares", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 10000000n,
        sharesMinted: 0n,
        reserveRatioBP: 1000n,
        reserveRatioThresholdBP: 800n,
        treasuryFeeBP: 500n,
        isDisconnected: false,
      };
      await hub.mock__setVaultSocket(vault, sockets);

      const funding = 1000n;

      const preFundCanMint = await dashboard.projectedMintableShares(funding);

      await dashboard.fund({ value: funding });

      const availableMintableShares = await dashboard.totalMintableShares();

      const canMint = await dashboard.projectedMintableShares(0n);
      expect(canMint).to.equal(availableMintableShares);
      expect(canMint).to.equal(preFundCanMint);
    });

    it("cannot mint shares", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 10000000n,
        sharesMinted: 900n,
        reserveRatioBP: 1000n,
        reserveRatioThresholdBP: 800n,
        treasuryFeeBP: 500n,
        isDisconnected: false,
      };
      await hub.mock__setVaultSocket(vault, sockets);
      const funding = 1000n;

      const preFundCanMint = await dashboard.projectedMintableShares(funding);

      await dashboard.fund({ value: funding });

      const canMint = await dashboard.projectedMintableShares(0n);
      expect(canMint).to.equal(0n); // 1000 - 10% - 900 = 0
      expect(canMint).to.equal(preFundCanMint);
    });

    it("cannot mint shares when over limit", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 10000000n,
        sharesMinted: 10000n,
        reserveRatioBP: 1000n,
        reserveRatioThresholdBP: 800n,
        treasuryFeeBP: 500n,
        isDisconnected: false,
      };
      await hub.mock__setVaultSocket(vault, sockets);
      const funding = 1000n;
      const preFundCanMint = await dashboard.projectedMintableShares(funding);
      await dashboard.fund({ value: funding });

      const canMint = await dashboard.projectedMintableShares(0n);
      expect(canMint).to.equal(0n);
      expect(canMint).to.equal(preFundCanMint);
    });

    it("can mint to full ratio", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 10000000n,
        sharesMinted: 500n,
        reserveRatioBP: 1000n,
        reserveRatioThresholdBP: 800n,
        treasuryFeeBP: 500n,
        isDisconnected: false,
      };
      await hub.mock__setVaultSocket(vault, sockets);
      const funding = 2000n;

      const preFundCanMint = await dashboard.projectedMintableShares(funding);
      await dashboard.fund({ value: funding });

      const sharesFunded = await steth.getSharesByPooledEth((funding * (BP_BASE - sockets.reserveRatioBP)) / BP_BASE);

      const canMint = await dashboard.projectedMintableShares(0n);
      expect(canMint).to.equal(sharesFunded - sockets.sharesMinted);
      expect(canMint).to.equal(preFundCanMint);
    });

    it("can not mint when bound by share limit", async () => {
      const sockets = {
        vault: await vault.getAddress(),
        shareLimit: 500n,
        sharesMinted: 500n,
        reserveRatioBP: 1000n,
        reserveRatioThresholdBP: 800n,
        treasuryFeeBP: 500n,
        isDisconnected: false,
      };

      await hub.mock__setVaultSocket(vault, sockets);
      const funding = 2000n;
      const preFundCanMint = await dashboard.projectedMintableShares(funding);
      await dashboard.fund({ value: funding });

      const canMint = await dashboard.projectedMintableShares(0n);
      expect(canMint).to.equal(0n);
      expect(canMint).to.equal(preFundCanMint);
    });
  });

  context("getWithdrawableEther", () => {
    it("returns the trivial amount can withdraw ether", async () => {
      const getWithdrawableEther = await dashboard.getWithdrawableEther();
      expect(getWithdrawableEther).to.equal(0n);
    });

    it("funds and returns the correct can withdraw ether", async () => {
      const amount = ether("1");

      await dashboard.fund({ value: amount });

      const getWithdrawableEther = await dashboard.getWithdrawableEther();
      expect(getWithdrawableEther).to.equal(amount);
    });

    it("funds and recieves external but and can only withdraw unlocked", async () => {
      const amount = ether("1");
      await dashboard.fund({ value: amount });
      await vaultOwner.sendTransaction({ to: vault.getAddress(), value: amount });
      expect(await dashboard.getWithdrawableEther()).to.equal(amount);
    });

    it("funds and get all ether locked and can not withdraw", async () => {
      const amount = ether("1");
      await dashboard.fund({ value: amount });

      await hub.mock_vaultLock(vault.getAddress(), amount);

      expect(await dashboard.getWithdrawableEther()).to.equal(0n);
    });

    it("funds and get all ether locked and can not withdraw", async () => {
      const amount = ether("1");
      await dashboard.fund({ value: amount });

      await hub.mock_vaultLock(vault.getAddress(), amount);

      expect(await dashboard.getWithdrawableEther()).to.equal(0n);
    });

    it("funds and get all half locked and can only half withdraw", async () => {
      const amount = ether("1");
      await dashboard.fund({ value: amount });

      await hub.mock_vaultLock(vault.getAddress(), amount / 2n);

      expect(await dashboard.getWithdrawableEther()).to.equal(amount / 2n);
    });

    it("funds and get all half locked, but no balance and can not withdraw", async () => {
      const amount = ether("1");
      await dashboard.fund({ value: amount });

      await hub.mock_vaultLock(vault.getAddress(), amount / 2n);

      await setBalance(await vault.getAddress(), 0n);

      expect(await dashboard.getWithdrawableEther()).to.equal(0n);
    });

    // TODO: add more tests when the vault params are change
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
      await expect(dashboard.connect(stranger).voluntaryDisconnect())
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.DEFAULT_ADMIN_ROLE());
    });

    it("disconnects the staking vault from the vault hub", async () => {
      await expect(dashboard.voluntaryDisconnect()).to.emit(hub, "Mock__VaultDisconnected").withArgs(vault);
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
      await expect(dashboard.connect(stranger).mintShares(vaultOwner, ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("mints stETH backed by the vault through the vault hub", async () => {
      const amount = ether("1");
      await expect(dashboard.mintShares(vaultOwner, amount))
        .to.emit(steth, "Transfer")
        .withArgs(ZeroAddress, vaultOwner, amount)
        .and.to.emit(steth, "TransferShares")
        .withArgs(ZeroAddress, vaultOwner, amount);

      expect(await steth.balanceOf(vaultOwner)).to.equal(amount);
    });

    it("funds and mints stETH backed by the vault", async () => {
      const amount = ether("1");
      await expect(dashboard.mintShares(vaultOwner, amount, { value: amount }))
        .to.emit(vault, "Funded")
        .withArgs(dashboard, amount)
        .to.emit(steth, "Transfer")
        .withArgs(ZeroAddress, vaultOwner, amount)
        .and.to.emit(steth, "TransferShares")
        .withArgs(ZeroAddress, vaultOwner, amount);
    });
  });

  context("mintWstETH", () => {
    const amount = ether("1");

    before(async () => {
      await steth.mock__setTotalPooledEther(ether("1000"));
      await steth.mock__setTotalShares(ether("1000"));
    });

    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).mintWstETH(vaultOwner, amount)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("mints wstETH backed by the vault", async () => {
      const wstethBalanceBefore = await wsteth.balanceOf(vaultOwner);

      const result = await dashboard.mintWstETH(vaultOwner, amount);

      await expect(result).to.emit(steth, "Transfer").withArgs(dashboard, wsteth, amount);
      await expect(result).to.emit(wsteth, "Transfer").withArgs(ZeroAddress, dashboard, amount);

      expect(await wsteth.balanceOf(vaultOwner)).to.equal(wstethBalanceBefore + amount);
    });
  });

  context("burn", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).burnShares(ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("burns stETH backed by the vault", async () => {
      const amountShares = ether("1");
      await dashboard.mintShares(vaultOwner, amountShares);
      expect(await steth.balanceOf(vaultOwner)).to.equal(amountShares);

      await expect(steth.connect(vaultOwner).approve(dashboard, amountShares))
        .to.emit(steth, "Approval")
        .withArgs(vaultOwner, dashboard, amountShares);
      expect(await steth.allowance(vaultOwner, dashboard)).to.equal(amountShares);

      await expect(dashboard.burnShares(amountShares))
        .to.emit(steth, "Transfer") // transfer from owner to hub
        .withArgs(vaultOwner, hub, amountShares)
        .and.to.emit(steth, "TransferShares") // transfer shares to hub
        .withArgs(vaultOwner, hub, amountShares)
        .and.to.emit(steth, "SharesBurnt") // burn
        .withArgs(hub, amountShares, amountShares, amountShares);
      expect(await steth.balanceOf(vaultOwner)).to.equal(0);
    });
  });

  context("burnWstETH", () => {
    const amount = ether("1");

    before(async () => {
      // mint steth to the vault owner for the burn
      await dashboard.mintShares(vaultOwner, amount + amount);
    });

    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).burnWstETH(amount)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("burns wstETH backed by the vault", async () => {
      // approve for wsteth wrap
      await steth.connect(vaultOwner).approve(wsteth, amount);
      // wrap steth to wsteth to get the amount of wsteth for the burn
      await wsteth.connect(vaultOwner).wrap(amount);

      // user flow

      const wstethBalanceBefore = await wsteth.balanceOf(vaultOwner);
      const stethBalanceBefore = await steth.balanceOf(vaultOwner);
      // approve wsteth to dashboard contract
      await wsteth.connect(vaultOwner).approve(dashboard, amount);

      const result = await dashboard.burnWstETH(amount);

      await expect(result).to.emit(wsteth, "Transfer").withArgs(vaultOwner, dashboard, amount); // transfer wsteth to dashboard
      await expect(result).to.emit(steth, "Transfer").withArgs(wsteth, dashboard, amount); // unwrap wsteth to steth
      await expect(result).to.emit(wsteth, "Transfer").withArgs(dashboard, ZeroAddress, amount); // burn wsteth

      await expect(result).to.emit(steth, "Transfer").withArgs(dashboard, hub, amount); // transfer steth to hub
      await expect(result).to.emit(steth, "TransferShares").withArgs(dashboard, hub, amount); // transfer shares to hub
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, amount, amount, amount); // burn steth (mocked event data)

      expect(await steth.balanceOf(vaultOwner)).to.equal(stethBalanceBefore);
      expect(await wsteth.balanceOf(vaultOwner)).to.equal(wstethBalanceBefore - amount);
    });
  });

  context("burnSharesWithPermit", () => {
    const amountShares = ether("1");
    let amountSteth: bigint;

    before(async () => {
      // mint steth to the vault owner for the burn
      await dashboard.mintShares(vaultOwner, amountShares);
      amountSteth = await steth.getPooledEthByShares(amountShares);
    });

    beforeEach(async () => {
      const eip712helper = await ethers.deployContract("EIP712StETH", [steth]);
      await steth.initializeEIP712StETH(eip712helper);
    });

    it("reverts if called by a non-admin", async () => {
      const permit = {
        owner: await vaultOwner.address,
        spender: String(dashboard.target),
        value: amountSteth,
        nonce: await steth.nonces(vaultOwner),
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await stethDomain(steth), permit, vaultOwner);
      const { deadline, value } = permit;
      const { v, r, s } = signature;

      await expect(
        dashboard.connect(stranger).burnSharesWithPermit(amountShares, {
          value,
          deadline,
          v,
          r,
          s,
        }),
      ).to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount");
    });

    it("reverts if the permit is invalid", async () => {
      const permit = {
        owner: await vaultOwner.address,
        spender: stranger.address, // invalid spender
        value: amountSteth,
        nonce: await steth.nonces(vaultOwner),
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await stethDomain(steth), permit, vaultOwner);
      const { deadline, value } = permit;
      const { v, r, s } = signature;

      await expect(
        dashboard.connect(vaultOwner).burnSharesWithPermit(amountShares, {
          value,
          deadline,
          v,
          r,
          s,
        }),
      ).to.be.revertedWith("Permit failure");
    });

    it("burns shares with permit", async () => {
      const permit = {
        owner: vaultOwner.address,
        spender: String(dashboard.target),
        value: amountSteth,
        nonce: await steth.nonces(vaultOwner),
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await stethDomain(steth), permit, vaultOwner);
      const { deadline, value } = permit;
      const { v, r, s } = signature;

      const balanceBefore = await steth.balanceOf(vaultOwner);
      const result = await dashboard.connect(vaultOwner).burnSharesWithPermit(amountShares, {
        value,
        deadline,
        v,
        r,
        s,
      });

      await expect(result).to.emit(steth, "Approval").withArgs(vaultOwner, dashboard, amountShares); // approve steth from vault owner to dashboard
      await expect(result).to.emit(steth, "Transfer").withArgs(vaultOwner, hub, amountShares); // transfer steth to hub
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, amountShares, amountShares, amountShares); // burn steth

      expect(await steth.balanceOf(vaultOwner)).to.equal(balanceBefore - amountShares);
    });

    it("succeeds if has allowance", async () => {
      const permit = {
        owner: vaultOwner.address,
        spender: stranger.address, // invalid spender
        value: amountShares,
        nonce: (await steth.nonces(vaultOwner)) + 1n, // invalid nonce
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await stethDomain(steth), permit, vaultOwner);
      const { deadline, value } = permit;
      const { v, r, s } = signature;
      const permitData = {
        value,
        deadline,
        v,
        r,
        s,
      };

      await expect(dashboard.connect(vaultOwner).burnSharesWithPermit(amountShares, permitData)).to.be.revertedWith(
        "Permit failure",
      );

      await steth.connect(vaultOwner).approve(dashboard, amountShares);

      const balanceBefore = await steth.balanceOf(vaultOwner);
      const result = await dashboard.connect(vaultOwner).burnSharesWithPermit(amountShares, permitData);

      await expect(result).to.emit(steth, "Transfer").withArgs(vaultOwner, hub, amountShares); // transfer steth to hub
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, amountShares, amountShares, amountShares); // burn steth

      expect(await steth.balanceOf(vaultOwner)).to.equal(balanceBefore - amountShares);
    });

    it("succeeds with rebalanced shares - 1 share = 0.5 steth", async () => {
      await steth.mock__setTotalShares(ether("1000000"));
      await steth.mock__setTotalPooledEther(ether("500000"));
      const sharesToBurn = ether("1");
      const stethToBurn = sharesToBurn / 2n; // 1 share = 0.5 steth

      const permit = {
        owner: vaultOwner.address,
        spender: String(dashboard.target),
        value: stethToBurn,
        nonce: await steth.nonces(vaultOwner),
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await stethDomain(steth), permit, vaultOwner);
      const { deadline, value } = permit;
      const { v, r, s } = signature;
      const permitData = {
        value,
        deadline,
        v,
        r,
        s,
      };

      const balanceBefore = await steth.balanceOf(vaultOwner);
      const result = await dashboard.connect(vaultOwner).burnSharesWithPermit(amountShares, permitData);

      await expect(result).to.emit(steth, "Transfer").withArgs(vaultOwner, hub, stethToBurn); // transfer steth to hub
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, stethToBurn, stethToBurn, sharesToBurn); // burn steth

      expect(await steth.balanceOf(vaultOwner)).to.equal(balanceBefore - stethToBurn);
    });

    it("succeeds with rebalanced shares - 1 share = 2 stETH", async () => {
      await steth.mock__setTotalShares(ether("500000"));
      await steth.mock__setTotalPooledEther(ether("1000000"));
      const sharesToBurn = ether("1");
      const stethToBurn = sharesToBurn * 2n; // 1 share = 2 steth

      const permit = {
        owner: vaultOwner.address,
        spender: String(dashboard.target),
        value: stethToBurn,
        nonce: await steth.nonces(vaultOwner),
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await stethDomain(steth), permit, vaultOwner);
      const { deadline, value } = permit;
      const { v, r, s } = signature;
      const permitData = {
        value,
        deadline,
        v,
        r,
        s,
      };

      const balanceBefore = await steth.balanceOf(vaultOwner);
      const result = await dashboard.connect(vaultOwner).burnSharesWithPermit(amountShares, permitData);

      await expect(result).to.emit(steth, "Transfer").withArgs(vaultOwner, hub, stethToBurn); // transfer steth to hub
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, stethToBurn, stethToBurn, sharesToBurn); // burn steth

      expect(await steth.balanceOf(vaultOwner)).to.equal(balanceBefore - stethToBurn);
    });
  });

  context("burnWstETHWithPermit", () => {
    const amountShares = ether("1");

    beforeEach(async () => {
      // mint steth to the vault owner for the burn
      await dashboard.mintShares(vaultOwner, amountShares);
      // approve for wsteth wrap
      await steth.connect(vaultOwner).approve(wsteth, amountShares);
      // wrap steth to wsteth to get the amount of wsteth for the burn
      await wsteth.connect(vaultOwner).wrap(amountShares);
    });

    it("reverts if called by a non-admin", async () => {
      const permit = {
        owner: await vaultOwner.address,
        spender: String(dashboard.target),
        value: amountShares,
        nonce: await wsteth.nonces(vaultOwner),
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await wstethDomain(wsteth), permit, vaultOwner);
      const { deadline, value } = permit;
      const { v, r, s } = signature;

      await expect(
        dashboard.connect(stranger).burnSharesWithPermit(amountShares, {
          value,
          deadline,
          v,
          r,
          s,
        }),
      ).to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount");
    });

    it("reverts if the permit is invalid", async () => {
      const permit = {
        owner: await vaultOwner.address,
        spender: stranger.address, // invalid spender
        value: amountShares,
        nonce: await wsteth.nonces(vaultOwner),
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await wstethDomain(wsteth), permit, vaultOwner);
      const { deadline, value } = permit;
      const { v, r, s } = signature;

      await expect(
        dashboard.connect(vaultOwner).burnWstETHWithPermit(amountShares, {
          value,
          deadline,
          v,
          r,
          s,
        }),
      ).to.be.revertedWith("Permit failure");
    });

    it("burns wstETH with permit", async () => {
      const permit = {
        owner: await vaultOwner.address,
        spender: String(dashboard.target),
        value: amountShares,
        nonce: await wsteth.nonces(vaultOwner),
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await wstethDomain(wsteth), permit, vaultOwner);
      const { deadline, value } = permit;
      const { v, r, s } = signature;

      const wstethBalanceBefore = await wsteth.balanceOf(vaultOwner);
      const stethBalanceBefore = await steth.balanceOf(vaultOwner);
      const result = await dashboard.connect(vaultOwner).burnWstETHWithPermit(amountShares, {
        value,
        deadline,
        v,
        r,
        s,
      });

      await expect(result).to.emit(wsteth, "Approval").withArgs(vaultOwner, dashboard, amountShares); // approve steth from vault owner to dashboard
      await expect(result).to.emit(wsteth, "Transfer").withArgs(vaultOwner, dashboard, amountShares); // transfer steth to dashboard
      await expect(result).to.emit(steth, "Transfer").withArgs(wsteth, dashboard, amountShares); // uwrap wsteth to steth
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, amountShares, amountShares, amountShares); // burn steth

      expect(await steth.balanceOf(vaultOwner)).to.equal(stethBalanceBefore);
      expect(await wsteth.balanceOf(vaultOwner)).to.equal(wstethBalanceBefore - amountShares);
    });

    it("succeeds if has allowance", async () => {
      const permit = {
        owner: await vaultOwner.address,
        spender: String(dashboard.target), // invalid spender
        value: amountShares,
        nonce: (await wsteth.nonces(vaultOwner)) + 1n, // invalid nonce
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await wstethDomain(wsteth), permit, vaultOwner);
      const { deadline, value } = permit;
      const { v, r, s } = signature;
      const permitData = {
        value,
        deadline,
        v,
        r,
        s,
      };

      await expect(dashboard.connect(vaultOwner).burnWstETHWithPermit(amountShares, permitData)).to.be.revertedWith(
        "Permit failure",
      );

      await wsteth.connect(vaultOwner).approve(dashboard, amountShares);

      const wstethBalanceBefore = await wsteth.balanceOf(vaultOwner);
      const stethBalanceBefore = await steth.balanceOf(vaultOwner);
      const result = await dashboard.connect(vaultOwner).burnWstETHWithPermit(amountShares, permitData);

      await expect(result).to.emit(wsteth, "Transfer").withArgs(vaultOwner, dashboard, amountShares); // transfer steth to dashboard
      await expect(result).to.emit(steth, "Transfer").withArgs(wsteth, dashboard, amountShares); // uwrap wsteth to steth
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, amountShares, amountShares, amountShares); // burn steth

      expect(await steth.balanceOf(vaultOwner)).to.equal(stethBalanceBefore);
      expect(await wsteth.balanceOf(vaultOwner)).to.equal(wstethBalanceBefore - amountShares);
    });

    it("succeeds with rebalanced shares - 1 share = 0.5 stETH", async () => {
      await steth.mock__setTotalShares(ether("1000000"));
      await steth.mock__setTotalPooledEther(ether("500000"));
      const sharesToBurn = ether("1");
      const stethToBurn = sharesToBurn / 2n; // 1 share = 0.5 steth

      const permit = {
        owner: await vaultOwner.address,
        spender: String(dashboard.target),
        value: sharesToBurn,
        nonce: await wsteth.nonces(vaultOwner),
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await wstethDomain(wsteth), permit, vaultOwner);
      const { deadline, value } = permit;
      const { v, r, s } = signature;

      const wstethBalanceBefore = await wsteth.balanceOf(vaultOwner);
      const stethBalanceBefore = await steth.balanceOf(vaultOwner);
      const result = await dashboard.connect(vaultOwner).burnWstETHWithPermit(sharesToBurn, {
        value,
        deadline,
        v,
        r,
        s,
      });

      await expect(result).to.emit(wsteth, "Transfer").withArgs(vaultOwner, dashboard, sharesToBurn); // transfer steth to dashboard
      await expect(result).to.emit(steth, "Transfer").withArgs(wsteth, dashboard, stethToBurn); // uwrap wsteth to steth
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, stethToBurn, stethToBurn, sharesToBurn); // burn steth

      expect(await steth.balanceOf(vaultOwner)).to.equal(stethBalanceBefore);
      expect(await wsteth.balanceOf(vaultOwner)).to.equal(wstethBalanceBefore - sharesToBurn);
    });

    it("succeeds with rebalanced shares - 1 share = 2 stETH", async () => {
      await steth.mock__setTotalShares(ether("500000"));
      await steth.mock__setTotalPooledEther(ether("1000000"));
      const sharesToBurn = ether("1");
      const stethToBurn = sharesToBurn * 2n; // 1 share = 2 steth

      const permit = {
        owner: await vaultOwner.address,
        spender: String(dashboard.target),
        value: sharesToBurn,
        nonce: await wsteth.nonces(vaultOwner),
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await wstethDomain(wsteth), permit, vaultOwner);
      const { deadline, value } = permit;
      const { v, r, s } = signature;

      const wstethBalanceBefore = await wsteth.balanceOf(vaultOwner);
      const stethBalanceBefore = await steth.balanceOf(vaultOwner);
      const result = await dashboard.connect(vaultOwner).burnWstETHWithPermit(sharesToBurn, {
        value,
        deadline,
        v,
        r,
        s,
      });

      await expect(result).to.emit(wsteth, "Transfer").withArgs(vaultOwner, dashboard, sharesToBurn); // transfer steth to dashboard
      await expect(result).to.emit(steth, "Transfer").withArgs(wsteth, dashboard, stethToBurn); // uwrap wsteth to steth
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, stethToBurn, stethToBurn, sharesToBurn); // burn steth

      expect(await steth.balanceOf(vaultOwner)).to.equal(stethBalanceBefore);
      expect(await wsteth.balanceOf(vaultOwner)).to.equal(wstethBalanceBefore - sharesToBurn);
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
