import { expect } from "chai";
import { ethers } from "hardhat";

import { WithdrawalCredentials_Harness, WithdrawalsPredeployed_Mock } from "typechain-types";

import { findEventsWithInterfaces } from "lib";

const withdrawalRequestEventABI = ["event WithdrawalRequestAdded(bytes pubkey, uint256 amount)"];
const withdrawalRequestEventInterface = new ethers.Interface(withdrawalRequestEventABI);

const withdrawalsPredeployedHardcodedAddress = "0x0c15F14308530b7CDB8460094BbB9cC28b9AaaAA";

export async function deployWithdrawalsPredeployedMock(): Promise<WithdrawalsPredeployed_Mock> {
  const withdrawalsPredeployed = await ethers.deployContract("WithdrawalsPredeployed_Mock");
  const withdrawalsPredeployedAddress = await withdrawalsPredeployed.getAddress();

  await ethers.provider.send("hardhat_setCode", [
    withdrawalsPredeployedHardcodedAddress,
    await ethers.provider.getCode(withdrawalsPredeployedAddress),
  ]);

  const contract = await ethers.getContractAt("WithdrawalsPredeployed_Mock", withdrawalsPredeployedHardcodedAddress);
  await contract.setFee(1n);
  return contract;
}

function toValidatorPubKey(num: number): string {
  if (num < 0 || num > 0xffff) {
    throw new Error("Number is out of the 2-byte range (0x0000 - 0xFFFF).");
  }

  return `0x${num.toString(16).padStart(4, "0").repeat(24)}`;
}

const convertEthToGwei = (ethAmount: string | number): bigint => {
  const ethString = ethAmount.toString();
  const wei = ethers.parseEther(ethString);
  return wei / 1_000_000_000n;
};

function generateWithdrawalRequestPayload(numberOfRequests: number) {
  const pubkeys: string[] = [];
  const amounts: bigint[] = [];
  for (let i = 1; i <= numberOfRequests; i++) {
    pubkeys.push(toValidatorPubKey(i));
    amounts.push(convertEthToGwei(i));
  }

  return { pubkeys, amounts };
}

