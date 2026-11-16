from copy import deepcopy
import pytest

from apps.api.app.client_service_quality import compact_metrics, layout_checks


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
    for text,atom in [('信息截至14:05:22，仍待核实。','14:05:22'),('来源日期为2026年11月16日12时。','2026年11月16日12时')]:
        lines=_lines(text,font,300)
        assert ''.join(lines)==text and any(atom in line for line in lines)
        assert not any(line.startswith(('，','。','；')) for line in lines)
