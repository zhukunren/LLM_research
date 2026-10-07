from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.platypus import Table, TableStyle

from apps.api.app import research_external as external


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    work=tmp_path/'work'
    work.mkdir()
    monkeypatch.setattr(external.research_workspace,'directory',lambda _:work)
    context=SimpleNamespace(conversation_id='test',research_depth='standard',as_of='2026-10-05')
    return work,context


@pytest.mark.parametrize('url', ['file:///C:/secret','http://localhost/file','http://127.0.0.1/file','http://user:password@example.com/file'])
def test_private_or_credential_urls_are_rejected(url):
    with pytest.raises(external.ExternalSourceError): external._public_url(url)


def test_hostname_resolving_to_private_address_is_rejected(monkeypatch):
    monkeypatch.setattr(external.socket,'getaddrinfo',lambda *_args,**_kwargs:[(2,1,6,'',('10.0.0.1',80))])
    with pytest.raises(external.ExternalSourceError,match='内网'): external._public_url('https://public.example/report.pdf')


def test_proxy_fake_ip_requires_public_dns_verified_https(monkeypatch):
    monkeypatch.setattr(external.socket,'getaddrinfo',lambda *_args,**_kwargs:[(2,1,6,'',('198.18.0.111',443))])
    monkeypatch.setattr(external,'_public_dns_addresses',lambda _:('8.8.8.8',))
    assert external._public_url('https://publisher.example/report.pdf')=='https://publisher.example/report.pdf'
    for url in ['http://publisher.example/report.pdf','https://publisher.example:8443/report.pdf','https://198.18.0.111/report.pdf']:
        with pytest.raises(external.ExternalSourceError): external._public_url(url)
    monkeypatch.setattr(external,'_public_dns_addresses',lambda _:('10.0.0.1',))
    with pytest.raises(external.ExternalSourceError): external._public_url('https://publisher.example/report.pdf')


def test_browser_proxy_credentials_are_not_embedded_in_server_url(monkeypatch):
    monkeypatch.setenv('LLMR_RESEARCH_HTTPS_PROXY','http://alice:private-secret@127.0.0.1:7897')
    proxy=external._browser_proxy()
    assert proxy=={'server':'http://127.0.0.1:7897','username':'alice','password':'private-secret'}
    assert 'private-secret' not in proxy['server']


def test_source_transport_uses_explicit_proxy_and_verified_ca_without_ambient_bypass(monkeypatch):
    monkeypatch.setenv('LLMR_RESEARCH_HTTPS_PROXY','http://127.0.0.1:7897')
    monkeypatch.setenv('NO_PROXY','*')
    with external._source_session() as session:
        assert session.trust_env is False
        assert session.proxies['https']=='http://127.0.0.1:7897'
        assert Path(session.verify).is_file()


def _pdf(work: Path):
    path=work/'source.pdf'
    document=canvas.Canvas(str(path),pagesize=(600,800))
    document.drawString(40,750,'Amounts: million EUR; EPS: EUR/share')
    table=Table([['Item','FY2024','FY2025'],['Revenue','1,234.5','1,499.6'],['Cash flow','(45.2)','(10.3)'],['EPS','0.35','0.42']],colWidths=[140,140,140])
    table.setStyle(TableStyle([('GRID',(0,0),(-1,-1),1,'black')]))
    table.wrapOn(document,420,200); table.drawOn(document,40,600)
    document.showPage()
    image=work/'scan.png'
    Image.new('RGB',(600,300),'white').save(image)
    document.drawImage(str(image),40,400,width=500,height=250)
    document.save()
    return path


def test_pdf_pages_tables_signs_units_and_scanned_page_are_preserved(workspace):
    work,context=workspace
    source=_pdf(work)
    before=source.read_bytes()
    result=external.inspect_pdf(external.InspectPdfArgs(path=str(source),pages=[1,2]),context)
    assert result['page_count']==2
    first,scan=result['pages']
    assert [first['page_number'],scan['page_number']]==[1,2]
    assert 'million EUR' in first['text_preview'] and 'EUR/share' in first['text_preview']
    assert any('(45.2)' in str(table['rows_preview']) for table in first['tables'])
    assert first['tables'][0]['visual_verified'] is False
    assert Path(first['tables'][0]['csv_path']).is_file()
    assert scan['text_status']=='no_text_detected' and scan['raster_image_count']==1
    assert scan['requires_visual_review'] is True and result['ocr'] is False
    for page in result['pages']:
        with Image.open(page['image_path']) as image: assert image.width>600 and image.height>800
    assert source.read_bytes()==before
    assert len(result['sha256'])==64
    assert external.list_sources(external.ListSourcesArgs(),context)['total']==1


def test_pdf_crop_is_bounded_and_retains_original_page_number(workspace):
    work,context=workspace
    source=_pdf(work)
    result=external.inspect_pdf(external.InspectPdfArgs(path=str(source),pages=[1],bbox=(40,150,500,230)),context)
    assert result['pages'][0]['page_number']==1
    assert result['pages'][0]['bbox']==(40.0,150.0,500.0,230.0)
    with pytest.raises(external.ExternalSourceError,match='裁剪'): external.inspect_pdf(external.InspectPdfArgs(path=str(source),bbox=(-1,0,30,30)),context)
    with pytest.raises(external.ExternalSourceError,match='页码'): external.inspect_pdf(external.InspectPdfArgs(path=str(source),pages=[3]),context)


