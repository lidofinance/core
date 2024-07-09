import { expect } from "chai";
import { MaxUint256, Signature, Signer, TypedDataDomain, TypedDataEncoder, ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { ExclusiveSuiteFunction, PendingSuiteFunction } from "mocha";

import { time } from "@nomicfoundation/hardhat-network-helpers";

import { IERC20, IERC2612 } from "typechain-types";

import { certainAddress, days, Permit, signPermit } from "lib";

import { Snapshot } from "test/suite";

interface ERC2612Target {
  tokenName: string;
  deploy: () => Promise<{
    token: IERC20 & IERC2612;
    domain: TypedDataDomain;
    owner: string;
    signer: Signer;
  }>;
  suiteFunction?: ExclusiveSuiteFunction | PendingSuiteFunction;
}

export function testERC2612Compliance({ tokenName, deploy, suiteFunction = describe }: ERC2612Target) {
  suiteFunction(`${tokenName} ERC-2612 Compliance`, () => {
    let token: IERC20 & IERC2612;
    let domain: TypedDataDomain;
    let owner: string;
    let signer: Signer;

    let permit: Permit;
    let signature: Signature;

    let originalState: string;

    before(async () => {
      ({ token, domain, owner, signer } = await deploy());

      const holderBalance = await token.balanceOf(owner);

      permit = {
        owner,
        spender: certainAddress("spender"),
        value: holderBalance,
        nonce: await token.nonces(owner),
        deadline: BigInt(await time.latest()) + days(7n),
      };
      signature = await signPermit(domain, permit, signer);
    });

    beforeEach(async () => (originalState = await Snapshot.take()));

    afterEach(async () => await Snapshot.restore(originalState));

    context("permit", () => {
      it("permit sets the allowance and increases nonce", async () => {
        const { owner, spender, value, nonce, deadline } = permit;
        const { v, r, s } = signature;

        await expect(token.permit(owner, spender, value, deadline, v, r, s))
          .to.emit(token, "Approval")
          .withArgs(owner, spender, value);

        expect(await token.allowance(owner, spender)).to.equal(value);
        expect(await token.nonces(owner)).to.equal(nonce + 1n);
      });

      it("The deadline argument can be set to uint(-1) to create Permits that effectively never expire.", async () => {
        const { owner, spender, value } = permit;
        const deadline = MaxUint256;
        const { v, r, s } = await signPermit(domain, { ...permit, deadline }, signer);

        await expect(token.permit(owner, spender, value, deadline, v, r, s)).not.to.be.reverted;
      });

      context("Reverts if not", () => {
        it("The current blocktime is less than or equal to deadline", async () => {
          const deadline = BigInt(await time.latest());
          const { owner, spender, value } = permit;
          const { v, r, s } = await signPermit(domain, { ...permit, deadline }, signer);

          await expect(token.permit(owner, spender, value, deadline, v, r, s)).to.be.reverted;
        });

        it("owner is not the zero address", async () => {
          const { spender, value, deadline } = permit;
          const { v, r, s } = await signPermit(domain, { ...permit, owner: ZeroAddress }, signer);

          await expect(token.permit(ZeroAddress, spender, value, deadline, v, r, s)).to.be.reverted;
        });

        it("nonces[owner] (before the state update) is equal to nonce", async () => {
          const { owner, spender, value, deadline, nonce } = permit;
          const { v, r, s } = signature;

          await expect(token.permit(owner, spender, value, deadline, v, r, s)).not.to.be.reverted;
          expect(await token.nonces(owner)).to.equal(nonce + 1n);
          await expect(token.permit(owner, spender, value, deadline, v, r, s)).to.be.reverted;
        });

        it("r, s and v is a valid secp256k1 signature from owner of the message", async () => {
          const { owner, spender, value, deadline } = permit;
          const { v, r, s } = signature;

          await expect(token.permit(owner, spender, value, deadline, v + 1, r, s)).to.be.reverted;
        });

        it("r, s and v is a valid secp256k1 signature from owner of the message", async () => {
          const { owner, spender, value, deadline } = permit;
          const { v, r, s } = await signPermit(
            domain,
            { ...permit, owner: ZeroAddress },
            (await ethers.getSigners())[9],
          );

          await expect(token.permit(owner, spender, value, deadline, v, r, s)).to.be.reverted;
        });
      });

      it("Reverts if owner does not match", async () => {
        const { spender, value, deadline } = permit;
        const { v, r, s } = signature;

        await expect(token.permit(spender, spender, value, deadline, v, r, s)).to.be.reverted;
      });

      it("Reverts if spender does not match", async () => {
        const { owner, value, deadline } = permit;
        const { v, r, s } = signature;

        await expect(token.permit(owner, owner, value, deadline, v, r, s)).to.be.reverted;
      });

      it("Reverts if value does not match", async () => {
        const { owner, value, deadline } = permit;
        const { v, r, s } = signature;

        await expect(token.permit(owner, owner, value + 1n, deadline, v, r, s)).to.be.reverted;
      });

      it("Reverts if deadline does not match", async () => {
        const { owner, value } = permit;
        const { v, r, s } = signature;

        await expect(token.permit(owner, owner, value, BigInt(await time.latest()) + days(1n), v, r, s)).to.be.reverted;
      });
    });

    context("DOMAIN_SEPARATOR", () => {
      it("Matches the expected value", async () => {
        const expected = TypedDataEncoder.hashDomain(domain);

        expect(await token.DOMAIN_SEPARATOR()).to.equal(expected);
      });
    });
  });
}

testERC2612Compliance.only = (target: ERC2612Target) =>
  testERC2612Compliance({
    ...target,
    suiteFunction: describe.only, // eslint-disable-line no-only-tests/no-only-tests
  });

testERC2612Compliance.skip = (target: ERC2612Target) =>
  testERC2612Compliance({
    ...target,
    suiteFunction: describe.skip,
  });
