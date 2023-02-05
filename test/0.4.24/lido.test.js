const hre = require('hardhat')

const { hash } = require('eth-ens-namehash')
const { artifacts } = require('hardhat')

const { getInstalledApp } = require('@aragon/contract-helpers-test/src/aragon-os')
const { assertBn, assertEvent } = require('@aragon/contract-helpers-test/src/asserts')

const { assertRevert } = require('../helpers/assertThrow')
const { ZERO_ADDRESS, bn } = require('@aragon/contract-helpers-test')
const { formatEther } = require('ethers/lib/utils')
const { waitBlocks, EvmSnapshot } = require('../helpers/blockchain')
const { getEthBalance, formatStEth, formatBN, hexConcat, pad, ETH, tokens, div15, assertNoEvent, StETH } = require('../helpers/utils')
const { assert } = require('../helpers/assert')
const nodeOperators = require('../helpers/node-operators')
const { deployProtocol } = require('../helpers/protocol')
const { setupNodeOperatorsRegistry } = require('../helpers/staking-modules')
const { pushOracleReport } = require('../helpers/oracle')
const { SECONDS_PER_FRAME } = require('../helpers/constants')

const { newApp } = require('../helpers/dao')

const ERC20Mock = artifacts.require('ERC20Mock.sol')
const AragonVaultMock = artifacts.require('AragonVaultMock.sol')
const ERC20WrongTransferMock = artifacts.require('ERC20WrongTransferMock.sol')
const RewardEmulatorMock = artifacts.require('RewardEmulatorMock.sol')
<<<<<<< HEAD
const BeaconChainDepositorMock = artifacts.require('BeaconChainDepositorMock.sol')
=======
const StakingRouter = artifacts.require('StakingRouterMock.sol')
>>>>>>> origin/feature/bye-bye-byteslib
const WithdrawalVault = artifacts.require('WithdrawalVault.sol')
const LidoMock = artifacts.require('LidoMock')

const ADDRESS_1 = '0x0000000000000000000000000000000000000001'
const ADDRESS_2 = '0x0000000000000000000000000000000000000002'
const ADDRESS_3 = '0x0000000000000000000000000000000000000003'
const ADDRESS_4 = '0x0000000000000000000000000000000000000004'

const UNLIMITED = 1000000000
const TOTAL_BASIS_POINTS = 10000
const FEE_PRECISION_POINTS = bn(10).pow(bn(20)) // 100 * 10e18
const toPrecBP = (bp) => bn(bp).mul(FEE_PRECISION_POINTS).div(bn(10000))

// Divides a BN by 1e15
const MAX_DEPOSITS = 150
const CURATED_MODULE_ID = 1
const CALLDATA = '0x0'

async function getTimestamp() {
  const blockNum = await ethers.provider.getBlockNumber();
  const block = await ethers.provider.getBlock(blockNum);
  return block.timestamp;
}

