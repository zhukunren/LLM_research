"""Run pytest in a fresh owned directory; never sweep historical test runs."""
from __future__ import annotations

import argparse
import os
import re
import shutil
import shlex
import stat
import subprocess
import sys
import uuid
from pathlib import Path

if __package__:
    from .backup_io import pin_windows_parents as _pin_windows_parents
else:
    from backup_io import pin_windows_parents as _pin_windows_parents

MARKER = '.llmr-test-run'


def _identity(path: Path) -> tuple[int, int]:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise ValueError(f'Refusing linked/reparse test path: {path}')
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError(f'Test path is not a directory: {path}')
    return info.st_dev, info.st_ino


def _check_parents(path: Path) -> None:
    for item in reversed((path, *path.parents)):
        try:
            _identity(item)
        except FileNotFoundError:
            continue




def remove_run(run: Path, parent: Path, parent_identity: tuple[int, int], run_identity: tuple[int, int], token: str) -> None:
    if run.parent != parent or not re.fullmatch(r'[0-9a-f]{32}', run.name):
        raise ValueError('Refusing cleanup outside the exact generated GUID directory')
    with _pin_windows_parents(parent):
        _check_parents(parent)
        if _identity(parent) != parent_identity or _identity(run) != run_identity:
            raise ValueError('Test directory identity changed; refusing cleanup')
        marker = run / MARKER
        marker_info = marker.lstat()
        if not stat.S_ISREG(marker_info.st_mode) or getattr(marker_info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT or marker_info.st_nlink != 1:
            raise ValueError('Unsafe test ownership marker; refusing cleanup')
        if marker.read_text(encoding='ascii') != token:
            raise ValueError('Test ownership marker changed; refusing cleanup')
        # pytest's tmp_path creates internal 'current' links. Never traverse them;
        # permit only links whose fully resolved target remains inside this run.
        for folder, directories, files in os.walk(run, followlinks=False):
            for name in directories + files:
                path = Path(folder) / name
                info = path.lstat()
                if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                    try:
                        internal = path.resolve(strict=True).is_relative_to(run)
                    except (OSError, RuntimeError) as error:
                        raise ValueError(f'Unverifiable linked test artifact: {path}') from error
                    if not internal:
                        raise ValueError(f'Refusing external linked/reparse test artifact: {path}')
        if shutil.rmtree.avoids_symlink_attacks:
            fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                info = os.fstat(fd)
                if (info.st_dev, info.st_ino) != parent_identity:
                    raise ValueError('Test parent identity changed; refusing cleanup')
                shutil.rmtree(run.name, dir_fd=fd)
            finally:
                os.close(fd)
        else:
            # Python 3.12 does not traverse directory junctions during rmtree.
            shutil.rmtree(run)


def run_tests(state_root: Path, dependencies: Path, pytest_args: list[str], *, keep_artifacts: bool = False) -> int:
    extra_args = shlex.split(os.environ.get('PYTEST_ADDOPTS', ''))
    if any(arg.startswith('@') for arg in [*extra_args, *pytest_args]):
        raise ValueError('pytest response files are not accepted here; pass arguments explicitly.')
    if any(arg.startswith('--') and len(arg.split('=', 1)[0]) > 2 and '--basetemp'.startswith(arg.split('=', 1)[0]) for arg in [*extra_args, *pytest_args]):
        raise ValueError('The runner owns --basetemp; use --keep-artifacts to retain this run.')
    parent = Path(os.path.abspath(state_root)) / 'test-runs'
    _check_parents(parent)
    parent.mkdir(parents=True, exist_ok=True)
    _check_parents(parent)
    parent_identity = _identity(parent)
    run = parent / uuid.uuid4().hex
    run.mkdir()  # No exist_ok: never adopt a previous run, even on a UUID collision.
    run_identity = _identity(run)
    token = uuid.uuid4().hex
    with (run / MARKER).open('x', encoding='ascii') as stream:
        stream.write(token)
    _check_parents(parent)
    if _identity(parent) != parent_identity or _identity(run) != run_identity:
        raise ValueError('Test directory changed before launch; refusing to run pytest')
    env = os.environ.copy()
    env.update(TEMP=str(run), TMP=str(run), PYTHONNOUSERSITE='1', PYTHONDONTWRITEBYTECODE='1', PYTEST_DISABLE_PLUGIN_AUTOLOAD='1')
    env['PYTHONPATH'] = str(dependencies) + (os.pathsep + env['PYTHONPATH'] if env.get('PYTHONPATH') else '')
    print(f'Test artifacts: {run}', flush=True)
    # Child-only environment: the caller's TEMP/TMP/PYTHONPATH never change.
    result = subprocess.run([sys.executable, '-m', 'pytest', '-p', 'no:cacheprovider', '--basetemp', str(run / 'pytest'), *pytest_args], env=env, check=False)
    if result.returncode == 0 and not keep_artifacts:
        try:
            remove_run(run, parent, parent_identity, run_identity, token)
        except (OSError, ValueError) as error:
            print(f'Warning: test artifacts retained at {run}: {error}', file=sys.stderr)
    else:
        print(f'Test artifacts retained: {run}', flush=True)
    return result.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-root', type=Path, required=True)
    parser.add_argument('--dependencies', type=Path, required=True)
    parser.add_argument('--keep-artifacts', action='store_true')
    parser.add_argument('pytest_args', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    forwarded = args.pytest_args[1:] if args.pytest_args[:1] == ['--'] else args.pytest_args
    return run_tests(args.state_root, args.dependencies, forwarded, keep_artifacts=args.keep_artifacts)


if __name__ == '__main__':
    sys.exit(main())
