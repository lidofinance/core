import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  ERC20__Harness,
  ERC721__Harness,
  Lido__MockForWithdrawalVault,
  WithdrawalsPredeployed_Mock,
  WithdrawalVault__Harness,
} from "typechain-types";

import { MAX_UINT256, proxify, streccak } from "lib";

import { Snapshot } from "test/suite";

import { findEip7002TriggerableWithdrawalMockEvents, findEvents } from "./lib/triggerableWithdrawals/findEvents";
import {
  deployWithdrawalsPredeployedMock,
  generateWithdrawalRequestPayload,
  withdrawalsPredeployedHardcodedAddress,
} from "./lib/triggerableWithdrawals/utils";

const PETRIFIED_VERSION = MAX_UINT256;

const ADD_FULL_WITHDRAWAL_REQUEST_ROLE = streccak("ADD_FULL_WITHDRAWAL_REQUEST_ROLE");

describe("WithdrawalVault.sol", () => {
  let owner: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let validatorsExitBus: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let originalState: string;

  let lido: Lido__MockForWithdrawalVault;
  let lidoAddress: string;

  let withdrawalsPredeployed: WithdrawalsPredeployed_Mock;

  let impl: WithdrawalVault__Harness;
  let vault: WithdrawalVault__Harness;
  let vaultAddress: string;

  before(async () => {
    [owner, treasury, validatorsExitBus, stranger] = await ethers.getSigners();

    withdrawalsPredeployed = await deployWithdrawalsPredeployedMock(1n);

    expect(await withdrawalsPredeployed.getAddress()).to.equal(withdrawalsPredeployedHardcodedAddress);

    lido = await ethers.deployContract("Lido__MockForWithdrawalVault");
    lidoAddress = await lido.getAddress();

    impl = await ethers.deployContract("WithdrawalVault__Harness", [lidoAddress, treasury.address], owner);

    [vault] = await proxify({ impl, admin: owner });
    vaultAddress = await vault.getAddress();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Constructor", () => {
    it("Reverts if the Lido address is zero", async () => {
      await expect(
        ethers.deployContract("WithdrawalVault", [ZeroAddress, treasury.address]),
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("Reverts if the treasury address is zero", async () => {
      await expect(ethers.deployContract("WithdrawalVault", [lidoAddress, ZeroAddress])).to.be.revertedWithCustomError(
        vault,
        "ZeroAddress",
      );
    });

    it("Sets initial properties", async () => {
      expect(await vault.LIDO()).to.equal(lidoAddress, "Lido address");
      expect(await vault.TREASURY()).to.equal(treasury.address, "Treasury address");
    });

    it("Petrifies the implementation", async () => {
      expect(await impl.getContractVersion()).to.equal(PETRIFIED_VERSION);
    });

    it("Returns 0 as the initial contract version", async () => {
      expect(await vault.getContractVersion()).to.equal(0n);
    });
  });

  context("initialize", () => {
    it("Should revert if the contract is already initialized", async () => {
      await vault.initialize(owner);

      await expect(vault.initialize(owner))
        .to.be.revertedWithCustomError(vault, "UnexpectedContractVersion")
        .withArgs(2, 0);
    });

    it("Initializes the contract", async () => {
      await expect(vault.initialize(owner)).to.emit(vault, "ContractVersionSet").withArgs(2);
    });

    it("Should revert if admin address is zero", async () => {
      await expect(vault.initialize(ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("Should set admin role during initialization", async () => {
      const adminRole = await vault.DEFAULT_ADMIN_ROLE();
      expect(await vault.getRoleMemberCount(adminRole)).to.equal(0);
      expect(await vault.hasRole(adminRole, owner)).to.equal(false);

      await vault.initialize(owner);

      expect(await vault.getRoleMemberCount(adminRole)).to.equal(1);
      expect(await vault.hasRole(adminRole, owner)).to.equal(true);
      expect(await vault.hasRole(adminRole, stranger)).to.equal(false);
    });
  });

  context("finalizeUpgrade_v2()", () => {
    it("Should revert with UnexpectedContractVersion error when called on implementation", async () => {
      await expect(impl.finalizeUpgrade_v2(owner))
        .to.be.revertedWithCustomError(impl, "UnexpectedContractVersion")
        .withArgs(MAX_UINT256, 1);
    });

    it("Should revert with UnexpectedContractVersion error when called on deployed from scratch WithdrawalVaultV2", async () => {
      await vault.initialize(owner);

      await expect(vault.finalizeUpgrade_v2(owner))
        .to.be.revertedWithCustomError(impl, "UnexpectedContractVersion")
        .withArgs(2, 1);
    });

    context("Simulate upgrade from v1", () => {
      beforeEach(async () => {
        await vault.harness__initializeContractVersionTo(1);
      });

      it("Should revert if admin address is zero", async () => {
        await expect(vault.finalizeUpgrade_v2(ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");
      });

      it("Should set correct contract version", async () => {
        expect(await vault.getContractVersion()).to.equal(1);
        await vault.finalizeUpgrade_v2(owner);
        expect(await vault.getContractVersion()).to.be.equal(2);
      });

      it("Should set admin role during finalization", async () => {
        const adminRole = await vault.DEFAULT_ADMIN_ROLE();
        expect(await vault.getRoleMemberCount(adminRole)).to.equal(0);
        expect(await vault.hasRole(adminRole, owner)).to.equal(false);

        await vault.finalizeUpgrade_v2(owner);

        expect(await vault.getRoleMemberCount(adminRole)).to.equal(1);
        expect(await vault.hasRole(adminRole, owner)).to.equal(true);
        expect(await vault.hasRole(adminRole, stranger)).to.equal(false);
      });
    });
  });

  context("Access control", () => {
    it("Returns ACL roles", async () => {
      expect(await vault.ADD_FULL_WITHDRAWAL_REQUEST_ROLE()).to.equal(ADD_FULL_WITHDRAWAL_REQUEST_ROLE);
    });

    it("Sets up roles", async () => {
      await vault.initialize(owner);

      expect(await vault.getRoleMemberCount(ADD_FULL_WITHDRAWAL_REQUEST_ROLE)).to.equal(0);
      expect(await vault.hasRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE, validatorsExitBus)).to.equal(false);

      await vault.connect(owner).grantRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE, validatorsExitBus);

      expect(await vault.getRoleMemberCount(ADD_FULL_WITHDRAWAL_REQUEST_ROLE)).to.equal(1);
      expect(await vault.hasRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE, validatorsExitBus)).to.equal(true);
    });
  });

  context("withdrawWithdrawals", () => {
    beforeEach(async () => await vault.initialize(owner));

    it("Reverts if the caller is not Lido", async () => {
      await expect(vault.connect(stranger).withdrawWithdrawals(0)).to.be.revertedWithCustomError(vault, "NotLido");
    });

    it("Reverts if amount is 0", async () => {
      await expect(lido.mock_withdrawFromVault(vaultAddress, 0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("Reverts if not enough funds are available", async () => {
      await expect(lido.mock_withdrawFromVault(vaultAddress, 1))
        .to.be.revertedWithCustomError(vault, "NotEnoughEther")
        .withArgs(1, 0);
    });

    it("Withdraws the requested amount", async () => {
      await setBalance(vaultAddress, 10);

      await expect(lido.mock_withdrawFromVault(vaultAddress, 1)).to.emit(lido, "WithdrawalsReceived").withArgs(1);
    });
  });

  context("recoverERC20", () => {
    let token: ERC20__Harness;
    let tokenAddress: string;

    before(async () => {
      token = await ethers.deployContract("ERC20__Harness", ["Test Token", "TT"]);

      tokenAddress = await token.getAddress();
    });

    it("Reverts if the token is not a contract", async () => {
      await expect(vault.recoverERC20(ZeroAddress, 1)).to.be.revertedWith("Address: call to non-contract");
    });

    it("Reverts if the recovered amount is 0", async () => {
      await expect(vault.recoverERC20(ZeroAddress, 0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("Transfers the requested amount", async () => {
      await token.mint(vaultAddress, 10);

      expect(await token.balanceOf(vaultAddress)).to.equal(10);
      expect(await token.balanceOf(treasury.address)).to.equal(0);

      await expect(vault.recoverERC20(tokenAddress, 1))
        .to.emit(vault, "ERC20Recovered")
        .withArgs(owner, tokenAddress, 1);

      expect(await token.balanceOf(vaultAddress)).to.equal(9);
      expect(await token.balanceOf(treasury.address)).to.equal(1);
    });
  });

  context("recoverERC721", () => {
    let token: ERC721__Harness;
    let tokenAddress: string;

    before(async () => {
      token = await ethers.deployContract("ERC721__Harness", ["Test NFT", "tNFT"]);

      tokenAddress = await token.getAddress();
    });

    it("Reverts if the token is not a contract", async () => {
      await expect(vault.recoverERC721(ZeroAddress, 0)).to.be.reverted;
    });

    it("Transfers the requested token id", async () => {
      await token.mint(vaultAddress, 1);

      expect(await token.ownerOf(1)).to.equal(vaultAddress);
      expect(await token.ownerOf(1)).to.not.equal(treasury.address);

      await expect(vault.recoverERC721(tokenAddress, 1))
        .to.emit(vault, "ERC721Recovered")
        .withArgs(owner, tokenAddress, 1);

      expect(await token.ownerOf(1)).to.equal(treasury.address);
    });
  });

  context("get triggerable withdrawal request fee", () => {
    it("Should get fee from the EIP 7002 contract", async function () {
      await withdrawalsPredeployed.setFee(333n);
      expect(
        (await vault.getWithdrawalRequestFee()) == 333n,
        "withdrawal request should use fee from the EIP 7002 contract",
      );
    });

    it("Should revert if fee read fails", async function () {
      await withdrawalsPredeployed.setFailOnGetFee(true);
      await expect(vault.getWithdrawalRequestFee()).to.be.revertedWithCustomError(
        vault,
        "WithdrawalRequestFeeReadFailed",
      );
    });
  });

  async function getFee(): Promise<bigint> {
    const fee = await vault.getWithdrawalRequestFee();

    return ethers.parseUnits(fee.toString(), "wei");
  }

  async function getWithdrawalCredentialsContractBalance(): Promise<bigint> {
    const contractAddress = await vault.getAddress();
    return await ethers.provider.getBalance(contractAddress);
  }

  async function getWithdrawalsPredeployedContractBalance(): Promise<bigint> {
    const contractAddress = await withdrawalsPredeployed.getAddress();
    return await ethers.provider.getBalance(contractAddress);
  }

  context("add triggerable withdrawal requests", () => {
    beforeEach(async () => {
      await vault.initialize(owner);
      await vault.connect(owner).grantRole(ADD_FULL_WITHDRAWAL_REQUEST_ROLE, validatorsExitBus);
    });

    it("Should revert if the caller is not Validator Exit Bus", async () => {
      await expect(
        vault.connect(stranger).addFullWithdrawalRequests(["0x1234"]),
      ).to.be.revertedWithOZAccessControlError(stranger.address, ADD_FULL_WITHDRAWAL_REQUEST_ROLE);
    });

    it("Should revert if empty arrays are provided", async function () {
      await expect(
        vault.connect(validatorsExitBus).addFullWithdrawalRequests([], { value: 1n }),
      ).to.be.revertedWithCustomError(vault, "NoWithdrawalRequests");
    });

    it("Should revert if not enough fee is sent", async function () {
      const { pubkeys } = generateWithdrawalRequestPayload(1);

      await withdrawalsPredeployed.setFee(3n); // Set fee to 3 gwei

      // 1. Should revert if no fee is sent
      await expect(vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeys))
        .to.be.revertedWithCustomError(vault, "InsufficientTriggerableWithdrawalFee")
        .withArgs(0, 3n, 1);

      // 2. Should revert if fee is less than required
      const insufficientFee = 2n;
      await expect(vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeys, { value: insufficientFee }))
        .to.be.revertedWithCustomError(vault, "InsufficientTriggerableWithdrawalFee")
        .withArgs(2n, 3n, 1);
    });

    it("Should revert if any pubkey is not 48 bytes", async function () {
      // Invalid pubkey (only 2 bytes)
      const pubkeys = ["0x1234"];

      const fee = await getFee();

      await expect(vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeys, { value: fee }))
        .to.be.revertedWithCustomError(vault, "InvalidPubkeyLength")
        .withArgs(pubkeys[0]);
    });

    it("Should revert if addition fails at the withdrawal request contract", async function () {
      const { pubkeys } = generateWithdrawalRequestPayload(1);
      const fee = await getFee();

      // Set mock to fail on add
      await withdrawalsPredeployed.setFailOnAddRequest(true);

      await expect(
        vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeys, { value: fee }),
      ).to.be.revertedWithCustomError(vault, "WithdrawalRequestAdditionFailed");
    });

    it("Should revert when fee read fails", async function () {
      await withdrawalsPredeployed.setFailOnGetFee(true);

      const { pubkeys } = generateWithdrawalRequestPayload(2);
      const fee = 10n;

      await expect(
        vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeys, { value: fee }),
      ).to.be.revertedWithCustomError(vault, "WithdrawalRequestFeeReadFailed");
    });

    it("Should accept withdrawal requests when the provided fee matches the exact required amount", async function () {
      const requestCount = 3;
      const { pubkeys } = generateWithdrawalRequestPayload(requestCount);

      await withdrawalsPredeployed.setFee(3n);
      const expectedTotalWithdrawalFee = 9n;

      await vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeys, { value: expectedTotalWithdrawalFee });

      // Check extremely high fee
      await withdrawalsPredeployed.setFee(ethers.parseEther("10"));
      const expectedLargeTotalWithdrawalFee = ethers.parseEther("30");

      await vault
        .connect(validatorsExitBus)
        .addFullWithdrawalRequests(pubkeys, { value: expectedLargeTotalWithdrawalFee });
    });

    it("Should accept withdrawal requests when the provided fee exceeds the required amount", async function () {
      const requestCount = 3;
      const { pubkeys } = generateWithdrawalRequestPayload(requestCount);

      await withdrawalsPredeployed.setFee(3n);
      const fee = 9n + 1n; // 3 request * 3 gwei (fee) + 1 gwei (extra fee)= 10 gwei

      await vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeys, { value: fee });

      // Check when the provided fee extremely exceeds the required amount
      const largeTotalWithdrawalFee = ethers.parseEther("10");

      await vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeys, { value: largeTotalWithdrawalFee });
    });

    it("Should not affect contract balance", async function () {
      const requestCount = 3;
      const { pubkeys } = generateWithdrawalRequestPayload(requestCount);

      await withdrawalsPredeployed.setFee(3n);
      const expectedTotalWithdrawalFee = 9n; // 3 requests * 3 gwei (fee) = 9 gwei

      const initialBalance = await getWithdrawalCredentialsContractBalance();
      await vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeys, { value: expectedTotalWithdrawalFee });
      expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance);

      const excessTotalWithdrawalFee = 9n + 1n; // 3 requests * 3 gwei (fee) + 1 gwei (extra fee) = 10 gwei
      await vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeys, { value: excessTotalWithdrawalFee });
      expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance);
    });

    // ToDo: should return back the excess fee

    it("Should transfer the total calculated fee to the EIP-7002 withdrawal contract", async function () {
      const requestCount = 3;
      const { pubkeys } = generateWithdrawalRequestPayload(requestCount);

      await withdrawalsPredeployed.setFee(3n);
      const expectedTotalWithdrawalFee = 9n;
      const excessTotalWithdrawalFee = 9n + 1n;

      let initialBalance = await getWithdrawalsPredeployedContractBalance();
      await vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeys, { value: expectedTotalWithdrawalFee });
      expect(await getWithdrawalsPredeployedContractBalance()).to.equal(initialBalance + expectedTotalWithdrawalFee);

      initialBalance = await getWithdrawalsPredeployedContractBalance();
      await vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeys, { value: excessTotalWithdrawalFee });
      // Only the expected fee should be transferred
      expect(await getWithdrawalsPredeployedContractBalance()).to.equal(initialBalance + expectedTotalWithdrawalFee);
    });

    it("Should emit a 'WithdrawalRequestAdded' event when a new withdrawal request is added", async function () {
      const requestCount = 3;
      const { pubkeys, fullWithdrawalAmounts } = generateWithdrawalRequestPayload(requestCount);
      const fee = 10n;

      const tx = await vault.connect(validatorsExitBus).addFullWithdrawalRequests(pubkeys, { value: fee });

      const receipt = await tx.wait();
      const events = findEvents(receipt!, "WithdrawalRequestAdded");
      expect(events.length).to.equal(requestCount);

      for (let i = 0; i < requestCount; i++) {
        expect(events[i].args[0]).to.equal(pubkeys[i]);
        expect(events[i].args[1]).to.equal(fullWithdrawalAmounts[i]);
      }
    });

    it("Should verify correct fee distribution among requests", async function () {
      const withdrawalFee = 2n;
      await withdrawalsPredeployed.setFee(withdrawalFee);

      const requestCount = 5;
      const { pubkeys } = generateWithdrawalRequestPayload(requestCount);

      const testFeeDistribution = async (totalWithdrawalFee: bigint) => {
        const tx = await vault
          .connect(validatorsExitBus)
          .addFullWithdrawalRequests(pubkeys, { value: totalWithdrawalFee });

        const receipt = await tx.wait();
        const events = findEip7002TriggerableWithdrawalMockEvents(receipt!, "eip7002WithdrawalRequestAdded");
        expect(events.length).to.equal(requestCount);

        for (let i = 0; i < requestCount; i++) {
          expect(events[i].args[1]).to.equal(withdrawalFee);
        }
      };

      await testFeeDistribution(10n);
      await testFeeDistribution(11n);
      await testFeeDistribution(14n);
    });

    it("Should ensure withdrawal requests are encoded as expected with a 48-byte pubkey and 8-byte amount", async function () {
      const requestCount = 16;
      const { pubkeys } = generateWithdrawalRequestPayload(requestCount);
      const totalWithdrawalFee = 333n;

      const normalize = (hex: string) => (hex.startsWith("0x") ? hex.slice(2).toLowerCase() : hex.toLowerCase());

      const tx = await vault
        .connect(validatorsExitBus)
        .addFullWithdrawalRequests(pubkeys, { value: totalWithdrawalFee });

      const receipt = await tx.wait();

      const events = findEip7002TriggerableWithdrawalMockEvents(receipt!, "eip7002WithdrawalRequestAdded");
      expect(events.length).to.equal(requestCount);

      for (let i = 0; i < requestCount; i++) {
        const encodedRequest = events[i].args[0];
        // 0x (2 characters) + 48-byte pubkey (96 characters) + 8-byte amount (16 characters) = 114 characters
        expect(encodedRequest.length).to.equal(114);

        expect(normalize(encodedRequest.substring(0, 98))).to.equal(normalize(pubkeys[i]));
        expect(normalize(encodedRequest.substring(98, 114))).to.equal("0".repeat(16));
      }
    });

    const testCasesForWithdrawalRequests = [
      { requestCount: 1, fee: 0n },
      { requestCount: 1, fee: 100n },
      { requestCount: 1, fee: 100_000_000_000n },
      { requestCount: 3, fee: 0n },
      { requestCount: 3, fee: 1n },
      { requestCount: 7, fee: 3n },
      { requestCount: 10, fee: 0n },
      { requestCount: 10, fee: 100_000_000_000n },
      { requestCount: 100, fee: 0n },
    ];

    testCasesForWithdrawalRequests.forEach(({ requestCount, fee }) => {
      it(`Should successfully add ${requestCount} requests with extra fee ${fee} and emit events`, async () => {
        const { pubkeys } = generateWithdrawalRequestPayload(requestCount);
        const requestFee = fee == 0n ? await getFee() : fee;
        const expectedTotalWithdrawalFee = requestFee * BigInt(requestCount);

        const initialBalance = await getWithdrawalCredentialsContractBalance();

        const tx = await vault
          .connect(validatorsExitBus)
          .addFullWithdrawalRequests(pubkeys, { value: expectedTotalWithdrawalFee });

        expect(await getWithdrawalCredentialsContractBalance()).to.equal(initialBalance);

        const receipt = await tx.wait();

        const events = findEvents(receipt!, "WithdrawalRequestAdded");
        expect(events.length).to.equal(pubkeys.length);

        for (let i = 0; i < pubkeys.length; i++) {
          expect(events[i].args[0]).to.equal(pubkeys[i]);
          expect(events[i].args[1]).to.equal(0);
        }

        const eip7002TriggerableWithdrawalMockEvents = findEip7002TriggerableWithdrawalMockEvents(
          receipt!,
          "eip7002WithdrawalRequestAdded",
        );
        expect(eip7002TriggerableWithdrawalMockEvents.length).to.equal(pubkeys.length);
        for (let i = 0; i < pubkeys.length; i++) {
          expect(eip7002TriggerableWithdrawalMockEvents[i].args[0]).to.equal(pubkeys[i].concat("0".repeat(16)));
        }
      });
    });
  });
});
