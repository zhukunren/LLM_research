import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from scripts import backup_retention as retention


def make_backup(root, name, *, dataset='a' * 64, day=1, pinned=False):
    path = root / name
    (path / 'runtime').mkdir(parents=True)
    database = path / 'runtime/app.db'
    with sqlite3.connect(database) as connection:
        connection.execute('CREATE TABLE fixture(value TEXT)')
    manifest = {
        'format_version': 2, 'database': 'runtime/app.db',
        'created_at': f'2026-01-{day:02d}T00:00:00+00:00',
        'retention': {'version': 1, 'dataset_id': dataset},
        'files': [{'path': 'runtime/app.db', 'bytes': database.stat().st_size,
                   'sha256': hashlib.sha256(database.read_bytes()).hexdigest(), 'database': True}],
        'source_references': [], 'source_files_copied': False,
        'storage_mappings': [{'original_path': '/fixture/app.db', 'path': 'runtime/app.db'}],
    }
    (path / 'manifest.json').write_text(json.dumps(manifest))
    if pinned:
        (path / '.keep').touch()
    return path


def test_rotation_keeps_newest_count_and_pinned_extra(tmp_path):
    old = make_backup(tmp_path, 'old')
    recent = make_backup(tmp_path, 'recent', day=2)
    pinned = make_backup(tmp_path, 'manual', pinned=True)
    current = make_backup(tmp_path, 'current', day=3)
    with retention.backup_lock(tmp_path):
        removed = retention.rotate_backups(current, 'a' * 64, 2)
    assert removed == [old]
    assert recent.is_dir() and current.is_dir() and pinned.is_dir()


def test_preview_never_deletes_and_new_backup_is_kept_despite_clock_skew(tmp_path):
    old = make_backup(tmp_path, 'old', day=3)
    current = make_backup(tmp_path, 'current', day=1)
    assert retention.rotate_backups(current, 'a' * 64, 1, dry_run=True) == [old]
    assert old.exists() and current.exists()
    assert retention.rotate_backups(current, 'a' * 64, 1) == [old]
    assert current.exists()


@pytest.mark.parametrize('kind', ['legacy', 'other_dataset', 'corrupt', 'extra', 'extra_empty_directory', 'linked_file', 'linked_dir', 'incomplete', 'traversal'])
def test_unknown_or_unsafe_candidates_are_never_deleted(tmp_path, kind):
    candidate = make_backup(tmp_path, 'candidate')
    manifest = json.loads((candidate / 'manifest.json').read_text())
    if kind == 'legacy':
        manifest.pop('retention')
    elif kind == 'other_dataset':
        manifest['retention']['dataset_id'] = 'b' * 64
    elif kind == 'corrupt':
        (candidate / 'runtime/app.db').write_bytes(b'corrupt')
    elif kind == 'extra':
        (candidate / 'manual.txt').write_text('important')
    elif kind == 'extra_empty_directory':
        (candidate / 'manual-folder').mkdir()
    elif kind.startswith('linked'):
        outside = tmp_path / 'outside'
        outside.mkdir()
        (outside / 'important.txt').write_text('keep')
        (candidate / ('alias' if kind == 'linked_dir' else 'alias.txt')).symlink_to(outside if kind == 'linked_dir' else outside / 'important.txt', target_is_directory=kind == 'linked_dir')
    elif kind == 'incomplete':
        manifest['files'] = []
    elif kind == 'traversal':
        manifest['files'][0]['path'] = '../outside.db'
    (candidate / 'manifest.json').write_text(json.dumps(manifest))
    current = make_backup(tmp_path, 'current', day=2)
    assert retention.rotate_backups(current, 'a' * 64, 1) == []
    assert candidate.exists() and current.exists()


def test_invalid_new_backup_prevents_all_rotation(tmp_path):
    old = make_backup(tmp_path, 'old')
    current = make_backup(tmp_path, 'current', day=2)
    (current / 'runtime/app.db').write_bytes(b'broken')
    with pytest.raises(ValueError):
        retention.rotate_backups(current, 'a' * 64, 1)
    assert old.exists()


def test_lock_rejects_concurrent_and_unknown_stale_locks(tmp_path):
    with retention.backup_lock(tmp_path):
        with pytest.raises(FileExistsError):
            with retention.backup_lock(tmp_path):
                pytest.fail('second writer acquired lock')
    lock = tmp_path / '.llmr-backup.lock'
    lock.write_text('unrecognized stale lock')
    with pytest.raises(FileExistsError):
        with retention.backup_lock(tmp_path):
            pass
    assert lock.read_text() == 'unrecognized stale lock'


