import base64
import importlib.util
from io import BytesIO
import json
from pathlib import Path
import sys

from PIL import Image
import pytest


@pytest.fixture
def bridge(monkeypatch):
    path = Path(__file__).resolve().parents[2] / 'skills/kairos/llm-research-workbench/scripts/workbench.py'
    spec = importlib.util.spec_from_file_location('service_image_test_bridge', path)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    monkeypatch.setenv('LLMR_WORKBENCH_ORIGIN', 'http://127.0.0.1:18860')
    monkeypatch.setenv('LLMR_WORKBENCH_PUBLIC_ORIGIN', 'https://research.example')
    monkeypatch.setattr(module.Workbench, 'verify', lambda _: {'paths': {
        **{path: {'post': {'requestBody': {'content': {'application/json': {}}}}}
           for path in module.SERVICE_PREVIEW_PATHS},
        module.SERVICE_CARD_PNG_PATH: {'get': {}},
        '/api/v1/client-service/robots/{robot_id}/send': {'post': {}},
    }})
    return module


def rpc_call(bridge, name, arguments):
    return bridge.rpc(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                                  'params': {'name': name, 'arguments': arguments}}))['result']


@pytest.mark.parametrize('endpoint', ['preview', 'opening-plans/preview', 'rebalance-suggestions/preview', 'celebrations'])
def test_hosted_service_preview_returns_a_complete_mcp_image(bridge, monkeypatch, endpoint):
    body = BytesIO()
    Image.new('RGB', (128, 128)).save(body, format='PNG', compress_level=0)
    original = body.getvalue()
    image_url = bridge.PNG_DATA_URL + base64.b64encode(original).decode('ascii')
    assert len(image_url) > 28000

    def request(base, path, **kwargs):
        if path == '/api/v1/auth/status':
            return 200, {'mode': 'local'}
        return 200, {'width': 128, 'height': 128, 'image': image_url}

    monkeypatch.setattr(bridge, 'request', request)
    result = rpc_call(bridge, 'workbench_write', {
        'operation': f'POST /api/v1/client-service/{endpoint}', 'body': {},
    })
    assert not result['isError']
    text, image = result['content']
    assert json.loads(text['text'])['data'] == {'width': 128, 'height': 128}
    assert image['type'] == 'image' and image['mimeType'] == 'image/png'
    assert base64.b64decode(image['data'], validate=True) == original


def test_hosted_card_download_embeds_the_png_and_keeps_the_download_link(bridge, monkeypatch):
    body = BytesIO()
    Image.new('RGB', (16, 16)).save(body, format='PNG')
    original = body.getvalue()

    def request(base, path, **kwargs):
        if path == '/api/v1/auth/status':
            return 200, {'mode': 'local'}
        assert kwargs['inline_png']
        return 200, {'url': base + path, 'media_type': 'image/png', '_mcp_image': bridge.service_image(original)}

    monkeypatch.setattr(bridge, 'request', request)
    result = rpc_call(bridge, 'workbench_download', {
        'operation': 'GET ' + bridge.SERVICE_CARD_PNG_PATH, 'path': {'card_id': 'card-id'},
    })
    assert not result['isError']
    text, image = result['content']
    assert json.loads(text['text'])['url'] == 'https://research.example/api/v1/client-service/cards/card-id/image.png'
    assert base64.b64decode(image['data'], validate=True) == original


def test_hosted_service_still_excludes_robot_send(bridge):
    result = rpc_call(bridge, 'workbench_describe', {'operation': 'POST /api/v1/client-service/robots/{robot_id}/send'})
    assert result['isError']
