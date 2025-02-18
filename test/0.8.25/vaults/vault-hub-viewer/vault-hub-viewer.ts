import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  CustomOwner__MockForHubViewer,
  Dashboard,
  Delegation,
  DepositContract__MockForStakingVault,
  StakingVault,
  StakingVault__factory,
  StETHPermit__HarnessForDashboard,
  UpgradeableBeacon,
  VaultHub__MockForHubViewer,
  VaultHubViewerV1,
  WETH9__MockForVault,
  WstETH__HarnessForVault,
} from "typechain-types";

import { ether, findEvents, impersonate } from "lib";

import { Snapshot } from "test/suite";

const deployVaultDelegation = async (
  beacon: UpgradeableBeacon,
  delegationImpl: Delegation,
  vaultOwner: HardhatEthersSigner,
  manager: HardhatEthersSigner,
  operator: HardhatEthersSigner,
) => {
  const factoryDelegation = await ethers.deployContract("VaultFactory", [
    beacon.getAddress(),
    delegationImpl.getAddress(),
  ]);
  expect(await factoryDelegation.BEACON()).to.equal(beacon);
  expect(await factoryDelegation.DELEGATION_IMPL()).to.equal(delegationImpl);

  const vaultDelegationCreationTx = await factoryDelegation.connect(vaultOwner).createVaultWithDelegation(
    {
      defaultAdmin: vaultOwner,
      curator: manager,
      funderWithdrawer: vaultOwner,
      minterBurner: vaultOwner,
      nodeOperatorManager: operator,
      nodeOperatorFeeClaimer: operator,
      curatorFeeBP: 0n,
      nodeOperatorFeeBP: 0n,
    },
    "0x",
  );

  const vaultDelegationCreationReceipt = await vaultDelegationCreationTx.wait();
  if (!vaultDelegationCreationReceipt) throw new Error("Vault creation receipt not found");

  const vaultDelegationCreatedEvents = findEvents(vaultDelegationCreationReceipt, "VaultCreated");
  expect(vaultDelegationCreatedEvents.length).to.equal(1);
  const stakingVaultAddress = vaultDelegationCreatedEvents[0].args.vault;
  const vaultDelegation = await ethers.getContractAt("StakingVault", stakingVaultAddress, vaultOwner);

  const delegationCreatedEvents = findEvents(vaultDelegationCreationReceipt, "DelegationCreated");
  expect(delegationCreatedEvents.length).to.equal(1);
  const delegationAddress = delegationCreatedEvents[0].args.delegation;
  const delegation = await ethers.getContractAt("Delegation", delegationAddress, vaultOwner);

  return { vaultDelegation, delegation };
};

const deployVaultDashboard = async (
  vaultImpl: StakingVault,
  dashboardImpl: Dashboard,
  factoryOwner: HardhatEthersSigner,
  vaultOwner: HardhatEthersSigner,
  operator: HardhatEthersSigner,
) => {
  // Dashboard Factory
  const factoryDashboard = await ethers.deployContract("VaultFactory__MockForDashboard", [
    factoryOwner,
    vaultImpl,
    dashboardImpl,
  ]);
  expect(await factoryDashboard.owner()).to.equal(factoryOwner);
  expect(await factoryDashboard.implementation()).to.equal(vaultImpl);
  expect(await factoryDashboard.dashboardImpl()).to.equal(dashboardImpl);

  // Dashboard Vault
  const vaultDashboardCreationTx = await factoryDashboard.connect(vaultOwner).createVault(operator);
  const vaultDashboardCreationReceipt = await vaultDashboardCreationTx.wait();
  if (!vaultDashboardCreationReceipt) throw new Error("Vault creation receipt not found");

  const vaultDashboardCreatedEvents = findEvents(vaultDashboardCreationReceipt, "VaultCreated");
  expect(vaultDashboardCreatedEvents.length).to.equal(1);
  const vaultDashboardAddress = vaultDashboardCreatedEvents[0].args.vault;
  const vaultDashboard = await ethers.getContractAt("StakingVault", vaultDashboardAddress, vaultOwner);

  const dashboardCreatedEvents = findEvents(vaultDashboardCreationReceipt, "DashboardCreated");
  expect(dashboardCreatedEvents.length).to.equal(1);
  const dashboardAddress = dashboardCreatedEvents[0].args.dashboard;
  const dashboard = await ethers.getContractAt("Dashboard", dashboardAddress, vaultOwner);

  return { vaultDashboard, dashboard };
};