def test_linked_root_is_rejected_without_touching_target(tmp_path):
    real = tmp_path / 'real'
    real.mkdir()
    alias = tmp_path / 'alias'
    alias.symlink_to(real, target_is_directory=True)
    with pytest.raises(ValueError):
        with retention.backup_lock(alias):
            pass
    assert list(real.iterdir()) == []


def test_new_pin_before_delete_is_respected(tmp_path, monkeypatch):
    old = make_backup(tmp_path, 'old')
    current = make_backup(tmp_path, 'current', day=2)
    original = retention.remove_candidate
    def pin_then_remove(root, candidate, identity, dataset, root_identity):
        (candidate / '.keep').touch()
        return original(root, candidate, identity, dataset, root_identity)
    monkeypatch.setattr(retention, 'remove_candidate', pin_then_remove)
    assert retention.rotate_backups(current, 'a' * 64, 1) == []
    assert old.exists()


def test_replaced_candidate_is_not_deleted(tmp_path, monkeypatch):
    old = make_backup(tmp_path, 'old')
    current = make_backup(tmp_path, 'current', day=2)
    original = retention.remove_candidate
    def replace_then_remove(root, candidate, identity, dataset, root_identity):
        candidate.rename(root / 'moved-original')
        candidate.mkdir()
        (candidate / 'important.txt').write_text('keep')
        return original(root, candidate, identity, dataset, root_identity)
    monkeypatch.setattr(retention, 'remove_candidate', replace_then_remove)
    with pytest.raises(ValueError, match='changed'):
        retention.rotate_backups(current, 'a' * 64, 1)
    assert (old / 'important.txt').read_text() == 'keep'


def test_deletion_failure_stops_remaining_candidates(tmp_path, monkeypatch):
    old = make_backup(tmp_path, 'old')
    other = make_backup(tmp_path, 'other', day=2)
    current = make_backup(tmp_path, 'current', day=3)
    attempts = []
    def fail(*args, **kwargs):
        attempts.append(args)
        raise PermissionError('synthetic locked file')
    fail.avoids_symlink_attacks = retention.shutil.rmtree.avoids_symlink_attacks
    monkeypatch.setattr(retention.shutil, 'rmtree', fail)
    with pytest.raises(PermissionError):
        retention.rotate_backups(current, 'a' * 64, 1)
    assert len(attempts) == 1 and other.exists() and current.exists()
    assert len(list(tmp_path.glob('.llmr-retiring-*'))) == 1


@pytest.mark.parametrize('count', [0, -1, True])
def test_invalid_counts_rejected(tmp_path, count):
    current = make_backup(tmp_path, 'current')
    with pytest.raises(ValueError):
        retention.rotate_backups(current, 'a' * 64, count)


@pytest.fixture
def source_backup(tmp_path, monkeypatch):
    from scripts import backup
    project = tmp_path / 'source'
    runtime = project / 'runtime'
    runtime.mkdir(parents=True)
    database = runtime / 'app.db'
    with sqlite3.connect(database) as connection:
        connection.execute('CREATE TABLE fixture(value TEXT)')
    monkeypatch.setattr(backup, 'PROJECT_ROOT', project)
    monkeypatch.setattr(backup, 'DB_PATH', database)
    monkeypatch.setattr(backup, 'STOCK_FILE', project / 'missing.parquet')
    monkeypatch.setattr(backup, 'REPORT_DIR', project / 'missing-reports')
    for name, child in [('STATE_ROOT', 'runtime'), ('UPLOAD_ROOT', 'uploads'), ('ARTIFACT_ROOT', 'artifacts'), ('SANDBOX_STATE_ROOT', 'sandbox'), ('CODEX_HOME', 'codex')]:
        monkeypatch.setenv('LLMR_' + name, str(project / child))
    monkeypatch.setenv('LLMR_IDENTITY_DB_PATH', str(project / 'identity.db'))
    monkeypatch.setenv('LLMR_CONFIG_FILE', str(project / 'absent.ini'))
    root = tmp_path / 'backups'
    def run(name, *options):
        target = root / name
        monkeypatch.setattr('sys.argv', ['backup.py', str(target), *options])
        backup.main()
        return target
    return backup, root, run


def test_cli_defaults_to_no_deletion_and_preview_keeps_old(source_backup, capsys):
    _, _, run = source_backup
    first = run('first')
    second = run('second')
    assert first.exists() and second.exists()
    preview = run('preview', '--retain-count', '1', '--retention-dry-run')
    assert first.exists() and second.exists() and preview.exists()
    assert 'Would retire (new backup already created)' in capsys.readouterr().out
    current = run('current', '--retain-count', '1')
    assert current.exists() and not first.exists() and not second.exists() and not preview.exists()


