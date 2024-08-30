import { ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  NFTDescriptor__MockForWithdrawalQueue,
  OssifiableProxy,
  StETHPermit__HarnessForWithdrawalQueueDeploy,
  WithdrawalQueueERC721,
  WstETH__HarnessForWithdrawalQueueDeploy,
} from "typechain-types";

import { ONE_ETHER, proxify, WITHDRAWAL_QUEUE_NAME, WITHDRAWAL_QUEUE_SYMBOL } from "lib";

interface StEthDeploymentParams {
  initialStEth: bigint;
  owner?: HardhatEthersSigner;
  ownerStEth?: bigint;
  ownerStShares?: bigint;
}

interface BaseWithdrawalQueueDeploymentParams {
  stEthSettings?: StEthDeploymentParams;
  name?: string;
  symbol?: string;
}

interface WithdrawalQueueDeploymentParams extends BaseWithdrawalQueueDeploymentParams {
  queueAdmin: HardhatEthersSigner;
  queuePauser?: HardhatEthersSigner;
  queueResumer?: HardhatEthersSigner;
  queueFinalizer?: HardhatEthersSigner;
  queueOracle?: HardhatEthersSigner;

  doInitialise?: boolean;
  doResume?: boolean;
}

export const MOCK_NFT_DESCRIPTOR_BASE_URI = "https://example-descriptor.com/";

async function deployNftDescriptor() {
  const nftDescriptor = await ethers.deployContract("NFTDescriptor__MockForWithdrawalQueue", [
    MOCK_NFT_DESCRIPTOR_BASE_URI,
  ]);

  return { nftDescriptor, nftDescriptorAddress: await nftDescriptor.getAddress() };
}

async function deployStEthMock(stEthSettings: StEthDeploymentParams) {
  const stEth = await ethers.deployContract("StETHPermit__HarnessForWithdrawalQueueDeploy", {
    value: stEthSettings.initialStEth,
  });

  if (stEthSettings.owner) {
    const eip712StETH = await ethers.deployContract("EIP712StETH", [await stEth.getAddress()]);
    await stEth.initializeEIP712StETH(await eip712StETH.getAddress());

    if (stEthSettings.ownerStEth) {
      await stEth.mintSteth(stEthSettings.owner, { value: stEthSettings.ownerStEth });
    }

    if (stEthSettings.ownerStShares) {
      await stEth.mintShares(stEthSettings.owner, stEthSettings.ownerStShares);
    }
  }

  return { stEth, stEthAddress: await stEth.getAddress() };
}

async function deployWstEthMock(stEthAddress: string) {
  const wstEth = await ethers.deployContract("WstETH__HarnessForWithdrawalQueueDeploy", [stEthAddress]);
  return { wstEth, wstEthAddress: await wstEth.getAddress() };
}

async function deployWithdrawalQueueImpl({
  stEthSettings = { initialStEth: ONE_ETHER },
  name = WITHDRAWAL_QUEUE_NAME,
  symbol = WITHDRAWAL_QUEUE_SYMBOL,
}: BaseWithdrawalQueueDeploymentParams = {}) {
  const { nftDescriptor, nftDescriptorAddress } = await deployNftDescriptor();
  const { stEth, stEthAddress } = await deployStEthMock(stEthSettings);
  const { wstEth, wstEthAddress } = await deployWstEthMock(stEthAddress);

  const deployConfig = [wstEthAddress, name, symbol];

  const impl = await ethers.deployContract("WithdrawalQueueERC721", deployConfig);

  return {
    // Deployed contract
    impl,
    name,
    symbol,
    // Related contracts
    stEth,
    stEthAddress,
    wstEth,
    wstEthAddress,
    nftDescriptor,
    nftDescriptorAddress,
  };
}

export async function deployWithdrawalQueue({
  stEthSettings = { initialStEth: ONE_ETHER },
  name = WITHDRAWAL_QUEUE_NAME,
  symbol = WITHDRAWAL_QUEUE_SYMBOL,
  queueAdmin,
  queuePauser,
  queueResumer,
  queueFinalizer,
  queueOracle,
  doInitialise = true,
  doResume = true,
}: WithdrawalQueueDeploymentParams): Promise<{
  queue: WithdrawalQueueERC721;
  queueAddress: string;
  impl: WithdrawalQueueERC721;
  name: string;
  symbol: string;
  initTx: ContractTransactionResponse | null;
  stEth: StETHPermit__HarnessForWithdrawalQueueDeploy;
  stEthAddress: string;
  wstEth: WstETH__HarnessForWithdrawalQueueDeploy;
  wstEthAddress: string;
  nftDescriptor: NFTDescriptor__MockForWithdrawalQueue;
  nftDescriptorAddress: string;
  proxy: OssifiableProxy;
}> {
  const { impl, stEth, stEthAddress, wstEth, wstEthAddress, nftDescriptor, nftDescriptorAddress } =
    await deployWithdrawalQueueImpl({ stEthSettings, name, symbol });

  const [queue, proxy] = await proxify({ impl, admin: queueAdmin });

  let initTx = null;
  if (doInitialise) {
    initTx = await queue.initialize(queueAdmin);

    await queue.connect(queueAdmin).grantRole(await queue.FINALIZE_ROLE(), queueFinalizer || stEthAddress);
    await queue.connect(queueAdmin).grantRole(await queue.PAUSE_ROLE(), queuePauser || queueAdmin);
    await queue.connect(queueAdmin).grantRole(await queue.RESUME_ROLE(), queueResumer || queueAdmin);
    await queue.connect(queueAdmin).grantRole(await queue.ORACLE_ROLE(), queueOracle || stEthAddress);
    await queue.connect(queueAdmin).grantRole(await queue.MANAGE_TOKEN_URI_ROLE(), queueAdmin);

    if (doResume) {
      await queue.connect(queueResumer || queueAdmin).resume();
    }
  }

  return {
    // Deployed contract
    queue,
    queueAddress: await queue.getAddress(),
    impl,
    name,
    symbol,
    initTx,
    // Related contracts
    stEth,
    stEthAddress,
    wstEth,
    wstEthAddress,
    nftDescriptor,
    nftDescriptorAddress,
    proxy,
  };
}
