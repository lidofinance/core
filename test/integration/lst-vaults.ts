import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether, impersonate } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { finalizeWithdrawalQueue, norEnsureOperators, report, sdvtEnsureOperators } from "lib/protocol/helpers";

import { Snapshot } from "test/suite";

const AMOUNT = ether("100");
const MAX_DEPOSIT = 150n;
const CURATED_MODULE_ID = 1n;

const ZERO_HASH = new Uint8Array(32).fill(0);

describe("Liquid Staking Vaults", () => {
  let ctx: ProtocolContext;

  let ethHolder: HardhatEthersSigner;
  let stEthHolder: HardhatEthersSigner;

  let snapshot: string;
  let originalState: string;

  before(async () => {
    ctx = await getProtocolContext();

    [stEthHolder, ethHolder] = await ethers.getSigners();

    snapshot = await Snapshot.take();

    const { lido, depositSecurityModule } = ctx.contracts;

    await finalizeWithdrawalQueue(ctx, stEthHolder, ethHolder);

    await norEnsureOperators(ctx, 3n, 5n);
    if (ctx.flags.withSimpleDvtModule) {
      await sdvtEnsureOperators(ctx, 3n, 5n);
    }

    const dsmSigner = await impersonate(depositSecurityModule.address, AMOUNT);
    await lido.connect(dsmSigner).deposit(MAX_DEPOSIT, CURATED_MODULE_ID, ZERO_HASH);

    await report(ctx, {
      clDiff: ether("32") * 3n, // 32 ETH * 3 validators
      clAppearedValidators: 3n,
      excludeVaultsBalances: true,
    });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot)); // Rollback to the initial state pre deployment

  it.skip("Should update vaults on rebase", async () => {});
});
