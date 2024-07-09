import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  ERC721Receiver__MockWithdrawalQueueERC721,
  NFTDescriptor__MockWithdrawalQueueERC721,
  Receiver__MockForWithdrawalQueueBase,
  StETH__MockForWithdrawalQueue,
  WithdrawalQueueERC721,
  WstETH__MockForWithdrawalQueue,
} from "typechain-types";

import {
  ERC165_INTERFACE_ID,
  ERC721_INTERFACE_ID,
  ERC721METADATA_INTERFACE_ID,
  ERC4906_INTERFACE_ID,
  ether,
  INVALID_INTERFACE_ID,
  OZ_ACCESS_CONTROL_ENUMERABLE_INTERFACE_ID,
  OZ_ACCESS_CONTROL_INTERFACE_ID,
  proxify,
  shareRate,
  shares,
  streccak,
  WITHDRAWAL_QUEUE_NAME,
  WITHDRAWAL_QUEUE_SYMBOL,
} from "lib";

import { Snapshot } from "test/suite";

const MANAGE_TOKEN_URI_ROLE = streccak("MANAGE_TOKEN_URI_ROLE");

const MOCK_NFT_DESCRIPTOR_BASE_URI = "https://example-descriptor.com/";
const MOCK_TOKEN_BASE_URL = "https://example.com";

