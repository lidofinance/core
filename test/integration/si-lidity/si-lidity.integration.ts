import fs from "node:fs";
import path from "node:path";

import { expect } from "chai";
import { Contract, parseEther, ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { checkSiLidityDeployment, requireSiLidityAddresses } from "scripts/scratch/si-lidity/checks";

import { createVaultWithDashboard, getProtocolContext, ProtocolContext, setupLidoForVaults } from "lib/protocol";
import { getAddress, readNetworkState, Sk } from "lib/state-file";

import { Snapshot } from "test/suite";

describe("Integration: si-lidity scratch helpers", () => {
  let state: ReturnType<typeof readNetworkState>;
  let snapshot: string;
  let ctx: ProtocolContext;

  before(async function () {
    ctx = await getProtocolContext();
    state = readNetworkState();
    if (!state[Sk.vaultViewer] && !state[Sk.wstETHReferralStaker]) this.skip();
    requireSiLidityAddresses({
      vaultViewer: state[Sk.vaultViewer]?.address,
      wstETHReferralStaker: state[Sk.wstETHReferralStaker]?.address,
    });
  });

  beforeEach(async () => {
    snapshot = await Snapshot.take();
  });
  afterEach(async () => {
    if (snapshot) await Snapshot.restore(snapshot);
  });

  it("binds both helpers to this deployment and reads the vault registry", async () => {
    await checkSiLidityDeployment(
      ethers.provider,
      {
        vaultViewer: getAddress(Sk.vaultViewer, state),
        wstETHReferralStaker: getAddress(Sk.wstETHReferralStaker, state),
      },
      {
        lidoLocator: getAddress(Sk.lidoLocator, state),
        vaultHub: getAddress(Sk.vaultHub, state),
        lazyOracle: getAddress(Sk.lazyOracle, state),
        stETH: getAddress(Sk.appLido, state),
        wstETH: getAddress(Sk.wstETH, state),
      },
    );
  });

  it("decodes vault records using the externally compiled viewer ABI", async function () {
    const directory = state[Sk.siLidityDeployment]?.directory;
    if (typeof directory !== "string") this.skip();
    const artifactPath = path.resolve(
      __dirname,
      "../../..",
      directory,
      "repo/artifacts/si-contracts/0.8.25/vaults/VaultViewer.sol/VaultViewer.json",
    );
    if (!fs.existsSync(artifactPath)) this.skip();
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    await setupLidoForVaults(ctx);
    const [, owner, operator] = await ethers.getSigners();
    const { stakingVault } = await createVaultWithDashboard(ctx, ctx.contracts.stakingVaultFactory, owner, operator);
    const viewer = new Contract(getAddress(Sk.vaultViewer, state), artifact.abi, ethers.provider);
    const created = await viewer.vaultData(await stakingVault.getAddress());
    expect(created.vaultAddress).to.equal(await stakingVault.getAddress());
    const count = await viewer.vaultsCount();
    const data = await viewer.vaultsDataBatch(0, 10);
    expect(BigInt(data.length)).to.equal(count < 10n ? count : 10n);
    const hub = await ethers.getContractAt("VaultHub", getAddress(Sk.vaultHub, state));
    for (const vault of data) {
      expect(vault.record.liabilityShares).to.equal((await hub.vaultRecord(vault.vaultAddress)).liabilityShares);
      expect(vault.totalValue).to.equal(await hub.totalValue(vault.vaultAddress));
    }
  });

  it("stakes ETH, emits the referral, and returns all minted wstETH to the caller", async () => {
    const [signer, referral] = await ethers.getSigners();
    const staker = new Contract(
      getAddress(Sk.wstETHReferralStaker, state),
      ["function stakeETH(address) payable returns (uint256)"],
      signer,
    );
    const wstETH = await ethers.getContractAt("WstETH", getAddress(Sk.wstETH, state));
    const stETH = await ethers.getContractAt("Lido", getAddress(Sk.appLido, state));
    const value = parseEther("1");
    const expected = await staker.stakeETH.staticCall(referral.address, { value });
    const before = await wstETH.balanceOf(signer.address);
    await expect(staker.stakeETH(referral.address, { value }))
      .to.emit(stETH, "Submitted")
      .withArgs(await staker.getAddress(), value, referral.address);
    expect(await wstETH.balanceOf(signer.address)).to.equal(before + expected);
    expect(expected).to.be.greaterThan(0n);
    expect(await wstETH.balanceOf(await staker.getAddress())).to.equal(0n);
    expect(await stETH.sharesOf(await staker.getAddress())).to.equal(0n);
    await expect(staker.stakeETH(ZeroAddress, { value: 0 })).to.be.reverted;
    await expect(signer.sendTransaction({ to: await staker.getAddress(), value })).to.be.reverted;
  });
});
