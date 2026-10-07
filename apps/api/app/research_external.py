"""Read-only public-source capture and visual PDF inspection for Codex research."""
from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import socket
import urllib.request
from pathlib import Path
from typing import Literal
from urllib.parse import unquote, urljoin, urlsplit
from uuid import uuid4

from PIL import Image
import requests
from pydantic import Field

from . import research_workspace, public_sources
from .db import utc_now
from .models import StrictModel
from .settings import research_mode_settings


ExternalSourceError = public_sources.PublicSourceError


class CapturePageArgs(StrictModel):
    url: str = Field(min_length=8, max_length=4000)
    scroll_y: int = Field(default=0, ge=0, le=50000)
    wait_selector: str | None = Field(default=None, max_length=200)


class DownloadSourceArgs(StrictModel):
    url: str = Field(min_length=8, max_length=4000)
    max_bytes: int = Field(default=50 * 1024 * 1024, ge=1024, le=200 * 1024 * 1024)


class InspectPdfArgs(StrictModel):
    path: str = Field(min_length=1, max_length=2000)
    pages: list[int] = Field(default_factory=lambda: [1], min_length=1, max_length=4, description="One-based physical PDF pages, including covers; not printed page labels or zero-based indices.")
    dpi: int = Field(default=144, ge=72, le=240)
    table_strategy: Literal["auto", "lines", "text"] = "auto"
    bbox: tuple[float, float, float, float] | None = None


class InspectImageArgs(StrictModel):
    path: str = Field(min_length=1, max_length=2000)
    bbox: tuple[int, int, int, int] | None = None


class ListSourcesArgs(StrictModel):
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=20, ge=1, le=50)


def _network_proxies() -> dict[str,str]:
    inherited=urllib.request.getproxies()
    return {scheme:os.environ.get('LLMR_RESEARCH_'+scheme.upper()+'_PROXY') or inherited[scheme]
            for scheme in ('http','https') if os.environ.get('LLMR_RESEARCH_'+scheme.upper()+'_PROXY') or inherited.get(scheme)}


def _browser_proxy() -> dict[str,str] | None:
    proxies=_network_proxies()
    value=proxies.get('https') or proxies.get('http')
    if not value:
        return None
    parts=urlsplit(value if '://' in value else 'http://'+value)
    server=f'{parts.scheme}://{parts.hostname}' + (f':{parts.port}' if parts.port else '')
    result={'server':server}
    if parts.username:
        result['username']=unquote(parts.username)
    if parts.password:
        result['password']=unquote(parts.password)
    return result


def _source_session():
    # Honour the explicitly inherited source proxy, not a sandbox account's
    # registry or ambient NO_PROXY setting. Keep model-provider traffic separate.
    return public_sources.source_session(proxies=_network_proxies(), public_dns=_public_dns_addresses)


_dns_failures = public_sources._dns_failures


def _public_dns_addresses(host: str) -> tuple[str, ...]:
    return public_sources.public_dns_addresses(host)


def _public_url(value: str) -> str:
    return public_sources.resolve_public_url(value, public_dns=_public_dns_addresses).url


def _work(context) -> Path:
    work = research_workspace.directory(context.conversation_id).resolve()
    work.mkdir(parents=True, exist_ok=True)
    return work


def _new_source(context, kind: str) -> Path:
    work = _work(context)
    root = work / "sources"
    if root.is_symlink() or not root.resolve().is_relative_to(work):
        raise ExternalSourceError("来源保存目录越界。")
    target = root / (kind + '-' + uuid4().hex)
    target.mkdir(parents=True)
    return target


def _source_file(context, value: str) -> Path:
    work = _work(context)
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = work / candidate
    path = candidate.resolve()
    if candidate.is_symlink() or not path.is_relative_to(work) or not path.is_file():
        raise ExternalSourceError("文件须位于当前研究工作目录。可先下载原文，或复制获准读取的本地原文到工作目录。")
    if path.stat().st_size > _byte_limit(context):
        raise ExternalSourceError("来源文件超过当前研究文件预算。")
    return path


