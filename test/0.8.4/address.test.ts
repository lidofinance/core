import { expect } from "chai";
import { randomBytes } from "crypto";
import { AbiCoder, hexlify } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { getStorageAt, setCode } from "@nomicfoundation/hardhat-network-helpers";

import {
  Address__Harness,
  Address__Harness__factory,
  Recipient__MockForAddress,
  Recipient__MockForAddress__factory,
} from "typechain-types";

import { batch, certainAddress } from "lib";

// this contract code reverts any call to it
const INVALID_BYTECODE = "0xFE";

// TODO: refactor similar tests for similar functions
describe("Address", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let address: Address__Harness;

  beforeEach(async () => {
    [deployer, user] = await ethers.getSigners();

    address = await new Address__Harness__factory(deployer).deploy();
    address = address.connect(user);
  });

  context("isContract", () => {
    it("Returns true if the account is a contract", async () => {
      const someContract = certainAddress("test:address-lib:random-contract");
      await setCode(someContract, "0xabcd");

      expect(await address.isContract(someContract)).to.be.true;
    });

    it("Returns false if the account is an EOA", async () => {
      expect(await address.isContract(certainAddress("test:address-lib:random-eoa"))).to.be.false;
    });
  });

  context("sendValue", () => {
    const recipient = certainAddress("test:address-lib:recipient");

    it("Reverts if there's not enough ether", async () => {
      await expect(address.sendValue(recipient, 1n)).to.be.revertedWith("Address: insufficient balance");
    });

    it("Reverts if the recipient rejects", async () => {
      const rejectingRecipient = certainAddress("test:address-lib:rejecting-contract");
      await setCode(rejectingRecipient, INVALID_BYTECODE);

      await expect(address.sendValue(rejectingRecipient, 1n, { value: 1n })).to.be.revertedWith(
        "Address: unable to send value, recipient may have reverted",
      );
    });

    it("Transfers value to recipient", async () => {
      const before = await batch({
        senderBalance: ethers.provider.getBalance(user),
        recipientBalance: ethers.provider.getBalance(recipient),
      });

      const value = 1n;
      const tx = await address.sendValue(recipient, value, { value });
      const receipt = await tx.wait();

      const after = await batch({
        senderBalance: ethers.provider.getBalance(user),
        recipientBalance: ethers.provider.getBalance(recipient),
      });

      expect(after.senderBalance).to.equal(before.senderBalance - value - receipt!.fee);
      expect(after.recipientBalance).to.equal(before.recipientBalance + value);
    });
  });

  context("functionCall", () => {
    let recipient: Recipient__MockForAddress;

    beforeEach(async () => {
      recipient = await new Recipient__MockForAddress__factory(deployer).deploy();
    });

    context("functionCall(address,bytes)", () => {
      it("Performs a low-level call", async () => {
        const number = await recipient.number();

        await address["functionCall(address,bytes)"](recipient, recipient.interface.encodeFunctionData("increment"));

        expect(await recipient.number()).to.equal(number + 1n);
      });
    });

    context("functionCall(address,bytes,string)", () => {
      it("Performs a low-level call with an error message", async () => {
        const number = await recipient.number();

        await address["functionCall(address,bytes,string)"](
          recipient,
          recipient.interface.encodeFunctionData("increment"),
          "error message",
        );

        expect(await recipient.number()).to.equal(number + 1n);
      });
    });

    context("functionCall(address,bytes,string)", () => {
      it("Sends value and performs a low-level call", async () => {
        const value = 1n;
        const number = await recipient.number();

        await address["functionCallWithValue(address,bytes,uint256)"](
          recipient,
          recipient.interface.encodeFunctionData("increment"),
          value,
          {
            value,
          },
        );

        expect(await recipient.number()).to.equal(number + 1n);
      });
    });

    context("functionCall(address,bytes,string)", () => {
      it("Sends value and performs a low-level call with a custom error message", async () => {
        const value = 1n;
        const number = await recipient.number();

        await address["functionCallWithValue(address,bytes,uint256,string)"](
          recipient,
          recipient.interface.encodeFunctionData("increment"),
          value,
          "error message",
          {
            value,
          },
        );

        expect(await recipient.number()).to.equal(number + 1n);
      });
    });

    context("functionStaticCall(address,bytes)", () => {
      it("Returns the result of staticcall", async () => {
        const expectedResult = await recipient.staticFunction.staticCall();

        const result = await address["functionStaticCall(address,bytes)"](
          recipient,
          recipient.interface.encodeFunctionData("staticFunction"),
        );

        expect(result).to.equal(new AbiCoder().encode(["string"], [expectedResult]));
      });

      it("Reverts on a non-static function", async () => {
        await expect(
          address["functionStaticCall(address,bytes)"](recipient, recipient.interface.encodeFunctionData("increment")),
        ).to.be.revertedWith("Address: low-level static call failed");
      });
    });

    context("functionStaticCall(address,bytes,string)", () => {
      it("Returns the result of staticcall", async () => {
        const expectedResult = await recipient.staticFunction.staticCall();

        const result = await address["functionStaticCall(address,bytes,string)"](
          recipient,
          recipient.interface.encodeFunctionData("staticFunction"),
          "my error message",
        );

        expect(result).to.equal(new AbiCoder().encode(["string"], [expectedResult]));
      });

      it("Reverts if the target is not a contract", async () => {
        await expect(
          address["functionStaticCall(address,bytes,string)"](
            certainAddress("test:address-lib:non-contract"),
            recipient.interface.encodeFunctionData("increment"),
            "my error message",
          ),
        ).to.be.revertedWith("Address: static call to non-contract");
      });

      it("Reverts on a non-static function", async () => {
        await expect(
          address["functionStaticCall(address,bytes,string)"](
            recipient,
            recipient.interface.encodeFunctionData("increment"),
            "my error message",
          ),
        ).to.be.revertedWith("my error message");
      });
    });

    context("functionDelegateCall(address,bytes)", () => {
      it("Writes to storage", async () => {
        const slot = hexlify(randomBytes(32));
        const value = hexlify(randomBytes(32));

        await address["functionDelegateCall(address,bytes)"](
          recipient,
          recipient.interface.encodeFunctionData("writeToStorage", [slot, value]),
        );

        expect(await getStorageAt(await address.getAddress(), slot)).to.equal(value);
      });

      it("Reverts if the target is not a contract", async () => {
        const slot = hexlify(randomBytes(32));
        const value = hexlify(randomBytes(32));

        await expect(
          address["functionDelegateCall(address,bytes)"](
            certainAddress("test:address-lib:non-contract"),
            recipient.interface.encodeFunctionData("writeToStorage", [slot, value]),
          ),
        ).to.be.revertedWith("Address: delegate call to non-contract");
      });
    });

    context("functionDelegateCall(address,bytes)", () => {
      it("Writes to storage", async () => {
        const slot = hexlify(randomBytes(32));
        const value = hexlify(randomBytes(32));

        await address["functionDelegateCall(address,bytes,string)"](
          recipient,
          recipient.interface.encodeFunctionData("writeToStorage", [slot, value]),
          "my error message",
        );

        expect(await getStorageAt(await address.getAddress(), slot)).to.equal(value);
      });

      it("Reverts with custom error message", async () => {
        await expect(
          address["functionDelegateCall(address,bytes,string)"](
            recipient,
            recipient.interface.encodeFunctionData("revertingFunction"),
            "my error message",
          ),
        ).to.be.revertedWith("my error message");
      });
    });
  });

  context("functionCallWithValue", () => {
    let recipient: Recipient__MockForAddress;

    beforeEach(async () => {
      recipient = await new Recipient__MockForAddress__factory(deployer).deploy();
    });

    it("Reverts if there's not enough ether", async () => {
      await expect(
        address["functionCallWithValue(address,bytes,uint256,string)"](recipient, "0x", 1n, "Error message"),
      ).to.be.revertedWith("Address: insufficient balance for call");
    });

    it("Reverts if the recipient is not a contract", async () => {
      const eoa = certainAddress("test:address-lib:eoa");

      await expect(
        address["functionCallWithValue(address,bytes,uint256,string)"](eoa, "0x", 1n, "Error message", {
          value: 1n,
        }),
      ).to.be.revertedWith("Address: call to non-contract");
    });

    it("Transfers value with no data", async () => {
      const before = await batch({
        senderBalance: ethers.provider.getBalance(user),
        recipientBalance: ethers.provider.getBalance(recipient),
      });

      const value = 1n;

      const tx = await address["functionCallWithValue(address,bytes,uint256,string)"](
        recipient,
        "0x",
        value,
        "Error message",
        {
          value,
        },
      );

      const receipt = await tx.wait();

      const after = await batch({
        senderBalance: ethers.provider.getBalance(user),
        recipientBalance: ethers.provider.getBalance(recipient),
      });

      expect(after.senderBalance).to.equal(before.senderBalance - value - receipt!.fee);
      expect(after.recipientBalance).to.equal(before.recipientBalance + value);
    });

    it("Reverts with error message if the recipient rejects", async () => {
      const receiveShouldRevert = true;
      await recipient.mock__receive(receiveShouldRevert);

      const value = 1n;
      const errorMessage = "Some error message";

      await expect(
        address["functionCallWithValue(address,bytes,uint256,string)"](recipient, "0x", value, errorMessage, {
          value,
        }),
      ).to.be.revertedWith(errorMessage);
    });

    it("Reverts if payload reverts", async () => {
      const value = 1n;
      const errorMessage = "Some error message";

      await expect(
        address["functionCallWithValue(address,bytes,uint256,string)"](
          recipient,
          recipient.interface.encodeFunctionData("revertingFunction"),
          value,
          errorMessage,
          {
            value,
          },
        ),
      ).to.be.revertedWith("Some error message");
    });

    it("Reverts with the original revert reason", async () => {
      await expect(
        address["functionCallWithValue(address,bytes,uint256,string)"](
          recipient,
          recipient.interface.encodeFunctionData("revertsWithMessage"),
          0n,
          "error message",
        ),
      ).to.be.revertedWith("Reverted");
    });
  });
});
