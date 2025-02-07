import { expect } from "chai";
import { randomBytes } from "crypto";
import { MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  Dashboard,
  DepositContract__MockForStakingVault,
  ERC721_MockForDashboard,
  LidoLocator,
  StakingVault,
  StETHPermit__HarnessForDashboard,
  VaultFactory__MockForDashboard,
  VaultHub__MockForDashboard,
  WETH9__MockForVault,
  WstETH__HarnessForVault,
} from "typechain-types";

import { certainAddress, days, ether, findEvents, signPermit, stethDomain, wstethDomain } from "lib";

import { deployLidoLocator, deployWithdrawalsPreDeployedMock } from "test/deploy";
import { Snapshot } from "test/suite";

describe("Dashboard.sol", () => {
  let factoryOwner: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let steth: StETHPermit__HarnessForDashboard;
  let weth: WETH9__MockForVault;
  let erc721: ERC721_MockForDashboard;
  let wsteth: WstETH__HarnessForVault;
  let hub: VaultHub__MockForDashboard;
  let depositContract: DepositContract__MockForStakingVault;
  let vaultImpl: StakingVault;
  let dashboardImpl: Dashboard;
  let factory: VaultFactory__MockForDashboard;
  let lidoLocator: LidoLocator;

  let vault: StakingVault;
  let dashboard: Dashboard;
  let dashboardAddress: string;

  let originalState: string;

  const BP_BASE = 10_000n;

  const FEE = 10n; // some withdrawal fee for EIP-7002

  before(async () => {
    [factoryOwner, vaultOwner, nodeOperator, stranger] = await ethers.getSigners();

    await deployWithdrawalsPreDeployedMock(FEE);

    steth = await ethers.deployContract("StETHPermit__HarnessForDashboard");
    await steth.mock__setTotalShares(ether("1000000"));
    await steth.mock__setTotalPooledEther(ether("1400000"));

    weth = await ethers.deployContract("WETH9__MockForVault");
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);
    hub = await ethers.deployContract("VaultHub__MockForDashboard", [steth]);
    erc721 = await ethers.deployContract("ERC721_MockForDashboard");
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

    const createVaultTx = await factory.connect(vaultOwner).createVault(nodeOperator);
    const createVaultReceipt = await createVaultTx.wait();
    if (!createVaultReceipt) throw new Error("Vault creation receipt not found");

    const vaultCreatedEvents = findEvents(createVaultReceipt, "VaultCreated");
    expect(vaultCreatedEvents.length).to.equal(1);

    const vaultAddress = vaultCreatedEvents[0].args.vault;
    vault = await ethers.getContractAt("StakingVault", vaultAddress, vaultOwner);

    const dashboardCreatedEvents = findEvents(createVaultReceipt, "DashboardCreated");
    expect(dashboardCreatedEvents.length).to.equal(1);

    dashboardAddress = dashboardCreatedEvents[0].args.dashboard;
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
        .withArgs("_wETH");
    });

    it("sets the stETH, wETH, and wstETH addresses", async () => {
      const dashboard_ = await ethers.deployContract("Dashboard", [weth, lidoLocator]);
      expect(await dashboard_.STETH()).to.equal(steth);
      expect(await dashboard_.WETH()).to.equal(weth);
      expect(await dashboard_.WSTETH()).to.equal(wsteth);
    });
  });

  context("initialize", () => {
    it("reverts if already initialized", async () => {
      await expect(dashboard.initialize(vaultOwner)).to.be.revertedWithCustomError(dashboard, "AlreadyInitialized");
    });

    it("reverts if called on the implementation", async () => {
      const dashboard_ = await ethers.deployContract("Dashboard", [weth, lidoLocator]);

      await expect(dashboard_.initialize(vaultOwner)).to.be.revertedWithCustomError(
        dashboard_,
        "NonProxyCallsForbidden",
      );
    });
  });

  context("votingCommittee", () => {
    it("returns the array of roles", async () => {
      const votingCommittee = await dashboard.votingCommittee();
      expect(votingCommittee).to.deep.equal([ZeroAddress]);
    });
  });

  context("initialized state", () => {
    it("post-initialization state is correct", async () => {
      // vault state
      expect(await vault.owner()).to.equal(dashboard);
      expect(await vault.nodeOperator()).to.equal(nodeOperator);
      expect(await dashboard.initialized()).to.equal(true);
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
      expect(await steth.allowance(dashboardAddress, wsteth.getAddress())).to.equal(MaxUint256);
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
      expect(await dashboard.reserveRatioBP()).to.equal(sockets.reserveRatioBP);
      expect(await dashboard.thresholdReserveRatioBP()).to.equal(sockets.reserveRatioThresholdBP);
      expect(await dashboard.treasuryFee()).to.equal(sockets.treasuryFeeBP);
    });
  });

  context("valuation", () => {
    it("returns the correct stETH valuation from vault", async () => {
      const valuation = await dashboard.valuation();
      expect(valuation).to.equal(await vault.valuation());
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

  context("projectedNewMintableShares", () => {
    it("returns trivial can mint shares", async () => {
      const canMint = await dashboard.projectedNewMintableShares(0n);
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

      const preFundCanMint = await dashboard.projectedNewMintableShares(funding);

      await dashboard.fund({ value: funding });

      const availableMintableShares = await dashboard.totalMintableShares();

      const canMint = await dashboard.projectedNewMintableShares(0n);
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

      const preFundCanMint = await dashboard.projectedNewMintableShares(funding);

      await dashboard.fund({ value: funding });

      const canMint = await dashboard.projectedNewMintableShares(0n);
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
      const preFundCanMint = await dashboard.projectedNewMintableShares(funding);
      await dashboard.fund({ value: funding });

      const canMint = await dashboard.projectedNewMintableShares(0n);
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

      const preFundCanMint = await dashboard.projectedNewMintableShares(funding);
      await dashboard.fund({ value: funding });

      const sharesFunded = await steth.getSharesByPooledEth((funding * (BP_BASE - sockets.reserveRatioBP)) / BP_BASE);

      const canMint = await dashboard.projectedNewMintableShares(0n);
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
      const preFundCanMint = await dashboard.projectedNewMintableShares(funding);
      await dashboard.fund({ value: funding });

      const canMint = await dashboard.projectedNewMintableShares(0n);
      expect(canMint).to.equal(0n);
      expect(canMint).to.equal(preFundCanMint);
    });
  });

  context("withdrawableEther", () => {
    it("returns the trivial amount can withdraw ether", async () => {
      const withdrawableEther = await dashboard.withdrawableEther();
      expect(withdrawableEther).to.equal(0n);
    });

    it("funds and returns the correct can withdraw ether", async () => {
      const amount = ether("1");

      await dashboard.fund({ value: amount });

      const withdrawableEther = await dashboard.withdrawableEther();
      expect(withdrawableEther).to.equal(amount);
    });

    it("funds and recieves external but and can only withdraw unlocked", async () => {
      const amount = ether("1");
      await dashboard.fund({ value: amount });
      await vaultOwner.sendTransaction({ to: vault.getAddress(), value: amount });
      expect(await dashboard.withdrawableEther()).to.equal(amount);
    });

    it("funds and get all ether locked and can not withdraw", async () => {
      const amount = ether("1");
      await dashboard.fund({ value: amount });

      await hub.mock_vaultLock(vault.getAddress(), amount);

      expect(await dashboard.withdrawableEther()).to.equal(0n);
    });

    it("funds and get all ether locked and can not withdraw", async () => {
      const amount = ether("1");
      await dashboard.fund({ value: amount });

      await hub.mock_vaultLock(vault.getAddress(), amount);

      expect(await dashboard.withdrawableEther()).to.equal(0n);
    });

    it("funds and get all half locked and can only half withdraw", async () => {
      const amount = ether("1");
      await dashboard.fund({ value: amount });

      await hub.mock_vaultLock(vault.getAddress(), amount / 2n);

      expect(await dashboard.withdrawableEther()).to.equal(amount / 2n);
    });

    it("funds and get all half locked, but no balance and can not withdraw", async () => {
      const amount = ether("1");
      await dashboard.fund({ value: amount });

      await hub.mock_vaultLock(vault.getAddress(), amount / 2n);

      await setBalance(await vault.getAddress(), 0n);

      expect(await dashboard.withdrawableEther()).to.equal(0n);
    });

    // TODO: add more tests when the vault params are change
  });

  context("transferStVaultOwnership", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).transferStakingVaultOwnership(vaultOwner)).to.be.revertedWithCustomError(
        dashboard,
        "NotACommitteeMember",
      );
    });

    it("assigns a new owner to the staking vault", async () => {
      const newOwner = certainAddress("dashboard:test:new-owner");
      await expect(dashboard.transferStakingVaultOwnership(newOwner))
        .to.emit(vault, "OwnershipTransferred")
        .withArgs(dashboard, newOwner);
      expect(await vault.owner()).to.equal(newOwner);
    });
  });

  context("voluntaryDisconnect", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).voluntaryDisconnect())
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.VOLUNTARY_DISCONNECT_ROLE());
    });

    context("when vault has no debt", () => {
      it("disconnects the staking vault from the vault hub", async () => {
        await expect(dashboard.voluntaryDisconnect()).to.emit(hub, "Mock__VaultDisconnected").withArgs(vault);
      });
    });

    context("when vault has debt", () => {
      const amountShares = ether("1");
      let amountSteth: bigint;

      before(async () => {
        amountSteth = await steth.getPooledEthByShares(amountShares);
      });

      beforeEach(async () => {
        await dashboard.mintShares(vaultOwner, amountShares);
      });

      it("reverts on disconnect attempt", async () => {
        await expect(dashboard.voluntaryDisconnect()).to.be.reverted;
      });

      it("succeeds with rebalance when providing sufficient ETH", async () => {
        await expect(dashboard.voluntaryDisconnect({ value: amountSteth }))
          .to.emit(hub, "Mock__Rebalanced")
          .withArgs(amountSteth)
          .to.emit(hub, "Mock__VaultDisconnected")
          .withArgs(vault);
      });
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

  context("fundWeth", () => {
    const amount = ether("1");

    beforeEach(async () => {
      await weth.connect(vaultOwner).deposit({ value: amount });
    });

    it("reverts if called by a non-admin", async () => {
      const strangerWeth = weth.connect(stranger);
      await strangerWeth.deposit({ value: amount });
      await strangerWeth.approve(dashboard, amount);
      await expect(dashboard.connect(stranger).fundWeth(ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("funds by weth", async () => {
      await weth.connect(vaultOwner).approve(dashboard, amount);

      await expect(dashboard.fundWeth(amount, { from: vaultOwner }))
        .to.emit(vault, "Funded")
        .withArgs(dashboard, amount);
      expect(await ethers.provider.getBalance(vault)).to.equal(amount);
    });

    it("reverts without approval", async () => {
      await expect(dashboard.fundWeth(amount, { from: vaultOwner })).to.be.revertedWithoutReason();
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

  context("withdrawWeth", () => {
    const amount = ether("1");

    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).withdrawWETH(vaultOwner, ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("withdraws ether from the staking vault to weth", async () => {
      await dashboard.fund({ value: amount });
      const previousBalance = await ethers.provider.getBalance(stranger);

      await expect(dashboard.withdrawWETH(stranger, amount))
        .to.emit(vault, "Withdrawn")
        .withArgs(dashboard, dashboard, amount);

      expect(await ethers.provider.getBalance(stranger)).to.equal(previousBalance);
      expect(await weth.balanceOf(stranger)).to.equal(amount);
    });
  });

  context("markValidatorsForExit", () => {
    const pubkeys = ["01".repeat(48), "02".repeat(48)];
    const pubkeysConcat = `0x${pubkeys.join("")}`;

    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).markValidatorsForExit(pubkeysConcat)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("signals the requested exit of a validator", async () => {
      await expect(dashboard.markValidatorsForExit(pubkeysConcat))
        .to.emit(vault, "ValidatorMarkedForExit")
        .withArgs(dashboard, `0x${pubkeys[0]}`)
        .to.emit(vault, "ValidatorMarkedForExit")
        .withArgs(dashboard, `0x${pubkeys[1]}`);
    });
  });

  context("requestValidatorWithdrawals", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(
        dashboard.connect(stranger).requestValidatorWithdrawals("0x", [0n], vaultOwner),
      ).to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount");
    });

    it("requests a full validator withdrawal", async () => {
      const validatorPublicKeys = "0x" + randomBytes(48).toString("hex");
      const amounts = [0n]; // 0 amount means full withdrawal

      await expect(dashboard.requestValidatorWithdrawals(validatorPublicKeys, amounts, vaultOwner, { value: FEE }))
        .to.emit(vault, "ValidatorWithdrawalsRequested")
        .withArgs(dashboard, validatorPublicKeys, amounts, vaultOwner, 0n);
    });

    it("requests a partial validator withdrawal", async () => {
      const validatorPublicKeys = "0x" + randomBytes(48).toString("hex");
      const amounts = [ether("0.1")];

      await expect(dashboard.requestValidatorWithdrawals(validatorPublicKeys, amounts, vaultOwner, { value: FEE }))
        .to.emit(vault, "ValidatorWithdrawalsRequested")
        .withArgs(dashboard, validatorPublicKeys, amounts, vaultOwner, 0n);
    });
  });

  context("mintShares", () => {
    const amountShares = ether("1");
    const amountFunded = ether("2");
    let amountSteth: bigint;

    before(async () => {
      amountSteth = await steth.getPooledEthByShares(amountShares);
    });

    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).mintShares(vaultOwner, ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("mints shares backed by the vault through the vault hub", async () => {
      await expect(dashboard.mintShares(vaultOwner, amountShares))
        .to.emit(steth, "Transfer")
        .withArgs(ZeroAddress, vaultOwner, amountSteth)
        .and.to.emit(steth, "TransferShares")
        .withArgs(ZeroAddress, vaultOwner, amountShares);

      expect(await steth.balanceOf(vaultOwner)).to.equal(amountSteth);
    });

    it("funds and mints shares backed by the vault", async () => {
      await expect(dashboard.mintShares(vaultOwner, amountShares, { value: amountFunded }))
        .to.emit(vault, "Funded")
        .withArgs(dashboard, amountFunded)
        .to.emit(steth, "Transfer")
        .withArgs(ZeroAddress, vaultOwner, amountSteth)
        .and.to.emit(steth, "TransferShares")
        .withArgs(ZeroAddress, vaultOwner, amountShares);
    });
  });

  context("mintSteth", () => {
    const amountShares = ether("1");
    const amountFunded = ether("2");
    let amountSteth: bigint;

    before(async () => {
      amountSteth = await steth.getPooledEthByShares(amountShares);
    });

    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).mintStETH(vaultOwner, amountSteth)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("mints steth backed by the vault through the vault hub", async () => {
      await expect(dashboard.mintStETH(vaultOwner, amountSteth))
        .to.emit(steth, "Transfer")
        .withArgs(ZeroAddress, vaultOwner, amountSteth)
        .and.to.emit(steth, "TransferShares")
        .withArgs(ZeroAddress, vaultOwner, amountShares);

      expect(await steth.balanceOf(vaultOwner)).to.equal(amountSteth);
    });

    it("funds and mints shares backed by the vault", async () => {
      await expect(dashboard.mintStETH(vaultOwner, amountSteth, { value: amountFunded }))
        .to.emit(vault, "Funded")
        .withArgs(dashboard, amountFunded)
        .and.to.emit(steth, "Transfer")
        .withArgs(ZeroAddress, vaultOwner, amountSteth)
        .and.to.emit(steth, "TransferShares")
        .withArgs(ZeroAddress, vaultOwner, amountShares);
    });

    it("cannot mint less stETH than 1 share", async () => {
      await expect(dashboard.mintStETH(vaultOwner, 1n)).to.be.revertedWithCustomError(hub, "ZeroArgument");
    });
  });

  context("mintWstETH", () => {
    const amountWsteth = ether("1");
    let amountSteth: bigint;

    before(async () => {
      amountSteth = await steth.getPooledEthByShares(amountWsteth);
    });

    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).mintWstETH(vaultOwner, amountWsteth)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("mints wstETH backed by the vault", async () => {
      const wstethBalanceBefore = await wsteth.balanceOf(vaultOwner);

      const result = await dashboard.mintWstETH(vaultOwner, amountWsteth);

      await expect(result).to.emit(steth, "Transfer").withArgs(dashboard, wsteth, amountSteth);
      await expect(result).to.emit(wsteth, "Transfer").withArgs(ZeroAddress, dashboard, amountWsteth);

      expect(await wsteth.balanceOf(vaultOwner)).to.equal(wstethBalanceBefore + amountWsteth);
    });

    it("reverts on zero mint", async () => {
      await expect(dashboard.mintWstETH(vaultOwner, 0n)).to.be.revertedWithCustomError(hub, "ZeroArgument");
    });

    for (let weiWsteth = 1n; weiWsteth <= 10n; weiWsteth++) {
      it(`mints ${weiWsteth} wei wsteth`, async () => {
        const weiSteth = await steth.getPooledEthBySharesRoundUp(weiWsteth);
        const wstethBalanceBefore = await wsteth.balanceOf(vaultOwner);

        const result = await dashboard.mintWstETH(vaultOwner, weiWsteth);

        await expect(result).to.emit(steth, "Transfer").withArgs(dashboard, wsteth, weiSteth);
        await expect(result).to.emit(wsteth, "Transfer").withArgs(ZeroAddress, dashboard, weiWsteth);

        expect(await wsteth.balanceOf(dashboard)).to.equal(0n);
        expect(await wsteth.balanceOf(vaultOwner)).to.equal(wstethBalanceBefore + weiWsteth);
      });
    }
  });

  context("burnShares", () => {
    it("reverts if called by a non-admin", async () => {
      const amountShares = ether("1");
      const amountSteth = await steth.getPooledEthByShares(amountShares);
      await steth.mintExternalShares(stranger, amountShares);
      await steth.connect(stranger).approve(dashboard, amountSteth);

      await expect(dashboard.connect(stranger).burnShares(amountShares)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("burns shares backed by the vault", async () => {
      const amountShares = ether("1");
      const amountSteth = await steth.getPooledEthByShares(amountShares);
      await dashboard.mintShares(vaultOwner, amountShares);
      expect(await steth.balanceOf(vaultOwner)).to.equal(amountSteth);

      await expect(steth.connect(vaultOwner).approve(dashboard, amountSteth))
        .to.emit(steth, "Approval")
        .withArgs(vaultOwner, dashboard, amountSteth);
      expect(await steth.allowance(vaultOwner, dashboard)).to.equal(amountSteth);

      await expect(dashboard.burnShares(amountShares))
        .to.emit(steth, "Transfer") // transfer from owner to hub
        .withArgs(vaultOwner, hub, amountSteth)
        .and.to.emit(steth, "TransferShares") // transfer shares to hub
        .withArgs(vaultOwner, hub, amountShares)
        .and.to.emit(steth, "SharesBurnt") // burn
        .withArgs(hub, amountSteth, amountSteth, amountShares);
      expect(await steth.balanceOf(vaultOwner)).to.equal(0);
    });
  });

  context("burnStETH", () => {
    const amountShares = ether("1");
    let amountSteth: bigint;

    beforeEach(async () => {
      amountSteth = await steth.getPooledEthByShares(amountShares);
      await dashboard.mintStETH(vaultOwner, amountSteth);
    });

    it("reverts if called by a non-admin", async () => {
      await steth.mintExternalShares(stranger, amountShares);
      await steth.connect(stranger).approve(dashboard, amountSteth);

      await expect(dashboard.connect(stranger).burnStETH(amountSteth)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("burns steth backed by the vault", async () => {
      expect(await steth.balanceOf(vaultOwner)).to.equal(amountSteth);

      await expect(steth.connect(vaultOwner).approve(dashboard, amountSteth))
        .to.emit(steth, "Approval")
        .withArgs(vaultOwner, dashboard, amountSteth);
      expect(await steth.allowance(vaultOwner, dashboard)).to.equal(amountSteth);

      await expect(dashboard.burnStETH(amountSteth))
        .to.emit(steth, "Transfer") // transfer from owner to hub
        .withArgs(vaultOwner, hub, amountSteth)
        .and.to.emit(steth, "TransferShares") // transfer shares to hub
        .withArgs(vaultOwner, hub, amountShares)
        .and.to.emit(steth, "SharesBurnt") // burn
        .withArgs(hub, amountSteth, amountSteth, amountShares);
      expect(await steth.balanceOf(vaultOwner)).to.equal(0);
    });

    it("does not allow to burn 1 wei stETH", async () => {
      await expect(dashboard.burnStETH(1n)).to.be.revertedWithCustomError(hub, "ZeroArgument");
    });
  });

  context("burnWstETH", () => {
    const amountWsteth = ether("1");

    before(async () => {
      // mint shares to the vault owner for the burn
      await dashboard.mintShares(vaultOwner, amountWsteth + amountWsteth);
    });

    it("reverts if called by a non-admin", async () => {
      // get steth
      await steth.mintExternalShares(stranger, amountWsteth + 1000n);
      const amountSteth = await steth.getPooledEthByShares(amountWsteth);
      // get wsteth
      await steth.connect(stranger).approve(wsteth, amountSteth);
      await wsteth.connect(stranger).wrap(amountSteth);
      // burn
      await wsteth.connect(stranger).approve(dashboard, amountWsteth);
      await expect(dashboard.connect(stranger).burnWstETH(amountWsteth)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("burns shares backed by the vault", async () => {
      const amountSteth = await steth.getPooledEthBySharesRoundUp(amountWsteth);
      // approve for wsteth wrap
      await steth.connect(vaultOwner).approve(wsteth, amountSteth);
      // wrap steth to wsteth to get the amount of wsteth for the burn
      await wsteth.connect(vaultOwner).wrap(amountSteth);

      // user flow

      const wstethBalanceBefore = await wsteth.balanceOf(vaultOwner);
      const stethBalanceBefore = await steth.balanceOf(vaultOwner);
      // approve wsteth to dashboard contract
      await wsteth.connect(vaultOwner).approve(dashboard, amountWsteth);

      const result = await dashboard.burnWstETH(amountWsteth);

      await expect(result).to.emit(wsteth, "Transfer").withArgs(vaultOwner, dashboard, amountWsteth); // transfer wsteth to dashboard
      await expect(result).to.emit(steth, "Transfer").withArgs(wsteth, dashboard, amountSteth); // unwrap wsteth to steth
      await expect(result).to.emit(wsteth, "Transfer").withArgs(dashboard, ZeroAddress, amountWsteth); // burn wsteth

      await expect(result).to.emit(steth, "Transfer").withArgs(dashboard, hub, amountSteth); // transfer steth to hub
      await expect(result).to.emit(steth, "TransferShares").withArgs(dashboard, hub, amountWsteth); // transfer shares to hub
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, amountSteth, amountSteth, amountWsteth); // burn steth (mocked event data)

      expect(await steth.balanceOf(vaultOwner)).to.equal(stethBalanceBefore);
      expect(await wsteth.balanceOf(vaultOwner)).to.equal(wstethBalanceBefore - amountWsteth);
    });

    it("reverts on zero burn", async () => {
      await expect(dashboard.burnWstETH(0n)).to.be.revertedWith("wstETH: zero amount unwrap not allowed");
    });

    it(`burns 1-10 wei wsteth with different share rate `, async () => {
      const baseTotalEther = ether("1000000");
      await steth.mock__setTotalPooledEther(baseTotalEther);
      await steth.mock__setTotalShares(baseTotalEther);

      const wstethContract = await wsteth.connect(vaultOwner);

      const totalEtherStep = baseTotalEther / 10n;
      const totalEtherMax = baseTotalEther * 2n;

      for (let totalEther = baseTotalEther; totalEther <= totalEtherMax; totalEther += totalEtherStep) {
        for (let weiShare = 1n; weiShare <= 20n; weiShare++) {
          await steth.mock__setTotalPooledEther(totalEther);

          // this is only used for correct steth value when wrapping to receive share==wsteth
          const weiStethUp = await steth.getPooledEthBySharesRoundUp(weiShare);
          // steth value actually used by wsteth inside the contract
          const weiStethDown = await steth.getPooledEthByShares(weiShare);
          // this share amount that is returned from wsteth on unwrap
          // because wsteth eats 1 share due to "rounding" (being a hungry-hungry wei gobler)
          const weiShareDown = await steth.getSharesByPooledEth(weiStethDown);
          // steth value occuring only in events when rounding down from weiShareDown
          const weiStethDownDown = await steth.getPooledEthByShares(weiShareDown);

          // approve for wsteth wrap
          await steth.connect(vaultOwner).approve(wsteth, weiStethUp);
          // wrap steth to wsteth to get the amount of wsteth for the burn
          await wstethContract.wrap(weiStethUp);

          expect(await wsteth.balanceOf(vaultOwner)).to.equal(weiShare);
          const stethBalanceBefore = await steth.balanceOf(vaultOwner);

          // approve wsteth to dashboard contract
          await wstethContract.approve(dashboard, weiShare);

          // reverts when rounding to zero
          // this condition is excessive but illustrative
          if (weiShareDown === 0n && weiShare == 1n) {
            await expect(dashboard.burnWstETH(weiShare)).to.be.revertedWithCustomError(hub, "ZeroArgument");
            // clean up wsteth
            await wstethContract.transfer(stranger, await wstethContract.balanceOf(vaultOwner));
            continue;
          }

          const result = await dashboard.burnWstETH(weiShare);

          // transfer wsteth from sender
          await expect(result).to.emit(wsteth, "Transfer").withArgs(vaultOwner, dashboard, weiShare); // transfer wsteth to dashboard
          // unwrap wsteth to steth
          await expect(result).to.emit(steth, "Transfer").withArgs(wsteth, dashboard, weiStethDown); // unwrap wsteth to steth
          await expect(result).to.emit(wsteth, "Transfer").withArgs(dashboard, ZeroAddress, weiShare); // burn wsteth
          // transfer shares to hub
          await expect(result).to.emit(steth, "Transfer").withArgs(dashboard, hub, weiStethDownDown);
          await expect(result).to.emit(steth, "TransferShares").withArgs(dashboard, hub, weiShareDown);
          // burn shares in the hub
          await expect(result)
            .to.emit(steth, "SharesBurnt")
            .withArgs(hub, weiStethDownDown, weiStethDownDown, weiShareDown);

          expect(await steth.balanceOf(vaultOwner)).to.equal(stethBalanceBefore);

          // no dust left over
          expect(await wsteth.balanceOf(vaultOwner)).to.equal(0n);
        }
      }
    });
  });

  context("burnSharesWithPermit", () => {
    const amountShares = ether("1");
    let amountSteth: bigint;

    before(async () => {
      // mint steth to the vault owner for the burn
      await dashboard.mintShares(vaultOwner, amountShares);
      amountSteth = await steth.getPooledEthBySharesRoundUp(amountShares);
    });

    beforeEach(async () => {
      const eip712helper = await ethers.deployContract("EIP712StETH", [steth]);
      await steth.initializeEIP712StETH(eip712helper);
    });

    it("reverts if called by a non-admin", async () => {
      await steth.mintExternalShares(stranger, amountShares);
      const permit = {
        owner: stranger.address,
        spender: dashboardAddress,
        value: amountSteth,
        nonce: await steth.nonces(stranger),
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await stethDomain(steth), permit, stranger);
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
        owner: vaultOwner.address,
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
      ).to.be.revertedWithCustomError(dashboard, "InvalidPermit");
    });

    it("burns shares with permit", async () => {
      const permit = {
        owner: vaultOwner.address,
        spender: dashboardAddress,
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

      await expect(result).to.emit(steth, "Approval").withArgs(vaultOwner, dashboard, amountSteth); // approve steth from vault owner to dashboard
      await expect(result).to.emit(steth, "Transfer").withArgs(vaultOwner, hub, amountSteth); // transfer steth to hub
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, amountSteth, amountSteth, amountShares); // burn steth

      expect(await steth.balanceOf(vaultOwner)).to.equal(balanceBefore - amountSteth);
    });

    it("succeeds if has allowance", async () => {
      const permit = {
        owner: vaultOwner.address,
        spender: stranger.address, // invalid spender
        value: amountSteth,
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

      await expect(
        dashboard.connect(vaultOwner).burnSharesWithPermit(amountShares, permitData),
      ).to.be.revertedWithCustomError(dashboard, "InvalidPermit");

      await steth.connect(vaultOwner).approve(dashboard, amountSteth);

      const balanceBefore = await steth.balanceOf(vaultOwner);
      const result = await dashboard.connect(vaultOwner).burnSharesWithPermit(amountShares, permitData);

      await expect(result).to.emit(steth, "Transfer").withArgs(vaultOwner, hub, amountSteth); // transfer steth to hub
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, amountSteth, amountSteth, amountShares); // burn steth

      expect(await steth.balanceOf(vaultOwner)).to.equal(balanceBefore - amountSteth);
    });

    it("succeeds with rebalanced shares - 1 share = 0.5 steth", async () => {
      await steth.mock__setTotalShares(ether("1000000"));
      await steth.mock__setTotalPooledEther(ether("500000"));
      const sharesToBurn = ether("1");
      const stethToBurn = sharesToBurn / 2n; // 1 share = 0.5 steth

      const permit = {
        owner: vaultOwner.address,
        spender: dashboardAddress,
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
        spender: dashboardAddress,
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

  context("burnStETHWithPermit", () => {
    const amountShares = ether("1");
    let amountSteth: bigint;

    before(async () => {
      // mint steth to the vault owner for the burn
      await dashboard.mintShares(vaultOwner, amountShares);
      amountSteth = await steth.getPooledEthBySharesRoundUp(amountShares);
    });

    beforeEach(async () => {
      const eip712helper = await ethers.deployContract("EIP712StETH", [steth]);
      await steth.initializeEIP712StETH(eip712helper);
    });

    it("reverts if called by a non-admin", async () => {
      await steth.mintExternalShares(stranger, amountShares);

      const permit = {
        owner: stranger.address,
        spender: dashboardAddress,
        value: amountSteth,
        nonce: await steth.nonces(stranger),
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await stethDomain(steth), permit, stranger);
      const { deadline, value } = permit;
      const { v, r, s } = signature;

      await expect(
        dashboard.connect(stranger).burnStETHWithPermit(amountSteth, {
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
        owner: vaultOwner.address,
        spender: stranger.address, // invalid spender
        value: amountSteth,
        nonce: await steth.nonces(vaultOwner),
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await stethDomain(steth), permit, vaultOwner);
      const { deadline, value } = permit;
      const { v, r, s } = signature;

      await expect(
        dashboard.connect(vaultOwner).burnStETHWithPermit(amountSteth, {
          value,
          deadline,
          v,
          r,
          s,
        }),
      ).to.be.revertedWithCustomError(dashboard, "InvalidPermit");
    });

    it("burns shares with permit", async () => {
      const permit = {
        owner: vaultOwner.address,
        spender: dashboardAddress,
        value: amountSteth,
        nonce: await steth.nonces(vaultOwner),
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await stethDomain(steth), permit, vaultOwner);
      const { deadline, value } = permit;
      const { v, r, s } = signature;

      const balanceBefore = await steth.balanceOf(vaultOwner);
      const result = await dashboard.connect(vaultOwner).burnStETHWithPermit(amountSteth, {
        value,
        deadline,
        v,
        r,
        s,
      });

      await expect(result).to.emit(steth, "Approval").withArgs(vaultOwner, dashboard, amountSteth); // approve steth from vault owner to dashboard
      await expect(result).to.emit(steth, "Transfer").withArgs(vaultOwner, hub, amountSteth); // transfer steth to hub
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, amountSteth, amountSteth, amountShares); // burn steth

      expect(await steth.balanceOf(vaultOwner)).to.equal(balanceBefore - amountSteth);
    });

    it("succeeds if has allowance", async () => {
      const permit = {
        owner: vaultOwner.address,
        spender: stranger.address, // invalid spender
        value: amountSteth,
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

      await expect(
        dashboard.connect(vaultOwner).burnStETHWithPermit(amountSteth, permitData),
      ).to.be.revertedWithCustomError(dashboard, "InvalidPermit");

      await steth.connect(vaultOwner).approve(dashboard, amountSteth);

      const balanceBefore = await steth.balanceOf(vaultOwner);
      const result = await dashboard.connect(vaultOwner).burnStETHWithPermit(amountSteth, permitData);

      await expect(result).to.emit(steth, "Transfer").withArgs(vaultOwner, hub, amountSteth); // transfer steth to hub
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, amountSteth, amountSteth, amountShares); // burn steth

      expect(await steth.balanceOf(vaultOwner)).to.equal(balanceBefore - amountSteth);
    });

    it("succeeds with rebalanced shares - 1 share = 0.5 steth", async () => {
      await steth.mock__setTotalShares(ether("1000000"));
      await steth.mock__setTotalPooledEther(ether("500000"));
      const sharesToBurn = ether("1");
      const stethToBurn = sharesToBurn / 2n; // 1 share = 0.5 steth

      const permit = {
        owner: vaultOwner.address,
        spender: dashboardAddress,
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
      const result = await dashboard.connect(vaultOwner).burnStETHWithPermit(stethToBurn, permitData);

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
        spender: dashboardAddress,
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
      const result = await dashboard.connect(vaultOwner).burnStETHWithPermit(stethToBurn, permitData);

      await expect(result).to.emit(steth, "Transfer").withArgs(vaultOwner, hub, stethToBurn); // transfer steth to hub
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, stethToBurn, stethToBurn, sharesToBurn); // burn steth

      expect(await steth.balanceOf(vaultOwner)).to.equal(balanceBefore - stethToBurn);
    });
  });

  context("burnWstETHWithPermit", () => {
    const amountShares = ether("1");
    let amountSteth: bigint;

    beforeEach(async () => {
      amountSteth = await steth.getPooledEthBySharesRoundUp(amountShares);
      // mint steth to the vault owner for the burn
      await dashboard.mintShares(vaultOwner, amountShares);
      // approve for wsteth wrap
      await steth.connect(vaultOwner).approve(wsteth, amountSteth);
      // wrap steth to wsteth to get the amount of wsteth for the burn
      await wsteth.connect(vaultOwner).wrap(amountSteth);
    });

    it("reverts if called by a non-admin", async () => {
      await dashboard.mintShares(stranger, amountShares + 100n);
      await steth.connect(stranger).approve(wsteth, amountSteth + 100n);
      await wsteth.connect(stranger).wrap(amountSteth + 100n);

      const permit = {
        owner: stranger.address,
        spender: dashboardAddress,
        value: amountShares,
        nonce: await wsteth.nonces(stranger),
        deadline: BigInt(await time.latest()) + days(1n),
      };

      const signature = await signPermit(await wstethDomain(wsteth), permit, stranger);
      const { deadline, value } = permit;
      const { v, r, s } = signature;

      await expect(
        dashboard.connect(stranger).burnWstETHWithPermit(amountShares, {
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
        owner: vaultOwner.address,
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
      ).to.be.revertedWithCustomError(dashboard, "InvalidPermit");
    });

    it("burns wstETH with permit", async () => {
      const permit = {
        owner: vaultOwner.address,
        spender: dashboardAddress,
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
      await expect(result).to.emit(steth, "Transfer").withArgs(wsteth, dashboard, amountSteth); // uwrap wsteth to steth
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, amountSteth, amountSteth, amountShares); // burn steth

      expect(await steth.balanceOf(vaultOwner)).to.equal(stethBalanceBefore);
      expect(await wsteth.balanceOf(vaultOwner)).to.equal(wstethBalanceBefore - amountShares);
    });

    it("succeeds if has allowance", async () => {
      const permit = {
        owner: vaultOwner.address,
        spender: dashboardAddress, // invalid spender
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

      await expect(
        dashboard.connect(vaultOwner).burnWstETHWithPermit(amountShares, permitData),
      ).to.be.revertedWithCustomError(dashboard, "InvalidPermit");

      await wsteth.connect(vaultOwner).approve(dashboard, amountShares);

      const wstethBalanceBefore = await wsteth.balanceOf(vaultOwner);
      const stethBalanceBefore = await steth.balanceOf(vaultOwner);
      const result = await dashboard.connect(vaultOwner).burnWstETHWithPermit(amountShares, permitData);

      await expect(result).to.emit(wsteth, "Transfer").withArgs(vaultOwner, dashboard, amountShares); // transfer steth to dashboard
      await expect(result).to.emit(steth, "Transfer").withArgs(wsteth, dashboard, amountSteth); // uwrap wsteth to steth
      await expect(result).to.emit(steth, "SharesBurnt").withArgs(hub, amountSteth, amountSteth, amountShares); // burn steth

      expect(await steth.balanceOf(vaultOwner)).to.equal(stethBalanceBefore);
      expect(await wsteth.balanceOf(vaultOwner)).to.equal(wstethBalanceBefore - amountShares);
    });

    it("succeeds with rebalanced shares - 1 share = 0.5 stETH", async () => {
      await steth.mock__setTotalShares(ether("1000000"));
      await steth.mock__setTotalPooledEther(ether("500000"));
      const sharesToBurn = ether("1");
      const stethToBurn = sharesToBurn / 2n; // 1 share = 0.5 steth

      const permit = {
        owner: vaultOwner.address,
        spender: dashboardAddress,
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
        owner: vaultOwner.address,
        spender: dashboardAddress,
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

  context("recover", async () => {
    const amount = ether("1");

    before(async () => {
      const wethContract = weth.connect(vaultOwner);

      await wethContract.deposit({ value: amount });

      await vaultOwner.sendTransaction({ to: dashboardAddress, value: amount });
      await wethContract.transfer(dashboardAddress, amount);
      await erc721.mint(dashboardAddress, 0);

      expect(await ethers.provider.getBalance(dashboardAddress)).to.equal(amount);
      expect(await wethContract.balanceOf(dashboardAddress)).to.equal(amount);
      expect(await erc721.ownerOf(0)).to.equal(dashboardAddress);
    });

    it("allows only admin to recover", async () => {
      await expect(dashboard.connect(stranger).recoverERC20(ZeroAddress, vaultOwner, 1n)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
      await expect(
        dashboard.connect(stranger).recoverERC721(erc721.getAddress(), 0, vaultOwner),
      ).to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount");
    });

    it("does not allow zero token address for erc20 recovery", async () => {
      await expect(dashboard.recoverERC20(ZeroAddress, vaultOwner, 1n)).to.be.revertedWithCustomError(
        dashboard,
        "ZeroArgument",
      );
      await expect(dashboard.recoverERC20(weth, ZeroAddress, 1n)).to.be.revertedWithCustomError(
        dashboard,
        "ZeroArgument",
      );
      await expect(dashboard.recoverERC20(weth, vaultOwner, 0n)).to.be.revertedWithCustomError(
        dashboard,
        "ZeroArgument",
      );
    });

    it("recovers all ether", async () => {
      const ethStub = await dashboard.ETH();
      const preBalance = await ethers.provider.getBalance(vaultOwner);
      const tx = await dashboard.recoverERC20(ethStub, vaultOwner, amount);
      const { gasUsed, gasPrice } = (await ethers.provider.getTransactionReceipt(tx.hash))!;

      await expect(tx).to.emit(dashboard, "ERC20Recovered").withArgs(tx.from, ethStub, amount);
      expect(await ethers.provider.getBalance(dashboardAddress)).to.equal(0);
      expect(await ethers.provider.getBalance(vaultOwner)).to.equal(preBalance + amount - gasUsed * gasPrice);
    });

    it("recovers all weth", async () => {
      const preBalance = await weth.balanceOf(vaultOwner);
      const tx = await dashboard.recoverERC20(weth.getAddress(), vaultOwner, amount);

      await expect(tx)
        .to.emit(dashboard, "ERC20Recovered")
        .withArgs(tx.from, await weth.getAddress(), amount);
      expect(await weth.balanceOf(dashboardAddress)).to.equal(0);
      expect(await weth.balanceOf(vaultOwner)).to.equal(preBalance + amount);
    });

    it("does not allow zero token address for erc721 recovery", async () => {
      await expect(dashboard.recoverERC721(ZeroAddress, 0, vaultOwner)).to.be.revertedWithCustomError(
        dashboard,
        "ZeroArgument",
      );
    });

    it("recovers erc721", async () => {
      const tx = await dashboard.recoverERC721(erc721.getAddress(), 0, vaultOwner);

      await expect(tx)
        .to.emit(dashboard, "ERC721Recovered")
        .withArgs(tx.from, await erc721.getAddress(), 0);

      expect(await erc721.ownerOf(0)).to.equal(vaultOwner.address);
    });
  });

  context("fallback behavior", () => {
    const amount = ether("1");

    it("does not allow fallback behavior", async () => {
      const tx = vaultOwner.sendTransaction({ to: dashboardAddress, data: "0x111111111111", value: amount });
      await expect(tx).to.be.revertedWithoutReason();
    });

    it("allows ether to be recieved", async () => {
      const preBalance = await weth.balanceOf(dashboardAddress);
      await vaultOwner.sendTransaction({ to: dashboardAddress, value: amount });
      expect(await ethers.provider.getBalance(dashboardAddress)).to.equal(amount + preBalance);
    });
  });

  context("pauseBeaconChainDeposits", () => {
    it("reverts if the caller is not a curator", async () => {
      await expect(dashboard.connect(stranger).pauseBeaconChainDeposits()).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if the beacon deposits are already paused", async () => {
      await dashboard.pauseBeaconChainDeposits();

      await expect(dashboard.pauseBeaconChainDeposits()).to.be.revertedWithCustomError(
        vault,
        "BeaconChainDepositsResumeExpected",
      );
    });

    it("pauses the beacon deposits", async () => {
      await expect(dashboard.pauseBeaconChainDeposits()).to.emit(vault, "BeaconChainDepositsPaused");
      expect(await vault.beaconChainDepositsPaused()).to.be.true;
    });
  });

  context("resumeBeaconChainDeposits", () => {
    it("reverts if the caller is not a curator", async () => {
      await expect(dashboard.connect(stranger).resumeBeaconChainDeposits()).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if the beacon deposits are already resumed", async () => {
      await expect(dashboard.resumeBeaconChainDeposits()).to.be.revertedWithCustomError(
        vault,
        "BeaconChainDepositsPauseExpected",
      );
    });

    it("resumes the beacon deposits", async () => {
      await dashboard.pauseBeaconChainDeposits();

      await expect(dashboard.resumeBeaconChainDeposits()).to.emit(vault, "BeaconChainDepositsResumed");
      expect(await vault.beaconChainDepositsPaused()).to.be.false;
    });
  });

  context("role management", () => {
    let assignments: Dashboard.RoleAssignmentStruct[];

    beforeEach(async () => {
      assignments = [
        { role: await dashboard.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(), account: vaultOwner.address },
        { role: await dashboard.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(), account: vaultOwner.address },
      ];
    });

    context("grantRoles", () => {
      it("reverts when assignments array is empty", async () => {
        await expect(dashboard.grantRoles([])).to.be.revertedWithCustomError(dashboard, "ZeroArgument");
      });

      it("grants roles to multiple accounts", async () => {
        await dashboard.grantRoles(assignments);

        for (const assignment of assignments) {
          expect(await dashboard.hasRole(assignment.role, assignment.account)).to.be.true;
        }
      });
    });

    context("revokeRoles", () => {
      beforeEach(async () => {
        await dashboard.grantRoles(assignments);
      });

      it("reverts when assignments array is empty", async () => {
        await expect(dashboard.revokeRoles([])).to.be.revertedWithCustomError(dashboard, "ZeroArgument");
      });

      it("revokes roles from multiple accounts", async () => {
        await dashboard.revokeRoles(assignments);

        for (const assignment of assignments) {
          expect(await dashboard.hasRole(assignment.role, assignment.account)).to.be.false;
        }
      });
    });
  });
});