contract('Lido', ([appManager, voting, user1, user2, user3, nobody, depositor, treasury]) => {
  let app, oracle, depositContract, operators
  let treasuryAddress
  let dao
  let elRewardsVault
  let stakingRouter
<<<<<<< HEAD
  let beaconChainDepositor
  let anyToken, badToken
=======
  let anyToken
>>>>>>> origin/feature/bye-bye-byteslib
  let eip712StETH
  let withdrawalQueue
  let lidoLocator
  let snapshot
  let consensus

  before('deploy base app', async () => {
    anyToken = await ERC20Mock.new()
    badToken = await ERC20WrongTransferMock.new()

    const deployed = await deployProtocol({
      stakingModulesFactory: async (protocol) => {
        const curatedModule = await setupNodeOperatorsRegistry(protocol)
        return [
          {
            module: curatedModule,
            name: 'Curated',
            targetShares: 10000,
            moduleFee: 500,
            treasuryFee: 500
          }
        ]
      },
      depositSecurityModuleFactory: async () => {
        return { address: depositor }
      }
    })

    dao = deployed.dao
    app = deployed.pool
    elRewardsVault = deployed.elRewardsVault
    eip712StETH = deployed.eip712StETH
    treasuryAddress = deployed.treasury.address
    depositContract = deployed.depositContract
    stakingRouter = deployed.stakingRouter
    operators = deployed.stakingModules[0]
    lidoLocator = deployed.lidoLocator
    withdrawalQueue = deployed.withdrawalQueue
    oracle = deployed.oracle
    consensus = deployed.consensusContract

    beaconChainDepositor = await BeaconChainDepositorMock.new(depositContract.address)

    snapshot = new EvmSnapshot(hre.ethers.provider)
    await snapshot.make()
  })

  afterEach(async () => {
    await snapshot.rollback()
  })

  const pushReport = async (clValidators, clBalance) => {
    const elRewards = await web3.eth.getBalance(elRewardsVault.address)
    await pushOracleReport(consensus, oracle, clValidators, clBalance, elRewards)
    await consensus.advanceTimeBy(SECONDS_PER_FRAME + 1000)
  }

  const checkStat = async ({ depositedValidators, beaconValidators, beaconBalance }) => {
    const stat = await app.getBeaconStat()
    assertBn(stat.depositedValidators, depositedValidators, 'depositedValidators check')
    assertBn(stat.beaconValidators, beaconValidators, 'beaconValidators check')
    assertBn(stat.beaconBalance, beaconBalance, 'beaconBalance check')
  }

  // Assert reward distribution. The values must be divided by 1e15.
  const checkRewards = async ({ treasury, operator }) => {
    const [treasury_b, operators_b, a1, a2, a3, a4] = await Promise.all([
      app.balanceOf(treasuryAddress),
      app.balanceOf(operators.address),
      app.balanceOf(ADDRESS_1),
      app.balanceOf(ADDRESS_2),
      app.balanceOf(ADDRESS_3),
      app.balanceOf(ADDRESS_4)
    ])

    assertBn(div15(treasury_b), treasury, 'treasury token balance check')
    assertBn(div15(operators_b.add(a1).add(a2).add(a3).add(a4)), operator, 'node operators token balance check')
  }

  const setupNodeOperatorsForELRewardsVaultTests = async (userAddress, initialDepositAmount) => {
    await operators.addNodeOperator('1', ADDRESS_1, { from: voting })
    await operators.addNodeOperator('2', ADDRESS_2, { from: voting })

    await stakingRouter.setWithdrawalCredentials(pad('0x0202', 32), { from: voting })

    await operators.addSigningKeys(0, 1, pad('0x010203', 48), pad('0x01', 96), { from: voting })
    await operators.addSigningKeys(
      0,
      3,
      hexConcat(pad('0x010204', 48), pad('0x010205', 48), pad('0x010206', 48)),
      hexConcat(pad('0x01', 96), pad('0x01', 96), pad('0x01', 96)),
      { from: voting }
    )

    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })
    await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

    const [curated] = await stakingRouter.getStakingModules()

    await web3.eth.sendTransaction({ to: app.address, from: userAddress, value: initialDepositAmount })

    // deposit(maxDeposits, stakingModuleId, calldata)
    await app.methods[`deposit(uint256,uint256,bytes)`](MAX_DEPOSITS, curated.id, CALLDATA, { from: depositor })
  }

  describe('finalizeUpgrade_v2()', () => {
    let appBase
    beforeEach(async () => {
      // contract initialize with version == 2, so reset version
      await app.setVersion(0)
      await app.resetEip712StETH()

      appBase = await LidoMock.new()
    })

    it('reverts if not initialized', async () => {
      const proxyAddress = await newApp(dao, 'lido-pool', appBase.address, appManager.address)
      const appProxy = await LidoMock.at(proxyAddress)
      assert.reverts(appProxy.finalizeUpgrade_v2(lidoLocator.address, eip712StETH.address), 'NOT_INITIALIZED')
    })

    it('reverts with PETRIFIED on implementation finalized ', async () => {
      assert.reverts(appBase.finalizeUpgrade_v2(lidoLocator.address, eip712StETH.address), 'PETRIFIED')
    })

    it('reverts if already initialized', async () => {
      assert.equal(await app.getContractVersion(), 0)
      await app.finalizeUpgrade_v2(lidoLocator.address, eip712StETH.address)
      assert.equal(await app.getContractVersion(), 2)
      assertRevert(
        app.finalizeUpgrade_v2(stakingRouter.address, depositor, eip712StETH.address, withdrawalQueue.address),
        'WRONG_BASE_VERSION'
      )
    })

    it('reverts if lido locator address is ZERO', async () => {
      assertRevert(app.finalizeUpgrade_v2(ZERO_ADDRESS, eip712StETH.address), 'LIDO_LOCATOR_ZERO_ADDRESS')
    })

    it('reverts if eip712StETH address is ZERO', async () => {
      assertRevert(app.finalizeUpgrade_v2(lidoLocator.address, ZERO_ADDRESS), 'EIP712_STETH_ZERO_ADDRESS')
    })
  })

  context('EL Rewards', async () => {
    let rewarder

    beforeEach('set up rewarder and limits', async () => {
      rewarder = await RewardEmulatorMock.new(elRewardsVault.address)

      //TODO(DZhon): revive
      //const maxPositiveTokenRebase = bn(1).mul(bn(10).pow(bn(8))) // 10%
      //await assertRevert(app.setMaxPositiveTokenRebase(maxPositiveTokenRebase), 'APP_AUTH_FAILED')
      //const receipt = await app.setMaxPositiveTokenRebase(maxPositiveTokenRebase, { from: voting })
      //assertEvent(receipt, 'MaxPositiveTokenRebaseSet', { expectedArgs: { maxPositiveTokenRebase: maxPositiveTokenRebase } })
    })

    async function getStEthBalance(address) {
      return formatStEth(await app.balanceOf(address))
    }

    const logLidoState = async () => {
      const elRewardsVaultBalance = await getEthBalance(elRewardsVault.address)
      const lidoBalance = await getEthBalance(app.address)
      const lidoTotalSupply = formatBN(await app.totalSupply())
      const lidoTotalPooledEther = formatBN(await app.getTotalPooledEther())
      const lidoBufferedEther = formatBN(await app.getBufferedEther())
      const lidoTotalShares = formatBN(await app.getTotalShares())
      const beaconStat = await app.getBeaconStat()
      const depositedValidators = beaconStat.depositedValidators.toString()
      const beaconValidators = beaconStat.beaconValidators.toString()
      const beaconBalance = formatEther(beaconStat.beaconBalance)

      console.log({
        elRewardsVaultBalance,
        lidoBalance,
        lidoTotalSupply,
        lidoTotalPooledEther,
        lidoBufferedEther,
        lidoTotalShares,
        depositedValidators,
        beaconValidators,
        beaconBalance
      })
    }

    const logBalances = async () => {
      const user2stEthBalance = await getStEthBalance(user2)
      const treasuryStEthBalance = await getStEthBalance(treasury)
      console.log({ user2stEthBalance, treasuryStEthBalance })
    }

    const logAll = async () => {
      await logLidoState()
      await logBalances()
      console.log()
    }

    it('Execution layer rewards distribution works when zero rewards reported', async () => {
      const depositAmount = 32
      const elRewards = depositAmount / TOTAL_BASIS_POINTS
      const beaconRewards = 0

      await setupNodeOperatorsForELRewardsVaultTests(user2, ETH(depositAmount))
      await pushReport(1, ETH(depositAmount))

      await rewarder.reward({ from: user1, value: ETH(elRewards) })
      await pushReport(1, ETH(depositAmount + beaconRewards))

      assertBn(await app.getTotalPooledEther(), ETH(depositAmount + elRewards + beaconRewards))
      assertBn(await app.totalSupply(), ETH(depositAmount + elRewards + beaconRewards))
      assertBn(await app.balanceOf(user2), StETH(depositAmount + elRewards))
      assertBn(await app.getTotalELRewardsCollected(), ETH(elRewards))
    })

    it('Execution layer rewards distribution works when negative rewards reported', async () => {
      const depositAmount = 32
      const elRewards = depositAmount / TOTAL_BASIS_POINTS
      const beaconRewards = -2

      await setupNodeOperatorsForELRewardsVaultTests(user2, ETH(depositAmount))
      await pushReport(1, ETH(depositAmount))

      await rewarder.reward({ from: user1, value: ETH(elRewards) })
      await pushReport(1, ETH(depositAmount + beaconRewards))

      assertBn(await app.getTotalPooledEther(), ETH(depositAmount + elRewards + beaconRewards))
      assertBn(await app.balanceOf(user2), StETH(depositAmount + elRewards + beaconRewards))
      assertBn(await app.getTotalELRewardsCollected(), ETH(elRewards))
    })

    it('Execution layer rewards distribution works when positive rewards reported', async () => {
      const depositAmount = 32
      const elRewards = depositAmount / TOTAL_BASIS_POINTS
      const beaconRewards = 3

      await setupNodeOperatorsForELRewardsVaultTests(user2, ETH(depositAmount))
      await pushReport(1, ETH(depositAmount))

      await rewarder.reward({ from: user1, value: ETH(elRewards) })
      await pushReport(1, ETH(depositAmount + beaconRewards))

      assertBn(await app.getTotalPooledEther(), ETH(depositAmount + elRewards + beaconRewards))
      assertBn(await app.getTotalELRewardsCollected(), ETH(elRewards))

      const { modulesFee, treasuryFee } = await stakingRouter.getStakingFeeAggregateDistribution()

      const stakersReward = bn(ETH(elRewards + beaconRewards))
        .mul(FEE_PRECISION_POINTS.sub(modulesFee).sub(treasuryFee))
        .div(FEE_PRECISION_POINTS)

      assertBn(await app.balanceOf(user2), bn(StETH(depositAmount)).add(stakersReward))
    })

    it('Attempt to set invalid execution layer rewards withdrawal limit', async () => {
      //TODO: revive
      //const initialValue = await app.getMaxPositiveTokenRebase()

      //assertEvent(await app.setMaxPositiveTokenRebase(1, { from: voting }), 'MaxPositiveTokenRebaseSet', {
      //  expectedArgs: { maxPositiveTokenRebase: 1 }
      //})

      const setupNodeOperatorsForELRewardsVaultTests = async (userAddress, initialDepositAmount) => {
        await app.setFee(1000, { from: voting }) // 10%

        await web3.eth.sendTransaction({ to: app.address, from: userAddress, value: initialDepositAmount })

        const withdrawal = await WithdrawalVault.new(app.address, treasury)
        await app.setWithdrawalCredentials(hexConcat('0x01', pad(withdrawal.address, 31)), { from: voting })

        await operators.addNodeOperator('1', ADDRESS_1, { from: voting })
        await operators.addNodeOperator('2', ADDRESS_2, { from: voting })

        await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })
        await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

        await operators.addSigningKeys(0, 1, pad('0x010203', 48), pad('0x01', 96), { from: voting })
        await operators.addSigningKeys(
          0,
          3,
          hexConcat(pad('0x010204', 48), pad('0x010205', 48), pad('0x010206', 48)),
          hexConcat(pad('0x01', 96), pad('0x01', 96), pad('0x01', 96)),
          { from: voting }
        )

        await app.methods['depositBufferedEther()']({ from: depositor })
      }

      it('Execution layer rewards distribution works when zero rewards reported', async () => {
        const depositAmount = 32
        const elRewards = depositAmount / TOTAL_BASIS_POINTS
        const beaconRewards = 0

        await setupNodeOperatorsForELRewardsVaultTests(user2, ETH(depositAmount))
        await pushReport(1, ETH(depositAmount))

        await rewarder.reward({ from: user1, value: ETH(elRewards) })
        await pushReport(1, ETH(depositAmount + beaconRewards))

        assertBn(await app.getTotalPooledEther(), ETH(depositAmount + elRewards + beaconRewards))
        assertBn(await app.getBufferedEther(), ETH(elRewards))
        assertBn(await app.balanceOf(user2), StETH(depositAmount + elRewards))
        assertBn(await app.getTotalELRewardsCollected(), ETH(elRewards))
      })

      it('Execution layer rewards distribution works when negative rewards reported', async () => {
        const depositAmount = 32
        const elRewards = depositAmount / TOTAL_BASIS_POINTS
        const beaconRewards = -2

        await setupNodeOperatorsForELRewardsVaultTests(user2, ETH(depositAmount))
        await pushReport(1, ETH(depositAmount))

        await rewarder.reward({ from: user1, value: ETH(elRewards) })
        await pushReport(1, ETH(depositAmount + beaconRewards))

        assertBn(await app.getTotalPooledEther(), ETH(depositAmount + elRewards + beaconRewards))
        assertBn(await app.getBufferedEther(), ETH(elRewards))
        assertBn(await app.balanceOf(user2), StETH(depositAmount + elRewards + beaconRewards))
        assertBn(await app.getTotalELRewardsCollected(), ETH(elRewards))
      })

      it('Execution layer rewards distribution works when positive rewards reported', async () => {
        const depositAmount = 32
        const elRewards = depositAmount / TOTAL_BASIS_POINTS
        const beaconRewards = 3

        await setupNodeOperatorsForELRewardsVaultTests(user2, ETH(depositAmount))
        await pushReport(1, ETH(depositAmount))

        await rewarder.reward({ from: user1, value: ETH(elRewards) })
        await pushReport(1, ETH(depositAmount + beaconRewards))

        const {totalFee} = await app.getFee()
        const shareOfRewardsForStakers = (TOTAL_BASIS_POINTS - totalFee) / TOTAL_BASIS_POINTS
        assertBn(await app.getTotalPooledEther(), ETH(depositAmount + elRewards + beaconRewards))
        assertBn(await app.getBufferedEther(), ETH(elRewards))
        assertBn(await app.balanceOf(user2), StETH(depositAmount + shareOfRewardsForStakers * (elRewards + beaconRewards)))
        assertBn(await app.getTotalELRewardsCollected(), ETH(elRewards))
      })

      it('Attempt to set invalid execution layer rewards withdrawal limit', async () => {
        const initialValue = await app.getELRewardsWithdrawalLimit()

        assertEvent(await app.setELRewardsWithdrawalLimit(1, { from: voting }), 'ELRewardsWithdrawalLimitSet', {
          expectedArgs: { limitPoints: 1 }
        })

        await assertNoEvent(app.setELRewardsWithdrawalLimit(1, { from: voting }), 'ELRewardsWithdrawalLimitSet')

        await app.setELRewardsWithdrawalLimit(10000, { from: voting })
        await assertRevert(app.setELRewardsWithdrawalLimit(10001, { from: voting }), 'VALUE_OVER_100_PERCENT')

        await app.setELRewardsWithdrawalLimit(initialValue, { from: voting })

        // unable to receive execution layer rewards from arbitrary account
        assertRevert(app.receiveELRewards({ from: user1, value: ETH(1) }), 'EXECUTION_LAYER_REAWARDS_VAULT_ONLY')
      })
    })
  })

  describe('receiveELRewards()', async () => {
    it('unable to receive eth from arbitrary account', async () => {
      assertRevert(app.receiveELRewards({ from: nobody, value: ETH(1) }), 'EXECUTION_LAYER_REAWARDS_VAULT_ONLY')
    })

    it('event work', async () => {
      await ethers.provider.send('hardhat_impersonateAccount', [elRewardsVault.address])
      await ethers.provider.send('hardhat_setBalance', [elRewardsVault.address, web3.utils.numberToHex(ETH(100))])

      const receipt = await app.receiveELRewards({ from: elRewardsVault.address, value: ETH(2) })

      assertEvent(receipt, 'ELRewardsReceived', {
        expectedArgs: { amount: ETH(2) }
      })

      assertBn(await app.getTotalELRewardsCollected(), ETH(2))
    })
  })

  describe('receiveStakingRouter()', async () => {
    it('unable to receive eth from arbitrary account', async () => {
      assertRevert(app.receiveStakingRouter({ from: nobody, value: ETH(1) }))
    })

    it('event work', async () => {
      // unlock stakingRouter account (allow transactions originated from stakingRouter.address)
      await ethers.provider.send('hardhat_impersonateAccount', [stakingRouter.address])

      // add some amount to the sender
      await ethers.provider.send('hardhat_setBalance', [stakingRouter.address, web3.utils.numberToHex(ETH(100))])

      const receipt = await app.receiveStakingRouter({ from: stakingRouter.address, value: ETH(2) })

      assertEvent(receipt, 'StakingRouterTransferReceived', {
        expectedArgs: { amount: ETH(2) }
      })
    })
  })

  // TODO: check if reverts are checked in Staking Router tests and remove this test from here
  it.skip('setModulesFee works', async () => {
    const [curated] = await stakingRouter.getStakingModules()

    let module1 = await stakingRouter.getStakingModule(curated.id)
    assertBn(module1.targetShare, 10000)
    assertBn(module1.stakingModuleFee, 500)
    assertBn(module1.treasuryFee, 500)

    // stakingModuleId, targetShare, stakingModuleFee, treasuryFee
    await stakingRouter.updateStakingModule(module1.id, module1.targetShare, 300, 700, { from: voting })

    module1 = await stakingRouter.getStakingModule(curated.id)

    await assertRevert(
      stakingRouter.updateStakingModule(module1.id, module1.targetShare, 300, 700, { from: user1 }),
      `AccessControl: account ${user1.toLowerCase()} is missing role ${await stakingRouter.STAKING_MODULE_MANAGE_ROLE()}`
    )

    await assertRevert(
      stakingRouter.updateStakingModule(module1.id, module1.targetShare, 300, 700, { from: nobody }),
      `AccessControl: account ${nobody.toLowerCase()} is missing role ${await stakingRouter.STAKING_MODULE_MANAGE_ROLE()}`
    )

    await assert.revertsWithCustomError(
      stakingRouter.updateStakingModule(module1.id, 10001, 300, 700, { from: voting }),
      'ErrorValueOver100Percent("_targetShare")'
    )

    await assert.revertsWithCustomError(
      stakingRouter.updateStakingModule(module1.id, 10000, 10001, 700, { from: voting }),
      'ErrorValueOver100Percent("_stakingModuleFee + _treasuryFee")'
    )

    await assert.revertsWithCustomError(
      stakingRouter.updateStakingModule(module1.id, 10000, 300, 10001, { from: voting }),
      'ErrorValueOver100Percent("_stakingModuleFee + _treasuryFee")'
    )

    // distribution fee calculates on active keys in modules
    const depositAmount = 32
    await setupNodeOperatorsForELRewardsVaultTests(user2, ETH(depositAmount))

    const {totalFee} = await app.getFee()
    assertBn(totalFee, toPrecBP(1000))

    const distribution = await app.getFeeDistribution({ from: nobody })
    assertBn(distribution.modulesFee, toPrecBP(300))
    assertBn(distribution.treasuryFee, toPrecBP(700))
  })

  it('setWithdrawalCredentials works', async () => {
    await stakingRouter.setWithdrawalCredentials(pad('0x0202', 32), { from: voting })

    await assertRevert(
      stakingRouter.setWithdrawalCredentials(pad('0x0203', 32), { from: user1 }),
      `AccessControl: account ${user1.toLowerCase()} is missing role ${await stakingRouter.MANAGE_WITHDRAWAL_CREDENTIALS_ROLE()}`
    )

    assert.equal(await stakingRouter.getWithdrawalCredentials(), pad('0x0202', 32))
    assert.equal(await app.getWithdrawalCredentials(), pad('0x0202', 32))
  })

  it('setWithdrawalCredentials resets unused keys', async () => {
    await operators.addNodeOperator('1', ADDRESS_1, { from: voting })
    await operators.addNodeOperator('2', ADDRESS_2, { from: voting })

    await stakingRouter.setWithdrawalCredentials(pad('0x0202', 32), { from: voting })

    await operators.addSigningKeys(0, 1, pad('0x010203', 48), pad('0x01', 96), { from: voting })
    await operators.addSigningKeys(1, 2, hexConcat(pad('0x050505', 48), pad('0x060606', 48)), hexConcat(pad('0x02', 96), pad('0x03', 96)), {
      from: voting
    })

    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })
    await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

    assertBn(await operators.getTotalSigningKeyCount(0, { from: nobody }), 1)
    assertBn(await operators.getUnusedSigningKeyCount(0, { from: nobody }), 1)
    assertBn(await operators.getTotalSigningKeyCount(1, { from: nobody }), 2)
    assertBn(await operators.getUnusedSigningKeyCount(1, { from: nobody }), 2)

    await stakingRouter.setWithdrawalCredentials(pad('0x0203', 32), { from: voting })

    assertBn(await operators.getTotalSigningKeyCount(0, { from: nobody }), 0)
    assertBn(await operators.getUnusedSigningKeyCount(0, { from: nobody }), 0)
    assertBn(await operators.getTotalSigningKeyCount(1, { from: nobody }), 0)
    assertBn(await operators.getUnusedSigningKeyCount(1, { from: nobody }), 0)
    assert.equal(await app.getWithdrawalCredentials({ from: nobody }), pad('0x0203', 32))
  })

  it('Lido.deposit(uint256,uint256,bytes) reverts when called by account without DEPOSIT_ROLE granted', async () => {
    await assertRevert(
      app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: nobody }),
      'APP_AUTH_DSM_FAILED'
    )
  })

  it('deposit works', async () => {
    await stakingRouter.setWithdrawalCredentials('0x00', { from: voting })

    await operators.addNodeOperator('1', ADDRESS_1, { from: voting })
    await operators.addNodeOperator('2', ADDRESS_2, { from: voting })

    await operators.addSigningKeys(0, 1, pad('0x010203', 48), pad('0x01', 96), { from: voting })
    await operators.addSigningKeys(
      0,
      3,
      hexConcat(pad('0x010204', 48), pad('0x010205', 48), pad('0x010206', 48)),
      hexConcat(pad('0x01', 96), pad('0x01', 96), pad('0x01', 96)),
      { from: voting }
    )

    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })
    await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

    // zero deposits revert
    await assertRevert(app.submit(ZERO_ADDRESS, { from: user1, value: ETH(0) }), 'ZERO_DEPOSIT')
    await assertRevert(web3.eth.sendTransaction({ to: app.address, from: user2, value: ETH(0) }), 'ZERO_DEPOSIT')

    // +1 ETH
    await web3.eth.sendTransaction({ to: app.address, from: user1, value: ETH(1) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 0, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await depositContract.totalCalls(), 0)
    assertBn(await app.getTotalPooledEther(), ETH(1))
    assertBn(await app.getBufferedEther(), ETH(1))
    assertBn(await app.getTotalELRewardsCollected(), 0)
    assertBn(await app.balanceOf(user1), tokens(1))
    assertBn(await app.totalSupply(), tokens(1))

    // +2 ETH
    const receipt = await app.submit(ZERO_ADDRESS, { from: user2, value: ETH(2) }) // another form of a deposit call

    assertEvent(receipt, 'Transfer', { expectedArgs: { from: ZERO_ADDRESS, to: user2, value: ETH(2) } })

    await checkStat({ depositedValidators: 0, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await depositContract.totalCalls(), 0)
    assertBn(await app.getTotalPooledEther(), ETH(3))
    assertBn(await app.getBufferedEther(), ETH(3))
    assertBn(await app.getTotalELRewardsCollected(), 0)
    assertBn(await app.balanceOf(user2), tokens(2))
    assertBn(await app.totalSupply(), tokens(3))

    // +30 ETH
    await web3.eth.sendTransaction({ to: app.address, from: user3, value: ETH(30) })

    await operators.addSigningKeys(0, 1, pad('0x010203', 48), pad('0x01', 96), { from: voting })

    // can not deposit with unset withdrawalCredentials
    await assert.revertsWithCustomError(
      app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor }),
      'ErrorEmptyWithdrawalsCredentials()'
    )
    // set withdrawalCredentials with keys, because they were trimmed
    await stakingRouter.setWithdrawalCredentials(pad('0x0202', 32), { from: voting })

    assertBn(await stakingRouter.getStakingModuleMaxDepositableKeys(CURATED_MODULE_ID), 0)

    await operators.addSigningKeys(0, 1, pad('0x010203', 48), pad('0x01', 96), { from: voting })
    await operators.addSigningKeys(
      0,
      3,
      hexConcat(pad('0x010204', 48), pad('0x010205', 48), pad('0x010206', 48)),
      hexConcat(pad('0x01', 96), pad('0x01', 96), pad('0x01', 96)),
      { from: voting }
    )
    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })

    assertBn(await stakingRouter.getStakingModuleMaxDepositableKeys(CURATED_MODULE_ID), 1)
    assertBn(await app.getTotalPooledEther(), ETH(33))
    assertBn(await app.getBufferedEther(), ETH(33))

    // now deposit works
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })

    await checkStat({ depositedValidators: 1, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getTotalPooledEther(), ETH(33))
    assertBn(await app.getBufferedEther(), ETH(1))
    assertBn(await app.balanceOf(user1), tokens(1))
    assertBn(await app.balanceOf(user2), tokens(2))
    assertBn(await app.balanceOf(user3), tokens(30))
    assertBn(await app.totalSupply(), tokens(33))

    assertBn(await depositContract.totalCalls(), 1)
    const c0 = await depositContract.calls.call(0)
    assert.equal(c0.pubkey, pad('0x010203', 48))
    assert.equal(c0.withdrawal_credentials, pad('0x0202', 32))
    assert.equal(c0.signature, pad('0x01', 96))
    assertBn(c0.value, ETH(32))

    // +100 ETH, test partial unbuffering
    await web3.eth.sendTransaction({ to: app.address, from: user1, value: ETH(100) })
    await app.deposit(1, 1, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 2, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getTotalPooledEther(), ETH(133))
    assertBn(await app.getBufferedEther(), ETH(69))
    assertBn(await app.balanceOf(user1), tokens(101))
    assertBn(await app.balanceOf(user2), tokens(2))
    assertBn(await app.balanceOf(user3), tokens(30))
    assertBn(await app.totalSupply(), tokens(133))

    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 4, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getTotalPooledEther(), ETH(133))
    assertBn(await app.getBufferedEther(), ETH(5))
    assertBn(await app.balanceOf(user1), tokens(101))
    assertBn(await app.balanceOf(user2), tokens(2))
    assertBn(await app.balanceOf(user3), tokens(30))
    assertBn(await app.totalSupply(), tokens(133))

    assertBn(await depositContract.totalCalls(), 4)
    const calls = {}
    for (const i of [1, 2, 3]) {
      calls[i] = await depositContract.calls.call(i)
      assert.equal(calls[i].withdrawal_credentials, pad('0x0202', 32))
      assert.equal(calls[i].signature, pad('0x01', 96))
      assertBn(calls[i].value, ETH(32))
    }
    assert.equal(calls[1].pubkey, pad('0x010204', 48))
    assert.equal(calls[2].pubkey, pad('0x010205', 48))
    assert.equal(calls[3].pubkey, pad('0x010206', 48))
  })

  it('deposit uses the expected signing keys', async () => {
    await operators.addNodeOperator('1', ADDRESS_1, { from: voting })
    await operators.addNodeOperator('2', ADDRESS_2, { from: voting })

    const op0 = {
      keys: Array.from({ length: 3 }, (_, i) => `0x11${i}${i}` + 'abcd'.repeat(46 / 2)),
      sigs: Array.from({ length: 3 }, (_, i) => `0x11${i}${i}` + 'cdef'.repeat(94 / 2))
    }

    const op1 = {
      keys: Array.from({ length: 3 }, (_, i) => `0x22${i}${i}` + 'efab'.repeat(46 / 2)),
      sigs: Array.from({ length: 3 }, (_, i) => `0x22${i}${i}` + 'fcde'.repeat(94 / 2))
    }

    await stakingRouter.setWithdrawalCredentials(pad('0x0202', 32), { from: voting })

    await operators.addSigningKeys(0, 3, hexConcat(...op0.keys), hexConcat(...op0.sigs), { from: voting })
    await operators.addSigningKeys(1, 3, hexConcat(...op1.keys), hexConcat(...op1.sigs), { from: voting })

    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })
    await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

    await app.submit(ZERO_ADDRESS, { from: user2, value: ETH(32) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    assertBn(await depositContract.totalCalls(), 1, 'first submit: total deposits')

    await app.submit(ZERO_ADDRESS, { from: user2, value: ETH(2 * 32) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    assertBn(await depositContract.totalCalls(), 3, 'second submit: total deposits')

    await app.submit(ZERO_ADDRESS, { from: user2, value: ETH(3 * 32) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    assertBn(await depositContract.totalCalls(), 6, 'third submit: total deposits')

    const calls = await Promise.all(Array.from({ length: 6 }, (_, i) => depositContract.calls(i)))
    const keys = [...op0.keys, ...op1.keys]
    const sigs = [...op0.sigs, ...op1.sigs]
    const pairs = keys.map((key, i) => `${key}|${sigs[i]}`)

    assert.sameMembers(
      calls.map((c) => `${c.pubkey}|${c.signature}`),
      pairs,
      'pairs'
    )
  })

  it('deposit works when the first node operator is inactive', async () => {
    await operators.addNodeOperator('1', ADDRESS_1, { from: voting })
    await operators.addNodeOperator('2', ADDRESS_2, { from: voting })

    await stakingRouter.setWithdrawalCredentials(pad('0x0202', 32), { from: voting })

    await operators.addSigningKeys(0, 1, pad('0x010203', 48), pad('0x01', 96), { from: voting })
    await operators.addSigningKeys(1, 1, pad('0x030405', 48), pad('0x06', 96), { from: voting })

    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })
    await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

    await operators.deactivateNodeOperator(0, { from: voting })
    await app.submit(ZERO_ADDRESS, { from: user2, value: ETH(32) })

    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    assertBn(await depositContract.totalCalls(), 1)
  })

  it('submits with zero and non-zero referrals work', async () => {
    const REFERRAL = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF'
    let receipt
    receipt = await app.submit(REFERRAL, { from: user2, value: ETH(2) })
    assertEvent(receipt, 'Submitted', { expectedArgs: { sender: user2, amount: ETH(2), referral: REFERRAL } })
    receipt = await app.submit(ZERO_ADDRESS, { from: user2, value: ETH(5) })
    assertEvent(receipt, 'Submitted', { expectedArgs: { sender: user2, amount: ETH(5), referral: ZERO_ADDRESS } })
  })

  const verifyStakeLimitState = async (
    expectedMaxStakeLimit,
    expectedLimitIncrease,
    expectedCurrentStakeLimit,
    expectedIsStakingPaused,
    expectedIsStakingLimited
  ) => {
    assert((await app.isStakingPaused()) === false)
    currentStakeLimit = await app.getCurrentStakeLimit()
    assertBn(currentStakeLimit, expectedCurrentStakeLimit)

    isStakingPaused = await app.isStakingPaused()
    assert.equal(isStakingPaused, expectedIsStakingPaused)
      ; ({
        isStakingPaused,
        isStakingLimitSet,
        currentStakeLimit,
        maxStakeLimit,
        maxStakeLimitGrowthBlocks,
        prevStakeLimit,
        prevStakeBlockNumber
      } = await app.getStakeLimitFullInfo())

    assertBn(currentStakeLimit, expectedCurrentStakeLimit)
    assertBn(maxStakeLimit, expectedMaxStakeLimit)
    assert.equal(isStakingPaused, expectedIsStakingPaused)
    assert.equal(isStakingLimitSet, expectedIsStakingLimited)

    if (isStakingLimitSet) {
      assertBn(maxStakeLimitGrowthBlocks, expectedLimitIncrease > 0 ? expectedMaxStakeLimit / expectedLimitIncrease : 0)
    }
  }

  it('staking pause & unlimited resume works', async () => {
    let receipt

    const MAX_UINT256 = bn(2).pow(bn(256)).sub(bn(1))
    await verifyStakeLimitState(bn(0), bn(0), MAX_UINT256, false, false)
    receipt = await app.submit(ZERO_ADDRESS, { from: user2, value: ETH(2) })
    assertEvent(receipt, 'Submitted', { expectedArgs: { sender: user2, amount: ETH(2), referral: ZERO_ADDRESS } })

    await assertRevert(app.pauseStaking(), 'APP_AUTH_FAILED')
    receipt = await app.pauseStaking({ from: voting })
    assertEvent(receipt, 'StakingPaused')
    verifyStakeLimitState(bn(0), bn(0), bn(0), true, false)

    await assertRevert(web3.eth.sendTransaction({ to: app.address, from: user2, value: ETH(2) }), `STAKING_PAUSED`)
    await assertRevert(app.submit(ZERO_ADDRESS, { from: user2, value: ETH(2) }), `STAKING_PAUSED`)

    await assertRevert(app.resumeStaking(), 'APP_AUTH_FAILED')
    receipt = await app.resumeStaking({ from: voting })
    assertEvent(receipt, 'StakingResumed')
    await verifyStakeLimitState(bn(0), bn(0), MAX_UINT256, false, false)

    await web3.eth.sendTransaction({ to: app.address, from: user2, value: ETH(1.1) })
    receipt = await app.submit(ZERO_ADDRESS, { from: user2, value: ETH(1.4) })
    assertEvent(receipt, 'Submitted', { expectedArgs: { sender: user2, amount: ETH(1.4), referral: ZERO_ADDRESS } })
  })

  it('staking resume with a limit works', async () => {
    let receipt

    const blocksToReachMaxStakeLimit = 300
    const expectedMaxStakeLimit = ETH(3)
    const limitIncreasePerBlock = bn(expectedMaxStakeLimit).div(bn(blocksToReachMaxStakeLimit)) // 1 * 10**16

    receipt = await app.resumeStaking({ from: voting })
    assertEvent(receipt, 'StakingResumed')

    await assertRevert(app.setStakingLimit(expectedMaxStakeLimit, limitIncreasePerBlock), 'APP_AUTH_FAILED')
    receipt = await app.setStakingLimit(expectedMaxStakeLimit, limitIncreasePerBlock, { from: voting })
    assertEvent(receipt, 'StakingLimitSet', {
      expectedArgs: {
        maxStakeLimit: expectedMaxStakeLimit,
        stakeLimitIncreasePerBlock: limitIncreasePerBlock
      }
    })

    await verifyStakeLimitState(expectedMaxStakeLimit, limitIncreasePerBlock, expectedMaxStakeLimit, false, true)
    receipt = await app.submit(ZERO_ADDRESS, { from: user2, value: ETH(2) })
    assertEvent(receipt, 'Submitted', { expectedArgs: { sender: user2, amount: ETH(2), referral: ZERO_ADDRESS } })
    await verifyStakeLimitState(expectedMaxStakeLimit, limitIncreasePerBlock, ETH(1), false, true)
    await assertRevert(app.submit(ZERO_ADDRESS, { from: user2, value: ETH(2.5) }), `STAKE_LIMIT`)
    await verifyStakeLimitState(expectedMaxStakeLimit, limitIncreasePerBlock, bn(ETH(1)).add(limitIncreasePerBlock), false, true)

    // expect to grow for another 1.5 ETH since last submit
    // every revert produces new block, so we need to account that block
    await waitBlocks(blocksToReachMaxStakeLimit / 2 - 1)
    await verifyStakeLimitState(expectedMaxStakeLimit, limitIncreasePerBlock, ETH(2.5), false, true)
    await assertRevert(app.submit(ZERO_ADDRESS, { from: user2, value: ETH(2.6) }), `STAKE_LIMIT`)
    receipt = await app.submit(ZERO_ADDRESS, { from: user2, value: ETH(2.5) })
    assertEvent(receipt, 'Submitted', { expectedArgs: { sender: user2, amount: ETH(2.5), referral: ZERO_ADDRESS } })
    await verifyStakeLimitState(expectedMaxStakeLimit, limitIncreasePerBlock, limitIncreasePerBlock.muln(2), false, true)

    await assertRevert(app.submit(ZERO_ADDRESS, { from: user2, value: ETH(0.1) }), `STAKE_LIMIT`)
    await verifyStakeLimitState(expectedMaxStakeLimit, limitIncreasePerBlock, limitIncreasePerBlock.muln(3), false, true)
    // once again, we are subtracting blocks number induced by revert checks
    await waitBlocks(blocksToReachMaxStakeLimit / 3 - 4)

    receipt = await app.submit(ZERO_ADDRESS, { from: user1, value: ETH(1) })
    assertEvent(receipt, 'Submitted', { expectedArgs: { sender: user1, amount: ETH(1), referral: ZERO_ADDRESS } })
    await verifyStakeLimitState(expectedMaxStakeLimit, limitIncreasePerBlock, ETH(0), false, true)

    // check that limit is restored completely
    await waitBlocks(blocksToReachMaxStakeLimit)
    await verifyStakeLimitState(expectedMaxStakeLimit, limitIncreasePerBlock, expectedMaxStakeLimit, false, true)

    // check that limit is capped by maxLimit value and doesn't grow infinitely
    await waitBlocks(10)
    await verifyStakeLimitState(expectedMaxStakeLimit, limitIncreasePerBlock, expectedMaxStakeLimit, false, true)

    await assertRevert(app.setStakingLimit(ETH(0), ETH(0), { from: voting }), `ZERO_MAX_STAKE_LIMIT`)
    await assertRevert(app.setStakingLimit(ETH(1), ETH(1.1), { from: voting }), `TOO_LARGE_LIMIT_INCREASE`)
    await assertRevert(app.setStakingLimit(ETH(1), bn(10), { from: voting }), `TOO_SMALL_LIMIT_INCREASE`)
  })

  it('resume staking with an one-shot limit works', async () => {
    let receipt

    const expectedMaxStakeLimit = ETH(7)
    const limitIncreasePerBlock = 0

    receipt = await app.resumeStaking({ from: voting })
    assertEvent(receipt, 'StakingResumed')
    receipt = await app.setStakingLimit(expectedMaxStakeLimit, limitIncreasePerBlock, { from: voting })
    assertEvent(receipt, 'StakingLimitSet', {
      expectedArgs: {
        maxStakeLimit: expectedMaxStakeLimit,
        stakeLimitIncreasePerBlock: limitIncreasePerBlock
      }
    })

    await verifyStakeLimitState(expectedMaxStakeLimit, limitIncreasePerBlock, expectedMaxStakeLimit, false, true)
    receipt = await app.submit(ZERO_ADDRESS, { from: user2, value: ETH(5) })
    assertEvent(receipt, 'Submitted', { expectedArgs: { sender: user2, amount: ETH(5), referral: ZERO_ADDRESS } })
    await verifyStakeLimitState(expectedMaxStakeLimit, limitIncreasePerBlock, ETH(2), false, true)
    receipt = await app.submit(ZERO_ADDRESS, { from: user2, value: ETH(2) })
    assertEvent(receipt, 'Submitted', { expectedArgs: { sender: user2, amount: ETH(2), referral: ZERO_ADDRESS } })
    await verifyStakeLimitState(expectedMaxStakeLimit, limitIncreasePerBlock, ETH(0), false, true)
    await assertRevert(app.submit(ZERO_ADDRESS, { from: user2, value: ETH(0.1) }), `STAKE_LIMIT`)
    await verifyStakeLimitState(expectedMaxStakeLimit, limitIncreasePerBlock, ETH(0), false, true)
    await waitBlocks(100)
    await verifyStakeLimitState(expectedMaxStakeLimit, limitIncreasePerBlock, ETH(0), false, true)
  })

  it('resume staking with various changing limits work', async () => {
    let receipt

    const expectedMaxStakeLimit = ETH(9)
    const limitIncreasePerBlock = bn(expectedMaxStakeLimit).divn(100)

    receipt = await app.resumeStaking({ from: voting })
    assertEvent(receipt, 'StakingResumed')
    receipt = await app.setStakingLimit(expectedMaxStakeLimit, limitIncreasePerBlock, { from: voting })
    assertEvent(receipt, 'StakingLimitSet', {
      expectedArgs: {
        maxStakeLimit: expectedMaxStakeLimit,
        stakeLimitIncreasePerBlock: limitIncreasePerBlock
      }
    })

    await verifyStakeLimitState(expectedMaxStakeLimit, limitIncreasePerBlock, expectedMaxStakeLimit, false, true)

    const smallerExpectedMaxStakeLimit = ETH(5)
    const smallerLimitIncreasePerBlock = bn(smallerExpectedMaxStakeLimit).divn(200)

    receipt = await app.setStakingLimit(smallerExpectedMaxStakeLimit, smallerLimitIncreasePerBlock, { from: voting })
    assertEvent(receipt, 'StakingLimitSet', {
      expectedArgs: {
        maxStakeLimit: smallerExpectedMaxStakeLimit,
        stakeLimitIncreasePerBlock: smallerLimitIncreasePerBlock
      }
    })

    await verifyStakeLimitState(smallerExpectedMaxStakeLimit, smallerLimitIncreasePerBlock, smallerExpectedMaxStakeLimit, false, true)

    const largerExpectedMaxStakeLimit = ETH(10)
    const largerLimitIncreasePerBlock = bn(largerExpectedMaxStakeLimit).divn(1000)

    receipt = await app.setStakingLimit(largerExpectedMaxStakeLimit, largerLimitIncreasePerBlock, { from: voting })
    assertEvent(receipt, 'StakingLimitSet', {
      expectedArgs: {
        maxStakeLimit: largerExpectedMaxStakeLimit,
        stakeLimitIncreasePerBlock: largerLimitIncreasePerBlock
      }
    })

    await verifyStakeLimitState(largerExpectedMaxStakeLimit, largerLimitIncreasePerBlock, smallerExpectedMaxStakeLimit, false, true)

    await assertRevert(app.removeStakingLimit(), 'APP_AUTH_FAILED')
    receipt = await app.removeStakingLimit({ from: voting })
    assertEvent(receipt, 'StakingLimitRemoved')

    await verifyStakeLimitState(0, 0, bn(2).pow(bn(256)).sub(bn(1)), false, false)
  })

  it('reverts when trying to call unknown function', async () => {
    const wrongMethodABI = '0x00'
    await assertRevert(web3.eth.sendTransaction({ to: app.address, from: user2, value: ETH(1), data: wrongMethodABI }), 'NON_EMPTY_DATA')
    await assertRevert(web3.eth.sendTransaction({ to: app.address, from: user2, value: ETH(0), data: wrongMethodABI }), 'NON_EMPTY_DATA')
  })

  it('key removal is taken into account during deposit', async () => {
    await operators.addNodeOperator('1', ADDRESS_1, { from: voting })
    await operators.addNodeOperator('2', ADDRESS_2, { from: voting })

    await stakingRouter.setWithdrawalCredentials(pad('0x0202', 32), { from: voting })
    await operators.addSigningKeys(0, 1, pad('0x010203', 48), pad('0x01', 96), { from: voting })
    await operators.addSigningKeys(
      0,
      3,
      hexConcat(pad('0x010204', 48), pad('0x010205', 48), pad('0x010206', 48)),
      hexConcat(pad('0x01', 96), pad('0x01', 96), pad('0x01', 96)),
      { from: voting }
    )

    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })
    await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

    await web3.eth.sendTransaction({ to: app.address, from: user3, value: ETH(33) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    assertBn(await depositContract.totalCalls(), 1)
    await assertRevert(operators.removeSigningKey(0, 0, { from: voting }), 'KEY_WAS_USED')

    assertBn(await app.getBufferedEther(), ETH(1))

    await operators.removeSigningKey(0, 1, { from: voting })

    await web3.eth.sendTransaction({ to: app.address, from: user3, value: ETH(100) })

    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    assertBn(await depositContract.totalCalls(), 1)
    assertBn(await app.getTotalPooledEther(), ETH(133))
    assertBn(await app.getBufferedEther(), ETH(101))
  })

  it("out of signing keys doesn't revert but buffers", async () => {
    await operators.addNodeOperator('1', ADDRESS_1, { from: voting })
    await operators.addNodeOperator('2', ADDRESS_2, { from: voting })

    await stakingRouter.setWithdrawalCredentials(pad('0x0202', 32), { from: voting })

    await operators.addSigningKeys(0, 1, pad('0x010203', 48), pad('0x01', 96), { from: voting })

    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })
    await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

    await web3.eth.sendTransaction({ to: app.address, from: user3, value: ETH(100) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 1, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await depositContract.totalCalls(), 1)
    assertBn(await app.getTotalPooledEther(), ETH(100))
    assertBn(await app.getBufferedEther(), ETH(100 - 32))

    // buffer unwinds
    await operators.addSigningKeys(
      0,
      3,
      hexConcat(pad('0x010204', 48), pad('0x010205', 48), pad('0x010206', 48)),
      hexConcat(pad('0x01', 96), pad('0x01', 96), pad('0x01', 96)),
      { from: voting }
    )

    // increase staking limit
    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })

    await web3.eth.sendTransaction({ to: app.address, from: user1, value: ETH(1) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 3, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await depositContract.totalCalls(), 3)
    assertBn(await app.getTotalPooledEther(), ETH(101))
    assertBn(await app.getBufferedEther(), ETH(5))
  })

  it('handleOracleReport works', async () => {
    await operators.addNodeOperator('1', ADDRESS_1, { from: voting })
    await operators.addNodeOperator('2', ADDRESS_2, { from: voting })

    await stakingRouter.setWithdrawalCredentials(pad('0x0202', 32), { from: voting })
    await operators.addSigningKeys(0, 1, pad('0x010203', 48), pad('0x01', 96), { from: voting })
    await operators.addSigningKeys(
      0,
      3,
      hexConcat(pad('0x010204', 48), pad('0x010205', 48), pad('0x010206', 48)),
      hexConcat(pad('0x01', 96), pad('0x01', 96), pad('0x01', 96)),
      { from: voting }
    )

    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })
    await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

    await web3.eth.sendTransaction({ to: app.address, from: user2, value: ETH(34) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 1, beaconValidators: 0, beaconBalance: ETH(0) })

    await assertRevert(
      app.handleOracleReport(await getTimestamp(), 1, ETH(30), 0, 0, 0, 0, 0, { from: appManager }),
      'APP_AUTH_FAILED'
    )

    await pushReport(1, ETH(30))
    await checkStat({ depositedValidators: 1, beaconValidators: 1, beaconBalance: ETH(30) })

    await assertRevert(app.handleOracleReport(await getTimestamp(), 1, ETH(29), 0, 0, 0, 0, 0, { from: nobody }), 'APP_AUTH_FAILED')

    await pushReport(1, ETH(100)) // stale data
    await checkStat({ depositedValidators: 1, beaconValidators: 1, beaconBalance: ETH(100) })

    await pushReport(1, ETH(33))
    await checkStat({ depositedValidators: 1, beaconValidators: 1, beaconBalance: ETH(33) })
  })

  it('oracle data affects deposits', async () => {
    await operators.addNodeOperator('1', ADDRESS_1, { from: voting })
    await operators.addNodeOperator('2', ADDRESS_2, { from: voting })

    await web3.eth.sendTransaction({ to: app.address, from: user2, value: ETH(34) })
    const withdrawal = await WithdrawalVault.new(app.address, treasury)
    const withdrawalCredentials = hexConcat('0x01', pad(withdrawal.address, 31))
    await stakingRouter.setWithdrawalCredentials(withdrawalCredentials, { from: voting })
    await operators.addSigningKeys(0, 1, pad('0x010203', 48), pad('0x01', 96), { from: voting })
    await operators.addSigningKeys(
      0,
      3,
      hexConcat(pad('0x010204', 48), pad('0x010205', 48), pad('0x010206', 48)),
      hexConcat(pad('0x01', 96), pad('0x01', 96), pad('0x01', 96)),
      { from: voting }
    )

    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })
    await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 1, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await depositContract.totalCalls(), 1)
    assertBn(await app.getTotalPooledEther(), ETH(34))
    assertBn(await app.getBufferedEther(), ETH(2))

    // down
    await pushReport(1, ETH(15))

    await checkStat({ depositedValidators: 1, beaconValidators: 1, beaconBalance: ETH(15) })
    assertBn(await depositContract.totalCalls(), 1)
    assertBn(await app.getTotalPooledEther(), ETH(17))
    assertBn(await app.getBufferedEther(), ETH(2))
    assertBn(await app.totalSupply(), tokens(17))

    // deposit, ratio is 0.5
    await web3.eth.sendTransaction({ to: app.address, from: user1, value: ETH(2) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })

    await checkStat({ depositedValidators: 1, beaconValidators: 1, beaconBalance: ETH(15) })
    assertBn(await depositContract.totalCalls(), 1)
    assertBn(await app.getTotalPooledEther(), ETH(19))
    assertBn(await app.getBufferedEther(), ETH(4))
    assertBn(await app.balanceOf(user1), tokens(2))
    assertBn(await app.totalSupply(), tokens(19))

    // up
    await assertRevert(pushReport(2, ETH(48)), 'REPORTED_MORE_DEPOSITED')
    await pushReport(1, ETH(48))

    await checkStat({ depositedValidators: 1, beaconValidators: 1, beaconBalance: ETH(48) })
    assertBn(await depositContract.totalCalls(), 1)
    assertBn(await app.getTotalPooledEther(), ETH(52))
    assertBn(await app.getBufferedEther(), ETH(4))
    assertBn(await app.totalSupply(), tokens(52))
  })

  it('can stop and resume', async () => {
    await operators.addNodeOperator('1', ADDRESS_1, { from: voting })
    await operators.addNodeOperator('2', ADDRESS_2, { from: voting })

    await stakingRouter.setWithdrawalCredentials(pad('0x0202', 32), { from: voting })
    await operators.addSigningKeys(0, 1, pad('0x010203', 48), pad('0x01', 96), { from: voting })
    await operators.addSigningKeys(
      0,
      3,
      hexConcat(pad('0x010204', 48), pad('0x010205', 48), pad('0x010206', 48)),
      hexConcat(pad('0x01', 96), pad('0x01', 96), pad('0x01', 96)),
      { from: voting }
    )

    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })
    await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

    await web3.eth.sendTransaction({ to: app.address, from: user2, value: ETH(40) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 1, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getBufferedEther(), ETH(8))

    await assertRevert(app.stop({ from: user2 }), 'APP_AUTH_FAILED')
    await app.stop({ from: voting })
    assert((await app.isStakingPaused()) === true)

    await assertRevert(web3.eth.sendTransaction({ to: app.address, from: user1, value: ETH(4) }), 'STAKING_PAUSED')
    await assertRevert(web3.eth.sendTransaction({ to: app.address, from: user1, value: ETH(4) }), 'STAKING_PAUSED')
    await assertRevert(app.submit('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', { from: user1, value: ETH(4) }), 'STAKING_PAUSED')

    await assertRevert(app.resume({ from: user2 }), 'APP_AUTH_FAILED')
    await app.resume({ from: voting })
    assert((await app.isStakingPaused()) === false)

    await web3.eth.sendTransaction({ to: app.address, from: user1, value: ETH(4) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 1, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getBufferedEther(), ETH(12))
  })

  it('rewards distribution on module with zero treasury and module fee', async () => {
    await operators.addNodeOperator('1', ADDRESS_1, { from: voting })
    await operators.addNodeOperator('2', ADDRESS_2, { from: voting })

    await stakingRouter.setWithdrawalCredentials(pad('0x0202', 32), { from: voting })
    await operators.addSigningKeys(0, 1, pad('0x010203', 48), pad('0x01', 96), { from: voting })
    await operators.addSigningKeys(
      0,
      3,
      hexConcat(pad('0x010204', 48), pad('0x010205', 48), pad('0x010206', 48)),
      hexConcat(pad('0x01', 96), pad('0x01', 96), pad('0x01', 96)),
      { from: voting }
    )

    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })
    await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

    // get staking module
    const [curated] = await stakingRouter.getStakingModules()

    let module1 = await stakingRouter.getStakingModule(curated.id)
    assertBn(module1.targetShare, 10000)
    assertBn(module1.stakingModuleFee, 500)
    assertBn(module1.treasuryFee, 500)

    // stakingModuleId, targetShare, stakingModuleFee, treasuryFee
    await stakingRouter.updateStakingModule(module1.id, module1.targetShare, 0, 0, { from: voting })

    module1 = await stakingRouter.getStakingModule(curated.id)
    assertBn(module1.targetShare, 10000)
    assertBn(module1.stakingModuleFee, 0)
    assertBn(module1.treasuryFee, 0)

    // check stat before deposit
    await checkStat({ depositedValidators: 0, beaconValidators: 0, beaconBalance: 0 })

    await web3.eth.sendTransaction({ to: app.address, from: user2, value: ETH(34) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })

    await pushReport(1, ETH(36))
    await checkStat({ depositedValidators: 1, beaconValidators: 1, beaconBalance: ETH(36) })
    assertBn(await app.totalSupply(), ETH(38)) // remote + buffered
    await checkRewards({ treasury: 0, operator: 0 })

    // return module commission
    await stakingRouter.updateStakingModule(module1.id, module1.targetShare, 500, 500, { from: voting })

    //
    await pushReport(1, ETH(38))
    await checkStat({ depositedValidators: 1, beaconValidators: 1, beaconBalance: ETH(38) })
    assertBn(await app.totalSupply(), ETH(40)) // remote + buffered
    await checkRewards({ treasury: 100, operator: 99 })
  })

  it('rewards distribution works in a simple case', async () => {

    await operators.addNodeOperator('1', ADDRESS_1, { from: voting })
    await operators.addNodeOperator('2', ADDRESS_2, { from: voting })

    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })
    await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

    await web3.eth.sendTransaction({ to: app.address, from: user2, value: ETH(34) })
    const withdrawal = await WithdrawalVault.new(app.address, treasury)
    await stakingRouter.setWithdrawalCredentials(hexConcat('0x01', pad(withdrawal.address, 31)), { from: voting })
    await operators.addSigningKeys(0, 1, pad('0x010203', 48), pad('0x01', 96), { from: voting })
    await operators.addSigningKeys(
      0,
      3,
      hexConcat(pad('0x010204', 48), pad('0x010205', 48), pad('0x010206', 48)),
      hexConcat(pad('0x01', 96), pad('0x01', 96), pad('0x01', 96)),
      { from: voting }
    )

    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })
    await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })

    await pushReport(1, ETH(36))
    await checkStat({ depositedValidators: 1, beaconValidators: 1, beaconBalance: ETH(36) })
    assertBn(await app.totalSupply(), ETH(38)) // remote + buffered
    await checkRewards({ treasury: 199, operator: 199 })
  })

  it('rewards distribution works', async () => {
    await operators.addNodeOperator('1', ADDRESS_1, { from: voting })
    await operators.addNodeOperator('2', ADDRESS_2, { from: voting })

    await web3.eth.sendTransaction({ to: app.address, from: user2, value: ETH(34) })
    const withdrawal = await WithdrawalVault.new(app.address, treasury)
    await stakingRouter.setWithdrawalCredentials(hexConcat('0x01', pad(withdrawal.address, 31)), { from: voting })
    await operators.addSigningKeys(0, 1, pad('0x010203', 48), pad('0x01', 96), { from: voting })
    await operators.addSigningKeys(
      0,
      3,
      hexConcat(pad('0x010204', 48), pad('0x010205', 48), pad('0x010206', 48)),
      hexConcat(pad('0x01', 96), pad('0x01', 96), pad('0x01', 96)),
      { from: voting }
    )

    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })
    await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    // some slashing occurred
    await pushReport(1, ETH(30))

    await checkStat({ depositedValidators: 1, beaconValidators: 1, beaconBalance: ETH(30) })
    // ToDo check buffer=2
    assertBn(await app.totalSupply(), tokens(32)) // 30 remote (slashed) + 2 buffered = 32
    await checkRewards({ treasury: 0, operator: 0 })

    // rewarded 200 Ether (was 30, became 230)
    await pushReport(1, ETH(130))
    await checkStat({ depositedValidators: 1, beaconValidators: 1, beaconBalance: ETH(130) })
    // Todo check reward effects
    // await checkRewards({ treasury: 0, operator: 0 })

    await pushReport(1, ETH(2230))
    await checkStat({ depositedValidators: 1, beaconValidators: 1, beaconBalance: ETH(2230) })
    assertBn(await app.totalSupply(), tokens(2232))
    // Todo check reward effects
    // await checkRewards({ treasury: tokens(33), operator: tokens(55) })
  })

  it('deposits accounted properly during rewards distribution', async () => {
    await stakingRouter.setWithdrawalCredentials(pad('0x0202', 32), { from: voting })

    await operators.addNodeOperator('1', ADDRESS_1, { from: voting })
    await operators.addNodeOperator('2', ADDRESS_2, { from: voting })
    await operators.addSigningKeys(0, 1, pad('0x010203', 48), pad('0x01', 96), { from: voting })
    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })
    await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

    // Only 32 ETH deposited
    await web3.eth.sendTransaction({ to: app.address, from: user3, value: ETH(32) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await web3.eth.sendTransaction({ to: app.address, from: user3, value: ETH(32) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    assertBn(await app.totalSupply(), tokens(64))

    await pushReport(1, ETH(36))
    await checkStat({ depositedValidators: 1, beaconValidators: 1, beaconBalance: ETH(36) })
    assertBn(await app.totalSupply(), tokens(68))
    await checkRewards({ treasury: 200, operator: 199 })
  })

  it('Node Operators filtering during deposit works when doing a huge deposit', async () => {
    await stakingRouter.setWithdrawalCredentials(pad('0x0202', 32), { from: voting })

    // id: 0
    await nodeOperators.addNodeOperator(
      operators,
      { name: 'good', rewardAddress: ADDRESS_1, totalSigningKeysCount: 2, vettedSigningKeysCount: 2 },
      { from: voting }
    )

    // id: 1
    await nodeOperators.addNodeOperator(
      operators,
      { name: 'limited', rewardAddress: ADDRESS_2, totalSigningKeysCount: 2, vettedSigningKeysCount: 1 },
      { from: voting }
    )

    // id: 2
    await nodeOperators.addNodeOperator(
      operators,
      { name: 'deactivated', rewardAddress: ADDRESS_3, totalSigningKeysCount: 2, vettedSigningKeysCount: 2, isActive: false },
      { from: voting }
    )

    // id: 3
    await nodeOperators.addNodeOperator(operators, { name: 'short on keys', rewardAddress: ADDRESS_4 }, { from: voting })

    // Deposit huge chunk
    await web3.eth.sendTransaction({ to: app.address, from: user1, value: ETH(32 * 3 + 50) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 3, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getTotalPooledEther(), ETH(146))
    assertBn(await app.getBufferedEther(), ETH(50))
    assertBn(await depositContract.totalCalls(), 3)

    assertBn(await operators.getTotalSigningKeyCount(0, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(1, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(3, { from: nobody }), 0)

    assertBn(await operators.getUnusedSigningKeyCount(0, { from: nobody }), 0)
    assertBn(await operators.getUnusedSigningKeyCount(1, { from: nobody }), 1)
    assertBn(await operators.getUnusedSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getUnusedSigningKeyCount(3, { from: nobody }), 0)

    // Next deposit changes nothing
    await web3.eth.sendTransaction({ to: app.address, from: user2, value: ETH(32) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 3, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getTotalPooledEther(), ETH(178))
    assertBn(await app.getBufferedEther(), ETH(82))
    assertBn(await depositContract.totalCalls(), 3)

    assertBn(await operators.getTotalSigningKeyCount(0, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(1, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(3, { from: nobody }), 0)

    assertBn(await operators.getUnusedSigningKeyCount(0, { from: nobody }), 0)
    assertBn(await operators.getUnusedSigningKeyCount(1, { from: nobody }), 1)
    assertBn(await operators.getUnusedSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getUnusedSigningKeyCount(3, { from: nobody }), 0)

    // #1 goes below the limit
    await operators.updateExitedValidatorsKeysCount(1, 1, { from: voting })
    await web3.eth.sendTransaction({ to: app.address, from: user3, value: ETH(1) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 3, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getTotalPooledEther(), ETH(179))
    assertBn(await app.getBufferedEther(), ETH(83))
    assertBn(await depositContract.totalCalls(), 3)

    assertBn(await operators.getTotalSigningKeyCount(0, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(1, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(3, { from: nobody }), 0)

    assertBn(await operators.getUnusedSigningKeyCount(0, { from: nobody }), 0)
    assertBn(await operators.getUnusedSigningKeyCount(1, { from: nobody }), 1)
    assertBn(await operators.getUnusedSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getUnusedSigningKeyCount(3, { from: nobody }), 0)

    // Adding a key & setting staking limit will help
    await operators.addSigningKeys(0, 1, pad('0x0003', 48), pad('0x01', 96), { from: voting })
    operators.setNodeOperatorStakingLimit(0, 3, { from: voting })

    await web3.eth.sendTransaction({ to: app.address, from: user3, value: ETH(1) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 4, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getTotalPooledEther(), ETH(180))
    assertBn(await app.getBufferedEther(), ETH(52))
    assertBn(await depositContract.totalCalls(), 4)

    assertBn(await operators.getTotalSigningKeyCount(0, { from: nobody }), 3)
    assertBn(await operators.getTotalSigningKeyCount(1, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(3, { from: nobody }), 0)

    assertBn(await operators.getUnusedSigningKeyCount(0, { from: nobody }), 0)
    assertBn(await operators.getUnusedSigningKeyCount(1, { from: nobody }), 1)
    assertBn(await operators.getUnusedSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getUnusedSigningKeyCount(3, { from: nobody }), 0)

    // Reactivation of #2 doesn't change anything cause keys of #2 was trimmed
    await operators.activateNodeOperator(2, { from: voting })
    await web3.eth.sendTransaction({ to: app.address, from: user3, value: ETH(12) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 4, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getTotalPooledEther(), ETH(192))
    assertBn(await app.getBufferedEther(), ETH(64))
    assertBn(await depositContract.totalCalls(), 4)

    assertBn(await operators.getTotalSigningKeyCount(0, { from: nobody }), 3)
    assertBn(await operators.getTotalSigningKeyCount(1, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(3, { from: nobody }), 0)

    assertBn(await operators.getUnusedSigningKeyCount(0, { from: nobody }), 0)
    assertBn(await operators.getUnusedSigningKeyCount(1, { from: nobody }), 1)
    assertBn(await operators.getUnusedSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getUnusedSigningKeyCount(3, { from: nobody }), 0)
  })

  it('Node Operators filtering during deposit works when doing small deposits', async () => {
    await stakingRouter.setWithdrawalCredentials(pad('0x0202', 32), { from: voting })

    // id: 0
    await nodeOperators.addNodeOperator(
      operators,
      { name: 'good', rewardAddress: ADDRESS_1, totalSigningKeysCount: 2, vettedSigningKeysCount: 2 },
      { from: voting }
    )

    // id: 1
    await nodeOperators.addNodeOperator(
      operators,
      { name: 'limited', rewardAddress: ADDRESS_2, totalSigningKeysCount: 2, vettedSigningKeysCount: 1 },
      { from: voting }
    )

    // id: 2
    await nodeOperators.addNodeOperator(
      operators,
      { name: 'deactivated', rewardAddress: ADDRESS_3, totalSigningKeysCount: 2, vettedSigningKeysCount: 2, isActive: false },
      { from: voting }
    )

    // id: 3
    await nodeOperators.addNodeOperator(operators, { name: 'short on keys', rewardAddress: ADDRESS_4 }, { from: voting })

    // Small deposits
    for (let i = 0; i < 14; i++) await web3.eth.sendTransaction({ to: app.address, from: user1, value: ETH(10) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await web3.eth.sendTransaction({ to: app.address, from: user1, value: ETH(6) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })

    await checkStat({ depositedValidators: 3, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getTotalPooledEther(), ETH(146))
    assertBn(await app.getBufferedEther(), ETH(50))
    assertBn(await depositContract.totalCalls(), 3)

    assertBn(await operators.getTotalSigningKeyCount(0, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(1, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(3, { from: nobody }), 0)

    assertBn(await operators.getUnusedSigningKeyCount(0, { from: nobody }), 0)
    assertBn(await operators.getUnusedSigningKeyCount(1, { from: nobody }), 1)
    assertBn(await operators.getUnusedSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getUnusedSigningKeyCount(3, { from: nobody }), 0)

    // Next deposit changes nothing
    await web3.eth.sendTransaction({ to: app.address, from: user2, value: ETH(32) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 3, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getTotalPooledEther(), ETH(178))
    assertBn(await app.getBufferedEther(), ETH(82))
    assertBn(await depositContract.totalCalls(), 3)

    assertBn(await operators.getTotalSigningKeyCount(0, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(1, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(3, { from: nobody }), 0)

    assertBn(await operators.getUnusedSigningKeyCount(0, { from: nobody }), 0)
    assertBn(await operators.getUnusedSigningKeyCount(1, { from: nobody }), 1)
    assertBn(await operators.getUnusedSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getUnusedSigningKeyCount(3, { from: nobody }), 0)

    // #1 goes below the limit (doesn't change situation. validator stop decreases limit)
    await operators.updateExitedValidatorsKeysCount(1, 1, { from: voting })
    await web3.eth.sendTransaction({ to: app.address, from: user3, value: ETH(1) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 3, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getTotalPooledEther(), ETH(179))
    assertBn(await app.getBufferedEther(), ETH(83))
    assertBn(await depositContract.totalCalls(), 3)

    assertBn(await operators.getTotalSigningKeyCount(0, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(1, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(3, { from: nobody }), 0)

    assertBn(await operators.getUnusedSigningKeyCount(0, { from: nobody }), 0)
    assertBn(await operators.getUnusedSigningKeyCount(1, { from: nobody }), 1)
    assertBn(await operators.getUnusedSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getUnusedSigningKeyCount(3, { from: nobody }), 0)

    // Adding a key & setting staking limit will help
    await operators.addSigningKeys(0, 1, pad('0x0003', 48), pad('0x01', 96), { from: voting })
    operators.setNodeOperatorStakingLimit(0, 3, { from: voting })

    await web3.eth.sendTransaction({ to: app.address, from: user3, value: ETH(1) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 4, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getTotalPooledEther(), ETH(180))
    assertBn(await app.getBufferedEther(), ETH(52))
    assertBn(await depositContract.totalCalls(), 4)

    assertBn(await operators.getTotalSigningKeyCount(0, { from: nobody }), 3)
    assertBn(await operators.getTotalSigningKeyCount(1, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(3, { from: nobody }), 0)

    assertBn(await operators.getUnusedSigningKeyCount(0, { from: nobody }), 0)
    assertBn(await operators.getUnusedSigningKeyCount(1, { from: nobody }), 1)
    assertBn(await operators.getUnusedSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getUnusedSigningKeyCount(3, { from: nobody }), 0)

    // Reactivation of #2 (changes nothing, it's not used keys were trimmed)
    await operators.activateNodeOperator(2, { from: voting })
    await web3.eth.sendTransaction({ to: app.address, from: user3, value: ETH(12) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 4, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getTotalPooledEther(), ETH(192))
    assertBn(await app.getBufferedEther(), ETH(64))
    assertBn(await depositContract.totalCalls(), 4)

    assertBn(await operators.getTotalSigningKeyCount(0, { from: nobody }), 3)
    assertBn(await operators.getTotalSigningKeyCount(1, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getTotalSigningKeyCount(3, { from: nobody }), 0)

    assertBn(await operators.getUnusedSigningKeyCount(0, { from: nobody }), 0)
    assertBn(await operators.getUnusedSigningKeyCount(1, { from: nobody }), 1)
    assertBn(await operators.getUnusedSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getUnusedSigningKeyCount(3, { from: nobody }), 0)
  })

  it('Deposit finds the right operator', async () => {
    await stakingRouter.setWithdrawalCredentials(pad('0x0202', 32), { from: voting })

    await operators.addNodeOperator('good', ADDRESS_1, { from: voting }) // 0
    await operators.addSigningKeys(0, 2, hexConcat(pad('0x0001', 48), pad('0x0002', 48)), hexConcat(pad('0x01', 96), pad('0x01', 96)), {
      from: voting
    })
    await operators.setNodeOperatorStakingLimit(0, UNLIMITED, { from: voting })

    await operators.addNodeOperator('2nd good', ADDRESS_2, { from: voting }) // 1
    await operators.addSigningKeys(1, 2, hexConcat(pad('0x0101', 48), pad('0x0102', 48)), hexConcat(pad('0x01', 96), pad('0x01', 96)), {
      from: voting
    })
    await operators.setNodeOperatorStakingLimit(1, UNLIMITED, { from: voting })

    await operators.addNodeOperator('deactivated', ADDRESS_3, { from: voting }) // 2
    await operators.addSigningKeys(2, 2, hexConcat(pad('0x0201', 48), pad('0x0202', 48)), hexConcat(pad('0x01', 96), pad('0x01', 96)), {
      from: voting
    })
    await operators.setNodeOperatorStakingLimit(2, UNLIMITED, { from: voting })
    await operators.deactivateNodeOperator(2, { from: voting })

    await operators.addNodeOperator('short on keys', ADDRESS_4, { from: voting }) // 3
    await operators.setNodeOperatorStakingLimit(3, UNLIMITED, { from: voting })

    // #1 and #0 get the funds
    await web3.eth.sendTransaction({ to: app.address, from: user2, value: ETH(64) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 2, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getTotalPooledEther(), ETH(64))
    assertBn(await app.getBufferedEther(), ETH(0))
    assertBn(await depositContract.totalCalls(), 2)

    assertBn(await operators.getUnusedSigningKeyCount(0, { from: nobody }), 1)
    assertBn(await operators.getUnusedSigningKeyCount(1, { from: nobody }), 1)
    assertBn(await operators.getUnusedSigningKeyCount(2, { from: nobody }), 2)
    assertBn(await operators.getUnusedSigningKeyCount(3, { from: nobody }), 0)

    // Reactivation of #2 & setting staking limit - has the smallest stake
    await operators.activateNodeOperator(2, { from: voting })
    await operators.addSigningKeys(2, 2, hexConcat(pad('0x0201', 48), pad('0x0202', 48)), hexConcat(pad('0x01', 96), pad('0x01', 96)), {
      from: voting
    })
    await operators.setNodeOperatorStakingLimit(2, UNLIMITED, { from: voting })

    await web3.eth.sendTransaction({ to: app.address, from: user2, value: ETH(36) })
    await app.methods['deposit(uint256,uint256,bytes)'](MAX_DEPOSITS, CURATED_MODULE_ID, CALLDATA, { from: depositor })
    await checkStat({ depositedValidators: 3, beaconValidators: 0, beaconBalance: ETH(0) })
    assertBn(await app.getTotalPooledEther(), ETH(100))
    assertBn(await app.getBufferedEther(), ETH(4))
    assertBn(await depositContract.totalCalls(), 3)

    assertBn(await operators.getUnusedSigningKeyCount(0, { from: nobody }), 1)
    assertBn(await operators.getUnusedSigningKeyCount(1, { from: nobody }), 1)
    assertBn(await operators.getUnusedSigningKeyCount(2, { from: nobody }), 3)
    assertBn(await operators.getUnusedSigningKeyCount(3, { from: nobody }), 0)
  })

  it('burnShares works', async () => {
    await web3.eth.sendTransaction({ to: app.address, from: user1, value: ETH(1) })

    // can burn shares of an arbitrary user
    const expectedPreTokenAmount = await app.getPooledEthByShares(ETH(0.5))
    let receipt = await app.burnShares(user1, ETH(0.5), { from: voting })
    const expectedPostTokenAmount = await app.getPooledEthByShares(ETH(0.5))
    assertEvent(receipt, 'SharesBurnt', {
      expectedArgs: {
        account: user1,
        preRebaseTokenAmount: expectedPreTokenAmount,
        postRebaseTokenAmount: expectedPostTokenAmount,
        sharesAmount: ETH(0.5)
      }
    })

    const expectedPreDoubledAmount = await app.getPooledEthByShares(ETH(0.5))
    receipt = await app.burnShares(user1, ETH(0.5), { from: voting })
    const expectedPostDoubledAmount = await app.getPooledEthByShares(ETH(0.5))
    assertEvent(receipt, 'SharesBurnt', {
      expectedArgs: {
        account: user1,
        preRebaseTokenAmount: expectedPreDoubledAmount,
        postRebaseTokenAmount: expectedPostDoubledAmount,
        sharesAmount: ETH(0.5)
      }
    })

    assertBn(expectedPreTokenAmount.mul(bn(2)), expectedPreDoubledAmount)
    assertBn(tokens(0), await app.getPooledEthByShares(ETH(0.5)))

    // user1 has zero shares after all
    assertBn(await app.sharesOf(user1), tokens(0))

    // voting can't continue burning if user already has no shares
    await assertRevert(app.burnShares(user1, 1, { from: voting }), 'BURN_AMOUNT_EXCEEDS_BALANCE')
  })

  context('treasury', () => {
    it('treasury address has been set after init', async () => {
      assert.notEqual(await lidoLocator.treasury(), ZERO_ADDRESS)
    })
  })

  context('recovery vault', () => {
    beforeEach(async () => {
      await anyToken.mint(app.address, 100)
      await badToken.mint(app.address, 100)
    })

    it('reverts when vault is not set', async () => {
      await assertRevert(app.transferToVault(anyToken.address, { from: nobody }), 'NOT_SUPPORTED')
    })

    it('reverts when recover disallowed', async () => {
      await app.setAllowRecoverability(false)
      await assertRevert(app.transferToVault(anyToken.address, { from: nobody }), 'NOT_SUPPORTED')
    })

    context('reverts when vault is set', () => {
      let vault

      beforeEach(async () => {
        // Create a new vault and set that vault as the default vault in the kernel
        const vaultId = hash('vault.aragonpm.test')
        const vaultBase = await AragonVaultMock.new()
        const vaultReceipt = await dao.newAppInstance(vaultId, vaultBase.address, '0x', true)
        const vaultAddress = getInstalledApp(vaultReceipt)
        vault = await AragonVaultMock.at(vaultAddress)
        await vault.initialize()

        await dao.setRecoveryVaultAppId(vaultId)
      })

      it('recovery with erc20 tokens reverts', async () => {
        await assertRevert(
          app.transferToVault(anyToken.address, { from: nobody }),
          'NOT_SUPPORTED'
        )
      })

      it('recovery with unaccounted ether reverts', async () => {
        await app.makeUnaccountedEther({ from: user1, value: ETH(10) })
        await assertRevert(
          app.transferToVault(ZERO_ADDRESS, { from: nobody }),
          'NOT_SUPPORTED'
        )
      })
    })
  })
})
