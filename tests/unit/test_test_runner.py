"""Only synthetic per-run directories; no user state or historical cleanup."""
from pathlib import Path
import os
import subprocess
import sys

import pytest

from scripts import test_runner


def test_success_removes_only_this_run_and_keeps_parent_environment(tmp_path, monkeypatch):
    state = tmp_path / 'state'
    history = state / 'test-runs' / ('a' * 32)
    history.mkdir(parents=True)
    (history / 'old.txt').write_text('keep')
    monkeypatch.setenv('TEMP', 'original-temp')
    monkeypatch.setenv('TMP', 'original-tmp')
    monkeypatch.setenv('PYTHONPATH', 'original-imports')
    seen = []
    def child(command, *, env, check):
        run = Path(env['TEMP'])
        seen.append(run)
        assert run == Path(env['TMP'])
        assert env['PYTHONPATH'].split(os.pathsep)[0] == str(tmp_path / 'deps')
        assert command[1:4] == ['-m', 'pytest', '-p']
        (run / 'result.txt').write_text('new')
        return subprocess.CompletedProcess(command, 0)
    monkeypatch.setattr(test_runner.subprocess, 'run', child)
    assert test_runner.run_tests(state, tmp_path / 'deps', ['-q']) == 0
    assert not seen[0].exists()
    assert (history / 'old.txt').read_text() == 'keep'
    assert os.environ['TEMP'] == 'original-temp'
    assert os.environ['TMP'] == 'original-tmp'
    assert os.environ['PYTHONPATH'] == 'original-imports'


@pytest.mark.parametrize('exit_code,keep', [(1, False), (5, False), (0, True)])
def test_failure_and_keep_preserve_this_run(tmp_path, monkeypatch, exit_code, keep):
    seen = []
    def child(command, *, env, check):
        seen.append(Path(env['TEMP']))
        (seen[-1] / 'failure.txt').write_text('diagnostic')
        return subprocess.CompletedProcess(command, exit_code)
    monkeypatch.setattr(test_runner.subprocess, 'run', child)
    assert test_runner.run_tests(tmp_path, tmp_path / 'deps', [], keep_artifacts=keep) == exit_code
    assert (seen[0] / 'failure.txt').exists()


def test_cleanup_failure_does_not_turn_success_into_failure(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(test_runner.subprocess, 'run', lambda command, **kwargs: subprocess.CompletedProcess(command, 0))
    monkeypatch.setattr(test_runner, 'remove_run', lambda *args: (_ for _ in ()).throw(OSError('locked')))
    assert test_runner.run_tests(tmp_path, tmp_path / 'deps', []) == 0
    assert 'locked' in capsys.readouterr().err
    assert len(list((tmp_path / 'test-runs').iterdir())) == 1


def test_failed_test_never_calls_cleanup(tmp_path, monkeypatch):
    monkeypatch.setattr(test_runner.subprocess, 'run', lambda command, **kwargs: subprocess.CompletedProcess(command, 7))
    monkeypatch.setattr(test_runner, 'remove_run', lambda *args: pytest.fail('must retain failed run'))
    assert test_runner.run_tests(tmp_path, tmp_path / 'deps', []) == 7


def test_rejects_linked_parent_without_launching(tmp_path, monkeypatch):
    outside = tmp_path / 'outside'; outside.mkdir()
    state = tmp_path / 'state'; state.mkdir()
    (state / 'test-runs').symlink_to(outside, target_is_directory=True)
    monkeypatch.setattr(test_runner.subprocess, 'run', lambda *args, **kwargs: pytest.fail('must not launch'))
    with pytest.raises(ValueError, match='link|reparse'):
        test_runner.run_tests(state, tmp_path / 'deps', [])
    assert list(outside.iterdir()) == []


def test_rejects_link_created_inside_run_and_keeps_target(tmp_path, monkeypatch, capsys):
    outside = tmp_path / 'outside'; outside.mkdir()
    sentinel = outside / 'important'; sentinel.write_text('retain')
    seen = []
    def child(command, *, env, check):
        seen.append(Path(env['TEMP']))
        (seen[-1] / 'escape').symlink_to(outside, target_is_directory=True)
        return subprocess.CompletedProcess(command, 0)
    monkeypatch.setattr(test_runner.subprocess, 'run', child)
    assert test_runner.run_tests(tmp_path / 'state', tmp_path / 'deps', []) == 0
    assert sentinel.read_text() == 'retain'
    assert seen[0].exists()
    assert 'retained' in capsys.readouterr().err


def test_refuses_replaced_marker_and_unrelated_directory(tmp_path, monkeypatch, capsys):
    def child(command, *, env, check):
        (Path(env['TEMP']) / test_runner.MARKER).write_text('not this run')
        return subprocess.CompletedProcess(command, 0)
    monkeypatch.setattr(test_runner.subprocess, 'run', child)
    assert test_runner.run_tests(tmp_path, tmp_path / 'deps', []) == 0
    assert len(list((tmp_path / 'test-runs').iterdir())) == 1
    assert 'retained' in capsys.readouterr().err


def test_launch_exception_retains_artifacts_and_environment(tmp_path, monkeypatch):
    monkeypatch.setenv('TEMP', 'before')
    monkeypatch.setattr(test_runner.subprocess, 'run', lambda *args, **kwargs: (_ for _ in ()).throw(OSError('missing executable')))
    with pytest.raises(OSError, match='missing executable'):
        test_runner.run_tests(tmp_path, tmp_path / 'deps', [])
    assert len(list((tmp_path / 'test-runs').iterdir())) == 1
    assert os.environ['TEMP'] == 'before'


def test_cli_and_powershell_keep_pytest_arguments_and_exit_status():
    source = (Path(__file__).parents[2] / 'scripts' / 'test.ps1').read_text(encoding='utf-8-sig')
    assert "$Argument -ieq '-KeepArtifacts'" in source
    assert '[switch]$KeepArtifacts' not in source
    assert '$TestExitCode = $LASTEXITCODE' in source
    assert 'exit $TestExitCode' in source
    assert '$env:TEMP =' not in source and '$env:TMP =' not in source
    assert 'foreach ($Argument in $args)' in source
    assert '@PytestArgs' in source
    assert '--' in source


@pytest.mark.parametrize('option', ['--basetemp', '--basetemp=/outside', '--baset=/outside'])
def test_cannot_override_the_owned_pytest_directory(tmp_path, monkeypatch, option):
    monkeypatch.setattr(test_runner.subprocess, 'run', lambda *args, **kwargs: pytest.fail('must not launch'))
    with pytest.raises(ValueError, match='owns --basetemp'):
        test_runner.run_tests(tmp_path, tmp_path / 'deps', [option])
    assert not (tmp_path / 'test-runs').exists()


@pytest.mark.parametrize('fails', [False, True])
def test_real_child_pytest_exit_and_artifact_lifecycle(tmp_path, fails):
    test_file = tmp_path / 'test_sample.py'
    test_file.write_text('import os\nfrom pathlib import Path\ndef test_sample(tmp_path):\n    (tmp_path / "artifact").write_text("fixture output")\n    assert Path(os.environ["TEMP"]) == Path(os.environ["TMP"])\n    assert ' + ('False' if fails else 'True') + '\n')
    config = tmp_path / 'pytest.ini'; config.write_text('[pytest]\n')
    dependencies = Path(pytest.__file__).parents[1]
    command = [sys.executable, str(Path(test_runner.__file__)), '--state-root', str(tmp_path / 'state'), '--dependencies', str(dependencies), '--', '-c', str(config), '-q', str(test_file)]
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode == (1 if fails else 0), result.stdout + result.stderr
    runs = list((tmp_path / 'state' / 'test-runs').iterdir())
    assert len(runs) == (1 if fails else 0)
    if fails:
        assert 'retained' in result.stdout


def test_reparse_attribute_is_rejected_even_when_not_a_symlink(tmp_path, monkeypatch):
    from types import SimpleNamespace
    import stat
    monkeypatch.setattr(Path, 'lstat', lambda self: SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT))
    with pytest.raises(ValueError, match='reparse'):
        test_runner._identity(tmp_path)


