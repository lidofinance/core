const APPS_TO_NAMES = new Map([
  ['lido', 'Lido'],
  ['node-operators-registry', 'NodeOperatorsRegistry'],
  ['oracle', 'LidoOracle']
])

const CONTRACTS_TO_NAMES = new Map([
  ['wstethContract', 'WstETH'],
  ['executionLayerRewardsVault', 'LidoExecutionLayerRewardsVault'],
  ['compositePostRebaseBeaconReceiver', 'CompositePostRebaseBeaconReceiver'],
  ['selfOwnedStETHBurner', 'SelfOwnedStETHBurner'],
  ['depositor', 'DepositSecurityModule']
])

const IGNORE_METADATA_CONTRACTS = ['WstETH']

module.exports = {
  APPS_TO_NAMES,
  CONTRACTS_TO_NAMES,
  IGNORE_METADATA_CONTRACTS
}
