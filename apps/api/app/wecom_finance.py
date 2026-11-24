"""Read text archives through the official WeCom Finance C SDK."""
from __future__ import annotations

import base64
import ctypes as c
import json
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa


class ArchiveError(RuntimeError):
    pass


def _load_library(path: Path):
    try:
        library = c.CDLL(str(path))
        signatures = {
            "NewSdk": (c.c_void_p, []),
            "DestroySdk": (None, [c.c_void_p]),
            "Init": (c.c_int, [c.c_void_p, c.c_char_p, c.c_char_p]),
            "NewSlice": (c.c_void_p, []),
            "FreeSlice": (None, [c.c_void_p]),
            "GetSliceLen": (c.c_int, [c.c_void_p]),
            "GetContentFromSlice": (c.c_void_p, [c.c_void_p]),
            "GetChatData": (c.c_int, [c.c_void_p, c.c_ulonglong, c.c_uint, c.c_char_p, c.c_char_p, c.c_int, c.c_void_p]),
            "DecryptData": (c.c_int, [c.c_char_p, c.c_char_p, c.c_void_p]),
        }
        for name, (result, arguments) in signatures.items():
            function = getattr(library, name)
            function.restype, function.argtypes = result, arguments
        return library
    except (OSError, AttributeError) as exc:
        raise ArchiveError("无法加载企业微信会话存档 C SDK，请检查服务端配置。") from exc


class FinanceArchive:
    def __init__(self, library: Path, corp_id: str, secret: str, key_dir: Path):
        self.sdk = _load_library(library)
        self.corp_id, self.secret, self.key_dir = corp_id, secret, key_dir
        self.keys: dict[int, rsa.RSAPrivateKey] = {}
        self.handle = None

    def __enter__(self):
        self.handle = self.sdk.NewSdk()
        if not self.handle:
            raise ArchiveError("无法初始化企业微信会话存档 SDK。")
        status = self.sdk.Init(self.handle, self.corp_id.encode(), self.secret.encode())
        if status:
            self.sdk.DestroySdk(self.handle)
            raise ArchiveError(f"会话存档身份验证失败（SDK {status}）。")
        return self

    def __exit__(self, *_):
        self.sdk.DestroySdk(self.handle)

    def _read_json(self, function, *arguments) -> dict:
        output = self.sdk.NewSlice()
        if not output:
            raise ArchiveError("企业微信会话存档暂时无法读取数据。")
        try:
            status = function(*arguments, output)
            if status:
                raise ArchiveError(f"企业微信会话存档读取失败（SDK {status}）。")
            length, data = self.sdk.GetSliceLen(output), self.sdk.GetContentFromSlice(output)
            if not data or not 0 < length <= 64 * 1024 * 1024:
                raise ArchiveError("企业微信会话存档返回的数据长度异常。")
            try:
                value = json.loads(c.string_at(data, length).rstrip(b"\0"))
            except ValueError:
                raise ArchiveError("企业微信会话存档数据格式异常。") from None
            if not isinstance(value, dict):
                raise ArchiveError("企业微信会话存档数据格式异常。")
            return value
        finally:
            self.sdk.FreeSlice(output)

    def _decrypt(self, item: dict) -> dict:
        try:
            version = item["publickey_ver"]
            if type(version) is not int or not 0 <= version <= 2**32 - 1:
                raise ValueError
            if version not in self.keys:
                try:
                    key = serialization.load_pem_private_key(
                        (self.key_dir / f"{version}.pem").read_bytes(), password=None,
                    )
                except (OSError, TypeError, ValueError):
                    raise ArchiveError(f"请检查企业微信会话存档的版本 {version} 私钥。") from None
                if not isinstance(key, rsa.RSAPrivateKey):
                    raise ArchiveError(f"企业微信会话存档的版本 {version} 私钥需要使用 RSA 格式。")
                self.keys[version] = key
            wrapped = base64.b64decode(item["encrypt_random_key"], validate=True)
            random_key = self.keys[version].decrypt(wrapped, padding.PKCS1v15())
            encrypted = item["encrypt_chat_msg"].encode("ascii")
        except (ValueError, TypeError, KeyError, AttributeError):
            raise ArchiveError("会话存档消息解密失败，请核对相应版本的私钥。") from None
        return self._read_json(self.sdk.DecryptData, random_key, encrypted)

    def read(self, cursor: int) -> tuple[int, list[dict]]:
        response = self._read_json(self.sdk.GetChatData, self.handle, cursor, 500, b"", b"", 8)
        status = response.get("errcode")
        if status != 0:
            suffix = f"（错误码 {status}）" if type(status) is int else ""
            raise ArchiveError(f"企业微信拒绝读取会话存档{suffix}。")
        items = response.get("chatdata")
        if not isinstance(items, list) or any(
            not isinstance(item, dict) or type(item.get("seq")) is not int
            or not cursor < item["seq"] < 2**64 for item in items
        ):
            raise ArchiveError("企业微信会话存档返回的游标无效。")
        return max((item["seq"] for item in items), default=cursor), [self._decrypt(item) for item in items]
