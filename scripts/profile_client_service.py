"""Read-only latency profile of a client card; excludes source bodies and reasoning text."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def interval_seconds(intervals):
    """Count overlapping/parallel tools once in elapsed wall time."""
    total = 0.0
    end = None
    for start, stop in sorted(intervals):
        if stop <= start:
            continue
        total += max(0.0, (stop - max(start, end or start)).total_seconds())
        end = max(stop, end or stop)
    return total


def profile(card_id):
    from apps.api.app.db import connect, json_load
    with connect() as connection:
        row = connection.execute('''SELECT c.turn_id,c.state AS card_state,c.market_json,c.content_json,
            t.model_id,t.reasoning_effort,t.created_at,t.updated_at
            FROM client_service_cards c JOIN conversation_turns t ON t.id=c.turn_id WHERE c.id=?''', (card_id,)).fetchone()
        if row is None:
            raise ValueError('找不到卡片或生成回合')
        snapshot = connection.execute('SELECT created_at FROM client_service_market_snapshots WHERE turn_id=?', (row['turn_id'],)).fetchone()
        events = connection.execute('SELECT method,payload_json,created_at FROM codex_turn_events WHERE app_turn_id=? ORDER BY sequence', (row['turn_id'],)).fetchall()
    start = datetime.fromisoformat(row['created_at'])
    elapsed = (datetime.fromisoformat(row['updated_at']) - start).total_seconds()
    starts, intervals, archive_intervals, timeline, counts, usages = {}, [], [], [], Counter(), []
    final_text_seconds = 0
    for event in events:
        body = json_load(event['payload_json'])
        item = body.get('item') or {}
        stamp = datetime.fromisoformat(event['created_at'])
        if event['method'] == 'thread/tokenUsage/updated':
            usages.append(body.get('tokenUsage', {}))
        if event['method'] == 'item/started':
            starts[item.get('id')] = stamp
        if event['method'] != 'item/completed':
            continue
        kind = item.get('type')
        began = starts.get(item.get('id'), stamp)
        if kind == 'agentMessage' and item.get('phase') == 'final_answer':
            final_text_seconds += (stamp - began).total_seconds()
        if kind not in {'commandExecution', 'webSearch', 'mcpToolCall'}:
            continue
        name = item.get('tool') if kind == 'mcpToolCall' else 'web.' + str((item.get('action') or {}).get('type')) if kind == 'webSearch' else 'shell'
        counts[name] += 1
        intervals.append((began, stamp))
        if name == 'capture_research_page':
            archive_intervals.append((began, stamp))
        timeline.append({'tool': name, 'start_seconds': (began - start).total_seconds(),
                         'duration_seconds': (stamp - began).total_seconds(), 'status': item.get('status')})
    market = json_load(row['market_json']) if row['market_json'] else {}
    return {'card_id': card_id, 'state': row['card_state'], 'model': row['model_id'], 'effort': row['reasoning_effort'],
            'turn_seconds': elapsed, 'snapshot_ready_seconds': (datetime.fromisoformat(snapshot['created_at']) - start).total_seconds() if snapshot else None,
            'tool_wait_union_seconds': interval_seconds(intervals), 'archive_wait_union_seconds': interval_seconds(archive_intervals),
            'non_tool_wall_seconds': max(0, elapsed - interval_seconds(intervals)), 'final_text_seconds': final_text_seconds,
            'model_rounds': len(usages), 'first_input_tokens': usages[0].get('last', {}).get('inputTokens') if usages else None,
            'last_input_tokens': usages[-1].get('last', {}).get('inputTokens') if usages else None,
            'total_token_usage': usages[-1].get('total') if usages else None,
            'tools': dict(counts), 'timeline': timeline, 'metric_count': len(market.get('metrics', [])),
            'source_count': len(market.get('sources', [])), 'quality': market.get('quality'),
            'notes': 'Times use persisted event timestamps (1-second precision). Parallel tool waits overlap; non-tool time includes model, queue, startup and transport, not pure inference.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('card_id')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    report = json.dumps(profile(args.card_id), ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report, encoding='utf-8')
    print(report)


if __name__ == '__main__':
    main()
