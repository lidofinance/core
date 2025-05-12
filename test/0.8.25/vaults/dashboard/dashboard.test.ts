import { expect } from "chai";
import { MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Dashboard,
  DepositContract__MockForStakingVault,
  ERC721__MockForDashboard,
  LidoLocator,
  Permissions,
  PredepositGuarantee__MockForDashboard,
  StakingVault,
  StETHPermit__HarnessForDashboard,
  UpgradeableBeacon,
  VaultFactory,
  VaultHub__MockForDashboard,
  WETH9__MockForVault,
  WstETH__HarnessForVault,
} from "typechain-types";

import {
  certainAddress,
  days,
  deployEIP7002WithdrawalRequestContract,
  EIP7002_MIN_WITHDRAWAL_REQUEST_FEE,
  ether,
  findEvents,
  getCurrentBlockTimestamp,
  impersonate,
  randomValidatorPubkey,
} from "lib";
import { reportVaultWithMockedVaultHub, reportVaultWithoutProof } from "lib/protocol/helpers/vaults";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

const VAULT_CONNECTION_DEPOSIT = ether("1");

describe("Dashboard.sol", () => {
  let deployer: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let hubSigner: HardhatEthersSigner;

  let steth: StETHPermit__HarnessForDashboard;
  let weth: WETH9__MockForVault;
  let erc721: ERC721__MockForDashboard;
  let wsteth: WstETH__HarnessForVault;
  let hub: VaultHub__MockForDashboard;
  let depositContract: DepositContract__MockForStakingVault;
  let vaultImpl: StakingVault;
  let dashboardImpl: Dashboard;
  let factory: VaultFactory;
  let pdg: PredepositGuarantee__MockForDashboard;
  let lidoLocator: LidoLocator;

  let vault: StakingVault;
  let beacon: UpgradeableBeacon;
  let vaultAddress: string;
  let dashboard: Dashboard;
  let dashboardAddress: string;

  const nodeOperatorFeeBP = 0n;
  const confirmExpiry = days(7n);

  let originalState: string;

  const BP_BASE = 10_000n;

  before(async () => {
    [deployer, vaultOwner, nodeOperator, stranger] = await ethers.getSigners();

    await deployEIP7002WithdrawalRequestContract(EIP7002_MIN_WITHDRAWAL_REQUEST_FEE);

    weth = await ethers.deployContract("WETH9__MockForVault");

    steth = await ethers.deployContract("StETHPermit__HarnessForDashboard");
    await steth.mock__setTotalShares(ether("1000000"));
    await steth.mock__setTotalPooledEther(ether("1400000"));

    pdg = await ethers.deployContract("PredepositGuarantee__MockForDashboard");
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);
    lidoLocator = await deployLidoLocator({ lido: steth, wstETH: wsteth, predepositGuarantee: pdg });

    hub = await ethers.deployContract("VaultHub__MockForDashboard", [steth, lidoLocator]);
    hubSigner = await impersonate(await hub.getAddress(), ether("1000"));
    erc721 = await ethers.deployContract("ERC721__MockForDashboard");

    depositContract = await ethers.deployContract("DepositContract__MockForStakingVault");

    vaultImpl = await ethers.deployContract("StakingVault", [hub, depositContract]);

    beacon = await ethers.deployContract("UpgradeableBeacon", [vaultImpl, deployer]);

    dashboardImpl = await ethers.deployContract("Dashboard", [steth, wsteth, hub]);
    expect(await dashboardImpl.STETH()).to.equal(steth);
    expect(await dashboardImpl.WSTETH()).to.equal(wsteth);

    factory = await ethers.deployContract("VaultFactory", [lidoLocator, beacon, dashboardImpl]);

    expect(await factory.LIDO_LOCATOR()).to.equal(lidoLocator);
    expect(await factory.BEACON()).to.equal(beacon);
    expect(await factory.DASHBOARD_IMPL()).to.equal(dashboardImpl);

    const createVaultTx = await factory
      .connect(vaultOwner)
      .createVaultWithDashboard(vaultOwner, nodeOperator, nodeOperator, nodeOperatorFeeBP, confirmExpiry, [], "0x", {
        value: VAULT_CONNECTION_DEPOSIT,
      });
    const createVaultReceipt = await createVaultTx.wait();
    if (!createVaultReceipt) throw new Error("Vault creation receipt not found");

    const vaultCreatedEvents = findEvents(createVaultReceipt, "VaultCreated");
    expect(vaultCreatedEvents.length).to.equal(1);

    vaultAddress = vaultCreatedEvents[0].args.vault;
    vault = await ethers.getContractAt("StakingVault", vaultAddress, vaultOwner);
    expect(await vault.vaultHub()).to.equal(hub);

    const dashboardCreatedEvents = findEvents(createVaultReceipt, "DashboardCreated");
    expect(dashboardCreatedEvents.length).to.equal(1);

    dashboardAddress = dashboardCreatedEvents[0].args.dashboard;
    dashboard = await ethers.getContractAt("Dashboard", dashboardAddress, vaultOwner);
    expect(await dashboard.stakingVault()).to.equal(vault);

    const defaultAdminRoles = await Promise.all([
      dashboard.FUND_ROLE(),
      dashboard.WITHDRAW_ROLE(),
      dashboard.LOCK_ROLE(),
      dashboard.MINT_ROLE(),
      dashboard.BURN_ROLE(),
      dashboard.REBALANCE_ROLE(),
      dashboard.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(),
      dashboard.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(),
      dashboard.REQUEST_VALIDATOR_EXIT_ROLE(),
      dashboard.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(),
      dashboard.VOLUNTARY_DISCONNECT_ROLE(),
      dashboard.PDG_COMPENSATE_PREDEPOSIT_ROLE(),
      dashboard.PDG_PROVE_VALIDATOR_ROLE(),
      dashboard.UNGUARANTEED_BEACON_CHAIN_DEPOSIT_ROLE(),
      dashboard.OSSIFY_ROLE(),
      dashboard.LIDO_VAULTHUB_DEAUTHORIZATION_ROLE(),
      dashboard.LIDO_VAULTHUB_AUTHORIZATION_ROLE(),
      dashboard.SET_DEPOSITOR_ROLE(),
      dashboard.RESET_LOCKED_ROLE(),
      dashboard.RECOVER_ASSETS_ROLE(),
    ]);

    await Promise.all(defaultAdminRoles.map((role) => dashboard.connect(vaultOwner).grantRole(role, vaultOwner)));

    //reset locked and inOutDelta
    await dashboard.deauthorizeLidoVaultHub();
    await expect(dashboard.resetLocked()).to.emit(vault, "LockedReset");
    await expect(dashboard.withdraw(vaultOwner, ether("1"))).to.emit(vault, "Withdrawn");

    expect(await vault.locked()).to.equal(0n);
    expect(await vault.inOutDelta()).to.equal(0n);

    await dashboard.authorizeLidoVaultHub();

    originalState = await Snapshot.take();
  });

  it("hello", async () => {
    expect("hello").to.equal("hello");
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("reverts if steth is zero address", async () => {
      await expect(ethers.deployContract("Dashboard", [ethers.ZeroAddress, wsteth, hub]))
        .to.be.revertedWithCustomError(dashboard, "ZeroArgument")
        .withArgs("_stETH");
    });

    it("reverts if wsteth is zero address", async () => {
      await expect(ethers.deployContract("Dashboard", [steth, ethers.ZeroAddress, hub]))
        .to.be.revertedWithCustomError(dashboard, "ZeroArgument")
        .withArgs("_wstETH");
    });

    it("reverts if vaultHub is zero address", async () => {
      await expect(ethers.deployContract("Dashboard", [steth, wsteth, ethers.ZeroAddress]))
        .to.be.revertedWithCustomError(dashboard, "ZeroArgument")
        .withArgs("_vaultHub");
    });

    it("sets the stETH, wETH, and wstETH addresses", async () => {
      const dashboard_ = await ethers.deployContract("Dashboard", [steth, wsteth, hub]);
      expect(await dashboard_.STETH()).to.equal(steth);
      expect(await dashboard_.WSTETH()).to.equal(wsteth);
      expect(await dashboard_.VAULT_HUB()).to.equal(hub);
    });
  });

  context("initialize", () => {
    it("reverts if already initialized", async () => {
      await expect(
        dashboard.initialize(vaultOwner, nodeOperator, nodeOperatorFeeBP, confirmExpiry),
      ).to.be.revertedWithCustomError(dashboard, "AlreadyInitialized");
    });

    it("reverts if called on the implementation", async () => {
      const dashboard_ = await ethers.deployContract("Dashboard", [steth, wsteth, hub]);

      await expect(
        dashboard_.initialize(vaultOwner, nodeOperator, nodeOperatorFeeBP, confirmExpiry),
      ).to.be.revertedWithCustomError(dashboard_, "NonProxyCallsForbidden");
    });
  });

  context("confirmingRoles", () => {
    it("returns the array of roles", async () => {
      const confirmingRoles = await dashboard.confirmingRoles();
      expect(confirmingRoles).to.deep.equal([
        await dashboard.DEFAULT_ADMIN_ROLE(),
        await dashboard.NODE_OPERATOR_MANAGER_ROLE(),
      ]);
    });
  });

  context("initialized state", () => {
    it("post-initialization state is correct", async () => {
      // vault state
      expect(await vault.owner()).to.equal(dashboard);
      expect(await vault.nodeOperator()).to.equal(nodeOperator);
      expect(await dashboard.initialized()).to.equal(true);
      expect(await dashboard.stakingVault()).to.equal(vault);
      expect(await dashboard.VAULT_HUB()).to.equal(hub);
      expect(await dashboard.STETH()).to.equal(steth);
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
        liabilityShares: 555n,
        shareLimit: 1000n,
        reserveRatioBP: 1000n,
        forcedRebalanceThresholdBP: 800n,
        treasuryFeeBP: 500n,
        pendingDisconnect: false,
        feeSharesCharged: 3000n,
      };

      await hub.mock__setVaultSocket(vault, sockets);

      expect(await dashboard.vaultSocket()).to.deep.equal(Object.values(sockets));
      expect(await dashboard.shareLimit()).to.equal(sockets.shareLimit);
      expect(await dashboard.liabilityShares()).to.equal(sockets.liabilityShares);
      expect(await dashboard.reserveRatioBP()).to.equal(sockets.reserveRatioBP);
      expect(await dashboard.forcedRebalanceThresholdBP()).to.equal(sockets.forcedRebalanceThresholdBP);
      expect(await dashboard.treasuryFeeBP()).to.equal(sockets.treasuryFeeBP);
    });

    it("totalValue", async () => {
      const totalValue = await dashboard.totalValue();
      expect(totalValue).to.equal(await vault.totalValue());
    });
  });

  context("totalMintingCapacity", () => {
    it("returns the trivial max mintable shares", async () => {
      const maxShares = await dashboard.totalMintingCapacity();

      expect(maxShares).to.equal(0n);
    });

    it("returns correct max mintable shares when not bound by shareLimit", async () => {
      const sockets = {
        vault: vaultAddress,
        shareLimit: 1000000000n,
        liabilityShares: 555n,
        reserveRatioBP: 1000n,
        forcedRebalanceThresholdBP: 800n,
        treasuryFeeBP: 500n,
        pendingDisconnect: false,
        feeSharesCharged: 3000n,
      };

      await hub.mock__setVaultSocket(vault, sockets);

      // await dashboard.connect(vaultOwner).fund({ value: 1000n });

      const maxMintableShares = await dashboard.totalMintingCapacity();
      const maxStETHMinted = ((await vault.totalValue()) * (BP_BASE - sockets.reserveRatioBP)) / BP_BASE;
      const maxSharesMinted = await steth.getSharesByPooledEth(maxStETHMinted);

      expect(maxMintableShares).to.equal(maxSharesMinted);
    });

    it("returns correct max mintable shares when bound by shareLimit", async () => {
      const sockets = {
        vault: vaultAddress,
        shareLimit: 100n,
        liabilityShares: 0n,
        reserveRatioBP: 1000n,
        forcedRebalanceThresholdBP: 800n,
        treasuryFeeBP: 500n,
        pendingDisconnect: false,
        feeSharesCharged: 3000n,
      };

      await hub.mock__setVaultSocket(vault, sockets);

      await dashboard.connect(vaultOwner).fund({ value: 1000n });

      const availableMintableShares = await dashboard.totalMintingCapacity();

      expect(availableMintableShares).to.equal(sockets.shareLimit);
    });

    it("returns zero when reserve ratio is does not allow mint", async () => {
      const sockets = {
        vault: vaultAddress,
        shareLimit: 1000000000n,
        liabilityShares: 555n,
        reserveRatioBP: 10_000n,
        forcedRebalanceThresholdBP: 800n,
        treasuryFeeBP: 500n,
        pendingDisconnect: false,
        feeSharesCharged: 3000n,
      };

      await hub.mock__setVaultSocket(vault, sockets);

      await dashboard.connect(vaultOwner).fund({ value: 1000n });

      const availableMintableShares = await dashboard.totalMintingCapacity();

      expect(availableMintableShares).to.equal(0n);
    });

    it("returns funded amount when reserve ratio is zero", async () => {
      const sockets = {
        vault: vaultAddress,
        shareLimit: 10000000n,
        liabilityShares: 555n,
        reserveRatioBP: 0n,
        forcedRebalanceThresholdBP: 0n,
        treasuryFeeBP: 500n,
        pendingDisconnect: false,
        feeSharesCharged: 3000n,
      };

      await hub.mock__setVaultSocket(vault, sockets);
      const funding = 1000n;
      await dashboard.connect(vaultOwner).fund({ value: funding });

      const availableMintableShares = await dashboard.totalMintingCapacity();

      const toShares = await steth.getSharesByPooledEth(funding);
      expect(availableMintableShares).to.equal(toShares);
    });
  });

  context("remainingMintingCapacity", () => {
    it("returns trivial can mint shares", async () => {
      const canMint = await dashboard.remainingMintingCapacity(0n);
      expect(canMint).to.equal(0n);
    });

    it("can mint all available shares", async () => {
      const sockets = {
        vault: vaultAddress,
        shareLimit: 10000000n,
        liabilityShares: 0n,
        reserveRatioBP: 1000n,
        forcedRebalanceThresholdBP: 800n,
        treasuryFeeBP: 500n,
        pendingDisconnect: false,
        feeSharesCharged: 3000n,
      };

      await hub.mock__setVaultSocket(vault, sockets);

      const funding = 1000n;

      const preFundCanMint = await dashboard.remainingMintingCapacity(funding);

      await dashboard.connect(vaultOwner).fund({ value: funding });

      const availableMintableShares = await dashboard.totalMintingCapacity();

      const canMint = await dashboard.remainingMintingCapacity(0n);
      expect(canMint).to.equal(availableMintableShares);
      expect(canMint).to.equal(preFundCanMint);
    });

    it("cannot mint shares", async () => {
      const sockets = {
        vault: vaultAddress,
        shareLimit: 10000000n,
        liabilityShares: 900n,
        reserveRatioBP: 1000n,
        forcedRebalanceThresholdBP: 800n,
        treasuryFeeBP: 500n,
        pendingDisconnect: false,
        feeSharesCharged: 3000n,
      };

      await hub.mock__setVaultSocket(vault, sockets);
      const funding = 1000n;

      const preFundCanMint = await dashboard.remainingMintingCapacity(funding);

      await dashboard.connect(vaultOwner).fund({ value: funding });

      const canMint = await dashboard.remainingMintingCapacity(0n);
      expect(canMint).to.equal(0n); // 1000 - 10% - 900 = 0
      expect(canMint).to.equal(preFundCanMint);
    });

    it("cannot mint shares when over limit", async () => {
      const sockets = {
        vault: vaultAddress,
        shareLimit: 10000000n,
        liabilityShares: 10000n,
        reserveRatioBP: 1000n,
        forcedRebalanceThresholdBP: 800n,
        treasuryFeeBP: 500n,
        pendingDisconnect: false,
        feeSharesCharged: 3000n,
      };

      await hub.mock__setVaultSocket(vault, sockets);
      const funding = 1000n;

      const preFundCanMint = await dashboard.remainingMintingCapacity(funding);

      await dashboard.connect(vaultOwner).fund({ value: funding });

      const canMint = await dashboard.remainingMintingCapacity(0n);
      expect(canMint).to.equal(0n);
      expect(canMint).to.equal(preFundCanMint);
    });

    it("can mint to full ratio", async () => {
      const sockets = {
        vault: vaultAddress,
        shareLimit: 10000000n,
        liabilityShares: 500n,
        reserveRatioBP: 1000n,
        forcedRebalanceThresholdBP: 800n,
        treasuryFeeBP: 500n,
        pendingDisconnect: false,
        feeSharesCharged: 3000n,
      };

      await hub.mock__setVaultSocket(vault, sockets);
      const funding = 2000n;

      const preFundCanMint = await dashboard.remainingMintingCapacity(funding);
      await dashboard.connect(vaultOwner).fund({ value: funding });

      const sharesFunded = await steth.getSharesByPooledEth((funding * (BP_BASE - sockets.reserveRatioBP)) / BP_BASE);

      const canMint = await dashboard.remainingMintingCapacity(0n);
      expect(canMint).to.equal(sharesFunded - sockets.liabilityShares);
      expect(canMint).to.equal(preFundCanMint);
    });

    it("can not mint when bound by share limit", async () => {
      const sockets = {
        vault: vaultAddress,
        shareLimit: 500n,
        liabilityShares: 500n,
        reserveRatioBP: 1000n,
        forcedRebalanceThresholdBP: 800n,
        treasuryFeeBP: 500n,
        pendingDisconnect: false,
        feeSharesCharged: 3000n,
      };

      await hub.mock__setVaultSocket(vault, sockets);
      const funding = 2000n;
      const preFundCanMint = await dashboard.remainingMintingCapacity(funding);
      await dashboard.connect(vaultOwner).fund({ value: funding });

      const canMint = await dashboard.remainingMintingCapacity(0n);
      expect(canMint).to.equal(0n);
      expect(canMint).to.equal(preFundCanMint);
    });
  });

  context("unreserved", () => {
    it("initially returns 0", async () => {
      expect(await dashboard.unreserved()).to.equal(0n);
    });

    it("returns 0 if locked is greater than total value", async () => {
      const totalValue = ether("2");
      const inOutDelta = ether("2");

      await vault.connect(hubSigner).report(await getCurrentBlockTimestamp(), totalValue, inOutDelta, totalValue + 1n);

      expect(await dashboard.unreserved()).to.equal(0n);
    });
  });

  context("withdrawableEther", () => {
    it("returns the trivial amount can withdraw ether", async () => {
      const withdrawableEther = await dashboard.withdrawableEther();
      expect(withdrawableEther).to.equal(0n);
    });

    it("funds and returns the correct can withdraw ether", async () => {
      const amount = ether("1");

      await dashboard.connect(vaultOwner).fund({ value: amount });

      const withdrawableEther = await dashboard.withdrawableEther();
      expect(withdrawableEther).to.equal(amount);
    });

    it("funds and recieves external but and can only withdraw unlocked", async () => {
      const amount = ether("1");
      await dashboard.connect(vaultOwner).fund({ value: amount });
      await vaultOwner.sendTransaction({ to: vault.getAddress(), value: amount });
      expect(await dashboard.withdrawableEther()).to.equal(amount);
    });

    it("funds and get all ether locked and can not withdraw", async () => {
      const amount = ether("1");
      await dashboard.connect(vaultOwner).fund({ value: amount });

      await reportVaultWithoutProof(vault);
      await dashboard.connect(vaultOwner).lock(amount);

      expect(await dashboard.withdrawableEther()).to.equal(0n);
    });

    it("funds and get all ether locked and can not withdraw", async () => {
      const amount = ether("1");
      await dashboard.connect(vaultOwner).fund({ value: amount });

      await dashboard.connect(vaultOwner).lock(amount);

      expect(await dashboard.withdrawableEther()).to.equal(0n);
    });

    it("funds and get all half locked and can only half withdraw", async () => {
      const fundAmount = ether("1");
      await dashboard.connect(vaultOwner).fund({ value: fundAmount });

      const lockAmount = fundAmount / 2n;
      await dashboard.connect(vaultOwner).lock(lockAmount);

      expect(await dashboard.withdrawableEther()).to.equal(fundAmount - lockAmount);
    });

    it("funds and get all half locked, but no balance and can not withdraw", async () => {
      const amount = ether("1");
      await dashboard.connect(vaultOwner).fund({ value: amount });

      const lockAmount = amount / 2n;
      await dashboard.connect(vaultOwner).lock(lockAmount);

      await setBalance(await vault.getAddress(), 0n);

      expect(await dashboard.withdrawableEther()).to.equal(0n);
    });

    // TODO: add more tests when the vault params are change
  });

  context("transferStVaultOwnership", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).transferStakingVaultOwnership(vaultOwner)).to.be.revertedWithCustomError(
        dashboard,
        "SenderNotMember",
      );
    });

    it("assigns a new owner to the staking vault", async () => {
      const newOwner = certainAddress("dashboard:test:new-owner");
      await dashboard.connect(nodeOperator).transferStakingVaultOwnership(newOwner);
      // owner is still dashboard
      expect(await vault.owner()).to.equal(dashboard);

      await expect(dashboard.connect(vaultOwner).transferStakingVaultOwnership(newOwner))
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

    it("disconnects the staking vault from the vault hub", async () => {
      await dashboard.connect(vaultOwner).grantRole(await dashboard.VOLUNTARY_DISCONNECT_ROLE(), vaultOwner);
      await expect(dashboard.voluntaryDisconnect()).to.emit(hub, "Mock__VaultDisconnectInitiated").withArgs(vault);
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
      await expect(dashboard.connect(vaultOwner).fund({ value: amount }))
        .to.emit(vault, "Funded")
        .withArgs(dashboard, amount);
      expect(await ethers.provider.getBalance(vault)).to.equal(previousBalance + amount);
    });
  });

  context("withdraw", () => {
    it("reverts if called by a non-admin", async () => {
      await dashboard.connect(vaultOwner).fund({ value: ether("1") });

      await expect(dashboard.connect(stranger).withdraw(vaultOwner, ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("withdraws ether from the staking vault", async () => {
      const amount = ether("1");
      await dashboard.connect(vaultOwner).fund({ value: amount });
      const recipient = certainAddress("dashboard:test:recipient");
      const previousBalance = await ethers.provider.getBalance(recipient);
      const stakingVaultContract = await ethers.getContractAt("StakingVault", await dashboard.stakingVault());
      await reportVaultWithoutProof(stakingVaultContract);

      await expect(dashboard.connect(vaultOwner).withdraw(recipient, amount))
        .to.emit(vault, "Withdrawn")
        .withArgs(dashboard, recipient, amount);
      expect(await ethers.provider.getBalance(recipient)).to.equal(previousBalance + amount);
    });
  });

  context("lock", () => {
    it("increases the locked amount", async () => {
      expect(await vault.locked()).to.equal(0n);

      await dashboard.fund({ value: ether("1") });
      await dashboard.lock(ether("1"));
      expect(await vault.locked()).to.equal(ether("1"));
    });

    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).lock(ether("1"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  context("mintShares", () => {
    const amountShares = ether("1");
    const amountFunded = ether("2");
    let amountSteth: bigint;

    beforeEach(async () => {
      amountSteth = await steth.getPooledEthByShares(amountShares);
      await dashboard.fund({ value: amountSteth });
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

    beforeEach(async () => {
      amountSteth = await steth.getPooledEthByShares(amountShares);
      await dashboard.fund({ value: amountSteth });
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

    beforeEach(async () => {
      amountSteth = await steth.getPooledEthByShares(amountWsteth);
      await dashboard.fund({ value: amountSteth });
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
      await dashboard.fund({ value: amountSteth });
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
      await dashboard.fund({ value: amountSteth });
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

    beforeEach(async () => {
      // mint shares to the vault owner for the burn
      const amountSteth = await steth.getPooledEthByShares(amountWsteth);
      await dashboard.fund({ value: amountSteth });
      await dashboard.mintShares(vaultOwner, amountWsteth);
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

      const wstethContract = wsteth.connect(vaultOwner);

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

  context("compensateDisprovenPredepositFromPDG", () => {
    let pdgWithdrawalSigner: HardhatEthersSigner;

    beforeEach(async () => {
      pdgWithdrawalSigner = await impersonate(certainAddress("pdg-withdrawal-signer"), ether("1"));
      await dashboard.grantRole(await dashboard.PDG_COMPENSATE_PREDEPOSIT_ROLE(), pdgWithdrawalSigner);
    });

    it("reverts if called not by a PDG_COMPENSATE_PREDEPOSIT_ROLE", async () => {
      await expect(
        dashboard.connect(stranger).compensateDisprovenPredepositFromPDG(new Uint8Array(), vaultOwner),
      ).to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount");
    });

    it("calls the PDG contract to compensate the disproven predeposit", async () => {
      const pubkey = new Uint8Array(32);
      pubkey[0] = 1;

      await expect(
        dashboard.connect(pdgWithdrawalSigner).compensateDisprovenPredepositFromPDG(pubkey, pdgWithdrawalSigner),
      )
        .to.emit(pdg, "Mock__CompensatedDisprovenPredeposit")
        .withArgs(pubkey, pdgWithdrawalSigner);
    });
  });

  context("recover", async () => {
    const amount = ether("1");

    beforeEach(async () => {
      const wethContract = weth.connect(vaultOwner);
      await wethContract.deposit({ value: amount });
      await wethContract.transfer(dashboardAddress, amount);
      await erc721.mint(dashboardAddress, 0);
      await dashboard.grantRole(await dashboard.RECOVER_ASSETS_ROLE(), vaultOwner);

      expect(await wethContract.balanceOf(dashboardAddress)).to.equal(amount);
      expect(await erc721.ownerOf(0)).to.equal(dashboardAddress);
    });

    it("allows only RECOVER_ASSETS_ROLE to recover", async () => {
      await expect(dashboard.connect(stranger).recoverERC20(ZeroAddress, vaultOwner, 1n)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
      await expect(
        dashboard.connect(stranger).recoverERC721(erc721.getAddress(), 0, vaultOwner),
      ).to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount");
    });

    it("does not allow zero arguments for erc20 recovery", async () => {
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

    it("does not allow zero arguments for erc721 recovery", async () => {
      await expect(dashboard.recoverERC721(ZeroAddress, 0n, ZeroAddress))
        .to.be.revertedWithCustomError(dashboard, "ZeroArgument")
        .withArgs("_token");

      await expect(dashboard.recoverERC721(erc721.getAddress(), 0n, ZeroAddress))
        .to.be.revertedWithCustomError(dashboard, "ZeroArgument")
        .withArgs("_recipient");
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

    it("receive funds the vault", async () => {
      const vaultBalanceBefore = await ethers.provider.getBalance(vault);
      await vaultOwner.sendTransaction({ to: dashboardAddress, value: amount });
      expect(await ethers.provider.getBalance(vault)).to.equal(amount + vaultBalanceBefore);
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

  context("requestValidatorExit", () => {
    const pubkeys = ["01".repeat(48), "02".repeat(48)];
    const pubkeysConcat = `0x${pubkeys.join("")}`;

    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).requestValidatorExit(pubkeysConcat)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("signals the requested exit of a validator", async () => {
      await expect(dashboard.requestValidatorExit(pubkeysConcat))
        .to.emit(vault, "ValidatorExitRequested")
        .withArgs(dashboard, `0x${pubkeys[0]}`, `0x${pubkeys[0]}`)
        .to.emit(vault, "ValidatorExitRequested")
        .withArgs(dashboard, `0x${pubkeys[1]}`, `0x${pubkeys[1]}`);
    });
  });

  context("triggerValidatorWithdrawal", () => {
    it("reverts if called by a non-admin", async () => {
      await expect(
        dashboard.connect(stranger).triggerValidatorWithdrawal("0x", [0n], vaultOwner),
      ).to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount");
    });

    it("requests a full validator withdrawal", async () => {
      const validatorPublicKeys = randomValidatorPubkey();
      const amounts = [0n]; // 0 amount means full withdrawal

      await expect(
        dashboard.triggerValidatorWithdrawal(validatorPublicKeys, amounts, vaultOwner, {
          value: EIP7002_MIN_WITHDRAWAL_REQUEST_FEE,
        }),
      )
        .to.emit(vault, "ValidatorWithdrawalTriggered")
        .withArgs(dashboard, validatorPublicKeys, amounts, vaultOwner, 0n);
    });

    it("requests a partial validator withdrawal", async () => {
      const validatorPublicKeys = randomValidatorPubkey();
      const amounts = [ether("0.1")];

      const stakingVault = await ethers.getContractAt("StakingVault", await dashboard.stakingVault());
      await reportVaultWithMockedVaultHub(stakingVault);

      await expect(
        dashboard.triggerValidatorWithdrawal(validatorPublicKeys, amounts, vaultOwner, {
          value: EIP7002_MIN_WITHDRAWAL_REQUEST_FEE,
        }),
      )
        .to.emit(vault, "ValidatorWithdrawalTriggered")
        .withArgs(dashboard, validatorPublicKeys, amounts, vaultOwner, 0n);
    });
  });

  context("authorizeLidoVaultHub", () => {
    it("authorizes the lido vault hub", async () => {
      await dashboard.connect(vaultOwner).voluntaryDisconnect();
      await hub.deleteVaultSocket(vault);
      await dashboard.deauthorizeLidoVaultHub();

      await expect(dashboard.authorizeLidoVaultHub()).to.emit(vault, "VaultHubAuthorizedSet");
    });

    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).authorizeLidoVaultHub()).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  context("ossifyStakingVault", () => {
    it("ossifies the staking vault", async () => {
      await dashboard.connect(vaultOwner).voluntaryDisconnect();
      await hub.deleteVaultSocket(vault);
      await dashboard.deauthorizeLidoVaultHub();

      await dashboard.ossifyStakingVault();

      expect(await vault.ossified()).to.be.true;
    });

    it("reverts if called by a non-admin", async () => {
      await dashboard.connect(vaultOwner).voluntaryDisconnect();
      await hub.deleteVaultSocket(vault);
      await dashboard.deauthorizeLidoVaultHub();

      await expect(dashboard.connect(stranger).ossifyStakingVault()).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  context("setDepositor", () => {
    it("sets the depositor", async () => {
      await dashboard.connect(vaultOwner).voluntaryDisconnect();
      await hub.deleteVaultSocket(vault);
      await dashboard.deauthorizeLidoVaultHub();

      await dashboard.setDepositor(vaultOwner);
      expect(await vault.depositor()).to.equal(vaultOwner);
    });

    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).setDepositor(vaultOwner)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  context("resetLocked", () => {
    it("resets the locked amount", async () => {
      await dashboard.connect(vaultOwner).voluntaryDisconnect();
      await hub.deleteVaultSocket(vault);
      await dashboard.deauthorizeLidoVaultHub();

      expect(await vault.locked()).to.equal(0n);
      const amount = ether("1");

      await dashboard.fund({ value: amount });
      await dashboard.lock(amount);
      expect(await vault.locked()).to.equal(amount);

      expect(await vault.vaultHubAuthorized()).to.be.false;
      await expect(dashboard.resetLocked()).to.emit(vault, "LockedReset");
      expect(await vault.locked()).to.equal(0n);
    });

    it("reverts if called by a non-admin", async () => {
      await expect(dashboard.connect(stranger).resetLocked()).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  context("role management", () => {
    let assignments: Permissions.RoleAssignmentStruct[];

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
