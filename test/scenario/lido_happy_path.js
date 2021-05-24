const { assert } = require('chai')
const { BN } = require('bn.js')
const { assertBn } = require('@aragon/contract-helpers-test/src/asserts')
const { getEventArgument } = require('@aragon/contract-helpers-test')

const { buildKeyData } = require('../0.4.24/helpers/keyData')
const { packKeyArray, packSigArray, createKeyBatches, createSigBatches } = require('../0.4.24/helpers/publicKeyArrays')
const { KEYS_BATCH_SIZE, padHash, toBN, ETH, tokens } = require('../helpers/utils')
const { deployDaoAndPool } = require('./helpers/deploy')

const NodeOperatorsRegistry = artifacts.require('NodeOperatorsRegistry')

contract('Lido: happy path', (addresses) => {
  const [
    // the root account which deployed the DAO
    appManager,
    // the address which we use to simulate the voting DAO application
    voting,
    // node operators
    operator_1,
    operator_2,
    // users who deposit Ether to the pool
    user1,
    user2,
    user3,
    // unrelated address
    nobody
  ] = addresses

  let pool, nodeOperatorRegistry, token
  let oracleMock, depositContractMock
  let treasuryAddr, insuranceAddr

  it('DAO, node operators registry, token, and pool are deployed and initialized', async () => {
    const deployed = await deployDaoAndPool(appManager, voting)

    // contracts/StETH.sol
    token = deployed.pool

    // contracts/Lido.sol
    pool = deployed.pool

    // contracts/nos/NodeOperatorsRegistry.sol
    nodeOperatorRegistry = deployed.nodeOperatorRegistry

    // mocks
    oracleMock = deployed.oracleMock
    depositContractMock = deployed.depositContractMock

    // addresses
    treasuryAddr = deployed.treasuryAddr
    insuranceAddr = deployed.insuranceAddr
  })

  // Fee and its distribution are in basis points, 10000 corresponding to 100%

  // Total fee is 1%
  const totalFeePoints = 0.01 * 10000

  // Of this 1%, 30% goes to the treasury
  const treasuryFeePoints = 0.3 * 10000
  // 20% goes to the insurance fund
  const insuranceFeePoints = 0.2 * 10000
  // 50% goes to node operators
  const nodeOperatorsFeePoints = 0.5 * 10000

  it('voting sets fee and its distribution', async () => {
    await pool.setFee(totalFeePoints, { from: voting })
    await pool.setFeeDistribution(treasuryFeePoints, insuranceFeePoints, nodeOperatorsFeePoints, { from: voting })

    // Fee and distribution were set

    assertBn(await pool.getFee({ from: nobody }), totalFeePoints, 'total fee')

    const distribution = await pool.getFeeDistribution({ from: nobody })
    assertBn(distribution.treasuryFeeBasisPoints, treasuryFeePoints, 'treasury fee')
    assertBn(distribution.insuranceFeeBasisPoints, insuranceFeePoints, 'insurance fee')
    assertBn(distribution.operatorsFeeBasisPoints, nodeOperatorsFeePoints, 'node operators fee')
  })

  const withdrawalCredentials = padHash('0x0202')

  it('voting sets withdrawal credentials', async () => {
    await pool.setWithdrawalCredentials(withdrawalCredentials, { from: voting })

    // Withdrawal credentials were set

    assert.equal(await pool.getWithdrawalCredentials({ from: nobody }), withdrawalCredentials, 'withdrawal credentials')
  })

  // Each node operator has its Ethereum 1 address, a name and a set of registered
  // validators, each of them defined as a (public key, signature) pair
  const nodeOperator1 = {
    name: 'operator_1',
    address: operator_1,
    keys: createKeyBatches(1),
    sigs: createSigBatches(1)
  }

  it('voting adds the first node operator', async () => {
    // How many validators can this node operator register
    const validatorsLimit = 1000000000

    const txn = await nodeOperatorRegistry.addNodeOperator(nodeOperator1.name, nodeOperator1.address, validatorsLimit, { from: voting })

    // Some Truffle versions fail to decode logs here, so we're decoding them explicitly using a helper
    nodeOperator1.id = getEventArgument(txn, 'NodeOperatorAdded', 'id', { decodeForAbi: NodeOperatorsRegistry._json.abi })
    assertBn(nodeOperator1.id, 0, 'operator id')

    assertBn(await nodeOperatorRegistry.getNodeOperatorsCount(), 1, 'total node operators')
  })

  it('the first node operator registers one batch of validators', async () => {
    await nodeOperatorRegistry.addSigningKeysOperatorBH(
      nodeOperator1.id,
      KEYS_BATCH_SIZE,
      packKeyArray(nodeOperator1.keys),
      packSigArray(nodeOperator1.sigs),
      {
        from: nodeOperator1.address
      }
    )

    // The batch of keys was added

    const totalKeys = await nodeOperatorRegistry.getTotalSigningKeyCount(nodeOperator1.id, { from: nobody })
    assertBn(totalKeys, KEYS_BATCH_SIZE, 'total signing keys')

    // The batch of keys was not used yet

    const unusedKeys = await nodeOperatorRegistry.getUnusedSigningKeyCount(nodeOperator1.id, { from: nobody })
    assertBn(unusedKeys, KEYS_BATCH_SIZE, 'unused signing keys')
  })

  it('the first user deposits 3 ETH to the pool', async () => {
    await web3.eth.sendTransaction({ to: pool.address, from: user1, value: ETH(3) })

    // No Ether was deposited yet to the validator contract

    assertBn(await depositContractMock.totalCalls(), 0)

    const ether2Stat = await pool.getBeaconStat()
    assertBn(ether2Stat.depositedValidators, 0, 'deposited ether2')
    assertBn(ether2Stat.beaconBalance, 0, 'remote ether2')

    // All Ether was buffered within the pool contract atm

    assertBn(await pool.getBufferedEther(), ETH(3), 'buffered ether')
    assertBn(await pool.getTotalPooledEther(), ETH(3), 'total pooled ether')

    // The amount of tokens corresponding to the deposited ETH value was minted to the user

    assertBn(await token.balanceOf(user1), tokens(3), 'user1 tokens')

    assertBn(await token.totalSupply(), tokens(3), 'token total supply')
  })

  it('the second user deposits 8*32 ETH to the pool', async () => {
    await web3.eth.sendTransaction({ to: pool.address, from: user2, value: ETH(32 * KEYS_BATCH_SIZE) })

    await pool.depositBufferedEther([buildKeyData([nodeOperator1], 0, 0)])

    // The first 32 ETH chunk was deposited to the deposit contract,
    // using public key and signature of the only validator of the first operator

    assertBn(await depositContractMock.totalCalls(), KEYS_BATCH_SIZE)

    const regCall = await depositContractMock.calls.call(0)
    assert.equal(regCall.pubkey, nodeOperator1.keys[0][0])
    assert.equal(regCall.withdrawal_credentials, withdrawalCredentials)
    assert.equal(regCall.signature, nodeOperator1.sigs[0][0])
    assertBn(regCall.value, ETH(32))

    const ether2Stat = await pool.getBeaconStat()
    assertBn(ether2Stat.depositedValidators, KEYS_BATCH_SIZE, 'deposited ether2')
    assertBn(ether2Stat.beaconBalance, 0, 'remote ether2')

    // Some Ether remained buffered within the pool contract

    assertBn(await pool.getBufferedEther(), ETH(3), 'buffered ether')
    assertBn(await pool.getTotalPooledEther(), ETH(3 + 32 * KEYS_BATCH_SIZE), 'total pooled ether')

    // The amount of tokens corresponding to the deposited ETH value was minted to the users

    assertBn(await token.balanceOf(user1), tokens(3), 'user1 tokens')
    assertBn(await token.balanceOf(user2), tokens(32 * KEYS_BATCH_SIZE), 'user2 tokens')

    assertBn(await token.totalSupply(), tokens(3 + 32 * KEYS_BATCH_SIZE), 'token total supply')
  })

  it('at this point, the pool has ran out of signing keys', async () => {
    const unusedKeys = await nodeOperatorRegistry.getUnusedSigningKeyCount(nodeOperator1.id, { from: nobody })
    assertBn(unusedKeys, 0, 'unused signing keys')
  })

  const nodeOperator2 = {
    name: 'operator_2',
    address: operator_2,
    keys: createKeyBatches(1, KEYS_BATCH_SIZE),
    sigs: createSigBatches(1, KEYS_BATCH_SIZE)
  }

  it('voting adds the second node operator who registers one batch of validators', async () => {
    // TODO: we have to submit operators with 0 validators allowed only
    const validatorsLimit = 1000000000

    const txn = await nodeOperatorRegistry.addNodeOperator(nodeOperator2.name, nodeOperator2.address, validatorsLimit, { from: voting })

    // Some Truffle versions fail to decode logs here, so we're decoding them explicitly using a helper
    nodeOperator2.id = getEventArgument(txn, 'NodeOperatorAdded', 'id', { decodeForAbi: NodeOperatorsRegistry._json.abi })
    assertBn(nodeOperator2.id, 1, 'operator id')

    assertBn(await nodeOperatorRegistry.getNodeOperatorsCount(), 2, 'total node operators')

    await nodeOperatorRegistry.addSigningKeysOperatorBH(
      nodeOperator2.id,
      KEYS_BATCH_SIZE,
      packKeyArray(nodeOperator2.keys),
      packSigArray(nodeOperator2.sigs),
      {
        from: nodeOperator2.address
      }
    )

    // The key was added

    const totalKeys = await nodeOperatorRegistry.getTotalSigningKeyCount(nodeOperator2.id, { from: nobody })
    assertBn(totalKeys, KEYS_BATCH_SIZE, 'total signing keys')

    // The key was not used yet

    const unusedKeys = await nodeOperatorRegistry.getUnusedSigningKeyCount(nodeOperator2.id, { from: nobody })
    assertBn(unusedKeys, KEYS_BATCH_SIZE, 'unused signing keys')
  })

  it('the third user deposits 64 ETH to the pool', async () => {
    await web3.eth.sendTransaction({ to: pool.address, from: user3, value: ETH(2 * 32 * KEYS_BATCH_SIZE) })

    await pool.depositBufferedEther([buildKeyData([nodeOperator1, nodeOperator2], 1, 0)])
    // The first 32 ETH chunk was deposited to the deposit contract,
    // using public key and signature of the only validator of the second operator

    assertBn(await depositContractMock.totalCalls(), 2 * KEYS_BATCH_SIZE)

    const regCall = await depositContractMock.calls.call(KEYS_BATCH_SIZE)
    assert.equal(regCall.pubkey, nodeOperator2.keys[0][0])
    assert.equal(regCall.withdrawal_credentials, withdrawalCredentials)
    assert.equal(regCall.signature, nodeOperator2.sigs[0][0])
    assertBn(regCall.value, ETH(32))

    const ether2Stat = await pool.getBeaconStat()
    assertBn(ether2Stat.depositedValidators, 2 * KEYS_BATCH_SIZE, 'deposited ether2')
    assertBn(ether2Stat.beaconBalance, 0, 'remote ether2')

    // The pool ran out of validator keys, so the remaining 32 ETH were added to the
    // pool buffer

    assertBn(await pool.getBufferedEther(), ETH(3 + 32 * KEYS_BATCH_SIZE), 'buffered ether')
    assertBn(await pool.getTotalPooledEther(), ETH(3 + 3 * 32 * KEYS_BATCH_SIZE), 'total pooled ether')

    // The amount of tokens corresponding to the deposited ETH value was minted to the users

    assertBn(await token.balanceOf(user1), tokens(3), 'user1 tokens')
    assertBn(await token.balanceOf(user2), tokens(32 * KEYS_BATCH_SIZE), 'user2 tokens')
    assertBn(await token.balanceOf(user3), tokens(64 * KEYS_BATCH_SIZE), 'user3 tokens')

    assertBn(await token.totalSupply(), tokens(3 + (32 + 64) * KEYS_BATCH_SIZE), 'token total supply')
  })

  it('the oracle reports balance increase on Ethereum2 side', async () => {
    const epoch = 100

    // Total shares are equal to deposited eth before ratio change and fee mint

    const oldTotalShares = await token.getTotalShares()
    assertBn(oldTotalShares, ETH(97), 'total shares')

    // Old total pooled Ether

    const oldTotalPooledEther = await pool.getTotalPooledEther()
    assertBn(oldTotalPooledEther, ETH(33 + 64), 'total pooled ether')

    // Reporting 1.5-fold balance increase (64 => 96)

    await oracleMock.reportBeacon(epoch, 2, ETH(96))

    // Total shares increased because fee minted (fee shares added)
    // shares ~= oldTotalShares + reward * oldTotalShares / (newTotalPooledEther - reward)

    const newTotalShares = await token.getTotalShares()
    assertBn(newTotalShares, new BN('97241218526577556729'), 'total shares')

    // Total pooled Ether increased

    const newTotalPooledEther = await pool.getTotalPooledEther()
    assertBn(newTotalPooledEther, ETH(33 + 96), 'total pooled ether')

    // Ether2 stat reported by the pool changed correspondingly

    const ether2Stat = await pool.getBeaconStat()
    assertBn(ether2Stat.depositedValidators, 2, 'deposited ether2')
    assertBn(ether2Stat.beaconBalance, ETH(96), 'remote ether2')

    // Buffered Ether amount didn't change

    assertBn(await pool.getBufferedEther(), ETH(33), 'buffered ether')

    // New tokens was minted to distribute fee
    assertBn(await token.totalSupply(), tokens(129), 'token total supply')

    const reward = toBN(ETH(96 - 64))
    const mintedAmount = new BN(totalFeePoints).mul(reward).divn(10000)

    // Token user balances increased
    assertBn(await token.balanceOf(user1), new BN('3979793814432989690'), 'user1 tokens')
    assertBn(await token.balanceOf(user2), new BN('39797938144329896907'), 'user2 tokens')
    assertBn(await token.balanceOf(user3), new BN('84902268041237113402'), 'user3 tokens')

    // Fee, in the form of minted tokens, was distributed between treasury, insurance fund
    // and node operators
    // treasuryTokenBalance ~= mintedAmount * treasuryFeePoints / 10000
    // insuranceTokenBalance ~= mintedAmount * insuranceFeePoints / 10000
    assertBn(await token.balanceOf(treasuryAddr), new BN('96000000000000001'), 'treasury tokens')
    assertBn(await token.balanceOf(insuranceAddr), new BN('63999999999999998'), 'insurance tokens')

    // The node operators' fee is distributed between all active node operators,
    // proprotional to their effective stake (the amount of Ether staked by the operator's
    // used and non-stopped validators).
    //
    // In our case, both node operators received the same fee since they have the same
    // effective stake (one signing key used from each operator, staking 32 ETH)

    assertBn(await token.balanceOf(nodeOperator1.address), new BN('79999999999999999'), 'operator_1 tokens')
    assertBn(await token.balanceOf(nodeOperator2.address), new BN('79999999999999999'), 'operator_2 tokens')

    // Real minted amount should be a bit less than calculated caused by round errors on mint and transfer operations
    assert(
      mintedAmount
        .sub(
          new BN(0)
            .add(await token.balanceOf(treasuryAddr))
            .add(await token.balanceOf(insuranceAddr))
            .add(await token.balanceOf(nodeOperator1.address))
            .add(await token.balanceOf(nodeOperator2.address))
            .add(await token.balanceOf(nodeOperatorRegistry.address))
        )
        .lt(mintedAmount.divn(100))
    )
  })
})
