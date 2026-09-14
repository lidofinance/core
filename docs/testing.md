# Testing

Unit tests use Hardhat’s in-process network (`yarn test`). The integration runner
requires an external Anvil or Hardhat node and only accepts `RUN_NETWORK=local`.
Tests mutate that node using snapshots, impersonation and time travel.

```bash
# Start a disposable node in another terminal.
anvil --port 8555 --base-fee 0 --gas-price 0

# Deploy, provision and test on it, preserving the requested DG setting.
RPC_URL=http://127.0.0.1:8555 DG_DEPLOYMENT_ENABLED=false yarn test:integration:scratch:local

# Deploy with the full post-deploy checks, then provision/test that deployment.
RPC_URL=http://127.0.0.1:8555 bash scripts/dao-local-deploy.sh

# Test an existing scratch deployment without deploying it again.
RPC_URL=http://127.0.0.1:8555 PROVISION_ON_FORK=1 yarn test:integration:fork:local
```

`MODE=scratch` calls `deployScratchProtocol()` before provisioning.
`MODE=forking` discovers existing contracts from `NETWORK_STATE_FILE` and provisions
only when `PROVISION_ON_FORK=1`. With the external `local` runtime, neither mode
creates an additional in-process fork. `RPC_URL` selects the node, and `NETWORK`
selects the state namespace (normally `local`).

| Command                          | Behavior                                                                   |
| -------------------------------- | -------------------------------------------------------------------------- |
| `test:integration:scratch:local` | New deployment; preserves DG toggle and genesis inputs                     |
| `test:integration:scratch`       | New deployment with DG forced off; requires `NETWORK` and an external node |
| `test:integration:fork:local`    | Existing deployment on the local external node                             |
| `test:integration`               | Existing deployment by default; requires `NETWORK`                         |
| `test:integration:upgrade`       | Existing deployment followed by upgrade steps on the external node         |

Both deployment wrappers and `just` node recipes use this supported topology.
`GENESIS_TIME` defaults only when unset; select Sepolia genesis time `1655733600`
and fork version `0x90000069` for a Sepolia fork. DG needs Forge and a reachable HTTP
RPC; see [scratch deployment](scratch-deploy.md) for setup and recovery details.

To select integration files, pass their paths to `yarn test:integration`.
Coverage commands and direct `hardhat test` commands have their own runtime setup;
they do not go through the integration runner.
