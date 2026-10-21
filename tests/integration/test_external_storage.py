"""The actual application can research and export with every mutable root outside code."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import pytest


@pytest.fixture
def external_root():
    # test.ps1 deliberately puts pytest temp files under the checkout. This
    # deployment check needs storage genuinely outside that code tree.
    temporary_parent = Path(os.environ["LOCALAPPDATA"]) / "Temp" if os.name == "nt" else Path("/tmp")
    with tempfile.TemporaryDirectory(prefix="llmr-external-storage-", dir=temporary_parent) as directory:
        yield Path(directory)


def test_external_roots_support_research_attachments_documents_and_compute(external_root):
    tmp_path = external_root
    root = Path(__file__).resolve().parents[2]
    state = tmp_path / "state"
    environment = os.environ.copy()
    for key in list(environment):
        if key.startswith("LLMR_"):
            environment.pop(key)
    environment.update({
        "LLMR_STATE_ROOT": str(state), "LLMR_UPLOAD_ROOT": str(tmp_path / "uploads"),
        "LLMR_ARTIFACT_ROOT": str(tmp_path / "artifacts"),
        "LLMR_SANDBOX_STATE_ROOT": str(tmp_path / "sandboxes"),
        "LLMR_DATA_ROOT": str(tmp_path / "data"), "LLMR_REQUIRE_EXTERNAL_STORAGE": "true",
        "LLMR_CONFIG_FILE": str(tmp_path / "absent-config.ini"), "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
        "LLMR_PYTHON_DEPS": str(root / "runtime/python-deps"),
    })
    code = r'''
from io import BytesIO
from pathlib import Path
import json
from openpyxl import Workbook
from docx import Document
from pptx import Presentation
from fastapi.testclient import TestClient
from apps.api.app import conversation_store as store, db, main, research_attachments as attachments, research_workspace as workspace, research_pdf, runtime_executor, generated_program, codex_runtime, settings
from apps.api.app.storage import application_paths
db.init_db()
cid = store.create_conversation('screening')['id']
attached = attachments.upload(cid, 'upload-fixture', 'source.txt', BytesIO(b'private fixture'))
message = store.add_user_message(cid, 'message-fixture', 0, 'Please research the uploaded source.', attachment_ids=[attached['id']])
store.start_turn(cid, message['turn_id'])
manifest = workspace.prepare(cid, message['turn_id'])
paths = application_paths()
assert Path(manifest['workspace']).is_relative_to(paths.artifact_root)
assert Path(manifest['attachments'][0]['path']).is_relative_to(paths.upload_root)
output = Path(manifest['outputs'])
Workbook().save(output / 'result.xlsx')
d = Document(); d.add_paragraph('fixture'); d.save(output / 'result.docx')
p = Presentation(); p.slides.add_slide(p.slide_layouts[6]); p.save(output / 'result.pptx')
(output / 'result.md').write_text('# Fixture\nResearch output.', encoding='utf-8')
pdf = research_pdf.export_file(cid, 'result.md')
assert pdf['url']
store.finish_turn(cid, message['turn_id'], 0, 'succeeded', 'Research completed.', {})
with TestClient(main.app) as client:
    files = client.get(f'/api/v1/conversations/{cid}/generated-files').json()['items']
    for name in ('result.xlsx', 'result.docx', 'result.pptx'):
        item = next(item for item in files if item['name'] == name)
        response = client.get(item['url'])
        assert response.status_code == 200 and len(response.content) > 0
    assert client.get(attached['url']).content == b'private fixture'
runtime_executor.execute_program(source_code="def screen(context, frames, params):\n    return {'decisions': {'A': True}}", context={'stock_codes': ['A'], 'required_fields': [], 'data_as_of': {}}, frames={'A': []}, params={})
assert runtime_executor.WORK_ROOT.is_relative_to(paths.sandbox_state_root)
assert not list(runtime_executor.WORK_ROOT.glob('screen-*'))
_, cached = generated_program._source_path('def calculate(data, params):\n    return data.close > 0')
assert cached.is_relative_to(paths.sandbox_state_root)
env = codex_runtime._runtime_environment(cid, message['turn_id'], 0, {})
assert Path(env['CODEX_HOME']).is_relative_to(paths.sandbox_state_root)
assert settings.REPORT_UPLOAD_DIR.is_relative_to(paths.upload_root)
print(json.dumps({'research': True, 'attachment_download': True, 'original_formats': True, 'pdf': True, 'compute': True}))
'''
    result = subprocess.run([sys.executable, "-c", code], env=environment, cwd=root,
                            capture_output=True, text=True, encoding="utf-8", timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
    assert all(json.loads(result.stdout.strip().splitlines()[-1]).values())
    assert (state / "app.db").is_file()
    assert list((tmp_path / "artifacts/research").glob("*/work/outputs/result.xlsx"))
