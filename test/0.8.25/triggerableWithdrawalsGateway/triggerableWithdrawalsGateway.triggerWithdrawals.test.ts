import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { TriggerableWithdrawalsGateway, WithdrawalVault__MockForTriggerableWithdrawalsGateway } from "typechain-types";

import { DEFAULT_TWG_LIMIT, deployTriggerableWithdrawalsGateway } from "test/deploy";
import { Snapshot } from "test/suite";

import {
  fullWithdrawal,
  MAX_PARTIAL_WITHDRAWAL_AMOUNT_GWEI,
  partialWithdrawal,
  WithdrawalIntent,
} from "../triggerable-withdrawals-helpers";

const GWEI_PER_ETH = 10n ** 9n;

describe("TriggerableWithdrawalsGateway.sol: triggerWithdrawals", () => {
  let gateway: TriggerableWithdrawalsGateway;
  let withdrawalVault: WithdrawalVault__MockForTriggerableWithdrawalsGateway;
  let admin: HardhatEthersSigner;
  let requester: HardhatEthersSigner;
  let refundRecipient: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let originalState: string;

  before(async () => {
    [admin, requester, refundRecipient, stranger] = await ethers.getSigners();

    ({ gateway, withdrawalVault } = await deployTriggerableWithdrawalsGateway(admin));

    await gateway.connect(admin).grantRole(await gateway.ADD_WITHDRAWAL_REQUEST_ROLE(), requester.address);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  const currentLimit = async () => (await gateway.getExitRequestLimitFullInfo()).currentExitBalanceEth;

  context("validation", () => {
    it("reverts if caller has no ADD_WITHDRAWAL_REQUEST_ROLE", async () => {
      await expect(gateway.connect(stranger).triggerWithdrawals([fullWithdrawal(0)], stranger.address, { value: 1n }))
        .to.be.revertedWithCustomError(gateway, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, await gateway.ADD_WITHDRAWAL_REQUEST_ROLE());
    });

    it("reverts if msg.value is zero", async () => {
      await expect(gateway.connect(requester).triggerWithdrawals([fullWithdrawal(0)], requester.address))
        .to.be.revertedWithCustomError(gateway, "ZeroArgument")
        .withArgs("msg.value");
    });

    it("reverts if intents are empty", async () => {
      await expect(gateway.connect(requester).triggerWithdrawals([], requester.address, { value: 1n }))
        .to.be.revertedWithCustomError(gateway, "ZeroArgument")
        .withArgs("intents");
    });

    it("reverts on a partial withdrawal above the max amount and reports its index", async () => {
      const tooLarge = MAX_PARTIAL_WITHDRAWAL_AMOUNT_GWEI + 1n;

      await expect(
        gateway
          .connect(requester)
          .triggerWithdrawals([fullWithdrawal(0), partialWithdrawal(1, tooLarge)], requester.address, { value: 2n }),
      )
        .to.be.revertedWithCustomError(gateway, "WithdrawalAmountTooLarge")
        .withArgs(1, tooLarge);
    });

    it("reverts if the fee is insufficient", async () => {
      await withdrawalVault.mock__setFee(3n);

      await expect(
        gateway
          .connect(requester)
          .triggerWithdrawals([fullWithdrawal(0), fullWithdrawal(1)], requester.address, { value: 5n }),
      )
        .to.be.revertedWithCustomError(gateway, "InsufficientFee")
        .withArgs(6n, 5n);
    });
  });

  context("requests", () => {
    it("forwards pubkeys and amounts to the WithdrawalVault with the exact fee", async () => {
      await withdrawalVault.mock__setFee(3n);
      const intents = [fullWithdrawal(0), partialWithdrawal(1, 1n), partialWithdrawal(2, 32n * GWEI_PER_ETH)];

      await expect(gateway.connect(requester).triggerWithdrawals(intents, requester.address, { value: 9n }))
        .to.emit(withdrawalVault, "Mock__AddWithdrawalRequestsCalled")
        .withArgs(
          intents.map((intent) => intent.pubkey),
          intents.map((intent) => intent.amount),
          9n,
        );
    });

    it("emits WithdrawalsTriggered with the consumed weight", async () => {
      const intents = [fullWithdrawal(0), partialWithdrawal(1, 5n * GWEI_PER_ETH)];

      await expect(gateway.connect(requester).triggerWithdrawals(intents, requester.address, { value: 2n }))
        .to.emit(gateway, "WithdrawalsTriggered")
        .withArgs(requester.address, 2, 2048n + 5n);
    });

    it("does not notify the StakingRouter", async () => {
      const tx = gateway.connect(requester).triggerWithdrawals([fullWithdrawal(0)], requester.address, { value: 1n });

      await expect(tx).to.not.be.reverted;
      expect((await (await tx).wait())!.logs.map((log) => log.address)).to.have.members([
        await withdrawalVault.getAddress(),
        await gateway.getAddress(),
      ]);
    });
  });

  context("weights", () => {
    const cases: { name: string; intents: WithdrawalIntent[]; weightEth: bigint }[] = [
      { name: "full withdrawal", intents: [fullWithdrawal(0)], weightEth: 2048n },
      { name: "1 gwei partial withdrawal", intents: [partialWithdrawal(0, 1n)], weightEth: 1n },
      { name: "1 ETH partial withdrawal", intents: [partialWithdrawal(0, GWEI_PER_ETH)], weightEth: 1n },
      { name: "1 ETH + 1 gwei partial withdrawal", intents: [partialWithdrawal(0, GWEI_PER_ETH + 1n)], weightEth: 2n },
      {
        name: "max partial withdrawal",
        intents: [partialWithdrawal(0, MAX_PARTIAL_WITHDRAWAL_AMOUNT_GWEI)],
        weightEth: 2048n,
      },
      {
        name: "mixed batch, rounded per intent",
        intents: [
          partialWithdrawal(0, GWEI_PER_ETH / 2n),
          partialWithdrawal(1, GWEI_PER_ETH / 2n),
          fullWithdrawal(2),
          partialWithdrawal(3, 31n * GWEI_PER_ETH + 1n),
        ],
        weightEth: 1n + 1n + 2048n + 32n,
      },
    ];

    for (const { name, intents, weightEth } of cases) {
      it(`consumes ${weightEth} ETH of the limit for ${name}`, async () => {
        await expect(
          gateway.connect(requester).triggerWithdrawals(intents, requester.address, { value: BigInt(intents.length) }),
        )
          .to.emit(gateway, "WithdrawalsTriggered")
          .withArgs(requester.address, intents.length, weightEth);

        expect(await currentLimit()).to.equal(DEFAULT_TWG_LIMIT.maxExitBalanceEth - weightEth);
      });
    }
  });

  context("refund", () => {
    beforeEach(async () => {
      await withdrawalVault.mock__setFee(3n);
    });

    it("refunds the excess fee to the refund recipient", async () => {
      await expect(
        gateway
          .connect(requester)
          .triggerWithdrawals([fullWithdrawal(0), fullWithdrawal(1)], refundRecipient.address, { value: 10n }),
      ).to.changeEtherBalances([requester, refundRecipient, withdrawalVault, gateway], [-10n, 4n, 6n, 0n]);
    });

    it("refunds the excess fee to the caller if the refund recipient is zero address", async () => {
      await expect(
        gateway
          .connect(requester)
          .triggerWithdrawals([fullWithdrawal(0), fullWithdrawal(1)], ethers.ZeroAddress, { value: 10n }),
      ).to.changeEtherBalances([requester, withdrawalVault, gateway], [-6n, 6n, 0n]);
    });

    it("does not refund if the exact fee is passed", async () => {
      await expect(
        gateway.connect(requester).triggerWithdrawals([fullWithdrawal(0)], refundRecipient.address, { value: 3n }),
      ).to.changeEtherBalances([requester, refundRecipient, withdrawalVault, gateway], [-3n, 0n, 3n, 0n]);
    });

    it("reverts if the refund fails", async () => {
      const refundReverter = await ethers.deployContract("RefundReverter");

      await expect(
        gateway
          .connect(requester)
          .triggerWithdrawals([fullWithdrawal(0)], await refundReverter.getAddress(), { value: 4n }),
      ).to.be.revertedWithCustomError(gateway, "FeeRefundFailed");
    });
  });
});