def test_files_outside_this_conversation_cannot_be_inspected(workspace,tmp_path):
    work,context=workspace
    other=tmp_path/'other.pdf'; other.write_bytes(b'%PDF-1.7')
    with pytest.raises(external.ExternalSourceError,match='当前研究'): external.inspect_pdf(external.InspectPdfArgs(path=str(other)),context)
    with pytest.raises(external.ExternalSourceError,match='当前研究'): external.inspect_pdf(external.InspectPdfArgs(path='../other.pdf'),context)


def test_image_crop_preserves_dimensions_and_composites_transparency(workspace):
    work,context=workspace
    path=work/'figure.png'
    Image.new('RGBA',(200,120),(0,0,0,0)).save(path)
    result=external.inspect_image(external.InspectImageArgs(path=str(path),bbox=(20,10,100,80)),context)
    assert result['original_size_pixels']==[200,120] and result['rendered_size_pixels']==[80,70]
    with Image.open(result['image_path']) as image: assert image.getpixel((0,0))==(255,255,255)


@pytest.mark.parametrize('content_type,payload', [('application/pdf',b'<html>login %PDF- fake</html>'),('text/html',b'<html>blocked</html>')])
def test_html_is_never_saved_as_a_pdf(workspace,monkeypatch,content_type,payload):
    work,context=workspace
    def download(_url,target,_limit):
        target.write_bytes(payload)
        return 'https://publisher.example/report.pdf',content_type
    monkeypatch.setattr(external,'_download',download)
    with pytest.raises(external.ExternalSourceError,match='不是支持'): external.download_source(external.DownloadSourceArgs(url='https://publisher.example/report.pdf'),context)
    assert not list(work.rglob('original.pdf')) and not list(work.rglob('*.partial'))


def test_downloaded_original_provenance_survives_pdf_inspection(workspace,monkeypatch):
    work,context=workspace
    source=_pdf(work)
    def download(_url,target,_limit):
        target.write_bytes(source.read_bytes())
        return 'https://publisher.example/final.pdf','application/pdf'
    monkeypatch.setattr(external,'_download',download)
    original=external.download_source(external.DownloadSourceArgs(url='https://publisher.example/start.pdf'),context)
    result=external.inspect_pdf(external.InspectPdfArgs(path=original['path']),context)
    assert result['source_url']==original['url']
    assert result['original_source_id']==original['source_id']
    assert result['sha256']==original['sha256']
    assert result['historical_availability_verified'] is False


def test_download_checks_redirect_destination_before_following(monkeypatch,tmp_path):
    checked=[]; requests=[]
    def validate(url):
        checked.append(url)
        if '127.0.0.1' in url: raise external.ExternalSourceError('private')
        return url
    class Response:
        status_code=302
        headers={'Location':'http://127.0.0.1/secret'}
        def __enter__(self): return self
        def __exit__(self,*_): pass
    class Session:
        def __enter__(self): return self
        def __exit__(self,*_): pass
        def get(self,url,**kwargs):
            assert kwargs['allow_redirects'] is False
            requests.append(url)
            return Response()
    monkeypatch.setattr(external,'_public_url',validate)
    monkeypatch.setattr(external,'_source_session',lambda:Session())
    with pytest.raises(external.ExternalSourceError,match='private'): external._download('https://publisher.example/report.pdf',tmp_path/'target',1000)
    assert requests==['https://publisher.example/report.pdf']
    assert checked[-1]=='http://127.0.0.1/secret'


def test_streaming_download_enforces_size_without_content_length(monkeypatch,tmp_path):
    class Response:
        status_code=200
        headers={'Content-Type':'application/pdf'}
        def __enter__(self): return self
        def __exit__(self,*_): pass
        def iter_content(self,_): yield b'%PDF-'+b'x'*2000
    class Session:
        def __enter__(self): return self
        def __exit__(self,*_): pass
        def get(self,*_args,**_kwargs): return Response()
    monkeypatch.setattr(external,'_public_url',lambda value:value)
    monkeypatch.setattr(external,'_source_session',lambda:Session())
    with pytest.raises(external.ExternalSourceError,match='大小预算'): external._download('https://publisher.example/report.pdf',tmp_path/'target',1000)


def test_audit_dns_rebinding_download_is_rejected_before_any_source_socket(monkeypatch, tmp_path):
    from apps.api.app import public_sources
    resolutions = []
    def resolve(host, port, *_args, **_kwargs):
        resolutions.append(host)
        address = '93.184.216.34' if len(resolutions) == 1 else '127.0.0.1'
        return [(2, 1, 6, '', (address, port))]
    monkeypatch.setattr(external.socket, 'getaddrinfo', resolve)
    monkeypatch.setattr(external, '_network_proxies', lambda: {})
    def source_socket_must_not_be_opened(*_args, **_kwargs):
        pytest.fail('The rebound private address reached HTTP transport')
    monkeypatch.setattr(public_sources._PinnedAdapter, 'send', source_socket_must_not_be_opened)
    with pytest.raises(external.ExternalSourceError, match='内网'):
        external._download('http://publisher.example/source.csv', tmp_path / 'target.csv', 1024)
    assert resolutions == ['publisher.example', 'publisher.example']
    assert not (tmp_path / 'target.csv').exists()
