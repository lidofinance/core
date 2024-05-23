import { ethers } from "hardhat";

import { ether } from "lib";

import { deployWithdrawalQueue } from "test/deploy";

import { testERC721Compliance } from "../common/erc721.test";

testERC721Compliance({
  tokenName: "unstETH NFT",
  deploy: async () => {
    const signers = await ethers.getSigners();
    const owner = signers[signers.length - 1];

    const initialStEth = ether("1.0");
    const ownerStEth = ether("99.0");

    const deployed = await deployWithdrawalQueue({
      stEthSettings: { initialStEth, owner: owner, ownerStEth },
      queueAdmin: owner,
    });

    const { queue, queueAddress, stEth } = deployed;

    await stEth.connect(owner).approve(queueAddress, ownerStEth);
    await queue.connect(owner).requestWithdrawals([ownerStEth], owner);

    const holderTokenId = await queue.getLastRequestId();

    return {
      token: queue,
      name: deployed.name,
      symbol: deployed.symbol,
      holder: owner,
      holderTokenId,
    };
  },
});
