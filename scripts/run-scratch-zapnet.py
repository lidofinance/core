import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request

work = Path(__file__).resolve().parents[1]
out = work / '.local/zapnet' / os.environ.get('PILOT_RUN', 'run1')
out.mkdir(parents=True, exist_ok=True)
(out / 'tmp').mkdir(exist_ok=True)
url = os.environ.get('ZAP_RPC_URL', 'http://127.0.0.1:18546')

def rpc(method, params=None, control=False):
    data = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or []}).encode()
    req = urllib.request.Request(url + ('/control' if control else ''), data=data, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as response:
        result = json.load(response)
    if result.get('error'):
        raise RuntimeError(result['error'])
    return result['result']

env = dict(os.environ)
env.update({
    'NETWORK': 'local-devnet', 'RUN_NETWORK': 'local-devnet', 'MODE': 'scratch',
    'RPC_URL': url, 'LOCAL_RPC_URL': url, 'LOCAL_DEVNET_CHAIN_ID': '1337',
    'LOCAL_DEVNET_PK': '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    'DEPLOYER': '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    'GENESIS_TIME': '2000000000', 'GENESIS_FORK_VERSION': '0x10000000',
    'SLOTS_PER_EPOCH': '32', 'DEPOSIT_CONTRACT': '0x4242424242424242424242424242424242424242',
    'GAS_PRIORITY_FEE': '1', 'GAS_MAX_FEE': '10', 'GAS_LIMIT': '',
    'NETWORK_STATE_FILE': 'deployed-local-devnet.json',
    'SCRATCH_DEPLOY_CONFIG': 'scripts/scratch/deploy-params-zapnet.toml', 'STEPS_FILE': 'scratch/steps.json',
    'AUTO_CONFIRM': 'true', 'ALLOW_SKIP_STEPS': 'false',
    'SKIP_INTERFACES_CHECK': 'true', 'SKIP_CONTRACT_SIZE': 'true',
    'SKIP_GAS_REPORT': 'true', 'SKIP_LINT_SOLIDITY': 'true',
    'TMPDIR': str(out / 'tmp'), 'HUSKY': '0', 'FORCE_COLOR': '0', 'FOUNDRY_THREADS': '2',
    'UPGRADE': 'false', 'AUTO_FEE': 'false',
})
assert not (work / env['NETWORK_STATE_FILE']).exists(), 'Scratch requires a fresh deployment artifact'
before = rpc('status', control=True)
assert before['id'] == os.environ.get('ZAP_ID', 'lido1940fix') and before['profile'] == 'gloas' and before['bake'] == 'stable'
assert int(before['el']['number'], 16) == 0, 'Measure scratch only on a fresh chain'
warmup_started = time.perf_counter()
rpc('stepSlot', control=True)
for attempt in range(100):
    try:
        assert rpc('eth_getTransactionReceipt', ['0x' + '00' * 32]) is None
        break
    except RuntimeError as error:
        if 'indexing is in progress' not in str(error):
            raise
        time.sleep(0.05)
else:
    raise RuntimeError('Geth transaction indexer did not become ready')
warmup_elapsed = time.perf_counter() - warmup_started
before = rpc('status', control=True)
assert int(rpc('eth_getTransactionCount', [env['DEPLOYER'], 'latest']), 16) == 0
rpc('setAutomine', [True], control=True)
command = ['yarn', 'deploy:scratch']
started = time.perf_counter()
events = []
with (out / 'deploy.log').open('w') as log:
    process = subprocess.Popen(command, cwd=work, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in process.stdout:
        log.write(line)
        log.flush()
        clean = re.sub(r'\x1b\[[0-9;]*m', '', line).strip()
        if clean.startswith('{'):
            try:
                event = json.loads(clean)
            except json.JSONDecodeError:
                event = {}
            if event.get('event') == 'scratch-vote-wait':
                status = rpc('status', control=True)
                remaining = event['executableAt'] - int(status['el']['timestamp'], 16)
                assert 0 <= remaining <= 600, 'Unexpected governance wait duration'
                slots = (remaining + 11) // 12
                advanced = time.perf_counter()
                rpc('advanceSlots', [slots], control=True)
                print(json.dumps({'event': 'vote-time-advanced', 'slots': slots, 'elapsedSeconds': time.perf_counter() - advanced}), flush=True)
            elif event.get('event') == 'external-project':
                print(json.dumps({'elapsedSeconds': time.perf_counter() - started, **event}), flush=True)
        if clean.startswith('Applying migration:'):
            event = {'elapsedSeconds': time.perf_counter() - started, 'step': clean.split('Applying migration: ', 1)[1].split('/scripts/')[-1]}
            events.append(event)
            print(json.dumps(event), flush=True)
    exit_code = process.wait()
elapsed = time.perf_counter() - started
after = rpc('status', control=True)
result = {'command': command, 'exitCode': exit_code, 'elapsedSeconds': elapsed, 'warmupSeconds': warmup_elapsed, 'before': before, 'after': after, 'stepsStarted': events}
(out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'exitCode': exit_code, 'elapsedSeconds': elapsed, 'latestBlock': after['el']['number']}), flush=True)
raise SystemExit(exit_code)
