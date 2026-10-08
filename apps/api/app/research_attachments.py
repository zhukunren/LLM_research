"""Conversation-owned immutable originals, bounded previews and turn bindings."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
from typing import BinaryIO
from urllib.parse import quote
from uuid import UUID, uuid4
import xml.etree.ElementTree as ET
import zipfile

from PIL import Image
from pypdf import PdfReader

from . import db

MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_FILES_PER_MESSAGE = 8
MAX_FILES_PER_CONVERSATION = 100
MAX_CONVERSATION_BYTES = 250 * 1024 * 1024
MAX_PREVIEW_CHARS = 120_000
MAX_OFFICE_EXPANDED_BYTES = 100 * 1024 * 1024
MEDIA_TYPES = {
    '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.txt': 'text/plain', '.md': 'text/markdown',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
}
IMAGE_FORMATS = {'.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.webp': 'WEBP', '.gif': 'GIF', '.bmp': 'BMP'}


class AttachmentError(ValueError):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def limits() -> dict:
    return {'max_file_bytes': MAX_FILE_BYTES, 'max_files_per_message': MAX_FILES_PER_MESSAGE,
            'max_files_per_conversation': MAX_FILES_PER_CONVERSATION,
            'max_conversation_bytes': MAX_CONVERSATION_BYTES, 'allowed_extensions': list(MEDIA_TYPES)}


def _conversation(connection, conversation_id: str, *, writable: bool = False):
    row = connection.execute('SELECT id,state FROM conversations WHERE id=?', (conversation_id,)).fetchone()
    if not row:
        raise AttachmentError('找不到所属对话', 404)
    if writable and row['state'] != 'active':
        raise AttachmentError('此对话已归档，不能上传附件', 409)
    return row


def _linked(path: Path) -> bool:
    return path.is_symlink() or bool(getattr(path, 'is_junction', lambda: False)())


def _directory(conversation_id: str, *, create: bool = False) -> Path:
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', conversation_id):
        raise AttachmentError('附件所属对话标识无效', 404)
    root = db.DB_PATH.parent.resolve() / 'research-attachments'
    target = root / conversation_id
    if _linked(root) or _linked(target) or not target.resolve().is_relative_to(root.resolve()):
        raise AttachmentError('附件目录不可用', 409)
    if create:
        target.mkdir(parents=True, exist_ok=True)
        if _linked(root) or _linked(target):
            raise AttachmentError('附件目录不可用', 409)
    return target


def _path(conversation_id: str, name: str) -> Path:
    if not re.fullmatch(r'[a-f0-9-]{36}(?:\.preview\.txt|\.model\.png|\.[a-z]+)', name):
        raise AttachmentError('附件存储路径无效', 409)
    target = _directory(conversation_id) / name
    if _linked(target) or not target.is_file() or target.stat().st_nlink != 1:
        raise AttachmentError('附件原件不可用，请重新上传', 409)
    return target


def _digest(path: Path, maximum: int = MAX_FILE_BYTES) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            if size > maximum:
                raise AttachmentError('附件文件超过大小限制', 413)
            digest.update(chunk)
    return digest.hexdigest(), size


def _verified(row, name_key='stored_name', digest_key='sha256') -> Path:
    target = _path(row['conversation_id'], row[name_key])
    digest, size = _digest(target)
    if digest != row[digest_key] or (name_key == 'stored_name' and size != row['bytes']):
        raise AttachmentError('附件原件校验失败，请重新上传', 409)
    return target


def metadata(row) -> dict:
    return {key: row[key] for key in ('id', 'conversation_id', 'request_id', 'filename', 'media_type', 'bytes', 'sha256', 'created_at')} | {
        'url': f"/api/v1/conversations/{quote(row['conversation_id'], safe='')}/attachments/{row['id']}/download",
        'preview_available': bool(row['preview_name'] or row['model_image_name']), 'preview_note': row['preview_note'],
    }


def _xml(archive: zipfile.ZipFile, name: str) -> ET.Element:
    info = archive.getinfo(name)
    if info.file_size > 8 * 1024 * 1024:
        raise AttachmentError('Office XML 内容过大，无法安全读取')
    content = archive.read(name)
    if b'<!DOCTYPE' in content.upper() or b'<!ENTITY' in content.upper():
        raise AttachmentError('不支持包含外部实体定义的 Office 文件')
    return ET.fromstring(content)


def _office_text(path: Path, suffix: str) -> str:
    required = {'.docx': 'word/document.xml', '.xlsx': 'xl/workbook.xml', '.pptx': 'ppt/presentation.xml'}[suffix]
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) > 5000 or sum(info.file_size for info in infos) > MAX_OFFICE_EXPANDED_BYTES:
            raise AttachmentError('Office 文件解压后超过安全读取限制', 413)
        for info in infos:
            parts = info.filename.replace('\\', '/').split('/')
            if info.filename.startswith(('/', '\\')) or '..' in parts or ':' in info.filename or stat.S_ISLNK(info.external_attr >> 16):
                raise AttachmentError('Office 文件包含不安全的内部路径')
            if info.flag_bits & 1:
                raise AttachmentError('请先解除 Office 文件加密再上传')
        names = {info.filename for info in infos}
        if required not in names or '[Content_Types].xml' not in names:
            raise AttachmentError('Office 文件内容与扩展名不匹配')
        _xml(archive, required)
        rows: list[str] = []
        preview_chars = 0
        def append_row(value: str) -> bool:
            nonlocal preview_chars
            text = value[:max(0, MAX_PREVIEW_CHARS - preview_chars)]
            rows.append(text)
            preview_chars += len(text) + 1
            return preview_chars >= MAX_PREVIEW_CHARS
        if suffix == '.docx':
            for paragraph in _xml(archive, required).iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p'):
                if append_row(''.join(paragraph.itertext())): break
        elif suffix == '.pptx':
            for name in sorted((name for name in names if re.fullmatch(r'ppt/slides/slide\d+\.xml', name)), key=lambda value: int(re.search(r'\d+(?=\.xml$)', value).group())):
                if append_row('\n[' + name + ']'): break
                for element in _xml(archive, name).iter('{http://schemas.openxmlformats.org/drawingml/2006/main}t'):
                    if append_row(element.text or ''): break
                if preview_chars >= MAX_PREVIEW_CHARS: break
        else:
            ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
            shared = [''.join(element.itertext()) for element in _xml(archive, 'xl/sharedStrings.xml').iter(ns + 'si')] if 'xl/sharedStrings.xml' in names else []
            for name in sorted(name for name in names if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', name)):
                if append_row('\n[' + name + ']'): break
                for element in _xml(archive, name).iter(ns + 'row'):
                    cells = []
                    for cell in element.findall(ns + 'c'):
                        inline = cell.find(ns + 'is')
                        value = cell.findtext(ns + 'v') or (''.join(inline.itertext()) if inline is not None else '')
                        if cell.get('t') == 's':
                            try: value = shared[int(value)]
                            except (ValueError, IndexError): value = '[无法识别的共享文本索引]'
                        formula = cell.findtext(ns + 'f')
                        cells.append(f"{cell.get('r', '')}: {value}" + (f' [公式: ={formula}]' if formula else ''))
                    if append_row('\t'.join(cells)): break
                if preview_chars >= MAX_PREVIEW_CHARS: break
        return '\n'.join(rows)[:MAX_PREVIEW_CHARS]


def _preview(path: Path, suffix: str) -> tuple[str | None, str | None]:
    try:
        if suffix in IMAGE_FORMATS:
            with Image.open(path) as image:
                if image.format != IMAGE_FORMATS[suffix] or image.width * image.height > 40_000_000:
                    raise AttachmentError('图片格式不匹配或像素尺寸过大')
                image.verify()
            return None, None
        if suffix == '.pdf':
            with path.open('rb') as stream:
                if not stream.read(8).startswith(b'%PDF-'):
                    raise AttachmentError('文件内容不是 PDF')
            reader = PdfReader(path)
            if reader.is_encrypted and not reader.decrypt(''):
                raise AttachmentError('请先解除 PDF 加密再上传')
            parts, count = [], 0
            for page in reader.pages[:200]:
                text = page.extract_text() or ''
                parts.append(text[:MAX_PREVIEW_CHARS - count]); count += len(text)
                if count >= MAX_PREVIEW_CHARS: break
            result = '\n'.join(parts)[:MAX_PREVIEW_CHARS]
            return result or None, None if result else '此 PDF 没有可提取文本，可按原页图像阅读。'
        if suffix in {'.docx', '.xlsx', '.pptx'}:
            result = _office_text(path, suffix)
            return result or None, 'Office 预览为有界文本，不含完整排版；精确核验请读取原件。' if result else '文件没有可提取文本，原件仍可读取。'
        content = path.read_bytes()
        encoding = 'utf-16' if content.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8-sig'
        try: text = content.decode(encoding)
        except UnicodeDecodeError: text = content.decode('gb18030')
        if '\0' in text:
            raise AttachmentError('文本文件包含二进制内容')
        if suffix == '.json': json.loads(text)
        return text[:MAX_PREVIEW_CHARS], '文本预览已截取前 120000 字符，完整数据见原件。' if len(text) > MAX_PREVIEW_CHARS else None
    except AttachmentError:
        raise
    except Exception as exc:
        raise AttachmentError('文件无法读取或内容与扩展名不匹配，请检查原件') from exc


def upload(conversation_id: str, request_id: str, filename: str, stream: BinaryIO) -> dict:
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,99}', request_id or ''):
        raise AttachmentError('上传请求标识无效')
    if not filename or len(filename) > 240 or filename != filename.strip() or any(ord(char) < 32 for char in filename) or any(char in filename for char in '/\\:'):
        raise AttachmentError('附件名称无效，请使用不含路径的文件名')
    suffix = Path(filename).suffix.lower()
    if suffix not in MEDIA_TYPES:
        raise AttachmentError('不支持此文件格式，请上传 PDF、DOCX、XLSX、PPTX、文本、表格或常见图片')
    with db.connect() as connection:
        _conversation(connection, conversation_id, writable=True)
    folder = _directory(conversation_id, create=True)
    attachment_id = str(uuid4())
    target = folder / (attachment_id + suffix)
    preview = folder / (attachment_id + '.preview.txt')
    model_image = folder / (attachment_id + '.model.png')
    owned = [target, preview, model_image]
    retain = False
    try:
        digest, size = hashlib.sha256(), 0
        stream.seek(0)
        with target.open('xb') as output:
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_FILE_BYTES: raise AttachmentError('单个附件不能超过 25 MiB', 413)
                output.write(chunk); digest.update(chunk)
        if not size: raise AttachmentError('不能上传空文件')
        text, note = _preview(target, suffix)
        preview_hash = None
        if text:
            with preview.open('x', encoding='utf-8') as output: output.write(text)
            preview_hash = _digest(preview)[0]
        image_name, image_hash = None, None
        if suffix in IMAGE_FORMATS:
            if suffix in {'.gif', '.bmp'}:
                with Image.open(target) as image:
                    image.seek(0); image.thumbnail((2048, 2048))
                    with model_image.open('xb') as output: image.convert('RGB').save(output, format='PNG')
                image_name, image_hash = model_image.name, _digest(model_image)[0]
            else:
                image_name, image_hash = target.name, digest.hexdigest()
        with db.connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            _conversation(connection, conversation_id, writable=True)
            existing = connection.execute('SELECT * FROM research_attachments WHERE conversation_id=? AND request_id=?', (conversation_id, request_id)).fetchone()
            if existing:
                if existing['filename'] != filename or existing['sha256'] != digest.hexdigest() or existing['bytes'] != size:
                    raise AttachmentError('同一上传请求不能用于不同文件，请重新选择文件', 409)
                _verified(existing)
                result = {**metadata(existing), 'idempotent_replay': True}
            else:
                count, used = connection.execute('SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM research_attachments WHERE conversation_id=?', (conversation_id,)).fetchone()
                if count >= MAX_FILES_PER_CONVERSATION or used + size > MAX_CONVERSATION_BYTES:
                    raise AttachmentError('此对话的附件数量或总大小已达上限，请新建对话', 413)
                _directory(conversation_id)
                _path(conversation_id, target.name)
                for path in owned:
                    if path.exists(): path.chmod(stat.S_IREAD)
                connection.execute('''INSERT INTO research_attachments(id,conversation_id,request_id,filename,stored_name,media_type,bytes,sha256,
                    preview_name,preview_sha256,model_image_name,model_image_sha256,preview_note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                    (attachment_id, conversation_id, request_id, filename, target.name, MEDIA_TYPES[suffix], size, digest.hexdigest(),
                     preview.name if text else None, preview_hash, image_name, image_hash, note, db.utc_now()))
                connection.execute('UPDATE conversations SET updated_at=? WHERE id=?', (db.utc_now(), conversation_id))
                result = {**metadata(connection.execute('SELECT * FROM research_attachments WHERE id=?', (attachment_id,)).fetchone()), 'idempotent_replay': False}
        retain = not result['idempotent_replay']
        return result
    finally:
        if not retain:
            try:
                safe_folder = _directory(conversation_id)
            except AttachmentError:
                safe_folder = None
            if safe_folder is not None:
                for path in owned:
                    if path.parent == safe_folder and path.exists() and not _linked(path):
                        if path.stat().st_nlink == 1: path.chmod(stat.S_IWRITE | stat.S_IREAD)
                        path.unlink()


def list_attachments(conversation_id: str) -> dict:
    with db.connect() as connection:
        _conversation(connection, conversation_id)
        items = connection.execute('SELECT * FROM research_attachments WHERE conversation_id=? ORDER BY created_at,id', (conversation_id,)).fetchall()
    return {'items': [metadata(row) for row in items], 'limits': limits()}


def download(conversation_id: str, attachment_id: str) -> tuple[Path, dict]:
    with db.connect() as connection:
        _conversation(connection, conversation_id)
        row = connection.execute('SELECT * FROM research_attachments WHERE id=? AND conversation_id=?', (attachment_id, conversation_id)).fetchone()
    if not row: raise AttachmentError('找不到此对话的附件', 404)
    return _verified(row), metadata(row)


def freeze(connection, conversation_id: str, attachment_ids: list[str]) -> list[dict]:
    if len(attachment_ids) > MAX_FILES_PER_MESSAGE or len(set(attachment_ids)) != len(attachment_ids):
        raise AttachmentError('每条消息最多附加 8 份不同文件')
    result = []
    for attachment_id in attachment_ids:
        try: UUID(attachment_id)
        except (ValueError, TypeError, AttributeError): raise AttachmentError('附件标识无效') from None
        row = connection.execute('SELECT * FROM research_attachments WHERE id=? AND conversation_id=?', (attachment_id, conversation_id)).fetchone()
        if not row: raise AttachmentError('附件不属于当前对话或尚未上传完成')
        _verified(row)
        result.append(metadata(row))
    return result


def turn_manifest(conversation_id: str, turn_id: str) -> list[dict]:
    with db.connect() as connection:
        turn = connection.execute('SELECT attachments_json FROM conversation_turns WHERE id=? AND conversation_id=?', (turn_id, conversation_id)).fetchone()
        if not turn: return []
        snapshots = db.json_load(turn['attachments_json'])
        result = []
        for snapshot in snapshots:
            row = connection.execute('SELECT * FROM research_attachments WHERE id=? AND conversation_id=?', (snapshot['id'], conversation_id)).fetchone()
            if not row or row['sha256'] != snapshot['sha256']:
                raise AttachmentError('本轮附件记录校验失败', 409)
            result.append({**snapshot, 'path': str(_verified(row)),
                'text_preview_path': str(_verified(row, 'preview_name', 'preview_sha256')) if row['preview_name'] else None,
                'model_image_path': str(_verified(row, 'model_image_name', 'model_image_sha256')) if row['model_image_name'] else None,
                'image_note': '原生图像输入是首帧预览；完整帧与分辨率请读取原件。' if row['model_image_name'] and row['model_image_name'] != row['stored_name'] else None,
                'read_only': True, 'trust': 'untrusted_user_file'})
    return result
