from copy import deepcopy
from pathlib import Path
import pytest

from apps.api.app.client_service_quality import (
    compact_metrics, ground_preopen_close_copy, layout_checks, observation_span, validate_generated_copy,
)


def metric(label,value,**extra):
    return {'label':label,'value':value,'observed_at':'2026-11-16T10:30:00+08:00','source_url':'https://www.sse.com.cn/example',**extra}


def test_combined_indexes_become_three_numeric_cells_and_keep_full_evidence():
    original={'quality':'verified','metrics':[metric('三大指数','上证指数报3599.51点，下跌0.96%；深证成指报11649.58点，上涨1.05%；创业板指报2400.01点（-1.24%），市场震荡，成交额仍需观察。')]}
    before=deepcopy(original)
    value=compact_metrics(original)
    assert value['metrics']==[
        metric('上证指数','3599.51点 -0.96%'),metric('深证成指','11649.58点 +1.05%'),metric('创业板指','2400.01点 -1.24%')]
    assert value['raw_metrics']==before['metrics'] and original==before
    assert value['quality']=='verified' and layout_checks(value)['state']=='passed'
    assert compact_metrics(value)==value


def test_missing_change_is_not_borrowed_from_the_next_index():
    value=compact_metrics({'metrics':[metric('三大指数','上证指数3599.51点，深证成指11649.58点，上涨1.05%，创业板指2400.01点，跌幅1.24%')]})
    assert value['metrics'][0]['value']=='3599.51点'
    assert value['metrics'][1]['value']=='11649.58点 +1.05%'


def test_unknown_or_unverifiable_values_are_never_filled_with_invented_prices():
    value=compact_metrics({'metrics':[metric('上证指数','昨日震荡后今日上涨0.3%'),metric('深证成指','11649.58（+1.05%）',source_url=None)]})
    assert [item['value'] for item in value['metrics']]==['+0.30%','未核实']
    assert value['quality']=='partial'
    ambiguous=compact_metrics({'metrics':[metric('上证指数、深证成指','3599.51（+0.2%）')]})
    assert all(item['value']=='未核实' for item in ambiguous['metrics'])


def test_amount_and_ratio_are_compacted_and_user_long_values_are_flagged():
    value=compact_metrics({'metrics':[metric('两市成交额','两市截至10:30成交额约1.23万亿元，具体成交统计口径详见来源页面'),metric('上涨占比','当前可核实的上涨比例为53.2%，部分证券因停牌未计入统计口径')]})
    assert value['metrics'][0]['value']=='约1.23万亿元'
    assert value['metrics'][1]['value']=='53.2%'
    assert layout_checks({'metrics':[{'label':'上证指数','value':'长文'*20}]})['state']=='warning'


@pytest.mark.parametrize('text,expected',[
    ('3600.75点，跌0.92%','3600.75点 -0.92%'),
    ('3600.75点，涨0.92%','3600.75点 +0.92%'),
    ('3600.75点（−0.92%）','3600.75点 -0.92%'),
    ('3600.75点（＋0.92%）','3600.75点 +0.92%'),
    ('3600.75点，0.92%','3600.75点'),
    ('3600.75点，0.00%','3600.75点 +0.00%'),
])
def test_signed_changes_preserve_direction_and_do_not_guess_missing_signs(text,expected):
    assert compact_metrics({'metrics':[metric('上证指数',text)]})['metrics'][0]['value']==expected


def test_format_upgrade_uses_original_evidence_to_recover_direction():
    original=metric('上证指数','3600.75点，跌0.92%')
    value=compact_metrics({'format_version':1,'raw_metrics':[original],'metrics':[metric('上证指数','3600.75点 0.92%')]})
    assert value['metrics'][0]['value']=='3600.75点 -0.92%'
    assert value['raw_metrics']==[original]


