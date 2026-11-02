"""Publish a verified directory without treating transient Windows sharing locks as corruption."""
from contextlib import ExitStack, contextmanager
from pathlib import Path
import os
import stat
import time


def publish_directory(temporary: Path, destination: Path) -> None:
    if temporary.is_symlink() or temporary.is_junction():
        raise ValueError("Temporary backup/restore directory cannot be a link")
    source, target = temporary.resolve(), destination.resolve()
    if source.parent != target.parent or source.name != target.name + ".tmp":
        raise ValueError("Temporary directory must be the destination's sibling staging directory")
    for attempt in range(6):
        if destination.exists():
            raise FileExistsError("The destination already exists; it will not be overwritten")
        try:
            temporary.rename(destination)
            return
        except PermissionError as exc:
            if getattr(exc, "winerror", None) not in {5, 32, 33} or attempt == 5:
                raise
            time.sleep(0.05 * 2 ** attempt)


@contextmanager
def pin_windows_parents(parent: Path):
    """Prevent ancestor replacement while Windows' path-based rmtree runs."""
    with ExitStack() as stack:
        if os.name == 'nt':
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
            kernel.CreateFileW.restype = wintypes.HANDLE
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
            for item in reversed((parent, *parent.parents)):
                # OPEN_REPARSE_POINT | BACKUP_SEMANTICS; deliberately no FILE_SHARE_DELETE.
                handle = kernel.CreateFileW(str(item), 0, 3, None, 3, 0x02200000, None)
                if handle == wintypes.HANDLE(-1).value:
                    raise ctypes.WinError(ctypes.get_last_error())
                stack.callback(kernel.CloseHandle, handle)
                attributes = (wintypes.DWORD * 2)()
                if not kernel.GetFileInformationByHandleEx(handle, 9, attributes, ctypes.sizeof(attributes)):
                    raise ctypes.WinError(ctypes.get_last_error())
                if attributes[0] & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                    raise ValueError(f'Refusing linked/reparse parent: {item}')
        yield