@pytest.mark.parametrize('options', ['--basetemp=/outside', '--basetemp "/outside path"', '--baset=/outside'])
def test_environment_cannot_override_owned_temp_directory(tmp_path, monkeypatch, options):
    monkeypatch.setenv('PYTEST_ADDOPTS', options)
    monkeypatch.setattr(test_runner.subprocess, 'run', lambda *args, **kwargs: pytest.fail('must not launch'))
    with pytest.raises(ValueError, match='owns --basetemp'):
        test_runner.run_tests(tmp_path, tmp_path / 'deps', [])
    assert not (tmp_path / 'test-runs').exists()


def test_dangling_parent_link_is_refused(tmp_path):
    state = tmp_path / 'state'; state.mkdir()
    (state / 'test-runs').symlink_to(tmp_path / 'missing', target_is_directory=True)
    with pytest.raises(ValueError, match='link|reparse'):
        test_runner.run_tests(state, tmp_path / 'deps', [])


def test_replaced_run_directory_cannot_redirect_cleanup(tmp_path, monkeypatch, capsys):
    outside = tmp_path / 'outside'; outside.mkdir()
    sentinel = outside / 'important'; sentinel.write_text('safe')
    def child(command, *, env, check):
        run = Path(env['TEMP'])
        run.rename(run.with_name('moved-owned-run'))
        run.symlink_to(outside, target_is_directory=True)
        return subprocess.CompletedProcess(command, 0)
    monkeypatch.setattr(test_runner.subprocess, 'run', child)
    assert test_runner.run_tests(tmp_path / 'state', tmp_path / 'deps', []) == 0
    assert sentinel.read_text() == 'safe'
    assert 'retained' in capsys.readouterr().err


def test_cleanup_rejects_non_guid_or_out_of_parent_paths(tmp_path):
    path = tmp_path / 'history'; path.mkdir()
    with pytest.raises(ValueError, match='exact generated GUID'):
        test_runner.remove_run(path, tmp_path, test_runner._identity(tmp_path), test_runner._identity(path), 'unused')


@pytest.mark.parametrize('via_environment', [False, True])
def test_response_file_cannot_smuggle_an_external_basetemp(tmp_path, monkeypatch, via_environment):
    outside = tmp_path / 'outside'; outside.mkdir()
    sentinel = outside / 'important'; sentinel.write_text('keep')
    response = tmp_path / 'args.txt'; response.write_text(f'--basetemp={outside}\n')
    args = [f'@{response}']
    if via_environment:
        monkeypatch.setenv('PYTEST_ADDOPTS', args[0]); args = []
    monkeypatch.setattr(test_runner.subprocess, 'run', lambda *args, **kwargs: pytest.fail('must not launch pytest'))
    with pytest.raises(ValueError, match='response files'):
        test_runner.run_tests(tmp_path / 'state', tmp_path / 'deps', args)
    assert sentinel.read_text() == 'keep'
    assert not (tmp_path / 'state').exists()
