import { expect } from "chai";
import { ContractTransactionReceipt, TransactionResponse, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Delegation, StakingVault } from "typechain-types";

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

import { bailOnFailure, Snapshot } from "test/suite";
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
const TOTAL_BASIS_POINTS = 100_00n; // 100%

const VAULT_CONNECTION_DEPOSIT = ether("1");
const VAULT_OWNER_FEE = 1_00n; // 1% AUM owner fee
const VAULT_NODE_OPERATOR_FEE = 3_00n; // 3% node operator fee

describe("Scenario: Staking Vaults Happy Path", () => {
  let ctx: ProtocolContext;

  let ethHolder: HardhatEthersSigner;
  let owner: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let curator: HardhatEthersSigner;
  let staker: HardhatEthersSigner;
  let tokenMaster: HardhatEthersSigner;

  let depositContract: string;

  const reserveRatio = 10_00n; // 10% of ETH allocation as reserve
  const reserveRatioThreshold = 8_00n; // 8% of reserve ratio
  const mintableRatio = TOTAL_BASIS_POINTS - reserveRatio; // 90% LTV

  let delegation: Delegation;
  let stakingVault: StakingVault;
  let stakingVaultAddress: string;
  let stakingVaultBeaconBalance = 0n;
  let stakingVaultMaxMintingShares = 0n;

  const treasuryFeeBP = 5_00n; // 5% of the treasury fee

  let pubKeysBatch: Uint8Array;
  let signaturesBatch: Uint8Array;

  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    [ethHolder, owner, operator, curator, staker, tokenMaster] = await ethers.getSigners();

    const { depositSecurityModule } = ctx.contracts;
    depositContract = await depositSecurityModule.DEPOSIT_CONTRACT();

    snapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(snapshot));

  beforeEach(bailOnFailure);

  async function calculateReportParams() {
    const { beaconBalance } = await ctx.contracts.lido.getBeaconStat();
    const { timeElapsed } = await getReportTimeElapsed(ctx);

    log.debug("Report time elapsed", { timeElapsed });

    const gross = (TARGET_APR * TOTAL_BASIS_POINTS) / (TOTAL_BASIS_POINTS - PROTOCOL_FEE); // take into account 10% Lido fee
    const elapsedProtocolReward = (beaconBalance * gross * timeElapsed) / TOTAL_BASIS_POINTS / ONE_YEAR;
    const elapsedVaultReward = (VAULT_DEPOSIT * gross * timeElapsed) / TOTAL_BASIS_POINTS / ONE_YEAR;

    log.debug("Report values", {
      "Elapsed rewards": elapsedProtocolReward,
      "Elapsed vault rewards": elapsedVaultReward,
    });

    return { elapsedProtocolReward, elapsedVaultReward };
  }

  async function addRewards(rewards: bigint) {
    if (!stakingVaultAddress || !stakingVault) {
      throw new Error("Staking Vault is not initialized");
    }

    const vault101Balance = (await ethers.provider.getBalance(stakingVaultAddress)) + rewards;
    await updateBalance(stakingVaultAddress, vault101Balance);

    // Use beacon balance to calculate the vault value
    return vault101Balance + stakingVaultBeaconBalance;
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
    const adminContractImplAddress = await stakingVaultFactory.delegationImpl();

    const vaultImpl = await ethers.getContractAt("StakingVault", implAddress);
    const vaultFactoryAdminContract = await ethers.getContractAt("Delegation", adminContractImplAddress);

    expect(await vaultImpl.vaultHub()).to.equal(ctx.contracts.accounting.address);
    expect(await vaultImpl.DEPOSIT_CONTRACT()).to.equal(depositContract);
    expect(await vaultFactoryAdminContract.STETH()).to.equal(ctx.contracts.lido.address);

    // TODO: check what else should be validated here
  });

  it("Should allow Owner to create vault and assign Operator and Manager roles", async () => {
    const { stakingVaultFactory } = ctx.contracts;

    // Owner can create a vault with operator as a node operator
    const deployTx = await stakingVaultFactory.connect(owner).createVault(
      {
        operatorFee: VAULT_OWNER_FEE,
        curatorFee: VAULT_NODE_OPERATOR_FEE,
        curator: curator,
        operator: operator,
        staker: staker,
        tokenMaster: tokenMaster,
        claimOperatorDueRole: operator,
      },
      "0x",
    );

    const createVaultTxReceipt = await trace<ContractTransactionReceipt>("vaultsFactory.createVault", deployTx);
    const createVaultEvents = ctx.getEvents(createVaultTxReceipt, "VaultCreated");

    expect(createVaultEvents.length).to.equal(1n);

    stakingVault = await ethers.getContractAt("StakingVault", createVaultEvents[0].args?.vault);
    delegation = await ethers.getContractAt("Delegation", createVaultEvents[0].args?.owner);

    expect(await delegation.getRoleMemberCount(await delegation.DEFAULT_ADMIN_ROLE())).to.be.equal(1n);
    expect(await delegation.hasRole(await delegation.DEFAULT_ADMIN_ROLE(), owner)).to.be.true;

    expect(await delegation.getRoleMemberCount(await delegation.CURATOR_ROLE())).to.be.equal(1n);
    expect(await delegation.hasRole(await delegation.CURATOR_ROLE(), curator)).to.be.true;

    expect(await delegation.getRoleMemberCount(await delegation.OPERATOR_ROLE())).to.be.equal(1n);
    expect(await delegation.hasRole(await delegation.OPERATOR_ROLE(), operator)).to.be.true;

    expect(await delegation.getRoleMemberCount(await delegation.CLAIM_OPERATOR_DUE_ROLE())).to.be.equal(1n);
    expect(await delegation.hasRole(await delegation.CLAIM_OPERATOR_DUE_ROLE(), operator)).to.be.true;
    expect(await delegation.getRoleAdmin(await delegation.CLAIM_OPERATOR_DUE_ROLE())).to.be.equal(
      await delegation.OPERATOR_ROLE(),
    );

    expect(await delegation.getRoleMemberCount(await delegation.TOKEN_MASTER_ROLE())).to.be.equal(1n);
    expect(await delegation.hasRole(await delegation.TOKEN_MASTER_ROLE(), tokenMaster)).to.be.true;

    expect(await delegation.getRoleMemberCount(await delegation.STAKER_ROLE())).to.be.equal(1n);
    expect(await delegation.hasRole(await delegation.STAKER_ROLE(), staker)).to.be.true;
  });

  it("Should allow Owner to assign Staker and Token Master roles", async () => {
    await delegation.connect(owner).grantRole(await delegation.STAKER_ROLE(), staker);
    await delegation.connect(owner).grantRole(await delegation.TOKEN_MASTER_ROLE(), tokenMaster);

    expect(await delegation.hasRole(await delegation.STAKER_ROLE(), staker)).to.be.true;
    expect(await delegation.hasRole(await delegation.TOKEN_MASTER_ROLE(), tokenMaster)).to.be.true;
  });

  it("Should allow Lido to recognize vaults and connect them to accounting", async () => {
    const { lido, accounting } = ctx.contracts;

    expect(await stakingVault.locked()).to.equal(0); // no ETH locked yet

    const votingSigner = await ctx.getSigner("voting");
    await lido.connect(votingSigner).setMaxExternalRatioBP(20_00n);

    // only equivalent of 10.0% of TVL can be minted as stETH on the vault
    const shareLimit = (await lido.getTotalShares()) / 10n; // 10% of total shares

    const agentSigner = await ctx.getSigner("agent");

    await accounting
      .connect(agentSigner)
      .connectVault(stakingVault, shareLimit, reserveRatio, reserveRatioThreshold, treasuryFeeBP);

    expect(await accounting.vaultsCount()).to.equal(1n);
    expect(await stakingVault.locked()).to.equal(VAULT_CONNECTION_DEPOSIT);
  });

  it("Should allow Staker to fund vault via delegation contract", async () => {
    const depositTx = await delegation.connect(staker).fund({ value: VAULT_DEPOSIT });
    await trace("delegation.fund", depositTx);

    const vaultBalance = await ethers.provider.getBalance(stakingVault);

    expect(vaultBalance).to.equal(VAULT_DEPOSIT);
    expect(await stakingVault.valuation()).to.equal(VAULT_DEPOSIT);
  });

  it("Should allow Operator to deposit validators from the vault", async () => {
    const keysToAdd = VALIDATORS_PER_VAULT;
    pubKeysBatch = ethers.randomBytes(Number(keysToAdd * PUBKEY_LENGTH));
    signaturesBatch = ethers.randomBytes(Number(keysToAdd * SIGNATURE_LENGTH));

    const topUpTx = await stakingVault.connect(operator).depositToBeaconChain(keysToAdd, pubKeysBatch, signaturesBatch);

    await trace("stakingVault.depositToBeaconChain", topUpTx);

    stakingVaultBeaconBalance += VAULT_DEPOSIT;
    stakingVaultAddress = await stakingVault.getAddress();

    const vaultBalance = await ethers.provider.getBalance(stakingVault);
    expect(vaultBalance).to.equal(0n);
    expect(await stakingVault.valuation()).to.equal(VAULT_DEPOSIT);
  });

  it("Should allow Token Master to mint max stETH", async () => {
    const { accounting, lido } = ctx.contracts;

    // Calculate the max stETH that can be minted on the vault 101 with the given LTV
    stakingVaultMaxMintingShares = await lido.getSharesByPooledEth(
      (VAULT_DEPOSIT * mintableRatio) / TOTAL_BASIS_POINTS,
    );

    log.debug("Staking Vault", {
      "Staking Vault Address": stakingVaultAddress,
      "Total ETH": await stakingVault.valuation(),
      "Max shares": stakingVaultMaxMintingShares,
    });

    // Validate minting with the cap
    const mintOverLimitTx = delegation.connect(tokenMaster).mint(tokenMaster, stakingVaultMaxMintingShares + 1n);
    await expect(mintOverLimitTx)
      .to.be.revertedWithCustomError(accounting, "InsufficientValuationToMint")
      .withArgs(stakingVault, stakingVault.valuation());

    const mintTx = await delegation.connect(tokenMaster).mint(tokenMaster, stakingVaultMaxMintingShares);
    const mintTxReceipt = await trace<ContractTransactionReceipt>("delegation.mint", mintTx);

    const mintEvents = ctx.getEvents(mintTxReceipt, "MintedSharesOnVault");
    expect(mintEvents.length).to.equal(1n);
    expect(mintEvents[0].args.vault).to.equal(stakingVaultAddress);
    expect(mintEvents[0].args.amountOfShares).to.equal(stakingVaultMaxMintingShares);

    const lockedEvents = ctx.getEvents(mintTxReceipt, "LockedIncreased", [stakingVault.interface]);
    expect(lockedEvents.length).to.equal(1n);
    expect(lockedEvents[0].args?.locked).to.equal(VAULT_DEPOSIT);

    expect(await stakingVault.locked()).to.equal(VAULT_DEPOSIT);

    log.debug("Staking Vault", {
      "Staking Vault Minted Shares": stakingVaultMaxMintingShares,
      "Staking Vault Locked": VAULT_DEPOSIT,
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

    const errorReportingEvent = ctx.getEvents(reportTxReceipt, "OnReportFailed", [stakingVault.interface]);
    expect(errorReportingEvent.length).to.equal(0n);

    const vaultReportedEvent = ctx.getEvents(reportTxReceipt, "Reported", [stakingVault.interface]);
    expect(vaultReportedEvent.length).to.equal(1n);

    expect(vaultReportedEvent[0].args?.valuation).to.equal(vaultValue);
    expect(vaultReportedEvent[0].args?.inOutDelta).to.equal(VAULT_DEPOSIT);
    // TODO: add assertions or locked values and rewards

    expect(await delegation.curatorDue()).to.be.gt(0n);
    expect(await delegation.operatorDue()).to.be.gt(0n);
  });

  it("Should allow Operator to claim performance fees", async () => {
    const performanceFee = await delegation.operatorDue();
    log.debug("Staking Vault stats", {
      "Staking Vault performance fee": ethers.formatEther(performanceFee),
    });

    const operatorBalanceBefore = await ethers.provider.getBalance(operator);

    const claimPerformanceFeesTx = await delegation.connect(operator).claimOperatorDue(operator);
    const claimPerformanceFeesTxReceipt = await trace<ContractTransactionReceipt>(
      "delegation.claimOperatorDue",
      claimPerformanceFeesTx,
    );

    const operatorBalanceAfter = await ethers.provider.getBalance(operator);
    const gasFee = claimPerformanceFeesTxReceipt.gasPrice * claimPerformanceFeesTxReceipt.cumulativeGasUsed;

    log.debug("Operator's StETH balance", {
      "Balance before": ethers.formatEther(operatorBalanceBefore),
      "Balance after": ethers.formatEther(operatorBalanceAfter),
      "Gas used": claimPerformanceFeesTxReceipt.cumulativeGasUsed,
      "Gas fees": ethers.formatEther(gasFee),
    });

    expect(operatorBalanceAfter).to.equal(operatorBalanceBefore + performanceFee - gasFee);
  });

  it("Should allow Owner to trigger validator exit to cover fees", async () => {
    // simulate validator exit
    const secondValidatorKey = pubKeysBatch.slice(Number(PUBKEY_LENGTH), Number(PUBKEY_LENGTH) * 2);
    await delegation.connect(owner).requestValidatorExit(secondValidatorKey);
    await updateBalance(stakingVaultAddress, VALIDATOR_DEPOSIT_SIZE);

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

  it("Should allow Manager to claim manager rewards in ETH after rebase with exited validator", async () => {
    const feesToClaim = await delegation.curatorDue();

    log.debug("Staking Vault stats after operator exit", {
      "Staking Vault management fee": ethers.formatEther(feesToClaim),
      "Staking Vault balance": ethers.formatEther(await ethers.provider.getBalance(stakingVaultAddress)),
    });

    const managerBalanceBefore = await ethers.provider.getBalance(curator);

    const claimEthTx = await delegation.connect(curator).claimCuratorDue(curator);
    const { gasUsed, gasPrice } = await trace("delegation.claimCuratorDue", claimEthTx);

    const managerBalanceAfter = await ethers.provider.getBalance(curator);
    const vaultBalance = await ethers.provider.getBalance(stakingVaultAddress);

    log.debug("Balances after owner fee claim", {
      "Manager's ETH balance before": ethers.formatEther(managerBalanceBefore),
      "Manager's ETH balance after": ethers.formatEther(managerBalanceAfter),
      "Manager's ETH balance diff": ethers.formatEther(managerBalanceAfter - managerBalanceBefore),
      "Staking Vault owner fee": ethers.formatEther(feesToClaim),
      "Staking Vault balance": ethers.formatEther(vaultBalance),
    });

    expect(managerBalanceAfter).to.equal(managerBalanceBefore + feesToClaim - gasUsed * gasPrice);
  });

  it("Should allow Token Master to burn shares to repay debt", async () => {
    const { lido } = ctx.contracts;

    // Token master can approve the vault to burn the shares
    const approveVaultTx = await lido
      .connect(tokenMaster)
      .approve(delegation, await lido.getPooledEthByShares(stakingVaultMaxMintingShares));
    await trace("lido.approve", approveVaultTx);

    const burnTx = await delegation.connect(tokenMaster).burn(stakingVaultMaxMintingShares);
    await trace("delegation.burn", burnTx);

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

    const lockedOnVault = await stakingVault.locked();
    expect(lockedOnVault).to.be.gt(0n); // lockedOnVault should be greater than 0, because of the debt

    // TODO: add more checks here
  });

  it("Should allow Manager to rebalance the vault to reduce the debt", async () => {
    const { accounting, lido } = ctx.contracts;

    const socket = await accounting["vaultSocket(address)"](stakingVaultAddress);
    const sharesMinted = await lido.getPooledEthByShares(socket.sharesMinted);

    const rebalanceTx = await delegation.connect(curator).rebalanceVault(sharesMinted, { value: sharesMinted });
    await trace("delegation.rebalanceVault", rebalanceTx);

    expect(await stakingVault.locked()).to.equal(VAULT_CONNECTION_DEPOSIT); // 1 ETH locked as a connection fee
  });

  it("Should allow Manager to disconnect vaults from the hub", async () => {
    const disconnectTx = await delegation.connect(curator).voluntaryDisconnect();
    const disconnectTxReceipt = await trace<ContractTransactionReceipt>("delegation.voluntaryDisconnect", disconnectTx);

    const disconnectEvents = ctx.getEvents(disconnectTxReceipt, "VaultDisconnected");
    expect(disconnectEvents.length).to.equal(1n);

    expect(await stakingVault.locked()).to.equal(0);
  });
});
