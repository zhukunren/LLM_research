from __future__ import annotations

from copy import deepcopy
from datetime import date, timedelta

import pytest
from pydantic import ValidationError

from apps.api.app import dynamic_indicators as di


SOURCE = '''def compute(context, frames, params):
    dates, series = {}, {}
    for code, frame in frames.items():
        values = []
        window = int(params['window'])
        for index in range(len(frame['close'])):
            start = index - window + 1
            if start < 0 or not all(frame['valid'][start:index + 1]):
                values.append(None)
            else:
                values.append(float(sum(frame['close'][start:index + 1]) / window))
        dates[code] = list(frame['trade_date'])
        series[code] = {'trend': values}
    return {'dates': dates, 'series': series}
'''


def definition(**updates):
    raw = {
        'name': '自定义趋势', 'description': '用户定义的数值时序', 'formula': '过去 window 日收盘均值',
        'original_prompt': '请生成一条自定义趋势曲线',
        'program': {'contract_version': 'python-indicator-v1', 'source_code': SOURCE,
                    'required_fields': ['close'], 'required_history_bars': 3,
                    'parameters': {'window': 3},
                    'parameter_specs': {'window': {'label': '均值窗口', 'type': 'integer', 'minimum': 2, 'maximum': 20}}},
        'outputs': [{'name': 'trend', 'label': '趋势', 'unit': '元', 'placement': 'overlay'}],
    }
    raw.update(updates)
    return raw


def bars(count=12):
    return [{'trade_date': (date(2026, 1, 1) + timedelta(days=index)).isoformat(),
             'open': float(index + 1), 'high': float(index + 2), 'low': float(index + 0.5),
             'close': float(index + 1), 'volume': 100., 'amount': 1000., 'quality_valid': True}
            for index in range(count)]


def model():
    return di.DynamicIndicatorDefinition.model_validate(definition())


def valid_result(rows):
    return {'dates': {'600000.SH': [row['trade_date'] for row in rows]},
            'series': {'600000.SH': {'trend': [None, None] + [float(i) for i in range(2, len(rows))]}}}


@pytest.mark.parametrize('value', [True, False, '1.2', float('nan'), float('inf'), -float('inf'), [], {}, 10**1000])
def test_numeric_output_rejects_coercion_and_nonfinite(value):
    rows = bars()
    result = valid_result(rows)
    result['series']['600000.SH']['trend'][-1] = value
    with pytest.raises(di.IndicatorError, match='有限数字'):
        di.validate_result(result, {'600000.SH': rows}, model())


@pytest.mark.parametrize('change', ['missing_stock', 'extra_stock', 'missing_output', 'extra_output', 'short', 'long', 'missing_dates', 'reverse_dates', 'shift_dates', 'scalar'])
def test_exact_stock_output_shape_and_dates(change):
    rows = bars()
    result = valid_result(rows)
    if change == 'missing_stock':
        result['series'] = {}
    elif change == 'extra_stock':
        result['series']['600001.SH'] = result['series']['600000.SH']
    elif change == 'missing_output':
        result['series']['600000.SH'] = {}
    elif change == 'extra_output':
        result['series']['600000.SH']['other'] = [None] * len(rows)
    elif change == 'short':
        result['series']['600000.SH']['trend'].pop()
    elif change == 'long':
        result['series']['600000.SH']['trend'].append(0.)
    elif change == 'missing_dates':
        result.pop('dates')
    elif change == 'reverse_dates':
        result['dates']['600000.SH'].reverse()
    elif change == 'shift_dates':
        result['dates']['600000.SH'][-1] = '2026-01-13'
    elif change == 'scalar':
        result['series']['600000.SH']['trend'] = 1.
    with pytest.raises(di.IndicatorError):
        di.validate_result(result, {'600000.SH': rows}, model())


def test_warmup_and_invalid_row_must_remain_null():
    rows = bars()
    result = valid_result(rows)
    result['series']['600000.SH']['trend'][0] = 0
    with pytest.raises(di.IndicatorError, match='预热'):
        di.validate_result(result, {'600000.SH': rows}, model())
    result['series']['600000.SH']['trend'][0] = None
    rows[5]['quality_valid'] = False
    with pytest.raises(di.IndicatorError, match='无效行情'):
        di.validate_result(result, {'600000.SH': rows}, model())
    result['series']['600000.SH']['trend'][5] = None
    assert di.validate_result(result, {'600000.SH': rows}, model())['600000.SH']['trend'][5] is None


@pytest.mark.parametrize('bad_date', ['2026-1-03', '2026-02-30', '2026-01-02', '2027-01-01', None])
def test_input_dates_are_iso_unique_ordered_and_cutoff_safe(bad_date):
    rows = bars()
    rows[3]['trade_date'] = bad_date
    with pytest.raises(di.IndicatorError, match='行情日期'):
        di._runtime_frames(model(), {'600000.SH': rows}, '2026-01-12')


def test_invalid_input_values_are_not_exposed_to_compute():
    rows = bars()
    rows[4]['quality_valid'] = False
    rows[6]['close'] = float('inf')
    rows[7]['close'] = True
    frames = di._runtime_frames(model(), {'600000.SH': rows}, '2026-01-12')
    for index in (4, 6, 7):
        assert frames['600000.SH'][index]['quality_valid'] is False
        assert frames['600000.SH'][index]['close'] is None


@pytest.mark.parametrize('value', [True, '3', 3.0, float('inf'), 0, 21])
def test_parameters_remain_strict_declared_and_bounded(value):
    with pytest.raises(di.IndicatorError):
        di._definition_with_parameters(model(), {'window': value})
    with pytest.raises(di.IndicatorError, match='未声明'):
        di._definition_with_parameters(model(), {'invented': 3})


@pytest.mark.parametrize('confirmation', [False, 1, 'true', None])
def test_save_requires_explicit_boolean_confirmation(confirmation):
    with pytest.raises(ValidationError):
        di.SaveIndicatorRequest.model_validate({'trial_id': 'trial', 'request_id': 'save', 'confirmed': confirmation})


def test_parameters_and_required_fields_must_have_unique_specs():
    for change in ('spec', 'duplicate_field', 'missing_compute', 'syntax'):
        raw = definition()
        if change == 'spec':
            raw['program']['parameter_specs'] = {}
        elif change == 'duplicate_field':
            raw['program']['required_fields'] = ['close', 'close']
        elif change == 'missing_compute':
            raw['program']['source_code'] = 'def screen(a,b,c): return {}'
        else:
            raw['program']['source_code'] = 'def compute(:'
        with pytest.raises(ValidationError):
            di.DynamicIndicatorDefinition.model_validate(raw)


def test_mixed_placement_outputs_supported_with_one_histogram_per_group():
    raw = definition()
    raw['outputs'].append({'name': 'momentum', 'label': '动量', 'placement': 'pane', 'kind': 'histogram'})
    assert len(di.DynamicIndicatorDefinition.model_validate(raw).outputs) == 2
    raw['outputs'].append({'name': 'other', 'label': '另一动量', 'placement': 'pane', 'kind': 'histogram'})
    with pytest.raises(ValidationError):
        di.DynamicIndicatorDefinition.model_validate(raw)
