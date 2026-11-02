"""Real restore route + actor-scoped SQLite; not a full application import."""
import ast
from pathlib import Path
from dataclasses import fields
import unittest
from tempfile import TemporaryDirectory
from fastapi import APIRouter, HTTPException
from apps.api.app import db
from apps.api.app.security_context import ActorContext, actor_scope
from apps.api.app.storage import StoragePaths


def routes():
    tree = ast.parse(Path('apps/api/app/observation_api.py').read_text())
    wanted = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in {'hide_entry', 'restore_entry'} or isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == '_OBSERVATION_ENTRIES' for t in node.targets)]
    env = dict(router=APIRouter(), connect=db.connect, utc_now=db.utc_now, HTTPException=HTTPException)
    exec(compile(ast.Module(body=wanted, type_ignores=[]), 'observation_api.py', 'exec'), env)
    return env


def actor(tmp_path, name):
    workspace = {f.name: str(tmp_path / name / ('app.db' if f.name == 'database' else f.name)) for f in fields(StoragePaths)}
    return ActorContext(name, 'tenant', workspace=workspace)


def candidate():
    db.init_db()
    with db.connect() as connection:
        connection.execute("INSERT INTO manual_observation_candidates(id,request_id,request_json,stock_code,created_at,updated_at) VALUES('one','request','{}','600000.SH',?,?)", (db.utc_now(), db.utc_now()))


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_restore_is_idempotent_and_preserves_source_and_custom_order(self):
        tmp_path = self.root
        api = routes()
        with actor_scope(actor(tmp_path, 'first')):
            candidate()
            api['hide_entry']('candidate:one')
            with db.connect() as connection:
                connection.execute("UPDATE observation_entry_preferences SET sort_order=2048 WHERE entry_key='candidate:one'")
            assert api['restore_entry']('candidate:one') == {'entry_key': 'candidate:one', 'hidden': False}
            assert api['restore_entry']('candidate:one')['hidden'] is False
            with db.connect() as connection:
                row = connection.execute("SELECT hidden,sort_order FROM observation_entry_preferences").fetchone()
                assert tuple(row) == (0, 2048)
                assert connection.execute('SELECT count(*) FROM manual_observation_candidates').fetchone()[0] == 1


    def test_restore_never_crosses_actor_or_creates_missing_source(self):
        tmp_path = self.root
        api = routes()
        with actor_scope(actor(tmp_path, 'first')):
            candidate(); api['hide_entry']('candidate:one')
        with actor_scope(actor(tmp_path, 'second')):
            db.init_db()
            with self.assertRaises(HTTPException) as error: api['restore_entry']('candidate:one')
            assert error.exception.status_code == 404
            with db.connect() as connection:
                assert connection.execute('SELECT count(*) FROM observation_entry_preferences').fetchone()[0] == 0
        with actor_scope(actor(tmp_path, 'first')):
            with db.connect() as connection:
                assert connection.execute('SELECT hidden FROM observation_entry_preferences').fetchone()[0] == 1
                connection.execute('DELETE FROM manual_observation_candidates')
            with self.assertRaises(HTTPException) as error: api['restore_entry']('candidate:one')
            assert error.exception.status_code == 404

if __name__ == '__main__':
    unittest.main()
