"""Exercise the real application in a read-only image with disposable storage."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(os.environ.get("LLMR_PYTHON_DEPS") or ROOT / "runtime/python-deps")))

from scripts.verify_sdk_sandbox import execute


CHECK = r'''
from io import BytesIO
import json
from pathlib import Path
from fastapi.testclient import TestClient
from openpyxl import Workbook
from docx import Document
from pptx import Presentation
from apps.api.app import db, main, conversation_store as store, research_workspace, research_attachments, research_pdf, runtime_executor
code = Path('/opt/app/apps/api/app/settings.py')
before = code.read_bytes()
try:
    with code.open('ab') as stream:
        stream.write(b'# must not write\n')
except OSError:
    assert code.read_bytes() == before
else:
    raise RuntimeError('Application code was writable')
db.init_db()
cid = store.create_conversation('screening')['id']
attached = research_attachments.upload(cid, 'fixture-upload', 'input.txt', BytesIO(b'fixture input'))
message = store.add_user_message(cid, 'fixture-message', 0, 'Research this input.', attachment_ids=[attached['id']])
store.start_turn(cid, message['turn_id'])
manifest = research_workspace.prepare(cid, message['turn_id'])
output = Path(manifest['outputs'])
Workbook().save(output/'result.xlsx')
d=Document(); d.add_paragraph('fixture'); d.save(output/'result.docx')
p=Presentation(); p.slides.add_slide(p.slide_layouts[6]); p.save(output/'result.pptx')
(output/'report.md').write_text('# Research\nFixture.',encoding='utf-8')
pdf = research_pdf.export_file(cid, 'report.md')
store.finish_turn(cid,message['turn_id'],0,'succeeded','Fixture complete.',{})
with TestClient(main.app) as client:
    assert client.get('/api/v1/health').json()['status']=='ok'
    assert client.get('/').status_code==200
    assert client.get(attached['url']).content==b'fixture input'
    assert client.get(pdf['url']).content.startswith(b'%PDF-')
    files=client.get(f'/api/v1/conversations/{cid}/generated-files').json()['items']
    for name in ['result.xlsx','result.docx','result.pptx']:
        item=next(item for item in files if item['name']==name)
        assert client.get(item['url']).status_code==200
result=runtime_executor.execute_program(source_code="def screen(context, frames, params):\n    return {'decisions': {'A': True}}",context={'stock_codes':['A'],'required_fields':[],'data_as_of':{}},frames={'A':[]},params={})
assert result['decisions']['A'] is True
print(json.dumps({'code_read_only':True,'api_boot':True,'web_boot':True,'attachments':True,'research_workspace':True,'pdf':True,'original_formats':True,'compute':True}))
'''


OIDC_CHECK = r'''
import json
from io import BytesIO
from pathlib import Path
from fastapi.testclient import TestClient
from apps.api.app import auth, db, identity, main, conversation_store as store, research_workspace, research_pdf, runtime_executor
from apps.api.app.security_context import actor_scope
code = Path('/opt/app/apps/api/app/settings.py')
before = code.read_bytes()
try:
    with code.open('ab') as stream: stream.write(b'# denied\n')
except OSError:
    assert code.read_bytes() == before
else:
    raise RuntimeError('Application code was writable')
with TestClient(main.app, base_url='https://app.example') as client:
    a=identity.user_from_oidc('https://issuer.example','alice','Alice')
    b=identity.user_from_oidc('https://issuer.example','bob','Bob')
    assert client.get('/api/v1/conversations').status_code==401
    token,csrf=identity.create_session(a)
    client.cookies.set(auth.COOKIE,token)
    client.headers.update({'X-CSRF-Token':csrf,'Origin':'https://app.example'})
    cid=client.post('/api/v1/conversations',json={'entry_scope':'report','request_id':'same-request'}).json()['id']
    attached=client.post(f'/api/v1/conversations/{cid}/attachments',data={'request_id':'attachment'},files={'file':('input.txt',b'private input','text/plain')})
    assert attached.status_code==201
    assert client.get(attached.json()['url']).content==b'private input'
    with actor_scope(a):
        turn=store.add_user_message(cid,'message',0,'Research this input.',attachment_ids=[attached.json()['id']])
        store.start_turn(cid,turn['turn_id'])
        manifest=research_workspace.prepare(cid,turn['turn_id'])
        output=Path(manifest['outputs'])
        (output/'result.txt').write_text('private result')
        (output/'report.md').write_text('# Research\nPrivate fixture.')
        pdf=research_pdf.export_file(cid,'report.md')
        store.finish_turn(cid,turn['turn_id'],0,'succeeded','Research complete.',{})
        result=runtime_executor.execute_program(source_code="def screen(context, frames, params):\n    return {'decisions': {'A': True}}",context={'stock_codes':['A'],'required_fields':[],'data_as_of':{}},frames={'A':[]},params={})
        assert result['decisions']['A'] is True
    assert client.get(pdf['url']).content.startswith(b'%PDF-')
    url=f'/api/v1/conversations/{cid}/generated-files/result.txt'
    assert client.get(url).text=='private result'
    assert '__LLMR_AUTH_REQUIRED__=true' in client.get('/').text
    token,csrf=identity.create_session(b)
    client.cookies.set(auth.COOKIE,token); client.headers['X-CSRF-Token']=csrf
    assert client.get(url).status_code==404
    assert client.get(attached.json()['url']).status_code==404
    assert client.get(pdf['url']).status_code==404
    own=client.post('/api/v1/conversations',json={'entry_scope':'report','request_id':'same-request'}).json()['id']
    assert own!=cid
    identity.set_permissions(b.user_id,role='viewer')
    assert client.get('/api/v1/me').status_code==401
print(json.dumps({'code_read_only':True,'authenticated_web':True,'unauthenticated_denied':True,'user_isolation':True,'attachments':True,'research_workspace':True,'pdf':True,'compute':True,'permission_revocation':True}))
'''


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", default="llmr-app:phase1")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--oidc", action="store_true", help="Synthetic authenticated two-user check; no provider or model credentials")
    args = parser.parse_args()
    from apps.api.app.storage import storage_paths
    output = (args.output or storage_paths().state_root / ("verification/readonly-app-oidc" if args.oidc else "verification/readonly-app")).resolve()
    output.mkdir(parents=True, exist_ok=True)
    name = "llmr-app-probe-" + uuid4().hex
    report = {"status": "failed"}
    command = ["docker", "run", "--rm", "--name", name, "--read-only", "--user", "10001:10001",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--network", "none",
        "--memory", "2g", "--cpus", "2", "--pids-limit", "128",
        "--tmpfs", "/var/lib/llmr:rw,nosuid,nodev,size=512m,uid=10001,gid=10001,mode=0700",
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777", "--entrypoint", "python"]
    if args.oidc:
        command += ["-e", "LLMR_AUTH_MODE=oidc", "-e", "LLMR_AUTH_ISSUER=https://issuer.example",
                    "-e", "LLMR_AUTH_CLIENT_ID=fixture-client", "-e", "LLMR_AUTH_PUBLIC_URL=https://app.example"]
    command += [args.image, "-c", OIDC_CHECK if args.oidc else CHECK]
    try:
        result = execute(command, timeout=120)
        if result.returncode == 0:
            checks = json.loads(result.stdout.decode().strip().splitlines()[-1])
            report = {"status": "passed" if all(checks.values()) else "failed", "checks": checks}
        else:
            report["error"] = result.stderr.decode(errors="replace")[-3000:]
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        report = {"status": "blocked", "reason": type(exc).__name__}
    finally:
        try:
            cleanup = execute(["docker", "rm", "-f", name], timeout=10)
            if cleanup.returncode and b"No such container" not in cleanup.stderr:
                report = {"status": "failed", "reason": "Could not confirm probe container cleanup"}
        except (FileNotFoundError, subprocess.TimeoutExpired):
            report = {"status": "failed", "reason": "Probe container cleanup unavailable"}
        (output / "result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))
    return 0 if report["status"] == "passed" else 2 if report["status"] == "blocked" else 1


if __name__ == "__main__":
    raise SystemExit(main())