@pytest.mark.parametrize('failure', ['snapshot', 'publication', 'published_verification'])
def test_creation_failures_never_rotate_old_backups(source_backup, monkeypatch, failure):
    backup, root, run = source_backup
    old = run('old')
    def fail(*_args, **_kwargs):
        raise RuntimeError('synthetic ' + failure)
    if failure == 'snapshot':
        monkeypatch.setattr(backup, 'write_snapshot', fail)
    elif failure == 'publication':
        monkeypatch.setattr(backup, 'publish_directory', fail)
    else:
        original = backup.verify_backup
        def verify(path, dataset):
            if path == root / 'new':
                fail()
            return original(path, dataset)
        monkeypatch.setattr(backup, 'verify_backup', verify)
    with pytest.raises(RuntimeError, match='synthetic'):
        run('new', '--retain-count', '1')
    assert old.is_dir()
    assert not (root / retention.LOCK).exists()


def test_dataset_identity_separates_source_mode_and_storage_roots(tmp_path):
    source = tmp_path / 'source'
    first = retention.dataset_id([(source, Path('runtime/app.db'))], False, [tmp_path / 'data'])
    assert first == retention.dataset_id([(source, Path('runtime/app.db'))], False, [tmp_path / 'data'])
    assert first != retention.dataset_id([(source, Path('runtime/app.db'))], True, [tmp_path / 'data'])
    assert first != retention.dataset_id([(tmp_path / 'other', Path('runtime/app.db'))], False, [tmp_path / 'data'])


def test_cli_concurrent_lock_prevents_snapshot_or_rotation(source_backup, monkeypatch):
    backup, root, run = source_backup
    old = run('old')
    monkeypatch.setattr(backup, 'write_snapshot', lambda *_: pytest.fail('snapshot started under competing lock'))
    with retention.backup_lock(root):
        with pytest.raises(FileExistsError):
            run('new', '--retain-count', '1')
    assert old.exists() and not (root / 'new').exists()


@pytest.mark.parametrize('change', [
    {'storage_mappings': None}, {'storage_mappings': []},
    {'storage_mappings': [{'original_path': '/source', 'path': '../outside'}]},
    {'storage_mappings': [{'original_path': '', 'path': 'runtime/app.db'}]},
    {'source_references': None}, {'source_references': [None]},
    {'source_files_copied': None},
    {'source_files_copied': True, 'source_references': [{'path': '/source.pdf', 'bytes': 0, 'sha256': 'a' * 64}]},
])
def test_restore_incompatible_manifests_are_not_retired(tmp_path, change):
    candidate = make_backup(tmp_path, 'candidate')
    manifest = json.loads((candidate / 'manifest.json').read_text())
    manifest.update(change)
    (candidate / 'manifest.json').write_text(json.dumps(manifest))
    current = make_backup(tmp_path, 'current', day=2)
    assert retention.rotate_backups(current, 'a' * 64, 1) == []
    assert candidate.exists()


def test_posix_deletion_remains_anchored_if_root_is_replaced_at_last_moment(tmp_path, monkeypatch):
    if not retention.shutil.rmtree.avoids_symlink_attacks:
        pytest.skip('POSIX dir_fd-specific safety regression')
    root = tmp_path / 'backups'
    root.mkdir()
    make_backup(root, 'old')
    current = make_backup(root, 'current', day=2)
    outside = tmp_path / 'outside'
    outside.mkdir()
    moved = tmp_path / 'original-backups'
    original = retention.shutil.rmtree
    def swap_then_remove(name, *, dir_fd=None):
        assert dir_fd is not None
        root.rename(moved)
        root.symlink_to(outside, target_is_directory=True)
        victim = outside / name
        victim.mkdir()
        (victim / 'important.txt').write_text('never delete outside the pinned root')
        original(name, dir_fd=dir_fd)
    swap_then_remove.avoids_symlink_attacks = True
    monkeypatch.setattr(retention.shutil, 'rmtree', swap_then_remove)
    retention.rotate_backups(current, 'a' * 64, 1)
    assert next(outside.glob('*/important.txt')).read_text() == 'never delete outside the pinned root'
    assert (moved / 'current').exists()
    assert not list(moved.glob('.llmr-retiring-*'))


def test_source_copy_mode_has_independent_retention_and_verified_copies(source_backup):
    backup, _, run = source_backup
    backup.STOCK_FILE.write_bytes(b'synthetic parquet source')
    backup.REPORT_DIR.mkdir()
    (backup.REPORT_DIR / 'fixture.pdf').write_bytes(b'%PDF-synthetic source')
    references_only = run('references-only')
    copied = run('copied', '--include-source', '--retain-count', '1')
    manifest = json.loads((copied / 'manifest.json').read_text())
    assert manifest['source_files_copied'] is True
    assert all((copied / item['backup_copy']).is_file() for item in manifest['source_references'])
    current = run('copied-current', '--include-source', '--retain-count', '1')
    assert references_only.exists() and current.exists() and not copied.exists()
