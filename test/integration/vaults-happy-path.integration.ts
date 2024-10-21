import { expect } from "chai";
import { ContractTransactionReceipt, TransactionResponse, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { LiquidStakingVault } from "typechain-types";

import { impersonate, log, trace, updateBalance } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import {
  getReportTimeElapsed,
  norEnsureOperators,
  OracleReportParams,
  report,
  sdvtEnsureOperators,
} from "lib/protocol/helpers";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";
import { CURATED_MODULE_ID, MAX_DEPOSIT, ONE_DAY, SIMPLE_DVT_MODULE_ID, ZERO_HASH } from "test/suite/constants";

type Vault = {
  vault: LiquidStakingVault;
  address: string;
  beaconBalance: bigint;
};

const PUBKEY_LENGTH = 48n;
const SIGNATURE_LENGTH = 96n;

const LIDO_DEPOSIT = ether("640");

const VAULTS_COUNT = 5; // Must be of type number to make Array(VAULTS_COUNT).fill() work
const VALIDATORS_PER_VAULT = 2n;
const VALIDATOR_DEPOSIT_SIZE = ether("32");
const VAULT_DEPOSIT = VALIDATOR_DEPOSIT_SIZE * VALIDATORS_PER_VAULT;

const ONE_YEAR = 365n * ONE_DAY;
const TARGET_APR = 3_00n; // 3% APR
const PROTOCOL_FEE = 10_00n; // 10% fee (5% treasury + 5% node operators)
const MAX_BASIS_POINTS = 100_00n; // 100%

const VAULT_OWNER_FEE = 1_00n; // 1% owner fee
const VAULT_NODE_OPERATOR_FEE = 3_00n; // 3% node operator fee

// based on https://hackmd.io/9D40wO_USaCH7gWOpDe08Q
describe("Staking Vaults Happy Path", () => {
  let ctx: ProtocolContext;

  let ethHolder: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  let agentSigner: HardhatEthersSigner;
  let depositContract: string;

  const vaults: Vault[] = [];

  const vault101Index = 0;
  const vault101LTV = 90_00n; // 90% of the deposit
  let vault101: Vault;
  let vault101Minted: bigint;

  const treasuryFeeBP = 5_00n; // 5% of the treasury fee

  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    [ethHolder, alice, bob] = await ethers.getSigners();

    const { depositSecurityModule } = ctx.contracts;

    agentSigner = await ctx.getSigner("agent");
    depositContract = await depositSecurityModule.DEPOSIT_CONTRACT();

    snapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(snapshot));

  async function calculateReportValues() {
    const { beaconBalance } = await ctx.contracts.lido.getBeaconStat();
    const { timeElapsed } = await getReportTimeElapsed(ctx);

    log.debug("Report time elapsed", { timeElapsed });

    const gross = (TARGET_APR * MAX_BASIS_POINTS) / (MAX_BASIS_POINTS - PROTOCOL_FEE); // take fee into account 10% Lido fee
    const elapsedRewards = (beaconBalance * gross * timeElapsed) / MAX_BASIS_POINTS / ONE_YEAR;
    const elapsedVaultRewards = (VAULT_DEPOSIT * gross * timeElapsed) / MAX_BASIS_POINTS / ONE_YEAR;

    // Simulate no activity on the vaults, just the rewards
    const vaultRewards = Array(VAULTS_COUNT).fill(elapsedVaultRewards);
    const netCashFlows = Array(VAULTS_COUNT).fill(VAULT_DEPOSIT);

    log.debug("Report values", {
      "Elapsed rewards": elapsedRewards,
      "Vaults rewards": vaultRewards,
      "Vaults net cash flows": netCashFlows,
    });

    return { elapsedRewards, vaultRewards, netCashFlows };
  }

  async function updateVaultValues(vaultRewards: bigint[]) {
    const vaultValues = [];

    for (const [i, rewards] of vaultRewards.entries()) {
      const vaultBalance = await ethers.provider.getBalance(vaults[i].address);
      // Update the vault balance with the rewards
      const vaultValue = vaultBalance + rewards;
      await updateBalance(vaults[i].address, vaultValue);

      // Use beacon balance to calculate the vault value
      const beaconBalance = vaults[i].beaconBalance;
      vaultValues.push(vaultValue + beaconBalance);
    }

    return vaultValues;
  }

  it("Should have at least 10 deposited node operators in NOR", async () => {
    const { depositSecurityModule, lido } = ctx.contracts;

    await norEnsureOperators(ctx, 10n, 1n);
    await sdvtEnsureOperators(ctx, 10n, 1n);
    expect(await ctx.contracts.nor.getNodeOperatorsCount()).to.be.at.least(10n);
    expect(await ctx.contracts.sdvt.getNodeOperatorsCount()).to.be.at.least(10n);

    // Send 640 ETH to lido
    await lido.connect(ethHolder).submit(ZeroAddress, { value: LIDO_DEPOSIT });

    const dsmSigner = await impersonate(depositSecurityModule.address, LIDO_DEPOSIT);
    const depositNorTx = await lido.connect(dsmSigner).deposit(MAX_DEPOSIT, CURATED_MODULE_ID, ZERO_HASH);
    await trace("lido.deposit", depositNorTx);

    const depositSdvtTx = await lido.connect(dsmSigner).deposit(MAX_DEPOSIT, SIMPLE_DVT_MODULE_ID, ZERO_HASH);
    await trace("lido.deposit", depositSdvtTx);

    const reportData: Partial<OracleReportParams> = {
      clDiff: LIDO_DEPOSIT,
      clAppearedValidators: 20n,
    };

    await report(ctx, reportData);
  });

  it("Should allow Alice to create vaults and assign Bob as node operator", async () => {
    const vaultParams = [ctx.contracts.accounting, ctx.contracts.lido, alice, depositContract];

    for (let i = 0n; i < VAULTS_COUNT; i++) {
      // Alice can create a vault
      const vault = await ethers.deployContract("LiquidStakingVault", vaultParams, { signer: alice });

      await vault.setVaultOwnerFee(VAULT_OWNER_FEE);
      await vault.setNodeOperatorFee(VAULT_NODE_OPERATOR_FEE);

      vaults.push({ vault, address: await vault.getAddress(), beaconBalance: 0n });

      // Alice can grant NODE_OPERATOR_ROLE to Bob
      const roleTx = await vault.connect(alice).grantRole(await vault.NODE_OPERATOR_ROLE(), bob);
      await trace("vault.grantRole", roleTx);

      // validate vault owner and node operator
      expect(await vault.hasRole(await vault.DEPOSITOR_ROLE(), await vault.EVERYONE())).to.be.true;
      expect(await vault.hasRole(await vault.VAULT_MANAGER_ROLE(), alice)).to.be.true;
      expect(await vault.hasRole(await vault.NODE_OPERATOR_ROLE(), bob)).to.be.true;
    }

    expect(vaults.length).to.equal(VAULTS_COUNT);
  });

  it("Should allow Lido to recognize vaults and connect them to accounting", async () => {
    const { lido, accounting } = ctx.contracts;

    // TODO: make cap and minBondRateBP suite the real values
    const capShares = (await lido.getTotalShares()) / 10n; // 10% of total shares
    const minBondRateBP = 10_00n; // 10% of ETH allocation as a bond

    for (const { vault } of vaults) {
      const connectTx = await accounting
        .connect(agentSigner)
        .connectVault(vault, capShares, minBondRateBP, treasuryFeeBP);

      await trace("accounting.connectVault", connectTx);
    }

    expect(await accounting.vaultsCount()).to.equal(VAULTS_COUNT);
  });

  it("Should allow Alice to deposit to vaults", async () => {
    for (const entry of vaults) {
      const depositTx = await entry.vault.connect(alice).deposit({ value: VAULT_DEPOSIT });
      await trace("vault.deposit", depositTx);

      const vaultBalance = await ethers.provider.getBalance(entry.address);
      expect(vaultBalance).to.equal(VAULT_DEPOSIT);
      expect(await entry.vault.value()).to.equal(VAULT_DEPOSIT);
    }
  });

  it("Should allow Bob to top-up validators from vaults", async () => {
    for (const entry of vaults) {
      const keysToAdd = VALIDATORS_PER_VAULT;
      const pubKeysBatch = ethers.randomBytes(Number(keysToAdd * PUBKEY_LENGTH));
      const signaturesBatch = ethers.randomBytes(Number(keysToAdd * SIGNATURE_LENGTH));

      const topUpTx = await entry.vault.connect(bob).topupValidators(keysToAdd, pubKeysBatch, signaturesBatch);
      await trace("vault.topupValidators", topUpTx);

      entry.beaconBalance += VAULT_DEPOSIT;

      const vaultBalance = await ethers.provider.getBalance(entry.address);
      expect(vaultBalance).to.equal(0n);
      expect(await entry.vault.value()).to.equal(VAULT_DEPOSIT);
    }
  });

  it("Should allow Alice to mint max stETH", async () => {
    const { accounting, lido } = ctx.contracts;

    vault101 = vaults[vault101Index];
    // Calculate the max stETH that can be minted on the vault 101 with the given LTV
    vault101Minted = await lido.getSharesByPooledEth((VAULT_DEPOSIT * vault101LTV) / MAX_BASIS_POINTS);

    log.debug("Vault 101", {
      "Vault 101 Address": vault101.address,
      "Total ETH": await vault101.vault.value(),
      "Max stETH": vault101Minted,
    });

    // Validate minting with the cap
    const mintOverLimitTx = vault101.vault.connect(alice).mint(alice, vault101Minted + 1n);
    await expect(mintOverLimitTx)
      .to.be.revertedWithCustomError(accounting, "BondLimitReached")
      .withArgs(vault101.address);

    const mintTx = await vault101.vault.connect(alice).mint(alice, vault101Minted);
    const mintTxReceipt = await trace<ContractTransactionReceipt>("vault.mint", mintTx);

    const mintEvents = ctx.getEvents(mintTxReceipt, "MintedStETHOnVault");
    expect(mintEvents.length).to.equal(1n);
    expect(mintEvents[0].args?.vault).to.equal(vault101.address);
    expect(mintEvents[0].args?.amountOfTokens).to.equal(vault101Minted);

    const lockedEvents = ctx.getEvents(mintTxReceipt, "Locked", [vault101.vault.interface]);
    expect(lockedEvents.length).to.equal(1n);
    expect(lockedEvents[0].args?.amountOfETH).to.equal(VAULT_DEPOSIT);
    expect(await vault101.vault.locked()).to.equal(VAULT_DEPOSIT);

    log.debug("Vault 101", {
      "Vault 101 Minted": vault101Minted,
      "Vault 101 Locked": VAULT_DEPOSIT,
    });
  });

  it("Should rebase simulating 3% APR", async () => {
    const { elapsedRewards, vaultRewards, netCashFlows } = await calculateReportValues();
    const vaultValues = await updateVaultValues(vaultRewards);

    const params = {
      clDiff: elapsedRewards,
      excludeVaultsBalances: true,
      vaultValues,
      netCashFlows,
    } as OracleReportParams;

    log.debug("Rebasing parameters", {
      "Vault Values": vaultValues,
      "Net Cash Flows": netCashFlows,
    });

    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;

    const vaultReportedEvent = ctx.getEvents(reportTxReceipt, "VaultReported");
    expect(vaultReportedEvent.length).to.equal(VAULTS_COUNT);

    for (const [vaultIndex, { address: vaultAddress }] of vaults.entries()) {
      const vaultReport = vaultReportedEvent.find((e) => e.args.vault === vaultAddress);

      expect(vaultReport).to.exist;
      expect(vaultReport?.args?.value).to.equal(vaultValues[vaultIndex]);
      expect(vaultReport?.args?.netCashFlow).to.equal(netCashFlows[vaultIndex]);

      // TODO: add assertions or locked values and rewards
    }
  });

  it("Should allow Bob to withdraw node operator fees in stETH", async () => {
    const { lido } = ctx.contracts;

    const vault101NodeOperatorFee = await vault101.vault.accumulatedNodeOperatorFee();
    log.debug("Vault 101 stats", {
      "Vault 101 node operator fee": ethers.formatEther(vault101NodeOperatorFee),
    });

    const bobStETHBalanceBefore = await lido.balanceOf(bob.address);

    const claimNOFeesTx = await vault101.vault.connect(bob).claimNodeOperatorFee(bob, true);
    await trace("vault.claimNodeOperatorFee", claimNOFeesTx);

    const bobStETHBalanceAfter = await lido.balanceOf(bob.address);

    log.debug("Bob's StETH balance", {
      "Bob's stETH balance before": ethers.formatEther(bobStETHBalanceBefore),
      "Bob's stETH balance after": ethers.formatEther(bobStETHBalanceAfter),
    });

    // 1 wei difference is allowed due to rounding errors
    expect(bobStETHBalanceAfter).to.approximately(bobStETHBalanceBefore + vault101NodeOperatorFee, 1);
  });

  it("Should stop Alice from claiming AUM rewards is stETH after bond limit reached", async () => {
    await expect(vault101.vault.connect(alice).claimVaultOwnerFee(alice, true))
      .to.be.revertedWithCustomError(ctx.contracts.accounting, "BondLimitReached")
      .withArgs(vault101.address);
  });

  it("Should stop Alice from claiming AUM rewards in ETH if not not enough unlocked ETH", async () => {
    const feesToClaim = await vault101.vault.accumulatedVaultOwnerFee();
    const availableToClaim = (await vault101.vault.value()) - (await vault101.vault.locked());

    await expect(vault101.vault.connect(alice).claimVaultOwnerFee(alice, false))
      .to.be.revertedWithCustomError(vault101.vault, "NotEnoughUnlockedEth")
      .withArgs(availableToClaim, feesToClaim);
  });

  it("Should allow Alice to trigger validator exit to cover fees", async () => {
    // simulate validator exit
    await vault101.vault.connect(alice).triggerValidatorExit(1n);
    await updateBalance(vault101.address, VALIDATOR_DEPOSIT_SIZE);

    const { elapsedRewards, vaultRewards, netCashFlows } = await calculateReportValues();
    // Half the vault rewards value to simulate the validator exit
    vaultRewards[vault101Index] = vaultRewards[vault101Index] / 2n;

    const vaultValues = await updateVaultValues(vaultRewards);
    const params = {
      clDiff: elapsedRewards,
      excludeVaultsBalances: true,
      vaultValues,
      netCashFlows,
    } as OracleReportParams;

    log.debug("Rebasing parameters", {
      "Vault Values": vaultValues,
      "Net Cash Flows": netCashFlows,
    });

    await report(ctx, params);
  });

  it("Should allow Alice to claim AUM rewards in ETH after rebase with exited validator", async () => {
    const vault101OwnerFee = await vault101.vault.accumulatedVaultOwnerFee();

    log.debug("Vault 101 stats after operator exit", {
      "Vault 101 owner fee": ethers.formatEther(vault101OwnerFee),
      "Vault 101 balance": ethers.formatEther(await ethers.provider.getBalance(vault101.address)),
    });

    const aliceBalanceBefore = await ethers.provider.getBalance(alice.address);

    const claimEthTx = await vault101.vault.connect(alice).claimVaultOwnerFee(alice, false);
    const { gasUsed, gasPrice } = await trace("vault.claimVaultOwnerFee", claimEthTx);

    const aliceBalanceAfter = await ethers.provider.getBalance(alice.address);

    log.debug("Balances after owner fee claim", {
      "Alice's ETH balance before": ethers.formatEther(aliceBalanceBefore),
      "Alice's ETH balance after": ethers.formatEther(aliceBalanceAfter),
      "Alice's ETH balance diff": ethers.formatEther(aliceBalanceAfter - aliceBalanceBefore),
      "Vault 101 owner fee": ethers.formatEther(vault101OwnerFee),
      "Vault 101 balance": ethers.formatEther(await ethers.provider.getBalance(vault101.address)),
    });

    expect(aliceBalanceAfter).to.equal(aliceBalanceBefore + vault101OwnerFee - gasUsed * gasPrice);
  });

  it("Should allow Alice to burn shares to repay debt", async () => {
    const { lido } = ctx.contracts;

    const approveTx = await lido.connect(alice).approve(vault101.address, vault101Minted);
    await trace("lido.approve", approveTx);

    const burnTx = await vault101.vault.connect(alice).burn(vault101Minted);
    await trace("vault.burn", burnTx);

    const { vaultRewards, netCashFlows } = await calculateReportValues();

    // Again half the vault rewards value to simulate operator exit
    vaultRewards[vault101Index] = vaultRewards[vault101Index] / 2n;
    const vaultValues = await updateVaultValues(vaultRewards);

    const params = {
      clDiff: 0n,
      excludeVaultsBalances: true,
      vaultValues,
      netCashFlows,
    };

    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };
    await trace("report", reportTx);

    const lockedOnVault = await vault101.vault.locked();
    expect(lockedOnVault).to.be.gt(0n); // lockedOnVault should be greater than 0, because of the debt

    // TODO: add more checks here
  });

  it("Should allow Alice to rebalance the vault to reduce the debt", async () => {
    const { accounting, lido } = ctx.contracts;

    const socket = await accounting["vaultSocket(address)"](vault101.address);
    const ethToTopUp = await lido.getPooledEthByShares(socket.mintedShares);

    const rebalanceTx = await vault101.vault.connect(alice).rebalance(ethToTopUp + 1n, { value: ethToTopUp + 1n });
    await trace("vault.rebalance", rebalanceTx);
  });

  it("Should allow Alice to disconnect vaults from the hub providing the debt in ETH", async () => {
    const disconnectTx = await vault101.vault.connect(alice).disconnectFromHub();
    const disconnectTxReceipt = await trace<ContractTransactionReceipt>("vault.disconnectFromHub", disconnectTx);

    const disconnectEvents = ctx.getEvents(disconnectTxReceipt, "VaultDisconnected");

    expect(disconnectEvents.length).to.equal(1n);

    // TODO: add more assertions for values during the disconnection
  });
});
