import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// import { days } from "lib";
import {
  Delegation__Harness,
  PDG__MockForPermissions,
  StakingVault__MockForPermissions,
  VaultHub__MockForPermissions,
} from "typechain-types";

describe("Delegation", () => {
  let deployer: HardhatEthersSigner;
  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let nodeOperatorManager: HardhatEthersSigner;

  let vaultHub: VaultHub__MockForPermissions;
  let pdg: PDG__MockForPermissions;
  let delegation: Delegation__Harness;
  let stakingVault: StakingVault__MockForPermissions;

  // const nodeOperatorFeeBP = 0;
  // const confirmExpiry = days(3n);

  before(async () => {
    [deployer, owner, nodeOperator, nodeOperatorManager] = await ethers.getSigners();

    pdg = await ethers.deployContract("PDG__MockForPermissions");
    vaultHub = await ethers.deployContract("VaultHub__MockForPermissions");
    stakingVault = await ethers.deployContract("StakingVault__MockForPermissions", [owner, pdg, vaultHub]);
    delegation = await ethers.deployContract("Delegation__Harness", [stakingVault]);

    await stakingVault.transferOwnership(delegation);

    expect(await stakingVault.owner()).to.equal(delegation);
    expect(await stakingVault.depositor()).to.equal(pdg);
    expect(await stakingVault.vaultHub()).to.equal(vaultHub);
    expect(await delegation.stakingVault()).to.equal(stakingVault);

    deployer;
    nodeOperator;
    nodeOperatorManager;
  });

  it("hello", async () => {
    expect(true).to.be.true;
  });
});