const deployCustomOwner = async (vaultImpl: StakingVault, operator: HardhatEthersSigner) => {
  const customOwner = await ethers.deployContract("CustomOwner__MockForHubViewer");
  // deploying factory/beacon
  const factoryStakingVault = await ethers.deployContract("VaultFactory__MockForStakingVault", [
    await vaultImpl.getAddress(),
  ]);
  const vaultCreation = await factoryStakingVault
    .createVault(await customOwner.getAddress(), await operator.getAddress())
    .then((tx) => tx.wait());
  if (!vaultCreation) throw new Error("Vault creation failed");
  const events = findEvents(vaultCreation, "VaultCreated");
  if (events.length != 1) throw new Error("There should be exactly one VaultCreated event");
  const vaultCreatedEvent = events[0];

  const stakingVault = StakingVault__factory.connect(vaultCreatedEvent.args.vault);
  return { stakingVault, customOwner };
};

const deployStakingVault = async (
  vaultImpl: StakingVault,
  vaultOwner: HardhatEthersSigner,
  operator: HardhatEthersSigner,
) => {
  // deploying factory/beacon
  const factoryStakingVault = await ethers.deployContract("VaultFactory__MockForStakingVault", [
    await vaultImpl.getAddress(),
  ]);

  // deploying beacon proxy
  const vaultCreation = await factoryStakingVault
    .createVault(await vaultOwner.getAddress(), await operator.getAddress())
    .then((tx) => tx.wait());
  if (!vaultCreation) throw new Error("Vault creation failed");
  const events = findEvents(vaultCreation, "VaultCreated");
  if (events.length != 1) throw new Error("There should be exactly one VaultCreated event");
  const vaultCreatedEvent = events[0];

  const stakingVault = StakingVault__factory.connect(vaultCreatedEvent.args.vault, vaultOwner);
  expect(await stakingVault.owner()).to.equal(await vaultOwner.getAddress());

  return stakingVault;
};

