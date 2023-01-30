const { artifacts, contract, ethers } = require('hardhat')
const { bn } = require('@aragon/contract-helpers-test')
const { assertBn } = require('@aragon/contract-helpers-test/src/asserts')
const { assert } = require('chai')
const { ETH, StETH, shareRate, shares } = require('../helpers/utils')
const { assertRevert } = require('../helpers/assertThrow')

const WithdrawalQueue = artifacts.require('WithdrawalQueue.sol')
const StETHMock = artifacts.require('StETHMock.sol')
const WstETH = artifacts.require('WstETH.sol')
const OssifiableProxy = artifacts.require('OssifiableProxy.sol')

contract('WithdrawalQueue', ([recipient, stranger, daoAgent, user]) => {
  let withdrawal, withdrawalImplAddress, steth, wsteth

  beforeEach('Deploy', async () => {
    steth = (await StETHMock.new({ value: ETH(600) }))
    await ethers.provider.send('hardhat_impersonateAccount', [steth.address])
    steth.setTotalPooledEther(ETH(300))

    wsteth = await WstETH.new(steth.address)

    withdrawalImplAddress = (await WithdrawalQueue.new(steth.address, wsteth.address)).address
    const withdrawalProxy = await OssifiableProxy.new(withdrawalImplAddress, daoAgent, '0x')
    withdrawal = await WithdrawalQueue.at(withdrawalProxy.address)

    await withdrawal.initialize(daoAgent, daoAgent, daoAgent, steth.address)
    await withdrawal.resume({ from: daoAgent })

    steth.mintShares(user, shares(1))
    steth.approve(withdrawal.address, StETH(300), { from: user })
  })

  context('Enqueue', async () => {
    let requestId

    beforeEach('Read some state', async () => {
      requestId = await withdrawal.queueLength()
    })

    it('One can enqueue a request', async () => {
      await withdrawal.requestWithdrawal(StETH(300), recipient, { from: user })

      assertBn(await withdrawal.queueLength(), +requestId + 1)
      assert.equal((await withdrawal.finalizedRequestsCounter()), 0)

      const request = await withdrawal.getWithdrawalRequestStatus(requestId)

      assert.equal(request.recipient, recipient)
      assertBn(request.etherToWithdraw, ETH(300))
      assertBn(request.shares, shares(1))
      assert.equal(request.isFinalized, false)
      assert.equal(request.isClaimed, false)
    })
  })

  context('Finalization', async () => {
    const amount = bn(ETH(300))
    const rate = shareRate(300)

    beforeEach('Enqueue a request', async () => {
      await withdrawal.requestWithdrawal(amount, recipient, { from: user })
    })

    it('Calculate one request batch', async () => {
      const batch = await withdrawal.calculateFinalizationParams(0, rate)

      assertBn(batch.etherToLock, amount)
      assertBn(batch.sharesToBurn, shares(1))
    })

    it('Only owner can finalize a request', async () => {
      await assertRevert(withdrawal.finalize(0, rate, { from: stranger }),
        `AccessControl: account ${stranger.toLowerCase()} is missing role ${await withdrawal.FINALIZE_ROLE()}`)
      await withdrawal.finalize(0, rate, { from: steth.address, value: amount })

      assertBn(await withdrawal.lockedEtherAmount(), amount)
      assertBn(await withdrawal.lockedEtherAmount(), await ethers.provider.getBalance(withdrawal.address))
    })

    it('One cannot finalize requests with no ether', async () => {
      assertBn(await withdrawal.lockedEtherAmount(), ETH(0))
      assertBn(await ethers.provider.getBalance(withdrawal.address), ETH(0))

      await assertRevert(withdrawal.finalize(0, rate, { from: steth.address, value: 0 }), 'NotEnoughEther()')

      assertBn(await withdrawal.lockedEtherAmount(), ETH(0))
      assertBn(await withdrawal.lockedEtherAmount(), await ethers.provider.getBalance(withdrawal.address))
    })

    it('One can finalize requests with discount', async () => {
      await withdrawal.finalize(0, shareRate(150), { from: steth.address, value: ETH(150) })

      assertBn(await withdrawal.lockedEtherAmount(), amount.div(bn(2)))
      assertBn(await withdrawal.lockedEtherAmount(), await ethers.provider.getBalance(withdrawal.address))
    })

    it('One can finalize part of the queue', async () => {
      steth.setTotalPooledEther(ETH(600))
      steth.mintShares(user, shares(1))
      steth.approve(withdrawal.address, StETH(600), { from: user })

      await withdrawal.requestWithdrawal(amount, recipient, { from: user })

      await withdrawal.finalize(0, shareRate(300), { from: steth.address, value: amount })

      assertBn(await withdrawal.queueLength(), 2)
      assertBn(await withdrawal.finalizedRequestsCounter(), 1)
      assertBn(await withdrawal.lockedEtherAmount(), amount)
      assertBn(await withdrawal.lockedEtherAmount(), await ethers.provider.getBalance(withdrawal.address))

      await withdrawal.finalize(1, shareRate(300), { from: steth.address, value: amount })

      assertBn(await withdrawal.queueLength(), 2)
      assertBn(await withdrawal.finalizedRequestsCounter(), 2)
      assertBn(await withdrawal.lockedEtherAmount(), amount.mul(bn(2)))
      assertBn(await withdrawal.lockedEtherAmount(), await ethers.provider.getBalance(withdrawal.address))
    })
  })

  context('Claim', async () => {
    let requestId
    const amount = ETH(300)
    beforeEach('Enqueue a request', async () => {
      requestId = await withdrawal.queueLength()
      await withdrawal.requestWithdrawal(amount, recipient, { from: user })
    })

    it('One cant claim not finalized request', async () => {
      await assertRevert(withdrawal.claimWithdrawal(requestId, 0, { from: steth.address }), 'RequestNotFinalized()')
    })

    it('Anyone can claim a finalized token', async () => {
      await withdrawal.finalize(0, shareRate(300), { from: steth.address, value: amount })

      const balanceBefore = bn(await ethers.provider.getBalance(recipient))

      await withdrawal.claimWithdrawal(requestId, 0, { from: stranger })

      assertBn(await ethers.provider.getBalance(recipient), balanceBefore.add(bn(amount)))
    })

    it('Cant withdraw token two times', async () => {
      await withdrawal.finalize(0, shareRate(300), { from: steth.address, value: amount })
      await withdrawal.claimWithdrawal(requestId, 0)

      await assertRevert(withdrawal.claimWithdrawal(requestId, 0), 'RequestAlreadyClaimed()')
    })

    it('Discounted withdrawals produce less eth', async () => {
      const balanceBefore = bn(await ethers.provider.getBalance(recipient))
      await withdrawal.finalize(0, shareRate(50), { from: steth.address, value: ETH(50) })

      await withdrawal.claimWithdrawal(requestId, 0)

      assertBn(await ethers.provider.getBalance(recipient), balanceBefore.add(bn(ETH(50))))
    })
  })

  context('Transfer request', async () => {
    let requestId

    beforeEach('Enqueue a request', async () => {
      requestId = await withdrawal.queueLength()
      await withdrawal.requestWithdrawal(bn(ETH(1)), user, { from: user })
    })

    it('One can change the recipient', async () => {
      const senderWithdrawalsBefore = await withdrawal.getWithdrawalRequests(user)
      const recipientWithdrawalsBefore = await withdrawal.getWithdrawalRequests(recipient)

      assert.isTrue(senderWithdrawalsBefore.map(v => v.toNumber()).includes(requestId.toNumber()))
      assert.isFalse(recipientWithdrawalsBefore.map(v => v.toNumber()).includes(requestId.toNumber()))

      await withdrawal.changeRecipient(requestId, recipient, { from: user })

      const senderWithdrawalAfter = await withdrawal.getWithdrawalRequests(user)
      const recipientWithdrawalsAfter = await withdrawal.getWithdrawalRequests(recipient)

      assert.isFalse(senderWithdrawalAfter.map(v => v.toNumber()).includes(requestId.toNumber()))
      assert.isTrue(recipientWithdrawalsAfter.map(v => v.toNumber()).includes(requestId.toNumber()))
    })
  })

  context('Transfer request performance', function () {
    const firstRequestCount = 1000
    const secondRequestCount = 10000
    
    this.timeout(1000000)

    it.skip('Can perform a lots of requests', async () => {
      for (let i = 0; i < firstRequestCount; i++) {
        await withdrawal.requestWithdrawal(bn(ETH(1 / secondRequestCount)), user, { from: user })
      }
      const firstGasUsed = (await withdrawal.changeRecipient(firstRequestCount - 1, recipient, { from: user })).receipt.gasUsed

      for (let i = firstRequestCount; i < secondRequestCount; i++) {
        await withdrawal.requestWithdrawal(bn(ETH(1 / secondRequestCount)), user, { from: user })
      }
      const secondGasUsed = (await withdrawal.changeRecipient(secondRequestCount / 2, recipient, { from: user })).receipt.gasUsed

      assert.isTrue(firstGasUsed >= secondGasUsed)
    })
  })
})
