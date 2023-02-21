const crypto = require('crypto')
const { ACCOUNTS_AND_KEYS, MAX_UINT256, ZERO_ADDRESS } = require('./helpers/constants')
const { bn } = require('@aragon/contract-helpers-test')
const { assert } = require('../helpers/assert')
const { signPermit, signTransferAuthorization, makeDomainSeparator } = require('./helpers/permit_helpers')
const { hexStringFromBuffer } = require('./helpers/sign_utils')
const { ETH } = require('../helpers/utils')
const { EvmSnapshot } = require('../helpers/blockchain')

const EIP712StETH = artifacts.require('EIP712StETH')
const StETHPermit = artifacts.require('StETHPermitMock')

contract('StETHPermit', ([deployer, ...accounts]) => {
  let stEthPermit, eip712StETH, chainId, domainSeparator
  const snapshot = new EvmSnapshot(hre.ethers.provider)

  before('deploy mock token', async () => {
    stEthPermit = await StETHPermit.new({ from: deployer, value: ETH(1) })
    eip712StETH = await EIP712StETH.new(stEthPermit.address, { from: deployer })
    await stEthPermit.initializeEIP712StETH(eip712StETH.address)

    chainId = await web3.eth.net.getId()

    domainSeparator = makeDomainSeparator('Liquid staked Ether 2.0', '2', chainId, stEthPermit.address)
    await snapshot.make()
  })

  afterEach(async () => {
    await snapshot.rollback()
  })

  context('permit', () => {
    const [alice, bob] = ACCOUNTS_AND_KEYS
    const charlie = accounts[1]

    const initialTotalSupply = 100e6
    const initialBalance = 90e6

    const permitParams = {
      owner: alice.address,
      spender: bob.address,
      value: 6e6,
      nonce: 0,
      deadline: MAX_UINT256,
    }

    beforeEach(async () => {
      await stEthPermit.setTotalPooledEther(initialTotalSupply, { from: deployer })
      await stEthPermit.mintShares(permitParams.owner, initialBalance, { from: deployer })
    })

    it('EIP-712 signature helper reverts when zero stETH address passed', async () => {
      await assert.revertsWithCustomError(EIP712StETH.new(ZERO_ADDRESS, { from: deployer }), `ZeroStETHAddress()`)
    })

    it('EIP-712 signature helper contract matches the stored one', async () => {
      assert.equals(await stEthPermit.getEIP712StETH(), eip712StETH.address)
    })

    it('eip712Domain() is correct', async () => {
      const { name, version, chainId, verifyingContract } = await stEthPermit.eip712Domain()

      assert.equals(name, 'Liquid staked Ether 2.0')
      assert.equals(version, '2')
      assert.equals(chainId, await web3.eth.net.getId())
      assert.equals(verifyingContract, stEthPermit.address)

      assert.equals(makeDomainSeparator(name, version, chainId, verifyingContract), domainSeparator)
    })

    it('grants allowance when a valid permit is given', async () => {
      const { owner, spender, deadline } = permitParams
      let { value } = permitParams
      // create a signed permit to grant Bob permission to spend Alice's funds
      // on behalf, and sign with Alice's key
      let nonce = 0

      let { v, r, s } = signPermit(owner, spender, value, nonce, deadline, domainSeparator, alice.key)

      // check that the allowance is initially zero
      assert.equals(await stEthPermit.allowance(owner, spender), bn(0))
      // check that the next nonce expected is zero
      assert.equals(await stEthPermit.nonces(owner), bn(0))
      // check domain separator
      assert.equals(await stEthPermit.DOMAIN_SEPARATOR(), domainSeparator)

      // a third-party, Charlie (not Alice) submits the permit
      const receipt = await stEthPermit.permit(owner, spender, value, deadline, v, r, s, { from: charlie })

      // check that allowance is updated
      assert.equals(await stEthPermit.allowance(owner, spender), bn(value))

      assert.emits(receipt, 'Approval', { owner, spender, value: bn(value) })

      assert.equals(await stEthPermit.nonces(owner), bn(1))

      // increment nonce
      nonce = 1
      value = 4e5
      ;({ v, r, s } = signPermit(owner, spender, value, nonce, deadline, domainSeparator, alice.key))

      // submit the permit
      const receipt2 = await stEthPermit.permit(owner, spender, value, deadline, v, r, s, { from: charlie })

      // check that allowance is updated
      assert.equals(await stEthPermit.allowance(owner, spender), bn(value))

      assert.emits(receipt2, 'Approval', { owner, spender, value: bn(value) })

      assert.equals(await stEthPermit.nonces(owner), bn(2))
    })

    it('reverts if the signature does not match given parameters', async () => {
      const { owner, spender, value, nonce, deadline } = permitParams
      // create a signed permit
      const { v, r, s } = signPermit(owner, spender, value, nonce, deadline, domainSeparator, alice.key)

      // try to cheat by claiming the approved amount + 1
      await assert.reverts(
        stEthPermit.permit(
          owner,
          spender,
          value + 1, // pass more than signed value
          deadline,
          v,
          r,
          s,
          { from: charlie }
        ),
        'ERC20Permit: invalid signature'
      )

      // check that msg is incorrect even if claim the approved amount - 1
      await assert.reverts(
        stEthPermit.permit(
          owner,
          spender,
          value - 1, // pass less than signed
          deadline,
          v,
          r,
          s,
          { from: charlie }
        ),
        'ERC20Permit: invalid signature'
      )
    })

    it('reverts if the signature is not signed with the right key', async () => {
      const { owner, spender, value, nonce, deadline } = permitParams
      // create a signed permit to grant Bob permission to spend
      // Alice's funds on behalf, but sign with Bob's key instead of Alice's
      const { v, r, s } = signPermit(owner, spender, value, nonce, deadline, domainSeparator, bob.key)

      // try to cheat by submitting the permit that is signed by a
      // wrong person
      await assert.reverts(
        stEthPermit.permit(owner, spender, value, deadline, v, r, s, {
          from: charlie,
        }),
        'ERC20Permit: invalid signature'
      )

      // unlock bob account (allow transactions originated from bob.address)
      await ethers.provider.send('hardhat_impersonateAccount', [bob.address])
      await web3.eth.sendTransaction({ to: bob.address, from: accounts[0], value: ETH(10) })

      // even Bob himself can't call permit with the invalid sig
      await assert.reverts(
        stEthPermit.permit(owner, spender, value, deadline, v, r, s, {
          from: bob.address,
        }),
        'ERC20Permit: invalid signature'
      )
    })

    it('reverts if the permit is expired', async () => {
      const { owner, spender, value, nonce } = permitParams
      // create a signed permit that already invalid
      const deadline = (await stEthPermit.getBlockTime()).toString() - 1
      const { v, r, s } = signPermit(owner, spender, value, nonce, deadline, domainSeparator, alice.key)

      // try to submit the permit that is expired
      await assert.reverts(
        stEthPermit.permit(owner, spender, value, deadline, v, r, s, {
          from: charlie,
        }),
        'ERC20Permit: expired deadline'
      )

      {
        // create a signed permit that valid for 1 minute (approximately)
        const deadline1min = (await stEthPermit.getBlockTime()).toString() + 60
        const { v, r, s } = signPermit(owner, spender, value, nonce, deadline1min, domainSeparator, alice.key)
        const receipt = await stEthPermit.permit(owner, spender, value, deadline1min, v, r, s, { from: charlie })

        assert.equals(await stEthPermit.nonces(owner), bn(1))
        assert.emits(receipt, 'Approval', { owner, spender, value: bn(value) })
      }
    })

    it('reverts if the nonce given does not match the next nonce expected', async () => {
      const { owner, spender, value, deadline } = permitParams
      const nonce = 1
      // create a signed permit
      const { v, r, s } = signPermit(owner, spender, value, nonce, deadline, domainSeparator, alice.key)
      // check that the next nonce expected is 0, not 1
      assert.equals(await stEthPermit.nonces(owner), bn(0))

      // try to submit the permit
      await assert.reverts(
        stEthPermit.permit(owner, spender, value, deadline, v, r, s, {
          from: charlie,
        }),
        'ERC20Permit: invalid signature'
      )
    })

    it('reverts if the permit has already been used', async () => {
      const { owner, spender, value, nonce, deadline } = permitParams
      // create a signed permit
      const { v, r, s } = signPermit(owner, spender, value, nonce, deadline, domainSeparator, alice.key)

      // submit the permit
      await stEthPermit.permit(owner, spender, value, deadline, v, r, s, { from: charlie })

      // try to submit the permit again
      await assert.reverts(
        stEthPermit.permit(owner, spender, value, deadline, v, r, s, {
          from: charlie,
        }),
        'ERC20Permit: invalid signature'
      )

      // unlock bob account (allow transactions originated from bob.address)
      await ethers.provider.send('hardhat_impersonateAccount', [alice.address])
      await web3.eth.sendTransaction({ to: alice.address, from: accounts[0], value: ETH(10) })

      // try to submit the permit again from Alice herself
      await assert.reverts(
        stEthPermit.permit(owner, spender, value, deadline, v, r, s, {
          from: alice.address,
        }),
        'ERC20Permit: invalid signature'
      )
    })

    it('reverts if the permit has a nonce that has already been used by the signer', async () => {
      const { owner, spender, value, nonce, deadline } = permitParams
      // create a signed permit
      const permit = signPermit(owner, spender, value, nonce, deadline, domainSeparator, alice.key)

      // submit the permit
      await stEthPermit.permit(owner, spender, value, deadline, permit.v, permit.r, permit.s, { from: charlie })

      // create another signed permit with the same nonce, but
      // with different parameters
      const permit2 = signPermit(owner, spender, 1e6, nonce, deadline, domainSeparator, alice.key)

      // try to submit the permit again
      await assert.reverts(
        stEthPermit.permit(owner, spender, 1e6, deadline, permit2.v, permit2.r, permit2.s, { from: charlie }),
        'ERC20Permit: invalid signature'
      )
    })

    it('reverts if the permit includes invalid approval parameters', async () => {
      const { owner, value, nonce, deadline } = permitParams
      // create a signed permit that attempts to grant allowance to the
      // zero address
      const spender = ZERO_ADDRESS
      const { v, r, s } = signPermit(owner, spender, value, nonce, deadline, domainSeparator, alice.key)

      // try to submit the permit with invalid approval parameters
      await assert.reverts(
        stEthPermit.permit(owner, spender, value, deadline, v, r, s, {
          from: charlie,
        }),
        'APPROVE_TO_ZERO_ADDRESS'
      )
    })

    it('reverts if the permit is not for an approval', async () => {
      const { owner: from, spender: to, value, deadline: validBefore } = permitParams
      // create a signed permit for a transfer
      const validAfter = 0
      const nonce = hexStringFromBuffer(crypto.randomBytes(32))
      const { v, r, s } = signTransferAuthorization(
        from,
        to,
        value,
        validAfter,
        validBefore,
        nonce,
        domainSeparator,
        alice.key
      )

      // try to submit the transfer permit
      await assert.reverts(
        stEthPermit.permit(from, to, value, validBefore, v, r, s, {
          from: charlie,
        }),
        'ERC20Permit: invalid signature'
      )
    })
  })
})
