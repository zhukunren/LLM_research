"""Exercise the local API publisher against the public host using synthetic data only."""
from pathlib import Path
import json
from uuid import uuid4

from fastapi.testclient import TestClient
import requests

from apps.api.app import db, main, conversation_store


def main_check():
    run = Path('runtime/verification') / ('share-api-' + uuid4().hex)
    run.mkdir(parents=True)
    db.DB_PATH = run / 'synthetic.db'
    with TestClient(main.app) as client:
        cid = client.post('/api/v1/conversations', json={'entry_scope': 'report', 'workflow_type': 'research'}).json()['id']
        turn = conversation_store.add_user_message(cid, 'test-question', 0, '公开分享功能验证：这是一条示例问题。')
        conversation_store.start_turn(cid, turn['turn_id'])
        conversation_store.finish_turn(cid, turn['turn_id'], 0, 'succeeded', '这是用于验证的示例回答，出处是[示例来源](https://example.com)。', {})
        message_id = conversation_store.get_conversation(cid)['messages'][-1]['id']
        later = conversation_store.add_user_message(cid, 'later-question', 0, '后续提问不应被分享。')
        conversation_store.start_turn(cid, later['turn_id'])
        conversation_store.finish_turn(cid, later['turn_id'], 0, 'succeeded', '后续回答不应被分享。', {})
        endpoint = f'/api/v1/conversations/{cid}/answers/{message_id}/share'
        published = client.post(endpoint, json={'request_id': 'synthetic-share'})
        assert published.status_code == 200, published.text
        result = published.json()
        received = requests.get(result['url'].replace('/s/', '/api/shares/'), timeout=45)
        assert received.status_code == 200
        snapshot = received.json()
        assert len(snapshot['messages']) == 2
        assert snapshot['messages'][-1]['sources'][0]['url'] == 'https://example.com'
        assert '后续提问' not in json.dumps(snapshot, ensure_ascii=False)
        assert client.post(endpoint, json={'request_id': 'synthetic-share'}).json() == result
        Path('runtime/verification/public-share-api-proof.json').write_text(json.dumps({'passed': True, 'url': result['url']}, ensure_ascii=False), encoding='utf-8')
        print(json.dumps({'passed': True, 'url': result['url'], 'messages': 2, 'sources': 1}, ensure_ascii=False))


if __name__ == '__main__':
    main_check()