def _file_hash(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()


def _original_provenance(source: Path) -> dict:
    record=source.parent/'metadata.json'
    if record.is_file() and not record.is_symlink():
        try:
            value=json.loads(record.read_text(encoding='utf-8'))
            expected_hash = value.get('sha256') if value.get('path')==str(source) else value.get('image_sha256') if value.get('image_path')==str(source) else None
            if expected_hash and expected_hash==_file_hash(source):
                return {'source_url':value.get('url'),'original_source_id':value.get('source_id')}
        except (OSError,ValueError):
            pass
    return {}


def _byte_limit(context) -> int:
    return int(research_mode_settings("research", context.research_depth)["max_output_file_bytes"])


def _provenance(context, directory: Path, **fields) -> dict:
    return {
        "source_id": directory.name, "retrieved_at": utc_now(),
        "research_as_of": context.as_of,
        "historical_availability_verified": False,
        "content_is_untrusted": True,
        **fields,
    }


def _write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")


def capture_page(args: CapturePageArgs, context) -> dict:
    from playwright.sync_api import sync_playwright

    url = _public_url(args.url)
    directory = _new_source(context, "web")
    try:
        with sync_playwright() as playwright:
            browser = public_sources.launch_browser(playwright, research_workspace.browser_options())
            try:
                session = browser.new_context(viewport={"width": 1440, "height": 1000}, accept_downloads=False, service_workers="block")
                guard = public_sources.BrowserSourceGuard(session, transport=_source_session())
                page = session.new_page()
                response = page.goto(url, wait_until="domcontentloaded", timeout=30000)
                if response is None or response.status >= 400:
                    raise ExternalSourceError(f"网页没有成功返回正文（HTTP {response.status if response else 'unknown'}）。")
                if args.wait_selector:
                    page.locator(args.wait_selector).first.wait_for(timeout=10000)
                page.wait_for_timeout(300)
                page.evaluate("y => window.scrollTo(0, y)", args.scroll_y)
                text = page.locator("body").inner_text(timeout=10000)
                if len(text.encode('utf-8')) > 2 * 1024 * 1024:
                    raise ExternalSourceError("网页正文过大，请缩小来源页面。")
                title = page.title()
                if any(marker in (title + '\n' + text[:1000]).lower() for marker in ("just a moment", "verify you are human", "access denied", "checking your browser")):
                    raise ExternalSourceError("网页返回访问验证或拦截页，未取得可信正文。")
                html = page.content()
                if len(html.encode('utf-8')) > 5 * 1024 * 1024:
                    raise ExternalSourceError("网页 HTML 过大，请缩小来源页面。")
                links = page.evaluate("""() => Array.from(document.querySelectorAll('a[href]')).map(a => ({text:a.innerText.trim(),url:a.href,download:a.hasAttribute('download')})).filter(a => /^https?:/.test(a.url)).slice(0,500)""")
                tables = page.evaluate("""() => Array.from(document.querySelectorAll('table')).slice(0,30).map(t => ({caption:t.caption?.innerText || '',rows:Array.from(t.rows).map(r => Array.from(r.cells).map(c => ({text:c.innerText,rowspan:c.rowSpan,colspan:c.colSpan})))}))""")
                declared_date = page.locator('meta[property="article:published_time"],meta[name="date"],meta[name="pubdate"]')
                publication = declared_date.first.get_attribute('content') if declared_date.count() else None
                page.screenshot(path=str(directory / 'page.png'))
                final_url = guard.final_url(page.url)
            finally:
                if 'guard' in locals():
                    guard.close()
                browser.close()
    except ExternalSourceError:
        raise
    except Exception as exc:
        if 'guard' in locals() and guard.errors:
            raise ExternalSourceError(f"网页来源读取受限：{guard.errors[-1]}") from exc
        raise ExternalSourceError(f"网页读取失败：{str(exc)[:200]}。下载链接请使用 download_research_source。") from exc
    (directory / 'page.html').write_text(html, encoding='utf-8')
    (directory / 'text.txt').write_text(text, encoding='utf-8')
    _write_json(directory / 'tables.json', tables)
    metadata = _provenance(context, directory, kind='web', requested_url=url, url=final_url,
                           title=title, publisher_declared_date=publication,
                           sha256=hashlib.sha256(html.encode('utf-8')).hexdigest(),
                           text_path=str(directory / 'text.txt'), html_path=str(directory / 'page.html'),
                           image_path=str(directory / 'page.png'), tables_path=str(directory / 'tables.json'),
                           image_sha256=_file_hash(directory/'page.png'),
                           scroll_y=args.scroll_y, text_characters=len(text), links=links)
    _write_json(directory / 'metadata.json', metadata)
    prioritized = sorted(links, key=lambda link: not (link['download'] or any(ext in link['url'].lower() for ext in ('.pdf', '.csv', '.xlsx', '.png', '.jpg'))))
    return {**{key:value for key,value in metadata.items() if key != 'links'},
            'text_preview':text[:8000], 'text_truncated':len(text)>8000,
            'links_preview':prioritized[:80], 'links_total':len(links),
            'tables_preview':[{'caption':table['caption'],'rows':table['rows'][:10],'row_count':len(table['rows'])} for table in tables[:5]],
            'note':'这是公开网页的实际快照；日期和内容仍须核验。完整正文和表格已保存。图表请用原生图像工具读取 image_path，或指定 scroll_y 重新截图。'}


def _download(url: str, target: Path, maximum: int) -> tuple[str, str]:
    try:
        with _source_session() as session:
            for _ in range(6):
                url = _public_url(url)
                with session.get(url,headers={'User-Agent':'Mozilla/5.0 (compatible; LLMResearch/0.1)'},timeout=30,stream=True,allow_redirects=False) as response:
                    if response.status_code in {301,302,303,307,308} and response.headers.get('Location'):
                        url=urljoin(url,response.headers['Location'])
                        continue
                    if response.status_code>=400:
                        raise ExternalSourceError(f"原文下载失败（HTTP {response.status_code}）。")
                    content_type=response.headers.get('Content-Type','application/octet-stream').split(';')[0].strip().lower()
                    declared=response.headers.get('Content-Length')
                    if declared and declared.isdigit() and int(declared)>maximum:
                        raise ExternalSourceError("原文超过下载大小预算。")
                    size=0
                    with target.open('wb') as stream:
                        for chunk in response.iter_content(64*1024):
                            size+=len(chunk)
                            if size>maximum:
                                raise ExternalSourceError("原文超过下载大小预算。")
                            stream.write(chunk)
                    return url,content_type
    except requests.RequestException as exc:
        raise ExternalSourceError("原文网络传输失败，未取得完整原件。") from exc
    raise ExternalSourceError("来源重定向次数过多。")


def download_source(args: DownloadSourceArgs, context) -> dict:
    directory = _new_source(context, 'document')
    temporary = directory / 'download.partial'
    try:
        url, content_type = _download(args.url, temporary, min(args.max_bytes, _byte_limit(context)))
        with temporary.open('rb') as stream:
            header = stream.read(1024)
        if header.lstrip(b'\x00\t\r\n ').startswith(b'%PDF-'):
            extension = '.pdf'
        elif header.startswith(b'\x89PNG'):
            extension = '.png'
        elif header.startswith(b'\xff\xd8'):
            extension = '.jpg'
        elif header[:4] == b'RIFF' and header[8:12] == b'WEBP':
            extension = '.webp'
        elif content_type in {'text/csv','application/csv'} and not header.lstrip().startswith(b'<'):
            extension = '.csv'
        elif content_type == 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and header.startswith(b'PK\x03\x04'):
            extension = '.xlsx'
        else:
            raise ExternalSourceError("下载结果不是支持的 PDF、图像或数据表；HTML/登录页不能当作原文 PDF。网页请使用 capture_research_page。")
        target = directory / ('original' + extension)
        temporary.replace(target)
        digest = _file_hash(target)
        metadata = _provenance(context,directory,kind='document',requested_url=args.url,url=url,
                               content_type=content_type,path=str(target),bytes=target.stat().st_size,sha256=digest)
        _write_json(directory / 'metadata.json',metadata)
        return {**metadata,'note':'原文件已保存，不自动导入业务资料库。PDF 用 inspect_research_pdf 检查；图像用 inspect_research_image 和原生图像工具读取。引用来源网址与原 PDF 页码。'}
    finally:
        temporary.unlink(missing_ok=True)


def inspect_pdf(args: InspectPdfArgs, context) -> dict:
    try:
        import pdfplumber
    except ImportError as exc:
        raise ExternalSourceError("PDF 检查依赖未安装，请运行项目 bootstrap。") from exc
    source = _source_file(context,args.path)
    with source.open('rb') as stream:
        if not stream.read(1024).lstrip(b'\x00\t\r\n ').startswith(b'%PDF-'):
            raise ExternalSourceError("来源不是 PDF 文件。")
    directory = _new_source(context,'pdf-inspection')
    source_hash=_file_hash(source)
    results = []
    try:
        with pdfplumber.open(source) as pdf:
            total = len(pdf.pages)
            for number in dict.fromkeys(args.pages):
                if number<1 or number>total:
                    raise ExternalSourceError(f"PDF 页码应在 1–{total} 之间。")
                page = pdf.pages[number-1]
                full_size = [page.width,page.height]
                if args.bbox:
                    x0,y0,x1,y1=args.bbox
                    if not all(math.isfinite(v) for v in args.bbox) or not (0<=x0<x1<=page.width and 0<=y0<y1<=page.height):
                        raise ExternalSourceError("裁剪范围越界；坐标为 PDF 点，原点在页面左上角。")
                    page=page.crop(args.bbox)
                if page.width*page.height*(args.dpi/72)**2 > 16_000_000:
                    raise ExternalSourceError("页面渲染超过像素预算，请降低 dpi 或裁剪区域。")
                text = page.extract_text(layout=True) or ''
                strategy = 'lines' if args.table_strategy=='auto' else args.table_strategy
                tables = page.find_tables({'vertical_strategy':strategy,'horizontal_strategy':strategy})
                if not tables and args.table_strategy=='auto':
                    strategy='text'
                    tables=page.find_tables({'vertical_strategy':'text','horizontal_strategy':'text','min_words_vertical':3})
                image_path=directory/f'page-{number}.png'
                page.to_image(resolution=args.dpi,antialias=True).save(image_path,format='PNG',quantize=False)
                text_path=directory/f'page-{number}.txt'
                text_path.write_text(text,encoding='utf-8')
                extracted=[]
                for index,table in enumerate(tables[:20],1):
                    rows=table.extract()
                    columns=max((len(row) for row in rows),default=0)
                    if len(rows)<2 or columns<2:
                        continue
                    csv_path=directory/f'page-{number}-table-{index}.csv'
                    with csv_path.open('w',encoding='utf-8-sig',newline='') as stream:
                        csv.writer(stream).writerows(rows)
                    _write_json(directory/f'page-{number}-table-{index}.json',rows)
                    extracted.append({'table_index':index,'bbox':list(table.bbox),'strategy':strategy,
                                      'row_count':len(rows),'column_count':columns,'rows_preview':[row[:12] for row in rows[:12]],
                                      'csv_path':str(csv_path),'extraction_is_candidate':True,'visual_verified':False})
                results.append({'page_number':number,'full_page_size_points':full_size,'bbox':args.bbox,
                                'text_path':str(text_path),'text_preview':text[:6000],'text_characters':len(text),
                                'text_truncated':len(text)>6000,'image_path':str(image_path),'dpi':args.dpi,
                                'raster_image_count':len(page.images),'tables':extracted,
                                'image_sha256':_file_hash(image_path),
                                'requires_visual_review':True,'text_status':'extracted' if text.strip() else 'no_text_detected'})
                page.close()
    except ExternalSourceError:
        raise
    except Exception as exc:
        raise ExternalSourceError(f"PDF 检查失败（可能加密或损坏）：{str(exc)[:200]}") from exc
    if _file_hash(source)!=source_hash:
        raise ExternalSourceError("原 PDF 在检查期间发生变化，请重新检查。")
    metadata=_provenance(context,directory,kind='pdf-inspection',source_path=str(source),sha256=source_hash,page_count=total,pages=results,ocr=False,**_original_provenance(source))
    _write_json(directory/'metadata.json',metadata)
    preview_pages=[{**page,'tables':page['tables'][:5],'tables_total':len(page['tables'])} for page in results]
    return {**metadata,'pages':preview_pages,'inspection_metadata_path':str(directory/'metadata.json'),
            'note':'page_number 是从1开始的PDF物理页（包括封面），不等于印刷页或从0开始的索引；印刷页码须核对原页标签。务必用原生图像工具打开 page.image_path 核对图表、列标题、币种、单位、负号、合并单元格和脚注。提取表格是候选，不是已验证结论。扫描页无文本不等于没有内容；裁剪 bbox 可放大难读区域。完整表格保存在 CSV/JSON，各页只内联展示前5个表格。'}


def inspect_image(args: InspectImageArgs, context) -> dict:
    source=_source_file(context,args.path)
    directory=_new_source(context,'image-inspection')
    try:
        with Image.open(source) as original:
            if original.width*original.height>50_000_000:
                raise ExternalSourceError("图像超过像素预算。")
            size=list(original.size)
            if 'A' in original.getbands():
                rgba=original.convert('RGBA')
                image=Image.new('RGB',rgba.size,'white')
                image.paste(rgba,mask=rgba.getchannel('A'))
            else:
                image=original.convert('RGB')
            if args.bbox:
                x0,y0,x1,y1=args.bbox
                if not (0<=x0<x1<=image.width and 0<=y0<y1<=image.height):
                    raise ExternalSourceError("图像裁剪范围越界，坐标单位为像素。")
                image=image.crop(args.bbox)
            image.thumbnail((2400,2400))
            target=directory/'image.png'
            image.save(target)
            rendered_size=list(image.size)
    except ExternalSourceError:
        raise
    except Exception as exc:
        raise ExternalSourceError("无法读取来源图像。") from exc
    metadata=_provenance(context,directory,kind='image-inspection',source_path=str(source),
                         original_size_pixels=size,bbox=args.bbox,image_path=str(target),rendered_size_pixels=rendered_size,
                         image_sha256=_file_hash(target),**_original_provenance(source))
    _write_json(directory/'metadata.json',metadata)
    return {**metadata,'note':'这是原图的可读副本；使用原生图像工具读取 image_path。区分标签明示值和根据图形估算的值，无法辨认的内容明确标为未知。'}


def list_sources(args: ListSourcesArgs, context) -> dict:
    root=_work(context)/'sources'
    if root.is_symlink() or not root.resolve().is_relative_to(_work(context)):
        raise ExternalSourceError("来源目录越界。")
    files=sorted(root.glob('*/metadata.json'),key=lambda path:path.stat().st_mtime,reverse=True)
    items=[]
    for path in files[args.offset:args.offset+args.limit]:
        if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            continue
        value=json.loads(path.read_text(encoding='utf-8'))
        items.append({key:value[key] for key in ('source_id','kind','url','title','retrieved_at','research_as_of','sha256','path','source_path','image_path','text_path') if key in value})
    return {'items':items,'total':len(files),'offset':args.offset,'next_offset':args.offset+args.limit if args.offset+args.limit<len(files) else None}


def _handler(function):
    def call(args,context):
        from .screening_tools import ToolDispatchError
        try:
            return function(args,context)
        except ExternalSourceError as exc:
            raise ToolDispatchError('external_source_error',str(exc)) from exc
    return call


def register_tools(registry) -> None:
    # Like query_tushare, these retrieve external data and keep a local cache;
    # they never mutate the remote source or business state. Accurate read hints
    # allow the unattended runtime to use them under approval_policy=never.
    registry.register('capture_research_page','Read a public page with isolated headless Playwright. Cache actual rendered text, HTML, HTML tables, source links and a viewport screenshot in this conversation workspace. Native web search discovers URLs first. Reject blocked/failed pages. Use scroll_y or wait_selector for dynamic pages. No account profile or website writes.',CapturePageArgs,_handler(capture_page),read_only=True,open_world=True)
    registry.register('download_research_source','Read an actual public PDF, image, CSV or XLSX and cache the original in the current research workspace. Retain final URL, retrieval time and file SHA-256. Validate each redirect and reject HTML disguised as PDF. Does not alter the source or import a business-library document.',DownloadSourceArgs,_handler(download_source),read_only=True,open_world=True)
    registry.register('inspect_research_pdf','Inspect up to four original PDF pages in the current workspace: preserve page numbers, extract text and candidate tables into CSV/JSON, render page images for native visual reading. bbox uses PDF points from the top-left and supports close inspection of chart/table regions. Scanned pages need visual reading. Do not treat extraction as semantic verification.',InspectPdfArgs,_handler(inspect_pdf),read_only=False)
    registry.register('inspect_research_image','Prepare a readable PNG or pixel-coordinate crop of a source image in the current workspace for the native image tool. Preserve original size and crop provenance. Does not infer or invent chart values.',InspectImageArgs,_handler(inspect_image),read_only=False)
    registry.register('list_research_external_sources','List persistent captured/downloaded/inspected external-source records for this conversation, including paths and provenance. Reuse original sources in follow-up turns.',ListSourcesArgs,_handler(list_sources))
