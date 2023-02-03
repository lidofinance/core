const hre = require('hardhat')

const { assertBn, assertEvent } = require('@aragon/contract-helpers-test/src/asserts')
const { assertRevert } = require('../helpers/assertThrow')
const { ZERO_ADDRESS, bn } = require('@aragon/contract-helpers-test')

const { StETH, ETH } = require('../helpers/utils')
const { assert } = require('../helpers/assert')
const { deployProtocol } = require('../helpers/protocol')
const { postSetup } = require('../helpers/factories')
const { EvmSnapshot } = require('../helpers/blockchain')

const ERC20OZMock = artifacts.require('ERC20OZMock.sol')
const ERC721OZMock = artifacts.require('ERC721OZMock.sol')

contract('LidoExecutionLayerRewardsVault', ([deployer, anotherAccount]) => {
  let lido, elRewardsVault, treasury, appManager, snapshot

  before('deploy lido with dao', async () => {
    const deployed = await deployProtocol({
      postSetup: async (protocol) => {
        await postSetup(protocol)
        await protocol.pool.resumeProtocolAndStaking()
      }
    })

    lido = deployed.pool
    elRewardsVault = deployed.elRewardsVault
    treasury = deployed.treasury.address
    appManager = deployed.appManager.address
    snapshot = new EvmSnapshot(hre.ethers.provider)
    await snapshot.make()
  })

  afterEach(async () => {
    await snapshot.rollback()
  })

  it('Addresses which are not Lido contract cannot withdraw from execution layer rewards vault', async () => {
    await assertRevert(elRewardsVault.withdrawRewards(12345, { from: anotherAccount }), 'ONLY_LIDO_CAN_WITHDRAW')
    await assertRevert(elRewardsVault.withdrawRewards(12345, { from: deployer }), 'ONLY_LIDO_CAN_WITHDRAW')
    await assertRevert(elRewardsVault.withdrawRewards(12345, { from: appManager }), 'ONLY_LIDO_CAN_WITHDRAW')
  })

  it('Execution layer rewards vault can receive Ether by plain transfers (no call data)', async () => {
    const before = +(await web3.eth.getBalance(elRewardsVault.address)).toString()
    const amount = 0.02
    await web3.eth.sendTransaction({ to: elRewardsVault.address, from: anotherAccount, value: ETH(amount) })
    assertBn(await web3.eth.getBalance(elRewardsVault.address), ETH(before + amount))
  })

  it('Execution layer rewards vault refuses to receive Ether by transfers with call data', async () => {
    const amount = 0.02
    await assertRevert(
      web3.eth.sendTransaction({ to: elRewardsVault.address, from: anotherAccount, value: ETH(amount), data: '0x12345678' })
    )
  })

  describe('Recover ERC20 / ERC721', () => {
    let mockERC20Token, mockNFT
    let nft1, nft2
    let totalERC20Supply

    beforeEach(async () => {
      // setup ERC20 token with total supply 100,000 units
      // mint two NFTs
      // the deployer solely holds newly created ERC20 and ERC721 items on setup

      nft1 = bn(666)
      nft2 = bn(777)
      totalERC20Supply = bn(1000000)

      mockERC20Token = await ERC20OZMock.new(totalERC20Supply, { from: deployer })

      assertBn(await mockERC20Token.totalSupply(), totalERC20Supply)
      assertBn(await mockERC20Token.balanceOf(deployer), totalERC20Supply)

      await mockERC20Token.balanceOf(deployer)

      mockNFT = await ERC721OZMock.new({ from: deployer })

      await mockNFT.mintToken(nft1, { from: deployer })
      await mockNFT.mintToken(nft2, { from: deployer })

      assertBn(await mockNFT.balanceOf(deployer), bn(2))
      assert.equal(await mockNFT.ownerOf(nft1), deployer)
      assert.equal(await mockNFT.ownerOf(nft2), deployer)
    })

    it(`can't recover zero ERC20 amount`, async () => {
      assertRevert(elRewardsVault.recoverERC20(mockERC20Token.address, bn(0)), `ZERO_RECOVERY_AMOUNT`)
    })

    it(`can't recover zero-address ERC20`, async () => {
      assertRevert(elRewardsVault.recoverERC20(ZERO_ADDRESS, bn(10)))
    })

    it(`can't recover stETH by recoverERC20`, async () => {
      // initial stETH balance is zero
      assertBn(await lido.balanceOf(anotherAccount), StETH(0))
      // submit 10 ETH to mint 10 stETH
      await web3.eth.sendTransaction({ from: anotherAccount, to: lido.address, value: ETH(10) })
      // check 10 stETH minted on balance
      assertBn(await lido.balanceOf(anotherAccount), StETH(10))
      // transfer 5 stETH to the elRewardsVault account
      await lido.transfer(elRewardsVault.address, StETH(5), { from: anotherAccount })

      assertBn(await lido.balanceOf(anotherAccount), StETH(5))
      assertBn(await lido.balanceOf(elRewardsVault.address), StETH(5))
    })

    it(`recover some accidentally sent ERC20`, async () => {
      // distribute deployer's balance among anotherAccount and elRewardsVault
      await mockERC20Token.transfer(anotherAccount, bn(400000), { from: deployer })
      await mockERC20Token.transfer(elRewardsVault.address, bn(600000), { from: deployer })

      // check the resulted state
      assertBn(await mockERC20Token.balanceOf(deployer), bn(0))
      assertBn(await mockERC20Token.balanceOf(anotherAccount), bn(400000))
      assertBn(await mockERC20Token.balanceOf(elRewardsVault.address), bn(600000))

      // recover ERC20
      const firstReceipt = await elRewardsVault.recoverERC20(mockERC20Token.address, bn(100000), { from: deployer })
      assertEvent(firstReceipt, `ERC20Recovered`, {
        expectedArgs: { requestedBy: deployer, token: mockERC20Token.address, amount: bn(100000) }
      })

      const secondReceipt = await elRewardsVault.recoverERC20(mockERC20Token.address, bn(400000), { from: anotherAccount })
      assertEvent(secondReceipt, `ERC20Recovered`, {
        expectedArgs: { requestedBy: anotherAccount, token: mockERC20Token.address, amount: bn(400000) }
      })

      // check balances again
      assertBn(await mockERC20Token.balanceOf(elRewardsVault.address), bn(100000))
      assertBn(await mockERC20Token.balanceOf(treasury), bn(500000))
      assertBn(await mockERC20Token.balanceOf(deployer), bn(0))
      assertBn(await mockERC20Token.balanceOf(anotherAccount), bn(400000))

      // recover last portion
      const lastReceipt = await elRewardsVault.recoverERC20(mockERC20Token.address, bn(100000), { from: anotherAccount })
      assertEvent(lastReceipt, `ERC20Recovered`, {
        expectedArgs: { requestedBy: anotherAccount, token: mockERC20Token.address, amount: bn(100000) }
      })

      // balance is zero already, have to be reverted
      assertRevert(elRewardsVault.recoverERC20(mockERC20Token.address, bn(1), { from: deployer }), `ERC20: transfer amount exceeds balance`)
    })

    it(`can't recover zero-address ERC721(NFT)`, async () => {
      assertRevert(elRewardsVault.recoverERC721(ZERO_ADDRESS, 0))
    })

    it(`recover some accidentally sent NFTs`, async () => {
      // send nft1 to anotherAccount and nft2 to the elRewardsVault address
      await mockNFT.transferFrom(deployer, anotherAccount, nft1, { from: deployer })
      await mockNFT.transferFrom(deployer, elRewardsVault.address, nft2, { from: deployer })

      // check the new holders' rights
      assertBn(await mockNFT.balanceOf(deployer), bn(0))
      assertBn(await mockNFT.balanceOf(anotherAccount), bn(1))
      assertBn(await mockNFT.balanceOf(elRewardsVault.address), bn(1))

      // recover nft2 should work
      const receiptNfc2 = await elRewardsVault.recoverERC721(mockNFT.address, nft2, { from: anotherAccount })
      assertEvent(receiptNfc2, `ERC721Recovered`, { expectedArgs: { requestedBy: anotherAccount, token: mockNFT.address, tokenId: nft2 } })

      // but nft1 recovery should revert
      assertRevert(elRewardsVault.recoverERC721(mockNFT.address, nft1), `ERC721: transfer caller is not owner nor approved`)

      // send nft1 to elRewardsVault and recover it
      await mockNFT.transferFrom(anotherAccount, elRewardsVault.address, nft1, { from: anotherAccount })
      const receiptNft1 = await elRewardsVault.recoverERC721(mockNFT.address, nft1, { from: deployer })

      assertEvent(receiptNft1, `ERC721Recovered`, { expectedArgs: { requestedBy: deployer, token: mockNFT.address, tokenId: nft1 } })

      // check final NFT ownership state
      assertBn(await mockNFT.balanceOf(treasury), bn(2))
      assertBn(await mockNFT.ownerOf(nft1), treasury)
      assertBn(await mockNFT.ownerOf(nft2), treasury)
    })
  })
})
