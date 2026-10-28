import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { TriggerableWithdrawalsGateway, WithdrawalVault__MockForTriggerableWithdrawalsGateway } from "typechain-types";

import { deployTriggerableWithdrawalsGateway } from "test/deploy";
import { Snapshot } from "test/suite";

import {
  DEFAULT_CONSUMER_LIMITS,
  fullWithdrawal,
  GWEI_PER_ETH,
  MAX_PWR_AMOUNT_GWEI,
  partialWithdrawal,
  WithdrawalIntent,
} from "../triggerable-withdrawals-helpers";

describe("TriggerableWithdrawalsGateway.sol: triggerWithdrawals", () => {
  let gateway: TriggerableWithdrawalsGateway;
  let withdrawalVault: WithdrawalVault__MockForTriggerableWithdrawalsGateway;
  let admin: HardhatEthersSigner;
  let requester: HardhatEthersSigner;
  let refundRecipient: HardhatEthersSigner;

  let originalState: string;

  before(async () => {
    [admin, requester, refundRecipient] = await ethers.getSigners();

    ({ gateway, withdrawalVault } = await deployTriggerableWithdrawalsGateway(admin));

    await gateway.connect(admin).grantRole(await gateway.TW_EXIT_LIMIT_MANAGER_ROLE(), admin.address);
    await gateway
      .connect(admin)
      .setConsumerLimits(requester.address, DEFAULT_CONSUMER_LIMITS.pwr, DEFAULT_CONSUMER_LIMITS.fwr);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  const currentLimits = async () => {
    const { pwrLimit, fwrLimit } = await gateway.getConsumerLimitsFullInfo(requester.address);
    return { pwr: pwrLimit.currentLimit, fwr: fwrLimit.currentLimit };
  };

  context("validation", () => {
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

    it("does not cap a single partial withdrawal amount: the PWR limit bounds it", async () => {
      const amount = MAX_PWR_AMOUNT_GWEI + 1n;

      await expect(
        gateway.connect(requester).triggerWithdrawals([partialWithdrawal(0, amount)], requester.address, { value: 1n }),
      )
        .to.emit(gateway, "WithdrawalsTriggered")
        .withArgs(requester.address, 1, amount, 0);
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

    it("emits WithdrawalsTriggered with the consumed quotas", async () => {
      const intents = [fullWithdrawal(0), partialWithdrawal(1, 5n * GWEI_PER_ETH), fullWithdrawal(2)];

      await expect(gateway.connect(requester).triggerWithdrawals(intents, requester.address, { value: 3n }))
        .to.emit(gateway, "WithdrawalsTriggered")
        .withArgs(requester.address, 1, 5n * GWEI_PER_ETH, 2);
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

  context("consumed quotas", () => {
    const cases: { name: string; intents: WithdrawalIntent[]; pwrAmountGwei: bigint; fwrCount: bigint }[] = [
      { name: "full withdrawal", intents: [fullWithdrawal(0)], pwrAmountGwei: 0n, fwrCount: 1n },
      { name: "1 gwei partial withdrawal", intents: [partialWithdrawal(0, 1n)], pwrAmountGwei: 1n, fwrCount: 0n },
      {
        name: "1 ETH + 1 gwei partial withdrawal",
        intents: [partialWithdrawal(0, GWEI_PER_ETH + 1n)],
        pwrAmountGwei: GWEI_PER_ETH + 1n,
        fwrCount: 0n,
      },
      {
        name: "max partial withdrawal",
        intents: [partialWithdrawal(0, MAX_PWR_AMOUNT_GWEI)],
        pwrAmountGwei: MAX_PWR_AMOUNT_GWEI,
        fwrCount: 0n,
      },
      {
        name: "mixed batch",
        intents: [
          partialWithdrawal(0, GWEI_PER_ETH / 2n),
          partialWithdrawal(1, 1n),
          fullWithdrawal(2),
          partialWithdrawal(3, 31n * GWEI_PER_ETH + 1n),
          fullWithdrawal(4),
        ],
        pwrAmountGwei: GWEI_PER_ETH / 2n + 1n + 31n * GWEI_PER_ETH + 1n,
        fwrCount: 2n,
      },
    ];

    for (const { name, intents, pwrAmountGwei, fwrCount } of cases) {
      it(`consumes ${pwrAmountGwei} gwei of the PWR limit and ${fwrCount} of the FWR limit for ${name}`, async () => {
        const pwrCount = BigInt(intents.length) - fwrCount;

        await expect(
          gateway.connect(requester).triggerWithdrawals(intents, requester.address, { value: BigInt(intents.length) }),
        )
          .to.emit(gateway, "WithdrawalsTriggered")
          .withArgs(requester.address, pwrCount, pwrAmountGwei, fwrCount);

        expect(await currentLimits()).to.deep.equal({
          pwr: DEFAULT_CONSUMER_LIMITS.pwr.maxLimit - pwrAmountGwei,
          fwr: DEFAULT_CONSUMER_LIMITS.fwr.maxLimit - fwrCount,
        });
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