export function tesWithdrawalRequestsBehavior(
  getContract: () => WithdrawalCredentials_Harness,
  getWithdrawalsPredeployedContract: () => WithdrawalsPredeployed_Mock,
) {
  async function getFee(requestsCount: number): Promise<bigint> {
    const fee = await getContract().getWithdrawalRequestFee();

    return ethers.parseUnits((fee * BigInt(requestsCount)).toString(), "wei");
  }

  async function getWithdrawalCredentialsContractBalance(): Promise<bigint> {
    const contract = getContract();
    const contractAddress = await contract.getAddress();
    return await ethers.provider.getBalance(contractAddress);
  }

  async function addWithdrawalRequests(requestCount: number, extraFee: bigint = 0n) {
    const contract = getContract();
    const initialBalance = await getWithdrawalCredentialsContractBalance();

    const { pubkeys, amounts } = generateWithdrawalRequestPayload(requestCount);

    const fee = (await getFee(pubkeys.length)) + extraFee;
    const tx = await contract.addWithdrawalRequests(pubkeys, amounts, { value: fee });

    expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance);

    const receipt = await tx.wait();

    expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance);

    const events = findEventsWithInterfaces(receipt!, "WithdrawalRequestAdded", [withdrawalRequestEventInterface]);
    expect(events.length).to.equal(requestCount);

    for (let i = 0; i < requestCount; i++) {
      expect(events[i].args[0]).to.equal(pubkeys[i]);
      expect(events[i].args[1]).to.equal(amounts[i]);
    }
  }

  context("addWithdrawalRequests", async () => {
    it("Should revert if array lengths do not match or empty arrays are provided", async function () {
      const { pubkeys, amounts } = generateWithdrawalRequestPayload(2);
      amounts.pop();

      expect(
        pubkeys.length !== amounts.length,
        "Test setup error: pubkeys and amounts arrays should have different lengths.",
      );

      const contract = getContract();

      const fee = await getFee(pubkeys.length);
      await expect(contract.addWithdrawalRequests(pubkeys, amounts, { value: fee }))
        .to.be.revertedWithCustomError(contract, "InvalidArrayLengths")
        .withArgs(pubkeys.length, amounts.length);

      // Also test empty arrays
      await expect(contract.addWithdrawalRequests([], [], { value: fee }))
        .to.be.revertedWithCustomError(contract, "InvalidArrayLengths")
        .withArgs(0, 0);
    });

    it("Should revert if not enough fee is sent", async function () {
      const { pubkeys, amounts } = generateWithdrawalRequestPayload(1);
      const contract = getContract();

      await getWithdrawalsPredeployedContract().setFee(3n); // Set fee to 3 gwei

      // Should revert if no fee is sent
      await expect(contract.addWithdrawalRequests(pubkeys, amounts)).to.be.revertedWithCustomError(
        contract,
        "FeeNotEnough",
      );

      // Should revert if fee is less than required
      const insufficientFee = 2n;
      await expect(
        contract.addWithdrawalRequests(pubkeys, amounts, { value: insufficientFee }),
      ).to.be.revertedWithCustomError(contract, "FeeNotEnough");
    });

    it("Should revert if any pubkey is not 48 bytes", async function () {
      // Invalid pubkey (only 2 bytes)
      const pubkeys = ["0x1234"];
      const amounts = [100n];

      const fee = await getFee(pubkeys.length);
      const contract = getContract();
      await expect(contract.addWithdrawalRequests(pubkeys, amounts, { value: fee }))
        .to.be.revertedWithCustomError(contract, "InvalidPubkeyLength")
        .withArgs(pubkeys[0]);
    });

    it("Should revert if addition fails at the withdrawal request contract", async function () {
      const { pubkeys, amounts } = generateWithdrawalRequestPayload(1);
      const fee = await getFee(pubkeys.length);

      // Set mock to fail on add
      await getWithdrawalsPredeployedContract().setFailOnAddRequest(true);
      const contract = getContract();

      await expect(contract.addWithdrawalRequests(pubkeys, amounts, { value: fee })).to.be.revertedWithCustomError(
        contract,
        "WithdrawalRequestAdditionFailed",
      );
    });

    it("Should accept full and partial withdrawals", async function () {
      const { pubkeys, amounts } = generateWithdrawalRequestPayload(2);
      amounts[0] = 0n; // Full withdrawal
      amounts[1] = 1n; // Partial withdrawal

      const fee = await getFee(pubkeys.length);
      const contract = getContract();

      await contract.addWithdrawalRequests(pubkeys, amounts, { value: fee });
    });

    it("Should accept exactly required fee without revert", async function () {
      const requestCount = 1;
      const { pubkeys, amounts } = generateWithdrawalRequestPayload(requestCount);

      const contract = getContract();
      const initialBalance = await getWithdrawalCredentialsContractBalance();

      await getWithdrawalsPredeployedContract().setFee(3n);
      expect((await contract.getWithdrawalRequestFee()) == 3n, "Test setup error: invalid withdrawal request fee.");
      const fee = 3n;

      await contract.addWithdrawalRequests(pubkeys, amounts, { value: fee });

      expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance);
    });

    it("Should accept exceed fee without revert", async function () {
      const requestCount = 1;
      const { pubkeys, amounts } = generateWithdrawalRequestPayload(requestCount);

      const contract = getContract();
      const initialBalance = await getWithdrawalCredentialsContractBalance();

      await getWithdrawalsPredeployedContract().setFee(3n);
      expect((await contract.getWithdrawalRequestFee()) == 3n, "Test setup error: invalid withdrawal request fee.");
      const fee = 3n + 1n; // 1 request * 3 gwei (fee) + 1 gwei (extra fee)= 4 gwei

      await contract.addWithdrawalRequests(pubkeys, amounts, { value: fee });
      expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance);
    });

    it("Should successfully add requests and emit events", async function () {
      await addWithdrawalRequests(1);
      await addWithdrawalRequests(3);
      await addWithdrawalRequests(10);
      await addWithdrawalRequests(100);
    });

    it("Should successfully add requests  with extra fee and not change contract balance", async function () {
      await addWithdrawalRequests(1, 100n);
      await addWithdrawalRequests(3, 1n);
      await addWithdrawalRequests(10, 1_000_000n);
      await addWithdrawalRequests(7, 3n);
      await addWithdrawalRequests(100, 0n);
    });
  });
}
