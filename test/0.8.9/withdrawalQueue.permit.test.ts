import { expect } from "chai";
import { TypedDataDomain } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import {
  StETHPermit__HarnessForWithdrawalQueueDeploy,
  WithdrawalQueueERC721,
  WstETH__HarnessForWithdrawalQueueDeploy,
} from "typechain-types";

import { ether, signPermit, stethDomain, wstethDomain } from "lib";

import { deployWithdrawalQueue } from "test/deploy";
import { Snapshot } from "test/suite";

// https://github.com/lidofinance/core/issues/803
describe("WithdrawalQueue.sol:permit front-run", () => {
  let admin: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  let queue: WithdrawalQueueERC721;
  let queueAddress: string;
  let stEth: StETHPermit__HarnessForWithdrawalQueueDeploy;
  let wstEth: WstETH__HarnessForWithdrawalQueueDeploy;

  const requests = [ether("1.00"), ether("1.00")];
  const value = ether("2.00");

  let originalState: string;

  before(async () => {
    [admin, alice, attacker] = await ethers.getSigners();

    ({ queue, queueAddress, stEth, wstEth } = await deployWithdrawalQueue({
      stEthSettings: { initialStEth: ether("1.00"), owner: alice, ownerStEth: ether("10.00") },
      queueAdmin: admin,
    }));

    await stEth.connect(alice).approve(wstEth, ether("5.00"));
    await wstEth.connect(alice).wrap(ether("5.00"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  // signs a permit of `value` for the queue that expires in `ttl` seconds
  async function signQueuePermit(domain: TypedDataDomain, nonce: bigint, ttl = 3600n) {
    const deadline = BigInt(await time.latest()) + ttl;
    const { v, r, s } = await signPermit(
      domain,
      { owner: alice.address, spender: queueAddress, value, nonce, deadline },
      alice,
    );
    return { value, deadline, v, r, s };
  }

  type Token = typeof stEth | typeof wstEth;

  // submits the signature from the pending transaction on behalf of the attacker
  async function frontRun(token: Token, permit: { deadline: bigint; v: number; r: string; s: string }) {
    await token.connect(attacker).permit(alice, queueAddress, value, permit.deadline, permit.v, permit.r, permit.s);
  }

  context("stETH", () => {
    let domain: TypedDataDomain;

    before(async () => (domain = await stethDomain(stEth)));

    it("Creates requests when the signature is already used by a front-run", async () => {
      const permit = await signQueuePermit(domain, await stEth.nonces(alice));
      await frontRun(stEth, permit);

      // the signature is spent, so permit() alone reverts now
      await expect(
        stEth.permit(alice, queueAddress, value, permit.deadline, permit.v, permit.r, permit.s),
      ).to.be.revertedWith("INVALID_SIGNATURE");

      await expect(queue.connect(alice).requestWithdrawalsWithPermit(requests, alice, permit))
        .to.emit(queue, "WithdrawalRequested")
        .to.emit(queue, "WithdrawalRequested");

      expect(await queue.getLastRequestId()).to.equal(2n);
      expect(await stEth.allowance(alice, queueAddress)).to.be.lte(1n);
    });

    it("Spends the signature when it's not front-run", async () => {
      const nonce = await stEth.nonces(alice);
      const permit = await signQueuePermit(domain, nonce);

      await expect(queue.connect(alice).requestWithdrawalsWithPermit(requests, alice, permit)).to.emit(
        queue,
        "WithdrawalRequested",
      );

      expect(await stEth.nonces(alice)).to.equal(nonce + 1n);
    });

    it("Accepts the front-run permit until its deadline inclusive", async () => {
      const permit = await signQueuePermit(domain, await stEth.nonces(alice), 100n);
      await frontRun(stEth, permit);

      await time.setNextBlockTimestamp(permit.deadline);
      await expect(queue.connect(alice).requestWithdrawalsWithPermit(requests, alice, permit)).to.emit(
        queue,
        "WithdrawalRequested",
      );
    });

    it("Reverts the front-run permit after its deadline", async () => {
      const permit = await signQueuePermit(domain, await stEth.nonces(alice), 100n);
      await frontRun(stEth, permit);

      await time.setNextBlockTimestamp(permit.deadline + 1n);
      await expect(queue.connect(alice).requestWithdrawalsWithPermit(requests, alice, permit)).to.be.revertedWith(
        "DEADLINE_EXPIRED",
      );
    });

    it("Does not let the caller spend the tokens of the signer even after a front-run", async () => {
      const permit = await signQueuePermit(domain, await stEth.nonces(alice));
      await frontRun(stEth, permit);
      const aliceBalance = await stEth.balanceOf(alice);

      // the signature is checked against the caller, and the fallback checks the caller's allowance only
      await expect(queue.connect(attacker).requestWithdrawalsWithPermit(requests, attacker, permit)).to.be.revertedWith(
        "INVALID_SIGNATURE",
      );

      expect(await stEth.balanceOf(alice)).to.equal(aliceBalance);
      expect(await stEth.allowance(alice, queueAddress)).to.equal(value);
    });
  });

  context("wstETH", () => {
    let domain: TypedDataDomain;

    before(async () => (domain = await wstethDomain(wstEth)));

    it("Creates requests when the signature is already used by a front-run", async () => {
      const permit = await signQueuePermit(domain, await wstEth.nonces(alice));
      await frontRun(wstEth, permit);

      // the signature is spent, so permit() alone reverts now
      await expect(
        wstEth.permit(alice, queueAddress, value, permit.deadline, permit.v, permit.r, permit.s),
      ).to.be.revertedWith("ERC20Permit: invalid signature");

      await expect(queue.connect(alice).requestWithdrawalsWstETHWithPermit(requests, alice, permit))
        .to.emit(queue, "WithdrawalRequested")
        .to.emit(queue, "WithdrawalRequested");

      expect(await queue.getLastRequestId()).to.equal(2n);
      expect(await wstEth.allowance(alice, queueAddress)).to.equal(0n);
    });

    it("Reverts the front-run permit after its deadline", async () => {
      const permit = await signQueuePermit(domain, await wstEth.nonces(alice), 100n);
      await frontRun(wstEth, permit);

      await time.setNextBlockTimestamp(permit.deadline + 1n);
      await expect(queue.connect(alice).requestWithdrawalsWstETHWithPermit(requests, alice, permit)).to.be.revertedWith(
        "ERC20Permit: expired deadline",
      );
    });
  });
});