describe("VaultHubViewerV1", () => {
  let vaultOwner: HardhatEthersSigner;
  let manager: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let beaconOwner: HardhatEthersSigner;
  let factoryOwner: HardhatEthersSigner;
  let hubSigner: HardhatEthersSigner;

  let steth: StETHPermit__HarnessForDashboard;
  let weth: WETH9__MockForVault;
  let wsteth: WstETH__HarnessForVault;

  let vaultImpl: StakingVault;
  let dashboardImpl: Dashboard;
  let delegationImpl: Delegation;

  let beacon: UpgradeableBeacon;

  let hub: VaultHub__MockForHubViewer;
  let depositContract: DepositContract__MockForStakingVault;
  let stakingVault: StakingVault;
  let vaultDashboard: StakingVault;
  let vaultDelegation: StakingVault;
  let vaultCustom: StakingVault;
  let vaultHubViewer: VaultHubViewerV1;

  let dashboard: Dashboard;
  let delegation: Delegation;
  let customOwnerContract: CustomOwner__MockForHubViewer;

  let originalState: string;

  before(async () => {
    [, vaultOwner, manager, operator, stranger, factoryOwner, beaconOwner] = await ethers.getSigners();

    steth = await ethers.deployContract("StETHPermit__HarnessForDashboard");
    weth = await ethers.deployContract("WETH9__MockForVault");
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);
    hub = await ethers.deployContract("VaultHub__MockForHubViewer", [steth]);

    depositContract = await ethers.deployContract("DepositContract__MockForStakingVault");
    vaultImpl = await ethers.deployContract("StakingVault", [hub, depositContract]);
    expect(await vaultImpl.vaultHub()).to.equal(hub);

    // beacon
    beacon = await ethers.deployContract("UpgradeableBeacon", [vaultImpl, beaconOwner]);

    dashboardImpl = await ethers.deployContract("Dashboard", [steth, weth, wsteth]);
    delegationImpl = await ethers.deployContract("Delegation", [steth, weth, wsteth]);

    // Delegation controlled vault
    const delegationResult = await deployVaultDelegation(beacon, delegationImpl, vaultOwner, manager, operator);
    vaultDelegation = delegationResult.vaultDelegation;
    delegation = delegationResult.delegation;

    // Dashboard controlled vault
    const dashboardResult = await deployVaultDashboard(vaultImpl, dashboardImpl, factoryOwner, vaultOwner, operator);
    vaultDashboard = dashboardResult.vaultDashboard;
    dashboard = dashboardResult.dashboard;

    // EOA controlled vault
    stakingVault = await deployStakingVault(vaultImpl, vaultOwner, operator);

    // Custom owner controlled vault
    const customdResult = await deployCustomOwner(vaultImpl, operator);
    vaultCustom = customdResult.stakingVault;
    customOwnerContract = customdResult.customOwner;

    vaultHubViewer = await ethers.deployContract("VaultHubViewerV1", [hub]);
    expect(await vaultHubViewer.vaultHub()).to.equal(hub);

    hubSigner = await impersonate(await hub.getAddress(), ether("100"));
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  context("constructor", () => {
    it("reverts if vault hub is zero address", async () => {
      await expect(ethers.deployContract("VaultHubViewerV1", [ethers.ZeroAddress]))
        .to.be.revertedWithCustomError(vaultHubViewer, "ZeroArgument")
        .withArgs("_vaultHubAddress");
    });
  });

  context("vaultsConnected", () => {
    beforeEach(async () => {
      await hub.connect(hubSigner).mock_connectVault(vaultDelegation.getAddress());
      await hub.connect(hubSigner).mock_connectVault(vaultDashboard.getAddress());
      await hub.connect(hubSigner).mock_connectVault(stakingVault.getAddress());
      await hub.connect(hubSigner).mock_connectVault(vaultCustom.getAddress());
    });

    it("returns all connected vaults", async () => {
      const vaults = await vaultHubViewer.vaultsConnected();
      expect(vaults.length).to.equal(4);
      expect(vaults[0]).to.equal(vaultDelegation);
      expect(vaults[1]).to.equal(vaultDashboard);
      expect(vaults[2]).to.equal(stakingVault);
      expect(vaults[3]).to.equal(vaultCustom);
    });
  });

  context("vaultsConnectedBound", () => {
    beforeEach(async () => {
      await hub.connect(hubSigner).mock_connectVault(vaultDelegation.getAddress());
      await hub.connect(hubSigner).mock_connectVault(vaultDashboard.getAddress());
      await hub.connect(hubSigner).mock_connectVault(stakingVault.getAddress());
      await hub.connect(hubSigner).mock_connectVault(vaultCustom.getAddress());
    });

    it("returns all connected vaults", async () => {
      const vaults = await vaultHubViewer.vaultsConnectedBound(0, 4);
      expect(vaults[0].length).to.equal(4);
    });

    it("returns all connected vaults in a given range", async () => {
      const vaults = await vaultHubViewer.vaultsConnectedBound(1, 3);
      expect(vaults[0].length).to.equal(2);
    });

    it("reverts if from is greater than to", async () => {
      await expect(vaultHubViewer.vaultsConnectedBound(3, 1)).to.be.revertedWithPanic();
    });
  });

  context("vaultsByOwner", () => {
    beforeEach(async () => {
      await hub.connect(hubSigner).mock_connectVault(vaultDelegation.getAddress());
      await hub.connect(hubSigner).mock_connectVault(vaultDashboard.getAddress());
      await hub.connect(hubSigner).mock_connectVault(stakingVault.getAddress());
      await hub.connect(hubSigner).mock_connectVault(vaultCustom.getAddress());
    });

    it("returns all vaults owned by a given address", async () => {
      const vaults = await vaultHubViewer.vaultsByOwner(vaultOwner.getAddress());
      expect(vaults.length).to.equal(3);
      expect(vaults[0]).to.equal(vaultDelegation);
      expect(vaults[1]).to.equal(vaultDashboard);
      expect(vaults[2]).to.equal(stakingVault);
    });

    it("returns correct owner for custom vault", async () => {
      const vaults = await vaultHubViewer.vaultsByOwner(customOwnerContract.getAddress());
      expect(vaults.length).to.equal(1);
      expect(vaults[0]).to.equal(vaultCustom);
    });
  });

  context("vaultsByOwnerBound", () => {
    beforeEach(async () => {
      await hub.connect(hubSigner).mock_connectVault(vaultDelegation.getAddress());
      await hub.connect(hubSigner).mock_connectVault(vaultDashboard.getAddress());
      await hub.connect(hubSigner).mock_connectVault(stakingVault.getAddress());
      await hub.connect(hubSigner).mock_connectVault(vaultCustom.getAddress());
    });

    it("returns all connected vaults", async () => {
      const vaults = await vaultHubViewer.vaultsByOwnerBound(vaultOwner.getAddress(), 0, 4);
      expect(vaults[0].length).to.equal(3);
    });

    it("returns all vaults owned by a given address in a given range - [0, 2]", async () => {
      const vaults = await vaultHubViewer.vaultsByOwnerBound(vaultOwner.getAddress(), 0, 2);
      expect(vaults[0].length).to.equal(2);
    });

    it("returns all vaults owned by a given address in a given range - [2, 4]", async () => {
      const vaults = await vaultHubViewer.vaultsByOwnerBound(vaultOwner.getAddress(), 2, 4);
      expect(vaults[0].length).to.equal(1);
    });

    it("reverts if from is greater than to", async () => {
      await expect(vaultHubViewer.vaultsByOwnerBound(vaultOwner.getAddress(), 3, 1)).to.be.revertedWithPanic();
    });
  });

  context("vaultsByRole", () => {
    beforeEach(async () => {
      await hub.connect(hubSigner).mock_connectVault(vaultDelegation.getAddress());
      await hub.connect(hubSigner).mock_connectVault(vaultDashboard.getAddress());
      await hub.connect(hubSigner).mock_connectVault(stakingVault.getAddress());
      await hub.connect(hubSigner).mock_connectVault(vaultCustom.getAddress());
    });

    it("returns all vaults with a given role on Delegation", async () => {
      await delegation.connect(vaultOwner).grantRole(await delegation.FUND_WITHDRAW_ROLE(), stranger.getAddress());

      const vaults = await vaultHubViewer.vaultsByRole(await delegation.FUND_WITHDRAW_ROLE(), stranger.getAddress());
      const curatorVaults = await vaultHubViewer.vaultsByRole(await delegation.CURATOR_ROLE(), manager.getAddress());
      const operatorVaults = await vaultHubViewer.vaultsByRole(
        await delegation.NODE_OPERATOR_MANAGER_ROLE(),
        operator.getAddress(),
      );

      expect(vaults.length).to.equal(1);
      expect(vaults[0]).to.equal(vaultDelegation);

      expect(curatorVaults.length).to.equal(1);
      expect(curatorVaults[0]).to.equal(vaultDelegation);

      expect(operatorVaults.length).to.equal(1);
      expect(operatorVaults[0]).to.equal(vaultDelegation);
    });

    it("returns all vaults with a given role on Dashboard", async () => {
      await dashboard.connect(vaultOwner).grantRole(await dashboard.DEFAULT_ADMIN_ROLE(), stranger.getAddress());

      const vaults = await vaultHubViewer.vaultsByRole(await dashboard.DEFAULT_ADMIN_ROLE(), stranger.getAddress());
      expect(vaults.length).to.equal(1);
      expect(vaults[0]).to.equal(vaultDashboard);
    });
  });

  context("vaultsByRoleBound", () => {
    beforeEach(async () => {
      await hub.connect(hubSigner).mock_connectVault(vaultDelegation.getAddress());
      await hub.connect(hubSigner).mock_connectVault(vaultDashboard.getAddress());
      await hub.connect(hubSigner).mock_connectVault(stakingVault.getAddress());
      await hub.connect(hubSigner).mock_connectVault(vaultCustom.getAddress());
    });

    it("returns all vaults with a given role on Delegation", async () => {
      await delegation.connect(vaultOwner).grantRole(await delegation.FUND_WITHDRAW_ROLE(), stranger.getAddress());

      const vaults = await vaultHubViewer.vaultsByRoleBound(
        await delegation.FUND_WITHDRAW_ROLE(),
        stranger.getAddress(),
        0,
        4,
      );
      expect(vaults[0].length).to.equal(1);
    });
  });
});
