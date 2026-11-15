"""Check required MCP initialization without submitting a model request."""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import tomllib

from apps.api.app import codex_runtime as runtime
from apps.api.app.settings import llm_settings, SANDBOX_STATE_ROOT

settings = llm_settings()
environment = runtime._runtime_environment('runtime-check', 'runtime-check', 0, settings)
environment.pop('LLMR_CODEX_CONVERSATION_ID', None)
environment.pop('LLMR_CODEX_TURN_ID', None)
overrides = runtime._mcp_overrides(environment)
mcp = tomllib.loads('\n'.join(overrides))['mcp_servers']['llm_research']
request = '\n'.join(json.dumps(value) for value in [
    {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
        'protocolVersion': '2024-11-05', 'capabilities': {},
        'clientInfo': {'name': 'deployment-check', 'version': '1'}}},
    {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
    {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}},
]) + '\n'
result = subprocess.run([mcp['command'], *mcp['args']], input=request,
    text=True, capture_output=True, cwd=mcp['cwd'], env={**environment, **mcp.get('env', {})}, timeout=30)
if result.returncode:
    raise RuntimeError(result.stderr[-4000:])
responses = [json.loads(line) for line in result.stdout.splitlines() if line]
assert next(item for item in responses if item.get('id') == 1).get('result')
tools = next(item for item in responses if item.get('id') == 2)['result']['tools']
print('MCP stdio initialize and tools/list OK:', len(tools), 'tools', flush=True)
_, Codex, CodexConfig, Sandbox, _, _ = runtime._sdk()
with tempfile.TemporaryDirectory(prefix='runtime-check-', dir=SANDBOX_STATE_ROOT) as directory:
    workspace = Path(directory)
    (workspace / 'tmp').mkdir()
    config = CodexConfig(cwd=directory, env=environment,
        config_overrides=runtime._provider_overrides(settings) + runtime._workspace_overrides(workspace) + overrides)
    with Codex(config=config) as codex:
        thread = codex.thread_start(model=str(settings['model']), model_provider=runtime.codex_provider_name(), cwd=directory,
                           sandbox=Sandbox.workspace_write)
        print('Codex thread start with required llm_research MCP OK', flush=True)
        if '--model-request' in sys.argv:
            from openai_codex import TextInput
            status = None
            for event in thread.turn([TextInput(text='Reply only OK. Do not use tools.')],
                    model=str(settings['model']), effort=str(settings['reasoning_effort'])).stream():
                payload = runtime._jsonable(event.payload)
                if event.method == 'turn/completed':
                    status = payload['turn']['status']
            assert status == 'completed', status
            print('Codex model request completed:', settings['model'], flush=True)
            catalog = codex.models().model_dump(by_alias=True)['data']
            models = [{'id': item['model'], 'label': item['displayName'],
                       'efforts': [e['reasoningEffort'] for e in item['supportedReasoningEfforts']]}
                      for item in catalog if not item['hidden']]
            (SANDBOX_STATE_ROOT / 'model-catalog-candidate.json').write_text(
                json.dumps({'models': models}, ensure_ascii=False))
            print('Codex model catalog:', len(models), 'visible models', flush=True)
