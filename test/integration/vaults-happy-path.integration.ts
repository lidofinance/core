import { expect } from "chai";
import { ContractTransactionReceipt, TransactionResponse, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { StakingVault, StVaultOwnerWithDelegation } from "typechain-types";

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

const PUBKEY_LENGTH = 48n;
const SIGNATURE_LENGTH = 96n;

const LIDO_DEPOSIT = ether("640");

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
describe("Scenario: Staking Vaults Happy Path", () => {
  let ctx: ProtocolContext;

  let ethHolder: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let mario: HardhatEthersSigner;
  let lidoAgent: HardhatEthersSigner;

  let depositContract: string;

  const reserveRatio = 10_00n; // 10% of ETH allocation as reserve
  const reserveRatioThreshold = 8_00n; // 8% of reserve ratio
  const vault101LTV = MAX_BASIS_POINTS - reserveRatio; // 90% LTV

  let vault101: StakingVault;
  let vault101Address: string;
  let vault101AdminContract: StVaultOwnerWithDelegation;
  let vault101BeaconBalance = 0n;
  let vault101MintingMaximum = 0n;

  const treasuryFeeBP = 5_00n; // 5% of the treasury fee

  let pubKeysBatch: Uint8Array;
  let signaturesBatch: Uint8Array;

  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    [ethHolder, alice, bob, mario, lidoAgent] = await ethers.getSigners();

    const { depositSecurityModule } = ctx.contracts;
    depositContract = await depositSecurityModule.DEPOSIT_CONTRACT();

    snapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(snapshot));

  async function calculateReportParams() {
    const { beaconBalance } = await ctx.contracts.lido.getBeaconStat();
    const { timeElapsed } = await getReportTimeElapsed(ctx);

    log.debug("Report time elapsed", { timeElapsed });

    const gross = (TARGET_APR * MAX_BASIS_POINTS) / (MAX_BASIS_POINTS - PROTOCOL_FEE); // take into account 10% Lido fee
    const elapsedProtocolReward = (beaconBalance * gross * timeElapsed) / MAX_BASIS_POINTS / ONE_YEAR;
    const elapsedVaultReward = (VAULT_DEPOSIT * gross * timeElapsed) / MAX_BASIS_POINTS / ONE_YEAR;

    log.debug("Report values", {
      "Elapsed rewards": elapsedProtocolReward,
      "Elapsed vault rewards": elapsedVaultReward,
    });

    return { elapsedProtocolReward, elapsedVaultReward };
  }

  async function addRewards(rewards: bigint) {
    if (!vault101Address || !vault101) {
      throw new Error("Vault 101 is not initialized");
    }

    const vault101Balance = (await ethers.provider.getBalance(vault101Address)) + rewards;
    await updateBalance(vault101Address, vault101Balance);

    // Use beacon balance to calculate the vault value
    return vault101Balance + vault101BeaconBalance;
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

  it("Should have vaults factory deployed and adopted by DAO", async () => {
    const { stakingVaultFactory } = ctx.contracts;

    const implAddress = await stakingVaultFactory.implementation();
    const adminContractImplAddress = await stakingVaultFactory.stVaultOwnerWithDelegationImpl();

    const vaultImpl = await ethers.getContractAt("StakingVault", implAddress);
    const vaultFactoryAdminContract = await ethers.getContractAt("StVaultOwnerWithDelegation", adminContractImplAddress);

    expect(await vaultImpl.VAULT_HUB()).to.equal(ctx.contracts.accounting.address);
    expect(await vaultImpl.DEPOSIT_CONTRACT()).to.equal(depositContract);
    expect(await vaultFactoryAdminContract.stETH()).to.equal(ctx.contracts.lido.address);

    // TODO: check what else should be validated here
  });

  it("Should allow Alice to create vaults and assign Bob as node operator", async () => {
    const { stakingVaultFactory } = ctx.contracts;

    // Alice can create a vault with Bob as a node operator
    const deployTx = await stakingVaultFactory.connect(alice).createVault("0x", {
      managementFee: VAULT_OWNER_FEE,
      performanceFee: VAULT_NODE_OPERATOR_FEE,
      manager: alice,
      operator: bob,
    }, lidoAgent);

    const createVaultTxReceipt = await trace<ContractTransactionReceipt>("vaultsFactory.createVault", deployTx);
    const createVaultEvents = ctx.getEvents(createVaultTxReceipt, "VaultCreated");

    expect(createVaultEvents.length).to.equal(1n);

    vault101 = await ethers.getContractAt("StakingVault", createVaultEvents[0].args?.vault);
    vault101AdminContract = await ethers.getContractAt("StVaultOwnerWithDelegation", createVaultEvents[0].args?.owner);

    expect(await vault101AdminContract.hasRole(await vault101AdminContract.DEFAULT_ADMIN_ROLE(), alice)).to.be.true;
    expect(await vault101AdminContract.hasRole(await vault101AdminContract.MANAGER_ROLE(), alice)).to.be.true;
    expect(await vault101AdminContract.hasRole(await vault101AdminContract.OPERATOR_ROLE(), bob)).to.be.true;

    expect(await vault101AdminContract.hasRole(await vault101AdminContract.KEY_MASTER_ROLE(), alice)).to.be.false;
    expect(await vault101AdminContract.hasRole(await vault101AdminContract.KEY_MASTER_ROLE(), bob)).to.be.false;

    expect(await vault101AdminContract.hasRole(await vault101AdminContract.TOKEN_MASTER_ROLE(), alice)).to.be.false;
    expect(await vault101AdminContract.hasRole(await vault101AdminContract.TOKEN_MASTER_ROLE(), bob)).to.be.false;
  });

  it("Should allow Alice to assign staker and plumber roles", async () => {
    await vault101AdminContract.connect(alice).grantRole(await vault101AdminContract.STAKER_ROLE(), alice);
    await vault101AdminContract.connect(alice).grantRole(await vault101AdminContract.TOKEN_MASTER_ROLE(), mario);

    expect(await vault101AdminContract.hasRole(await vault101AdminContract.TOKEN_MASTER_ROLE(), mario)).to.be.true;
    expect(await vault101AdminContract.hasRole(await vault101AdminContract.TOKEN_MASTER_ROLE(), mario)).to.be.true;
  });

  it("Should allow Bob to assign the keymaster role", async () => {
    await vault101AdminContract.connect(bob).grantRole(await vault101AdminContract.KEY_MASTER_ROLE(), bob);

    expect(await vault101AdminContract.hasRole(await vault101AdminContract.KEY_MASTER_ROLE(), bob)).to.be.true;
  });

  it("Should allow Lido to recognize vaults and connect them to accounting", async () => {
    const { lido, accounting } = ctx.contracts;

    // only equivalent of 10.0% of total eth can be minted as stETH on the vaults
    const votingSigner = await ctx.getSigner("voting");
    await lido.connect(votingSigner).setMaxExternalBalanceBP(10_00n);

    // TODO: make cap and reserveRatio reflect the real values
    const shareLimit = (await lido.getTotalShares()) / 10n; // 10% of total shares

    const agentSigner = await ctx.getSigner("agent");

    await accounting
      .connect(agentSigner)
      .connectVault(vault101, shareLimit, reserveRatio, reserveRatioThreshold, treasuryFeeBP);

    expect(await accounting.vaultsCount()).to.equal(1n);
  });

  it("Should allow Alice to fund vault via admin contract", async () => {
    const depositTx = await vault101AdminContract.connect(alice).fund({ value: VAULT_DEPOSIT });
    await trace("vaultAdminContract.fund", depositTx);

    const vaultBalance = await ethers.provider.getBalance(vault101);

    expect(vaultBalance).to.equal(VAULT_DEPOSIT);
    expect(await vault101.valuation()).to.equal(VAULT_DEPOSIT);
  });

  it("Should allow Bob to deposit validators from the vault", async () => {
    const keysToAdd = VALIDATORS_PER_VAULT;
    pubKeysBatch = ethers.randomBytes(Number(keysToAdd * PUBKEY_LENGTH));
    signaturesBatch = ethers.randomBytes(Number(keysToAdd * SIGNATURE_LENGTH));

    const topUpTx = await vault101AdminContract
      .connect(bob)
      .depositToBeaconChain(keysToAdd, pubKeysBatch, signaturesBatch);

    await trace("vaultAdminContract.depositToBeaconChain", topUpTx);

    vault101BeaconBalance += VAULT_DEPOSIT;
    vault101Address = await vault101.getAddress();

    const vaultBalance = await ethers.provider.getBalance(vault101);
    expect(vaultBalance).to.equal(0n);
    expect(await vault101.valuation()).to.equal(VAULT_DEPOSIT);
  });

  it("Should allow Mario to mint max stETH", async () => {
    const { accounting } = ctx.contracts;

    // Calculate the max stETH that can be minted on the vault 101 with the given LTV
    vault101MintingMaximum = (VAULT_DEPOSIT * vault101LTV) / MAX_BASIS_POINTS;

    log.debug("Vault 101", {
      "Vault 101 Address": vault101Address,
      "Total ETH": await vault101.valuation(),
      "Max stETH": vault101MintingMaximum,
    });

    // Validate minting with the cap
    const mintOverLimitTx = vault101AdminContract.connect(mario).mint(mario, vault101MintingMaximum + 1n);
    await expect(mintOverLimitTx)
      .to.be.revertedWithCustomError(accounting, "InsufficientValuationToMint")
      .withArgs(vault101, vault101.valuation());

    const mintTx = await vault101AdminContract.connect(mario).mint(mario, vault101MintingMaximum);
    const mintTxReceipt = await trace<ContractTransactionReceipt>("vaultAdminContract.mint", mintTx);

    const mintEvents = ctx.getEvents(mintTxReceipt, "MintedStETHOnVault");
    expect(mintEvents.length).to.equal(1n);
    expect(mintEvents[0].args.sender).to.equal(vault101Address);
    expect(mintEvents[0].args.tokens).to.equal(vault101MintingMaximum);

    const lockedEvents = ctx.getEvents(mintTxReceipt, "Locked", [vault101.interface]);
    expect(lockedEvents.length).to.equal(1n);
    expect(lockedEvents[0].args?.locked).to.equal(VAULT_DEPOSIT);

    expect(await vault101.locked()).to.equal(VAULT_DEPOSIT);

    log.debug("Vault 101", {
      "Vault 101 Minted": vault101MintingMaximum,
      "Vault 101 Locked": VAULT_DEPOSIT,
    });
  });

  it("Should rebase simulating 3% APR", async () => {
    const { elapsedProtocolReward, elapsedVaultReward } = await calculateReportParams();
    const vaultValue = await addRewards(elapsedVaultReward);

    const params = {
      clDiff: elapsedProtocolReward,
      excludeVaultsBalances: true,
      vaultValues: [vaultValue],
      netCashFlows: [VAULT_DEPOSIT],
    } as OracleReportParams;

    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };
    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;

    const errorReportingEvent = ctx.getEvents(reportTxReceipt, "OnReportFailed", [vault101.interface]);
    expect(errorReportingEvent.length).to.equal(0n);

    const vaultReportedEvent = ctx.getEvents(reportTxReceipt, "Reported", [vault101.interface]);
    expect(vaultReportedEvent.length).to.equal(1n);

    expect(vaultReportedEvent[0].args?.vault).to.equal(vault101Address);
    expect(vaultReportedEvent[0].args?.valuation).to.equal(vaultValue);
    expect(vaultReportedEvent[0].args?.inOutDelta).to.equal(VAULT_DEPOSIT);
    // TODO: add assertions or locked values and rewards

    expect(await vault101AdminContract.managementDue()).to.be.gt(0n);
    expect(await vault101AdminContract.performanceDue()).to.be.gt(0n);
  });

  it("Should allow Bob to withdraw node operator fees", async () => {
    const nodeOperatorFee = await vault101AdminContract.performanceDue();
    log.debug("Vault 101 stats", {
      "Vault 101 node operator fee": ethers.formatEther(nodeOperatorFee),
    });

    const bobBalanceBefore = await ethers.provider.getBalance(bob);

    const claimNOFeesTx = await vault101AdminContract.connect(bob).claimPerformanceDue(bob, false);
    const claimNOFeesTxReceipt = await trace<ContractTransactionReceipt>("vault.claimNodeOperatorFee", claimNOFeesTx);

    const bobBalanceAfter = await ethers.provider.getBalance(bob);

    const gasFee = claimNOFeesTxReceipt.gasPrice * claimNOFeesTxReceipt.cumulativeGasUsed;

    log.debug("Bob's StETH balance", {
      "Bob's balance before": ethers.formatEther(bobBalanceBefore),
      "Bob's balance after": ethers.formatEther(bobBalanceAfter),
      "Gas used": claimNOFeesTxReceipt.cumulativeGasUsed,
      "Gas fees": ethers.formatEther(gasFee),
    });

    expect(bobBalanceAfter).to.equal(bobBalanceBefore + nodeOperatorFee - gasFee);
  });

  it("Should stop Alice from claiming management fee is stETH after reserve limit reached", async () => {
    await expect(vault101AdminContract.connect(alice).claimManagementDue(alice, true))
      .to.be.revertedWithCustomError(ctx.contracts.accounting, "InsufficientValuationToMint")
      .withArgs(vault101Address, await vault101.valuation());
  });

  it("Should stop Alice from claiming management fee in ETH if not not enough unlocked ETH", async () => {
    const feesToClaim = await vault101AdminContract.managementDue();
    const availableToClaim = (await vault101.valuation()) - (await vault101.locked());

    await expect(vault101AdminContract.connect(alice).connect(alice).claimManagementDue(alice, false))
      .to.be.revertedWithCustomError(vault101AdminContract, "InsufficientUnlockedAmount")
      .withArgs(availableToClaim, feesToClaim);
  });

  it("Should allow Alice to trigger validator exit to cover fees", async () => {
    // simulate validator exit
    const secondValidatorKey = pubKeysBatch.slice(Number(PUBKEY_LENGTH), Number(PUBKEY_LENGTH) * 2);
    await vault101AdminContract.connect(alice).requestValidatorExit(secondValidatorKey);
    await updateBalance(vault101Address, VALIDATOR_DEPOSIT_SIZE);

    const { elapsedProtocolReward, elapsedVaultReward } = await calculateReportParams();
    const vaultValue = await addRewards(elapsedVaultReward / 2n); // Half the vault rewards value to simulate the validator exit

    const params = {
      clDiff: elapsedProtocolReward,
      excludeVaultsBalances: true,
      vaultValues: [vaultValue],
      netCashFlows: [VAULT_DEPOSIT],
    } as OracleReportParams;

    await report(ctx, params);
  });

  it("Should allow Alice to claim manager rewards in ETH after rebase with exited validator", async () => {
    const feesToClaim = await vault101AdminContract.managementDue();

    log.debug("Vault 101 stats after operator exit", {
      "Vault 101 owner fee": ethers.formatEther(feesToClaim),
      "Vault 101 balance": ethers.formatEther(await ethers.provider.getBalance(vault101Address)),
    });

    const aliceBalanceBefore = await ethers.provider.getBalance(alice.address);

    const claimEthTx = await vault101AdminContract.connect(alice).claimManagementDue(alice, false);
    const { gasUsed, gasPrice } = await trace("vaultAdmin.claimManagementDue", claimEthTx);

    const aliceBalanceAfter = await ethers.provider.getBalance(alice.address);
    const vaultBalance = await ethers.provider.getBalance(vault101Address);

    log.debug("Balances after owner fee claim", {
      "Alice's ETH balance before": ethers.formatEther(aliceBalanceBefore),
      "Alice's ETH balance after": ethers.formatEther(aliceBalanceAfter),
      "Alice's ETH balance diff": ethers.formatEther(aliceBalanceAfter - aliceBalanceBefore),
      "Vault 101 owner fee": ethers.formatEther(feesToClaim),
      "Vault 101 balance": ethers.formatEther(vaultBalance),
    });

    expect(aliceBalanceAfter).to.equal(aliceBalanceBefore + feesToClaim - gasUsed * gasPrice);
  });

  it("Should allow Mario to burn shares to repay debt", async () => {
    const { lido } = ctx.contracts;

    // Mario can approve the vault to burn the shares
    const approveVaultTx = await lido.connect(mario).approve(vault101AdminContract, vault101MintingMaximum);
    await trace("lido.approve", approveVaultTx);

    const burnTx = await vault101AdminContract.connect(mario).burn(vault101MintingMaximum);
    await trace("vault.burn", burnTx);

    const { elapsedProtocolReward, elapsedVaultReward } = await calculateReportParams();
    const vaultValue = await addRewards(elapsedVaultReward / 2n); // Half the vault rewards value after validator exit

    const params = {
      clDiff: elapsedProtocolReward,
      excludeVaultsBalances: true,
      vaultValues: [vaultValue],
      netCashFlows: [VAULT_DEPOSIT],
    } as OracleReportParams;

    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };
    await trace("report", reportTx);

    const lockedOnVault = await vault101.locked();
    expect(lockedOnVault).to.be.gt(0n); // lockedOnVault should be greater than 0, because of the debt

    // TODO: add more checks here
  });

  it("Should allow Alice to rebalance the vault to reduce the debt", async () => {
    const { accounting, lido } = ctx.contracts;

    const socket = await accounting["vaultSocket(address)"](vault101Address);
    const sharesMinted = (await lido.getPooledEthByShares(socket.sharesMinted)) + 1n; // +1 to avoid rounding errors

    const rebalanceTx = await vault101AdminContract
      .connect(alice)
      .rebalanceVault(sharesMinted, { value: sharesMinted });

    await trace("vault.rebalance", rebalanceTx);
  });

  it("Should allow Alice to disconnect vaults from the hub providing the debt in ETH", async () => {
    const disconnectTx = await vault101AdminContract.connect(alice).disconnectFromVaultHub();
    const disconnectTxReceipt = await trace<ContractTransactionReceipt>("vault.disconnectFromHub", disconnectTx);

    const disconnectEvents = ctx.getEvents(disconnectTxReceipt, "VaultDisconnected");

    expect(disconnectEvents.length).to.equal(1n);

    // TODO: add more assertions for values during the disconnection
  });
});
