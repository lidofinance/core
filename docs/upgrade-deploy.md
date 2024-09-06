# Deploy Lido contracts on upgrades

To help with deploying contracts on upgrades there are scripts under [scripts/upgrade](/scripts/upgrade).

## Deploy LidoLocator

At first, you need to specify `DEPLOYER` private key in accounts.json under `/eth/sepolia`, e.g.:

```json
{
  "eth": {
    "sepolia": ["<DEPLOYER-PK>"]
  }
}
```

E. g. to deploy `LidoLocator` implementation with new addresses for `legacyOracle` and `postTokenRebaseReceiver`
on Sepolia run

```shell
legacyOracle=<PUT-YOU-VALUE> \
postTokenRebaseReceiver=<PUT-YOU-VALUE> \
GAS_MAX_FEE=100 GAS_PRIORITY_FEE=2 \
DEPLOYER=<PUT-YOU-VALUE> \
RPC_URL=<PUT-YOU-VALUE> \
STEPS_FILE=scripts/upgrade/steps.json \
yarn hardhat --network sepolia run --no-compile scripts/utils/migrate.ts
```

specifying require values under `<PUT-YOU-VALUE>`.

Names of env variables specifying new addresses (e.g. `postTokenRebaseReceiver`) correspond to immutables names of
`LidoLocator` contract.
