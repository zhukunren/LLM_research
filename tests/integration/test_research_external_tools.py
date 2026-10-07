import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
import requests
import socket

from apps.api.app import db, conversation_store, research_external, screening_tools
from apps.api.app.tool_protocol import ToolCall


def test_external_tools_are_available_in_research_and_cancelled_turns_cannot_capture(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'DB_PATH',tmp_path/'app.db')
    db.init_db()
    cid=conversation_store.create_conversation('screening',workflow_type='research')['id']
    message=conversation_store.add_user_message(cid,'source-check',0,'读取公开来源')
    conversation_store.start_turn(cid,message['turn_id'])
    context=screening_tools.ToolContext(cid,message['turn_id'],0,workflow_type='research')
    names={tool.name for tool in screening_tools.registry.tools_for_codex(context)}
    assert {'capture_research_page','download_research_source','inspect_research_pdf','inspect_research_image','list_research_external_sources'}<=names
    definitions={tool.name:tool.as_mcp() for tool in screening_tools.registry.tools_for_codex(context)}
    for name in ('capture_research_page','download_research_source'):
        assert definitions[name]['annotations']['readOnlyHint'] is True
        assert definitions[name]['annotations']['openWorldHint'] is True
    called=[]
    monkeypatch.setattr(research_external,'_public_url',lambda url:called.append(url) or url)
    with db.connect() as connection:
        connection.execute("UPDATE conversation_turns SET state='cancelled' WHERE id=?",(message['turn_id'],))
    result=screening_tools.registry.dispatch(ToolCall('cancelled','capture_research_page',{'url':'https://example.com/'}),context)
    assert not result['ok'] and called==[]


def test_dynamic_page_is_rendered_and_persisted_with_tables_links_and_screenshot(tmp_path,monkeypatch):
    html='''<!doctype html><title>Dynamic source fixture</title><meta name="date" content="2026-09-30">
    <h1>Public filing fixture</h1><table id="data"><tr><th>Year</th><th>Revenue EUR million</th></tr></table>
    <a href="original.pdf">Original PDF</a><script>setTimeout(()=>document.querySelector('#data').insertAdjacentHTML('beforeend','<tr id="loaded"><td>2025</td><td>1499.6</td></tr>'),120)</script>'''
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*_): pass
        def do_GET(self):
            payload=html.encode()
            self.send_response(200); self.send_header('Content-Type','text/html; charset=utf-8'); self.send_header('Content-Length',str(len(payload))); self.end_headers(); self.wfile.write(payload)
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
    # Explicit fixture transport maps this public test hostname to our isolated
    # HTTP server. Production URL validation remains enabled and rejects any
    # other host; no application setting permits access to private sources.
    real_dns = socket.getaddrinfo
    def fixture_dns(host, port, *args, **kwargs):
        if host == 'public-fixture.example':
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', port))]
        return real_dns(host, port, *args, **kwargs)
    monkeypatch.setattr(socket, 'getaddrinfo', fixture_dns)
    class FixtureTransport:
        def __init__(self):
            self.session = requests.Session()
            self.session.trust_env = False
        def request(self, method, url, **kwargs):
            assert url == 'http://public-fixture.example/'
            response = self.session.request(method, f'http://127.0.0.1:{server.server_port}/', **kwargs)
            response.url = url
            return response
        def close(self): self.session.close()
    monkeypatch.setattr(research_external, '_source_session', FixtureTransport)
    monkeypatch.setattr(research_external.research_workspace,'directory',lambda _:tmp_path/'work')
    context=SimpleNamespace(conversation_id='dynamic',research_depth='standard',as_of='2026-10-05')
    url='http://public-fixture.example/'
    try:
        result=research_external.capture_page(research_external.CapturePageArgs(url=url,wait_selector='#loaded'),context)
    finally:
        server.shutdown(); server.server_close()
    assert result['title']=='Dynamic source fixture' and '1499.6' in result['text_preview']
    assert result['tables_preview'][0]['rows'][1][1]['text']=='1499.6'
    assert result['publisher_declared_date']=='2026-09-30'
    assert result['historical_availability_verified'] is False
    assert any(link['url'].endswith('/original.pdf') for link in result['links_preview'])
    assert Path(result['text_path']).is_file() and Path(result['image_path']).is_file()
    persisted=research_external.list_sources(research_external.ListSourcesArgs(),context)
    assert persisted['items'][0]['url']==url
    stored=json.loads(Path(result['tables_path']).read_text(encoding='utf-8'))
    assert stored[0]['rows'][1][1]['text']=='1499.6'