describe("WithdrawalQueueERC721.sol", () => {
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let tokenManager: HardhatEthersSigner;
  let finalizer: HardhatEthersSigner;

  let nftDescriptor: NFTDescriptor__MockWithdrawalQueueERC721;
  let nftDescriptorAddress: string;
  let stEth: StETH__MockForWithdrawalQueue;
  let stEthAddress: string;
  let wstEth: WstETH__MockForWithdrawalQueue;
  let wstEthAddress: string;

  let impl: WithdrawalQueueERC721;
  let queue: WithdrawalQueueERC721;
  let queueAddress: string;

  let originalState: string;

  before(async () => {
    [owner, user, stranger, tokenManager, finalizer] = await ethers.getSigners();

    nftDescriptor = await ethers.deployContract("NFTDescriptor__MockWithdrawalQueueERC721", [
      MOCK_NFT_DESCRIPTOR_BASE_URI,
    ]);
    nftDescriptorAddress = await nftDescriptor.getAddress();

    stEth = await ethers.deployContract("StETH__MockForWithdrawalQueue", []);
    stEthAddress = await stEth.getAddress();

    wstEth = await ethers.deployContract("WstETH__MockForWithdrawalQueue", [stEthAddress]);
    wstEthAddress = await wstEth.getAddress();

    impl = await ethers.deployContract(
      "WithdrawalQueueERC721",
      [wstEthAddress, WITHDRAWAL_QUEUE_NAME, WITHDRAWAL_QUEUE_SYMBOL],
      owner,
    );

    [queue] = await proxify({ impl, admin: owner });

    queueAddress = await queue.getAddress();

    await queue.initialize(owner);
    await queue.grantRole(await queue.PAUSE_ROLE(), owner);
    await queue.grantRole(await queue.RESUME_ROLE(), owner);
    await queue.grantRole(await queue.MANAGE_TOKEN_URI_ROLE(), tokenManager);
    await queue.grantRole(await queue.FINALIZE_ROLE(), finalizer);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Constants", () => {
    it("Returns the MANAGE_TOKEN_URI_ROLE variable", async () => {
      expect(await queue.MANAGE_TOKEN_URI_ROLE()).to.equal(MANAGE_TOKEN_URI_ROLE);
    });
  });

  context("Constructor", () => {
    it("Reverts if name is empty", async () => {
      await expect(
        ethers.deployContract("WithdrawalQueueERC721", [wstEthAddress, "", "unstETH"]),
      ).to.be.revertedWithCustomError(queue, "ZeroMetadata");
    });

    it("Reverts if symbol is empty", async () => {
      await expect(
        ethers.deployContract("WithdrawalQueueERC721", [wstEthAddress, "unstETH NFT", ""]),
      ).to.be.revertedWithCustomError(queue, "ZeroMetadata");
    });

    it("Reverts if name is too long", async () => {
      await expect(
        ethers.deployContract("WithdrawalQueueERC721", [
          wstEthAddress,
          "lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
          "unstETH",
        ]),
      ).to.be.revertedWithCustomError(queue, "StringTooLong");
    });

    it("Creates a contract with the correct name and symbol", async () => {
      const contract = await ethers.deployContract("WithdrawalQueueERC721", [wstEthAddress, "unstETH NFT", "unstETH"]);

      expect(await contract.name()).to.equal("unstETH NFT");
      expect(await contract.symbol()).to.equal("unstETH");
    });
  });

  context("supportsInterface", () => {
    it("Returns true for ERC165_INTERFACE_ID", async () => {
      expect(await queue.supportsInterface(ERC165_INTERFACE_ID)).to.be.true;
    });

    it("Returns true for ERC-721 interface", async () => {
      expect(await queue.supportsInterface(ERC721_INTERFACE_ID)).to.equal(true);
    });

    it("Returns true for ERC-721Metadata interface", async () => {
      expect(await queue.supportsInterface(ERC721METADATA_INTERFACE_ID)).to.equal(true);
    });

    it("Returns true for AccessControl", async () => {
      expect(await queue.supportsInterface(OZ_ACCESS_CONTROL_INTERFACE_ID)).to.be.true;
    });

    it("Returns true for AccessControlEnumerable", async () => {
      expect(await queue.supportsInterface(OZ_ACCESS_CONTROL_ENUMERABLE_INTERFACE_ID)).to.equal(true);
    });

    // NB! This is a test for ERC4906, that is Metadata Update Extension https://eips.ethereum.org/EIPS/eip-4906
    it("Returns true for ERC4906 interface", async () => {
      expect(await queue.supportsInterface(ERC4906_INTERFACE_ID)).to.be.true;
    });

    it("Returns false for invalid interface", async () => {
      expect(await queue.supportsInterface(INVALID_INTERFACE_ID)).to.equal(false);
    });
  });

  context("name", () => {
    it("Returns the correct name", async () => {
      expect(await queue.name()).to.equal(WITHDRAWAL_QUEUE_NAME);
    });
  });

  context("symbol", () => {
    it("Returns the correct symbol", async () => {
      expect(await queue.symbol()).to.equal(WITHDRAWAL_QUEUE_SYMBOL);
    });
  });

  context("tokenURI", () => {
    const requestId = 1;

    beforeEach(async () => {
      await stEth.mockSetTotalPooledEther(ether("600.00"));
      await stEth.exposedMintShares(user, shares(300n));
      await stEth.connect(user).approve(queue, shares(300n));

      await queue.resume();
      await queue.connect(user).requestWithdrawals([ether("25.00"), ether("25.00")], user);
    });

    it("Reverts on invalid token id", async () => {
      await expect(queue.tokenURI(0)).to.be.revertedWithCustomError(queue, "InvalidRequestId");
    });

    it("Returns tokenURI without nftDescriptor and baseUri", async () => {
      expect(await queue.tokenURI(requestId)).to.be.equal("");
    });

    it("Returns correct tokenURI without nftDescriptor", async () => {
      await queue.connect(tokenManager).setBaseURI(MOCK_TOKEN_BASE_URL);

      const createdAt = (await queue.getWithdrawalStatus([requestId]))[0].timestamp;
      const params = new URLSearchParams({
        requested: ether("25.00").toString(),
        created_at: createdAt.toString(),
      });

      expect(await queue.tokenURI(requestId)).to.equal(`${MOCK_TOKEN_BASE_URL}/${requestId}?${params.toString()}`);
    });

    it("Returns correct tokenURI with nftDescriptor", async () => {
      await queue.connect(tokenManager).setNFTDescriptorAddress(nftDescriptorAddress);

      expect(await queue.tokenURI(requestId)).to.equal(`${MOCK_NFT_DESCRIPTOR_BASE_URI}${requestId}`);
    });

    it("Returns correct tokenURI after finalization", async () => {
      await queue.connect(tokenManager).setBaseURI(MOCK_TOKEN_BASE_URL);
      await queue.connect(finalizer).finalize(1, shareRate(300n));

      const createdAt = (await queue.getWithdrawalStatus([requestId]))[0].timestamp;
      const finalizedEth = (await queue.getClaimableEther([1], [1]))[0];

      const params = new URLSearchParams({
        requested: ether("25.00").toString(),
        created_at: createdAt.toString(),
        finalized: finalizedEth.toString(),
      });

      expect(await queue.tokenURI(requestId)).to.equal(`${MOCK_TOKEN_BASE_URL}/${requestId}?${params.toString()}`);
    });

    it("Returns correct tokenURI after finalization with discount", async () => {
      await queue.connect(tokenManager).setBaseURI(MOCK_TOKEN_BASE_URL);

      const batch = await queue.prefinalize([1], shareRate(1n));
      await queue.connect(finalizer).finalize(1, shareRate(1n), { value: batch.ethToLock });

      const createdAt = (await queue.getWithdrawalStatus([requestId]))[0].timestamp;
      const finalized = batch.sharesToBurn;

      const params = new URLSearchParams({
        requested: ether("25.00").toString(),
        created_at: createdAt.toString(),
        finalized: finalized.toString(),
      });

      expect(await queue.tokenURI(requestId)).to.equal(`${MOCK_TOKEN_BASE_URL}/${requestId}?${params.toString()}`);
    });

    it("Returns correct tokenURI after token ownership transfer", async () => {
      const currentURI = await queue.tokenURI(requestId);
      await queue.connect(user).transferFrom(user, stranger, requestId);
      expect(await queue.tokenURI(requestId)).to.equal(currentURI);
    });

    it("Returns correct tokenURI after NFT Descriptor update", async () => {
      const NEW_NFT_URL = "https://example.com/";
      const newNFTDescriptor = await ethers.deployContract("NFTDescriptorMock", [NEW_NFT_URL]);
      const newNFTDescriptorAddress = await newNFTDescriptor.getAddress();

      await expect(queue.connect(tokenManager).setNFTDescriptorAddress(newNFTDescriptorAddress))
        .to.emit(queue, "NftDescriptorAddressSet")
        .withArgs(newNFTDescriptorAddress);

      expect(await queue.tokenURI(requestId)).to.equal(`${NEW_NFT_URL}${requestId}`);

      await queue.connect(tokenManager).setNFTDescriptorAddress(ZeroAddress);

      expect(await queue.tokenURI(requestId)).to.equal("");
    });
  });

  context("getBaseURI", () => {
    it("Returns empty string when not set", async () => {
      expect(await queue.getBaseURI()).to.equal("");
    });

    it("Returns correct tokenURI when set by token manager", async () => {
      await queue.connect(tokenManager).setBaseURI(MOCK_TOKEN_BASE_URL);

      expect(await queue.getBaseURI()).to.equal(MOCK_TOKEN_BASE_URL);
    });
  });

  context("setBaseURI", () => {
    it("Reverts when called by non-manager", async () => {
      await expect(queue.connect(stranger).setBaseURI(MOCK_TOKEN_BASE_URL)).to.be.revertedWithOZAccessControlError(
        stranger.address,
        MANAGE_TOKEN_URI_ROLE,
      );
    });

    it("Sets the correct baseURI and emit `BaseURISet`", async () => {
      await expect(queue.connect(tokenManager).setBaseURI(MOCK_TOKEN_BASE_URL))
        .to.emit(queue, "BaseURISet")
        .withArgs(MOCK_TOKEN_BASE_URL);

      expect(await queue.getBaseURI()).to.equal(MOCK_TOKEN_BASE_URL);
    });
  });

  context("getNFTDescriptorAddress", () => {
    it("Returns zero address when not set", async () => {
      expect(await queue.getNFTDescriptorAddress()).to.equal(ZeroAddress);
    });

    it("Returns correct NFTDescriptorAddress when set by token manager", async () => {
      await queue.connect(tokenManager).setNFTDescriptorAddress(nftDescriptorAddress);

      expect(await queue.getNFTDescriptorAddress()).to.equal(nftDescriptorAddress);
    });
  });

  context("setNFTDescriptorAddress", () => {
    it("Reverts when called by non-manager", async () => {
      await expect(
        queue.connect(stranger).setNFTDescriptorAddress(nftDescriptorAddress),
      ).to.be.revertedWithOZAccessControlError(stranger.address, MANAGE_TOKEN_URI_ROLE);
    });

    it("Sets the correct NFTDescriptorAddress and emit `NftDescriptorAddressSet`", async () => {
      await expect(queue.connect(tokenManager).setNFTDescriptorAddress(nftDescriptorAddress))
        .to.emit(queue, "NftDescriptorAddressSet")
        .withArgs(nftDescriptorAddress);

      expect(await queue.getNFTDescriptorAddress()).to.equal(nftDescriptorAddress);
    });
  });

  context("finalize", () => {
    beforeEach(async () => {
      await stEth.mockSetTotalPooledEther(ether("600.00"));
      await stEth.exposedMintShares(user, shares(300n));
      await stEth.connect(user).approve(queue, shares(300n));
    });

    it("Reverts if paused", async () => {
      await expect(queue.connect(finalizer).finalize(1, shareRate(300n))).to.be.revertedWithCustomError(
        queue,
        "ResumedExpected",
      );
    });

    it("Reverts if not finalizer", async () => {
      await queue.resume();
      await expect(queue.connect(stranger).finalize(1, shareRate(300n))).to.be.revertedWithOZAccessControlError(
        stranger.address,
        await queue.FINALIZE_ROLE(),
      );
    });

    it("Finalizes withdrawals and emits `BatchMetadataUpdate`", async () => {
      await queue.resume();
      await queue.connect(user).requestWithdrawals([ether("25.00"), ether("25.00")], user);

      await expect(queue.connect(finalizer).finalize(2, shareRate(300n)))
        .to.emit(queue, "BatchMetadataUpdate")
        .withArgs(1, 2);
    });

    it("Finalizes withdrawals and emits `BatchMetadataUpdate` with discount", async () => {
      await queue.resume();
      await queue.connect(user).requestWithdrawals([ether("25.00"), ether("25.00")], user);
      const batch = await queue.prefinalize([1, 2], shareRate(1n));

      await expect(queue.connect(finalizer).finalize(2, shareRate(1n), { value: batch.ethToLock }))
        .to.emit(queue, "BatchMetadataUpdate")
        .withArgs(1, 2);
    });
  });

  context("balanceOf", () => {
    it("Reverts of owner is zero address", async () => {
      await expect(queue.balanceOf(ZeroAddress))
        .to.revertedWithCustomError(queue, "InvalidOwnerAddress")
        .withArgs(ZeroAddress.toString());
    });

    it("Returns 0 for non-token holder", async () => {
      expect(await queue.balanceOf(stranger)).to.equal(0);
    });

    it("Returns correct balance for token holder", async () => {
      await stEth.mockSetTotalPooledEther(ether("600.00"));
      await stEth.exposedMintShares(user, shares(300n));
      await stEth.connect(user).approve(queue, shares(300n));
      await queue.resume();
      await queue.connect(user).requestWithdrawals([ether("25.00"), ether("25.00")], user);

      expect(await queue.balanceOf(user)).to.equal(2);
    });
  });

  context("ownerOf", () => {
    beforeEach(async () => {
      await stEth.mockSetTotalPooledEther(ether("600.00"));
      await stEth.exposedMintShares(user, shares(300n));
      await stEth.connect(user).approve(queue, shares(300n));

      await queue.resume();
    });

    it("Reverts on invalid token id", async () => {
      await expect(queue.ownerOf(0)).to.be.revertedWithCustomError(queue, "InvalidRequestId").withArgs(0);
    });

    it("Reverts when token is out of bounds", async () => {
      await expect(queue.ownerOf(1)).to.be.revertedWithCustomError(queue, "InvalidRequestId").withArgs(1);
    });

    it("Reverts when token is already claimed", async () => {
      await setBalance(queueAddress, ether("10.00"));

      await queue.connect(user).requestWithdrawals([ether("25.00")], user);
      await queue.connect(finalizer).finalize(1, shareRate(300n), { value: ether("25.00") });
      await queue.connect(user).claimWithdrawal(1);

      await expect(queue.ownerOf(1)).to.be.revertedWithCustomError(queue, "RequestAlreadyClaimed").withArgs(1);
    });

    it("Returns correct owner of token", async () => {
      await queue.connect(user).requestWithdrawals([ether("25.00"), ether("25.00")], user);

      expect(await queue.ownerOf(1)).to.equal(user.address);
    });
  });

  context("approve", () => {
    beforeEach(async () => {
      await stEth.mockSetTotalPooledEther(ether("600.00"));
      await stEth.exposedMintShares(user, shares(300n));
      await stEth.connect(user).approve(queue, shares(300n));

      await queue.resume();
      await queue.connect(user).requestWithdrawals([ether("25.00"), ether("25.00")], user);
    });

    it("Reverts approval to owner", async () => {
      await expect(queue.connect(user).approve(user, 1)).to.be.revertedWithCustomError(queue, "ApprovalToOwner");
    });

    it("Reverts if not owner and not approved for all", async () => {
      await expect(queue.connect(stranger).approve(stranger, 1))
        .to.be.revertedWithCustomError(queue, "NotOwnerOrApprovedForAll")
        .withArgs(stranger.address);
    });

    it("Approves token for spender", async () => {
      await expect(queue.connect(user).approve(stranger, 1))
        .to.emit(queue, "Approval")
        .withArgs(user.address, stranger.address, 1);
    });
  });

  context("getApproved", () => {
    beforeEach(async () => {
      await stEth.mockSetTotalPooledEther(ether("600.00"));
      await stEth.exposedMintShares(user, shares(300n));
      await stEth.connect(user).approve(queue, shares(300n));

      await queue.resume();
      await queue.connect(user).requestWithdrawals([ether("25.00"), ether("25.00")], user);
    });

    it("Reverts on invalid request id", async () => {
      await expect(queue.getApproved(0)).to.be.revertedWithCustomError(queue, "InvalidRequestId").withArgs(0);
    });

    it("Returns zero address for unapproved token", async () => {
      expect(await queue.getApproved(1)).to.equal(ZeroAddress);
    });

    it("Returns correct spender for approved token", async () => {
      await queue.connect(user).approve(stranger, 1);

      expect(await queue.getApproved(1)).to.equal(stranger.address);
    });
  });

  context("setApprovalForAll", () => {
    it("Reverts if operator is the caller", async () => {
      await expect(queue.connect(user).setApprovalForAll(user, true)).to.be.revertedWithCustomError(
        queue,
        "ApproveToCaller",
      );
    });

    it("Approves operator for all tokens", async () => {
      await expect(queue.connect(user).setApprovalForAll(stranger, true))
        .to.emit(queue, "ApprovalForAll")
        .withArgs(user.address, stranger.address, true);
    });
  });

  context("isApprovedForAll", () => {
    it("Returns false for non-operator", async () => {
      expect(await queue.isApprovedForAll(user, stranger)).to.equal(false);
    });

    it("Returns true for operator", async () => {
      await queue.connect(user).setApprovalForAll(stranger, true);

      expect(await queue.isApprovedForAll(user, stranger)).to.equal(true);
    });
  });

  // NB! Most of the `_transfer` function logic is tested below in `transferFrom` tests
  context("safeTransferFrom", () => {
    context("safeTransferFrom(address,address,uint256)", () => {
      beforeEach(async () => {
        await stEth.mockSetTotalPooledEther(ether("600.00"));
        await stEth.exposedMintShares(user, shares(300n));
        await stEth.connect(user).approve(queue, shares(300n));

        await queue.resume();
        await queue.connect(user).requestWithdrawals([ether("25.00"), ether("25.00")], user);
      });

      it("Works as safeTransferFrom(address,address,uint256,bytes)", async () => {
        await expect(queue.connect(user)["safeTransferFrom(address,address,uint256)"](user, stranger, 1))
          .to.emit(queue, "Transfer")
          .withArgs(user.address, stranger.address, 1);
      });
    });

    context("safeTransferFrom(address,address,uint256,bytes)", () => {
      let erc721ReceiverContract: ERC721Receiver__MockWithdrawalQueueERC721;
      let erc721ReceiverContractAddress: string;
      let receiverContract: Receiver__MockForWithdrawalQueueBase;
      let receiverContractAddress: string;

      beforeEach(async () => {
        await stEth.mockSetTotalPooledEther(ether("600.00"));
        await stEth.exposedMintShares(user, shares(300n));
        await stEth.connect(user).approve(queue, shares(300n));

        await queue.resume();
        await queue.connect(user).requestWithdrawals([ether("25.00"), ether("25.00")], user);

        erc721ReceiverContract = await ethers.deployContract("ERC721Receiver__MockWithdrawalQueueERC721", []);
        erc721ReceiverContractAddress = await erc721ReceiverContract.getAddress();

        receiverContract = await ethers.deployContract("Receiver__MockForWithdrawalQueueBase");
        receiverContractAddress = await receiverContract.getAddress();
      });

      it("Transfers token to user", async () => {
        await expect(
          queue.connect(user)["safeTransferFrom(address,address,uint256,bytes)"](user, stranger, 1, new Uint8Array()),
        )
          .to.emit(queue, "Transfer")
          .withArgs(user.address, stranger.address, 1);
      });

      it("Reverts when transfer to non IERC721 receiver", async () => {
        await expect(
          queue
            .connect(user)
            ["safeTransferFrom(address,address,uint256,bytes)"](user, receiverContractAddress, 1, new Uint8Array()),
        )
          .revertedWithCustomError(queue, "TransferToNonIERC721Receiver")
          .withArgs(receiverContractAddress);
      });

      it("Reverts when transfer to IERC721 receiver that does not accept tokens", async () => {
        await erc721ReceiverContract.setDoesAcceptTokens(false);

        await expect(
          queue
            .connect(user)
            [
              "safeTransferFrom(address,address,uint256,bytes)"
            ](user, erc721ReceiverContractAddress, 1, new Uint8Array()),
        ).revertedWith("ERC721_NOT_ACCEPT_TOKENS");
      });

      it("Reverts when transfer to IERC721 receiver that returns not selector", async () => {
        await erc721ReceiverContract.setDoesAcceptTokens(true);
        await erc721ReceiverContract.setReturnValid(false);

        await expect(
          queue
            .connect(user)
            [
              "safeTransferFrom(address,address,uint256,bytes)"
            ](user, erc721ReceiverContractAddress, 1, new Uint8Array()),
        )
          .revertedWithCustomError(queue, "TransferToNonIERC721Receiver")
          .withArgs(erc721ReceiverContractAddress);
      });

      it("Transfers token to IERC721 receiver", async () => {
        await erc721ReceiverContract.setDoesAcceptTokens(true);
        await erc721ReceiverContract.setReturnValid(true);

        await expect(
          queue
            .connect(user)
            [
              "safeTransferFrom(address,address,uint256,bytes)"
            ](user, erc721ReceiverContractAddress, 1, new Uint8Array()),
        )
          .to.emit(queue, "Transfer")
          .withArgs(user.address, erc721ReceiverContractAddress, 1);
      });
    });
  });

  context("transferFrom", () => {
    beforeEach(async () => {
      await stEth.mockSetTotalPooledEther(ether("600.00"));
      await stEth.exposedMintShares(user, shares(300n));
      await stEth.connect(user).approve(queue, shares(300n));

      await queue.resume();
      await queue.connect(user).requestWithdrawals([ether("25.00"), ether("25.00")], user);
    });

    it("Reverts if transfer to zero address", async () => {
      await expect(queue.connect(user).transferFrom(user, ZeroAddress, 1)).to.be.revertedWithCustomError(
        queue,
        "TransferToZeroAddress",
      );
    });

    it("Reverts if transfer to self", async () => {
      await expect(queue.connect(user).transferFrom(user, user, 1)).to.be.revertedWithCustomError(
        queue,
        "TransferToThemselves",
      );
    });

    it("Reverts if request id is 0", async () => {
      await expect(queue.connect(user).transferFrom(user, stranger, 0))
        .to.be.revertedWithCustomError(queue, "InvalidRequestId")
        .withArgs(0);
    });

    it("Reverts if request id is out of bounds", async () => {
      await expect(queue.connect(user).transferFrom(user, stranger, 10))
        .to.be.revertedWithCustomError(queue, "InvalidRequestId")
        .withArgs(10);
    });

    it("Reverts if request is already claimed", async () => {
      await setBalance(queueAddress, ether("10.00"));

      await queue.connect(user).requestWithdrawals([ether("25.00")], user);
      await queue.connect(finalizer).finalize(1, shareRate(300n), { value: ether("25.00") });
      await queue.connect(user).claimWithdrawal(1);

      await expect(queue.connect(user).transferFrom(user, stranger, 1))
        .to.be.revertedWithCustomError(queue, "RequestAlreadyClaimed")
        .withArgs(1);
    });

    it("Reverts if transfer from incorrect owner", async () => {
      await expect(queue.connect(stranger).transferFrom(stranger, user, 1))
        .to.be.revertedWithCustomError(queue, "TransferFromIncorrectOwner")
        .withArgs(stranger.address, user.address);
    });

    it("Reverts if not owner and not approved for all", async () => {
      await expect(queue.connect(stranger).transferFrom(user, stranger, 1))
        .to.be.revertedWithCustomError(queue, "NotOwnerOrApproved")
        .withArgs(stranger.address);
    });
  });
});