def test_density_checks_use_actual_chinese_text_width_and_require_explicit_direction():
    assert layout_checks({'metrics':[metric('说明','指数在震荡中走低市场目前仍有较大的分歧与犹豫')]})['state']=='warning'
    assert layout_checks({'metrics':[metric('上证指数','3600.75点 0.92%')]})['issues'][0]['message']=='指数涨跌幅需要明确正负方向'


def test_renderer_keeps_times_dates_and_closing_punctuation_together():
    from apps.api.app.client_service_images import _lines, _font
    font=_font(24)
    for text,atom in [('信息截至14:05:22，仍待核实。','14:05:22'),('来源日期为2026年11月16日12时。','2026年11月16日12时'),
                      ('午间成交较上一交易日同期增加606亿元，行情仍在变化。','606亿元')]:
        lines=_lines(text,font,300)
        assert ''.join(lines)==text and any(atom in line for line in lines)
        assert not any(line.startswith(('，','。','；')) for line in lines)


def test_observation_span_keeps_both_dates_for_mixed_day_quotes():
    market = {'metrics': [metric('上证指数', '3600点'), metric('上涨家数', '2000家', observed_at='2026-11-17T09:30:00+08:00')]}
    assert observation_span(market) == '11-16 10:30–11-17 09:30'


def preopen_copy():
    return {
        'cutoff': '2026-11-25T08:45:00+08:00', 'quality': 'verified', 'limitations': [],
        'metrics': [metric(label, value, observed_at='2026-11-24T15:00:00+08:00') for label, value in (
            ('上证指数', '+0.10%'), ('深证成指', '-0.20%'), ('创业板指', '-0.30%'),
        )],
        'summary': '上一交易日三大指数涨跌不一。',
        'commentary': {'headline': '指数涨跌不一', 'conclusion': '盘面局部修复。科创50收涨1.81%。'},
    }


def test_preopen_copy_replaces_unscoped_closing_claim_with_frozen_prior_session():
    value = preopen_copy()
    metrics = deepcopy(value['metrics'])
    with pytest.raises(ValueError, match='今日判断使用了收盘措辞'):
        validate_generated_copy(value)
    ground_preopen_close_copy(value)
    validate_generated_copy(value)
    assert value['metrics'] == metrics
    assert value['summary'] == '上一交易日三大指数涨跌不一。'
    assert value['commentary']['conclusion'] == '上一交易日（11月24日）收盘，上证指数+0.10%、深证成指-0.20%、创业板指-0.30%。'
    assert value['quality'] == 'partial'


@pytest.mark.parametrize('change', [
    {'observed_at': '2026-11-21T15:00:00+08:00'}, {'observed_at': '2026-11-24T11:30:00+08:00'},
    {'source_url': None},
])
def test_preopen_copy_still_rejects_unverified_or_mixed_session_evidence(change):
    value = preopen_copy()
    value['metrics'][0].update(change)
    start = deepcopy(value)
    ground_preopen_close_copy(value)
    assert value == start
    with pytest.raises(ValueError, match='今日判断使用了收盘措辞'):
        validate_generated_copy(value)


def test_compact_snapshot_keeps_horizon_once_and_shortens_breadth_counts():
    original = [metric('半日成交额', '9164亿元（半日）'), metric('沪深涨跌家数', '1575只上涨，3557只下跌')]
    result = compact_metrics({'format_version': 3, 'raw_metrics': original})
    assert result['raw_metrics'] == original
    assert [item['value'] for item in result['metrics']] == ['9164亿元', '涨1575 / 跌3557']


def test_card_font_uses_simplified_chinese_face_in_noto_collection(monkeypatch):
    from PIL import ImageFont
    from apps.api.app.client_service_images import _font

    path = Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc')
    if not path.is_file():
        pytest.skip('Noto CJK collection unavailable')
    monkeypatch.setenv('LLMR_CLIENT_CARD_FONT', str(path))
    _font.cache_clear()
    font = _font(62, True)
    _font.cache_clear()
    assert font.getname()[0] == 'Noto Sans CJK SC'
    old_font = ImageFont.truetype(path, 62)
    assert bytes(font.getmask('复')) != bytes(old_font.getmask('复'))
